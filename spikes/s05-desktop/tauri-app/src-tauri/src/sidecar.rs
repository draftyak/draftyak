//! Supervises the bundled hub, `draftyak-node --disable-sigusr1 hub.mjs` (plan §7 Bundled
//! sidecar), started with `std::process::Command`, never with inspector flags.
//!
//! - **Frames.** Both pipes carry length-prefixed frames: a big-endian `u32` length, then that many
//!   bytes of UTF-8 JSON, at most [`MAX_FRAME`]. The app writes [`ToHub`] frames to the hub's stdin,
//!   [`ToHub::Unlock`] first on every spawn; the hub writes [`FromHub`] frames to stdout and logs
//!   only on stderr ([`Event::Log`]). The hub exits when its stdin closes.
//! - **Environment.** The hub gets only the app's variables that [`KEEP_ENV`] names, plus
//!   [`Config::env`], so `NODE_OPTIONS` and the other `NODE_*` variables never reach it.
//! - **Windows.** The hub is created suspended, assigned to its own kill-on-close Job Object that
//!   allows no breakaway, then resumed, so everything it starts, plugins included, ends with the job:
//!   on a restart, on shutdown and when the app process dies. Rust 1.95 has no stable accessor for
//!   the primary thread's handle (`ChildExt::main_thread_handle` is unstable, rust-lang/rust#96723),
//!   so [`job::Job::spawn`] resumes the process's only thread through a Toolhelp thread snapshot.
//! - **Linux and macOS.** The hub leads its own process group, which the supervisor kills on a
//!   restart and on shutdown; when the app dies, the hub sees stdin EOF and ends its plugins itself.
//! - **Supervision.** Every [`Policy::health_every`], a ready hub must echo a probe sent to its L2
//!   port within [`Policy::health_timeout`]: the kernel accepts connections for a hung hub too, but
//!   only the hub's event loop answers. A hub that exits, sends no ready frame in time, breaks the
//!   protocol or fails [`Policy::unhealthy_after`] probes in a row is ended and restarted after a
//!   backoff ([`Restarts`]).
//!
//! M0.23a quits through [`Supervisor::shutdown`]; M0.23b sends [`ToHub::Resumed`] after a wake and
//! holds keep-awake on [`Event::KeepAwake`].

use std::collections::VecDeque;
use std::ffi::OsString;
use std::fmt;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// The largest frame payload either side accepts.
pub const MAX_FRAME: usize = 1 << 20;
/// How long [`Supervisor`]'s drop waits for the hub after the shutdown frame.
pub const STOP_GRACE: Duration = Duration::from_secs(10);
/// The app's environment variables the hub keeps, matched case-insensitively on Windows. All the
/// others, `PATH` and `NODE_OPTIONS` among them, are dropped.
pub const KEEP_ENV: &[&str] = &[
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "HOME",
    "TMPDIR",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "LANG",
    "LC_ALL",
    "TZ",
];
/// What the supervisor writes to the hub's L2 port, and expects back.
const PROBE: &[u8] = b"draftyak-health\n";
const POLL: Duration = Duration::from_millis(100);

/// Writes one frame in a single write.
pub fn write_frame(out: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame over MAX_FRAME"));
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    out.write_all(&frame)?;
    out.flush()
}

/// Reads one frame; `Ok(None)` when the stream ends between frames.
pub fn read_frame(input: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0; 4];
    let mut filled = 0;
    while filled < header.len() {
        match input.read(&mut header[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame over MAX_FRAME"));
    }
    let mut payload = vec![0; length];
    input.read_exact(&mut payload)?;
    Ok(Some(payload))
}

/// `bytes` random bytes as lowercase hex.
pub fn random_hex(bytes: usize) -> io::Result<String> {
    let mut buffer = vec![0; bytes];
    getrandom::fill(&mut buffer).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// The unlock frame's secrets, hex-encoded. Debug output never shows them.
#[derive(Clone, PartialEq, Eq)]
pub struct Secrets {
    pub master_key: String,
    pub bootstrap_secret: String,
}

impl Secrets {
    /// A random 32-byte master key and 16-byte bootstrap secret; the spike has no keychain yet.
    pub fn generate() -> io::Result<Secrets> {
        Ok(Secrets { master_key: random_hex(32)?, bootstrap_secret: random_hex(16)? })
    }
}

impl fmt::Debug for Secrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secrets { .. }")
    }
}

/// Frames the app writes to the hub's stdin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToHub {
    /// `{masterKey, bootstrapSecret}`; the supervisor sends it first on every spawn.
    Unlock(Secrets),
    /// `{power: "resumed"}` after an OS wake.
    Resumed,
    /// `{shutdown: true}`: stop claiming, drain and exit.
    Shutdown,
}

impl ToHub {
    pub fn encode(&self) -> Vec<u8> {
        let frame = match self {
            ToHub::Unlock(secrets) => json!({
                "masterKey": secrets.master_key,
                "bootstrapSecret": secrets.bootstrap_secret,
            }),
            ToHub::Resumed => json!({ "power": "resumed" }),
            ToHub::Shutdown => json!({ "shutdown": true }),
        };
        frame.to_string().into_bytes()
    }
}

/// Frames the hub writes to its stdout.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FromHub {
    /// `{ready: true, l2Port, hubId}`.
    Ready { l2_port: u16, hub_id: String },
    /// `{keepAwake: untilMs | null}`, in epoch milliseconds.
    KeepAwake { until_ms: Option<u64> },
}

impl FromHub {
    pub fn parse(payload: &[u8]) -> Result<FromHub, String> {
        let value: Value = serde_json::from_slice(payload).map_err(|error| error.to_string())?;
        let frame = value.as_object().ok_or("a frame is a JSON object")?;
        if frame.get("ready") == Some(&Value::Bool(true)) {
            let l2_port = frame.get("l2Port").and_then(Value::as_u64);
            let l2_port =
                l2_port.and_then(|port| u16::try_from(port).ok()).filter(|&port| port != 0);
            let hub_id = frame.get("hubId").and_then(Value::as_str).filter(|id| is_hub_id(id));
            return match (l2_port, hub_id) {
                (Some(l2_port), Some(hub_id)) => {
                    Ok(FromHub::Ready { l2_port, hub_id: hub_id.into() })
                }
                _ => Err("ready needs l2Port (1-65535) and hubId (DYK-XXXX-XXXX-XXXX-XXXX)".into()),
            };
        }
        match frame.get("keepAwake") {
            Some(Value::Null) => Ok(FromHub::KeepAwake { until_ms: None }),
            Some(until) => until
                .as_u64()
                .map(|until_ms| FromHub::KeepAwake { until_ms: Some(until_ms) })
                .ok_or_else(|| "keepAwake is epoch milliseconds or null".into()),
            None => Err("unknown frame".into()),
        }
    }
}

fn is_hub_id(id: &str) -> bool {
    let groups: Vec<&str> = id.split('-').collect();
    groups.len() == 5
        && groups[0] == "DYK"
        && groups[1..].iter().all(|group| {
            group.len() == 4
                && group.bytes().all(|byte| byte.is_ascii_digit() || byte.is_ascii_uppercase())
        })
}

/// Health checks, the ready deadline and the restart budget (plan §7 Supervision).
#[derive(Clone, Debug)]
pub struct Policy {
    pub health_every: Duration,
    pub health_timeout: Duration,
    pub unhealthy_after: u32,
    pub ready_within: Duration,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    pub max_restarts: usize,
    pub restart_window: Duration,
    /// A hub that ran this long before it ended restarts after `backoff_min` again.
    pub stable_after: Duration,
}

impl Default for Policy {
    fn default() -> Policy {
        Policy {
            health_every: Duration::from_secs(10),
            health_timeout: Duration::from_secs(2),
            unhealthy_after: 3,
            ready_within: Duration::from_secs(30),
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
            max_restarts: 5,
            restart_window: Duration::from_secs(300),
            stable_after: Duration::from_secs(60),
        }
    }
}

/// Exponential backoff from `backoff_min` to `backoff_max`, and at most `max_restarts` restarts
/// within any `restart_window`.
#[derive(Debug)]
pub struct Restarts {
    policy: Policy,
    consecutive: u32,
    recent: VecDeque<Instant>,
}

impl Restarts {
    pub fn new(policy: &Policy) -> Restarts {
        Restarts { policy: policy.clone(), consecutive: 0, recent: VecDeque::new() }
    }

    /// The delay before the next restart, or `None` once the budget is spent; `ran` is how long
    /// the hub that just ended had been running.
    pub fn next(&mut self, now: Instant, ran: Duration) -> Option<Duration> {
        let policy = &self.policy;
        if ran >= policy.stable_after {
            self.consecutive = 0;
        }
        while self.recent.front().is_some_and(|&at| now.duration_since(at) >= policy.restart_window)
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= policy.max_restarts {
            return None;
        }
        let factor = 1u32 << self.consecutive.min(16);
        let delay = policy.backoff_min.saturating_mul(factor).min(policy.backoff_max);
        self.consecutive += 1;
        self.recent.push_back(now);
        Some(delay)
    }
}

/// What the supervisor starts: `node --disable-sigusr1 hub`, with `env` added to [`KEEP_ENV`].
#[derive(Clone, Debug)]
pub struct Config {
    pub node: PathBuf,
    pub hub: PathBuf,
    pub env: Vec<(OsString, OsString)>,
    pub secrets: Secrets,
    pub policy: Policy,
}

impl Config {
    pub fn new(node: PathBuf, hub: PathBuf, secrets: Secrets) -> Config {
        Config { node, hub, env: Vec::new(), secrets, policy: Policy::default() }
    }
}

/// The external binary Tauri places beside the app's executable (`externalBin`, triple removed).
pub fn sibling_binary(name: &str) -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().ok_or_else(|| io::Error::other("the executable has no folder"))?;
    Ok(dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)))
}

/// How a hub was started and contained on Windows (zeros elsewhere): the creation flags, the job's
/// limit flags as the OS reports them back, and the threads resumed with the first one's previous
/// suspend count.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Containment {
    pub creation_flags: u32,
    pub job_limits: u32,
    pub resumed_threads: u32,
    pub suspend_count: u32,
}

/// What the supervisor reports, on its own thread.
#[derive(Clone, Debug)]
pub enum Event {
    /// First, with the policy in effect.
    Started {
        policy: Policy,
    },
    Spawned {
        generation: u32,
        pid: u32,
        containment: Containment,
    },
    /// `contained` lists the process ids in the hub's Job Object (Windows; empty elsewhere).
    Ready {
        generation: u32,
        pid: u32,
        l2_port: u16,
        hub_id: String,
        after: Duration,
        contained: Vec<u32>,
    },
    KeepAwake {
        generation: u32,
        until_ms: Option<u64>,
    },
    Log {
        generation: u32,
        line: String,
    },
    Unhealthy {
        generation: u32,
        reason: String,
    },
    Exited {
        generation: u32,
        pid: u32,
        code: Option<i32>,
    },
    Restarting {
        generation: u32,
        delay: Duration,
    },
    SpawnFailed {
        generation: u32,
        error: String,
    },
    GaveUp {
        restarts: usize,
    },
    Stopped,
}

impl Event {
    /// `{"event": "<kind>", ...}`, as the spike app prints it.
    pub fn to_json(&self) -> Value {
        let ms = |duration: &Duration| duration.as_millis() as u64;
        match self {
            Event::Started { policy } => json!({
                "event": "started",
                "healthEveryMs": ms(&policy.health_every),
                "healthTimeoutMs": ms(&policy.health_timeout),
                "unhealthyAfter": policy.unhealthy_after,
                "readyWithinMs": ms(&policy.ready_within),
                "backoffMinMs": ms(&policy.backoff_min),
                "backoffMaxMs": ms(&policy.backoff_max),
                "maxRestarts": policy.max_restarts,
                "restartWindowMs": ms(&policy.restart_window),
                "stableAfterMs": ms(&policy.stable_after),
            }),
            Event::Spawned { generation, pid, containment } => json!({
                "event": "spawned", "generation": generation, "pid": pid,
                "creationFlags": containment.creation_flags,
                "jobLimitFlags": containment.job_limits,
                "resumedThreads": containment.resumed_threads,
                "suspendCount": containment.suspend_count,
            }),
            Event::Ready { generation, pid, l2_port, hub_id, after, contained } => json!({
                "event": "ready", "generation": generation, "pid": pid, "l2Port": l2_port,
                "hubId": hub_id, "afterMs": ms(after), "contained": contained,
            }),
            Event::KeepAwake { generation, until_ms } => {
                json!({ "event": "keepAwake", "generation": generation, "untilMs": until_ms })
            }
            Event::Log { generation, line } => {
                json!({ "event": "log", "generation": generation, "line": line })
            }
            Event::Unhealthy { generation, reason } => {
                json!({ "event": "unhealthy", "generation": generation, "reason": reason })
            }
            Event::Exited { generation, pid, code } => {
                json!({ "event": "exited", "generation": generation, "pid": pid, "code": code })
            }
            Event::Restarting { generation, delay } => {
                json!({ "event": "restarting", "generation": generation, "delayMs": ms(delay) })
            }
            Event::SpawnFailed { generation, error } => {
                json!({ "event": "spawnFailed", "generation": generation, "error": error })
            }
            Event::GaveUp { restarts } => json!({ "event": "gaveUp", "restarts": restarts }),
            Event::Stopped => json!({ "event": "stopped" }),
        }
    }
}

enum Msg {
    Frame(u32, Vec<u8>),
    Broken(u32, String),
    Log(u32, String),
    Send(ToHub),
    Stop(Duration, Sender<()>),
}

/// Keeps the hub running until [`Supervisor::shutdown`] or drop.
pub struct Supervisor {
    tx: Sender<Msg>,
    thread: Option<JoinHandle<()>>,
}

impl Supervisor {
    /// Starts the hub; `on_event` runs on the supervisor thread, so it should return quickly.
    pub fn start(
        config: Config,
        on_event: impl FnMut(Event) + Send + 'static,
    ) -> io::Result<Supervisor> {
        let (tx, rx) = mpsc::channel();
        let readers = tx.clone();
        let thread = thread::Builder::new()
            .name("hub-supervisor".into())
            .spawn(move || supervise(&config, &readers, &rx, on_event))?;
        Ok(Supervisor { tx, thread: Some(thread) })
    }

    /// Queues a frame for the running hub; a frame sent while no hub runs is dropped.
    pub fn send(&self, frame: ToHub) {
        let _ = self.tx.send(Msg::Send(frame));
    }

    /// Sends [`ToHub::Shutdown`], closes the hub's stdin and waits up to `grace` for it to exit,
    /// then ends whatever is left and returns.
    pub fn shutdown(mut self, grace: Duration) {
        self.stop(grace);
    }

    fn stop(&mut self, grace: Duration) {
        let Some(thread) = self.thread.take() else {
            return;
        };
        let (done, stopped) = mpsc::channel();
        if self.tx.send(Msg::Stop(grace, done)).is_ok() {
            let _ = stopped.recv();
        }
        let _ = thread.join();
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop(STOP_GRACE);
    }
}

fn supervise(
    config: &Config,
    readers: &Sender<Msg>,
    rx: &Receiver<Msg>,
    mut emit: impl FnMut(Event),
) {
    emit(Event::Started { policy: config.policy.clone() });
    let mut restarts = Restarts::new(&config.policy);
    let mut generation = 0;
    let stopped = loop {
        generation += 1;
        let started = Instant::now();
        let stop = match Hub::spawn(config, generation, readers) {
            Ok(mut hub) => {
                emit(Event::Spawned { generation, pid: hub.pid, containment: hub.containment });
                let stop = watch(&config.policy, &mut hub, rx, &mut emit);
                let code = hub.end();
                emit(Event::Exited { generation, pid: hub.pid, code });
                stop
            }
            Err(error) => {
                emit(Event::SpawnFailed { generation, error: error.to_string() });
                None
            }
        };
        if stop.is_some() {
            break stop;
        }
        let Some(delay) = restarts.next(Instant::now(), started.elapsed()) else {
            emit(Event::GaveUp { restarts: config.policy.max_restarts });
            break None;
        };
        emit(Event::Restarting { generation: generation + 1, delay });
        if let Some(done) = pause(delay, rx, &mut emit) {
            break Some(done);
        }
    };
    if let Some(done) = stopped {
        emit(Event::Stopped);
        let _ = done.send(());
    }
}

fn unhealthy(emit: &mut impl FnMut(Event), generation: u32, reason: String) -> Option<Sender<()>> {
    emit(Event::Unhealthy { generation, reason });
    None
}

// Runs until the hub ends or has to be ended; `Some` when asked to stop.
fn watch(
    policy: &Policy,
    hub: &mut Hub,
    rx: &Receiver<Msg>,
    emit: &mut impl FnMut(Event),
) -> Option<Sender<()>> {
    let generation = hub.generation;
    let started = Instant::now();
    let mut port = None;
    let mut next_check = started;
    let mut failures = 0;
    loop {
        match rx.recv_timeout(POLL) {
            Ok(Msg::Frame(from, payload)) if from == generation => match FromHub::parse(&payload) {
                Ok(FromHub::Ready { l2_port, hub_id }) => {
                    port = Some(l2_port);
                    next_check = Instant::now() + policy.health_every;
                    let contained = hub.job.pids();
                    let after = started.elapsed();
                    emit(Event::Ready {
                        generation,
                        pid: hub.pid,
                        l2_port,
                        hub_id,
                        after,
                        contained,
                    });
                }
                Ok(FromHub::KeepAwake { until_ms }) => {
                    emit(Event::KeepAwake { generation, until_ms })
                }
                Err(error) => return unhealthy(emit, generation, format!("bad frame: {error}")),
            },
            Ok(Msg::Broken(from, error)) if from == generation => {
                return unhealthy(emit, generation, format!("bad stdout: {error}"));
            }
            Ok(Msg::Log(from, line)) => emit(Event::Log { generation: from, line }),
            Ok(Msg::Send(frame)) => {
                let _ = hub.write(&frame);
            }
            Ok(Msg::Stop(grace, done)) => {
                hub.stop(grace, rx, emit);
                return Some(done);
            }
            _ => {}
        }
        if hub.exited() {
            return None;
        }
        let now = Instant::now();
        match port {
            None if now.duration_since(started) >= policy.ready_within => {
                return unhealthy(emit, generation, "no ready frame".into());
            }
            Some(port) if now >= next_check => {
                failures = if healthy(port, policy.health_timeout) { 0 } else { failures + 1 };
                next_check = Instant::now() + policy.health_every;
                if failures >= policy.unhealthy_after {
                    return unhealthy(emit, generation, format!("{failures} failed health checks"));
                }
            }
            _ => {}
        }
    }
}

fn pause(delay: Duration, rx: &Receiver<Msg>, emit: &mut impl FnMut(Event)) -> Option<Sender<()>> {
    let deadline = Instant::now() + delay;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return None;
        }
        match rx.recv_timeout(left) {
            Ok(Msg::Stop(_, done)) => return Some(done),
            Ok(Msg::Log(generation, line)) => emit(Event::Log { generation, line }),
            Ok(_) => {}
            Err(_) => return None,
        }
    }
}

// Sends PROBE to the hub's L2 port and expects it back within `timeout`.
fn healthy(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let left = || match deadline.saturating_duration_since(Instant::now()) {
        left if left.is_zero() => Err(io::Error::from(io::ErrorKind::TimedOut)),
        left => Ok(left),
    };
    let probe = || -> io::Result<bool> {
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let mut stream = TcpStream::connect_timeout(&address, left()?)?;
        stream.set_write_timeout(Some(left()?))?;
        stream.write_all(PROBE)?;
        stream.set_read_timeout(Some(left()?))?;
        let mut reply = [0; PROBE.len()];
        stream.read_exact(&mut reply)?;
        Ok(reply == PROBE)
    };
    probe().unwrap_or(false)
}

// The app's variables that KEEP_ENV names.
fn kept_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os()
        .filter(|(name, _)| {
            let name = name.to_string_lossy();
            KEEP_ENV.iter().any(|kept| {
                if cfg!(windows) { kept.eq_ignore_ascii_case(&name) } else { *kept == name }
            })
        })
        .collect()
}

struct Hub {
    generation: u32,
    pid: u32,
    child: Child,
    stdin: Option<ChildStdin>,
    containment: Containment,
    job: job::Job,
}

impl Hub {
    fn spawn(config: &Config, generation: u32, tx: &Sender<Msg>) -> io::Result<Hub> {
        let mut command = Command::new(&config.node);
        command
            .arg("--disable-sigusr1")
            .arg(&config.hub)
            .env_clear()
            .envs(kept_env())
            .envs(config.env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = config.hub.parent() {
            command.current_dir(dir);
        }
        let (mut child, job, containment) = job::Job::spawn(&mut command)?;
        let pid = child.id();
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let stdin = child.stdin.take();
        let frames = tx.clone();
        thread::spawn(move || read_frames(generation, stdout, &frames));
        let logs = tx.clone();
        thread::spawn(move || read_logs(generation, stderr, &logs));
        let mut hub = Hub { generation, pid, child, stdin, containment, job };
        if let Err(error) = hub.write(&ToHub::Unlock(config.secrets.clone())) {
            hub.end();
            return Err(error);
        }
        Ok(hub)
    }

    fn write(&mut self, frame: &ToHub) -> io::Result<()> {
        let stdin = self.stdin.as_mut().ok_or(io::ErrorKind::BrokenPipe)?;
        write_frame(stdin, &frame.encode())
    }

    fn exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    fn stop(&mut self, grace: Duration, rx: &Receiver<Msg>, emit: &mut impl FnMut(Event)) {
        let _ = self.write(&ToHub::Shutdown);
        self.stdin = None;
        let deadline = Instant::now() + grace;
        while !self.exited() && Instant::now() < deadline {
            if let Ok(Msg::Log(generation, line)) = rx.recv_timeout(POLL) {
                emit(Event::Log { generation, line });
            }
        }
    }

    // Ends the hub and everything it started; returns its exit code.
    fn end(&mut self) -> Option<i32> {
        self.stdin = None;
        let _ = self.job.terminate();
        self.child.wait().ok().and_then(|status| status.code())
    }
}

fn read_frames(generation: u32, stdout: impl Read, tx: &Sender<Msg>) {
    let mut reader = BufReader::new(stdout);
    loop {
        let message = match read_frame(&mut reader) {
            Ok(Some(payload)) => Msg::Frame(generation, payload),
            Ok(None) => return,
            Err(error) => Msg::Broken(generation, error.to_string()),
        };
        let broken = matches!(message, Msg::Broken(..));
        if tx.send(message).is_err() || broken {
            return;
        }
    }
}

fn read_logs(generation: u32, stderr: impl Read, tx: &Sender<Msg>) {
    let mut reader = BufReader::new(stderr);
    let mut line = Vec::new();
    while matches!(reader.read_until(b'\n', &mut line), Ok(read) if read > 0) {
        let text = String::from_utf8_lossy(&line).trim_end().to_owned();
        line.clear();
        if tx.send(Msg::Log(generation, text)).is_err() {
            return;
        }
    }
}

/// What contains the hub and everything it starts.
#[cfg(windows)]
pub mod job {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};
    use std::ptr;

    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_MORE_DATA, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOBOBJECTINFOCLASS, JobObjectBasicProcessIdList,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
    };
    use windows_sys::core::BOOL;

    use super::Containment;

    /// No console window opens for the hub; Windows then gives each console process in the job
    /// its own conhost.exe, which is in the job too.
    pub const CREATION_FLAGS: u32 = CREATE_SUSPENDED | CREATE_NO_WINDOW;

    struct Owned(HANDLE);

    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    fn check(ok: BOOL) -> io::Result<()> {
        if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }

    /// A kill-on-close Job Object without breakaway: closing its handle, as dropping the `Job` or
    /// the app process dying does, ends every process in it.
    pub struct Job(Owned);

    impl Job {
        /// Spawns `command` suspended and without a console window, assigns it to a new job, then
        /// resumes it.
        pub fn spawn(command: &mut Command) -> io::Result<(Child, Job, Containment)> {
            command.creation_flags(CREATION_FLAGS);
            let job = Job::new()?;
            let mut child = command.spawn()?;
            let contained =
                check(unsafe { AssignProcessToJobObject(job.0.0, child.as_raw_handle()) })
                    .and_then(|()| job.limits())
                    .and_then(|job_limits| {
                        let (resumed_threads, suspend_count) = resume(child.id())?;
                        Ok(Containment {
                            creation_flags: CREATION_FLAGS,
                            job_limits,
                            resumed_threads,
                            suspend_count,
                        })
                    });
            match contained {
                Ok(containment) => Ok((child, job, containment)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    Err(error)
                }
            }
        }

        fn new() -> io::Result<Job> {
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Job(Owned(handle));
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = size_of_val(&limits) as u32;
            let info = (&raw const limits).cast();
            check(unsafe {
                SetInformationJobObject(handle, JobObjectExtendedLimitInformation, info, size)
            })?;
            Ok(job)
        }

        fn query<T>(&self, class: JOBOBJECTINFOCLASS, info: &mut T) -> BOOL {
            let size = size_of::<T>() as u32;
            let info = (info as *mut T).cast();
            unsafe { QueryInformationJobObject(self.0.0, class, info, size, ptr::null_mut()) }
        }

        /// The ids of the processes in the job (at most 64).
        pub fn pids(&self) -> Vec<u32> {
            #[repr(C)]
            struct List {
                _assigned: u32,
                listed: u32,
                ids: [usize; 64],
            }
            let mut list = List { _assigned: 0, listed: 0, ids: [0; 64] };
            let more = || io::Error::last_os_error().raw_os_error() == Some(ERROR_MORE_DATA as i32);
            if self.query(JobObjectBasicProcessIdList, &mut list) == 0 && !more() {
                return Vec::new();
            }
            list.ids.iter().take(list.listed as usize).map(|&id| id as u32).collect()
        }

        /// The job's limit flags, read back from the OS.
        pub fn limits(&self) -> io::Result<u32> {
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            check(self.query(JobObjectExtendedLimitInformation, &mut limits))?;
            Ok(limits.BasicLimitInformation.LimitFlags)
        }

        /// Ends every process in the job.
        pub fn terminate(&self) -> io::Result<()> {
            check(unsafe { TerminateJobObject(self.0.0, 1) })
        }
    }

    // Resumes the threads of `pid` and returns how many, with the first one's previous suspend
    // count. One ResumeThread on the primary thread's handle replaces this walk once Rust exposes
    // that handle on stable.
    fn resume(pid: u32) -> io::Result<(u32, u32)> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = Owned(snapshot);
        let size = size_of::<THREADENTRY32>() as u32;
        let mut entry = THREADENTRY32 { dwSize: size, ..Default::default() };
        let (mut threads, mut first_count) = (0, 0);
        let mut more = unsafe { Thread32First(snapshot.0, &mut entry) } != 0;
        while more {
            if entry.th32OwnerProcessID == pid {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let thread = Owned(thread);
                let previous = unsafe { ResumeThread(thread.0) };
                if previous == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                if threads == 0 {
                    first_count = previous;
                }
                threads += 1;
            }
            entry.dwSize = size;
            more = unsafe { Thread32Next(snapshot.0, &mut entry) } != 0;
        }
        if threads == 0 {
            return Err(io::Error::other("the suspended hub has no thread to resume"));
        }
        Ok((threads, first_count))
    }
}

/// What contains the hub and everything it starts.
#[cfg(unix)]
pub mod job {
    use std::io;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command};

    use super::Containment;

    /// Nothing to pass here.
    pub const CREATION_FLAGS: u32 = 0;

    /// No Job Object here: the hub leads its own process group, which [`Job::terminate`] kills,
    /// plugins included. Nothing ends the group when the app dies; the hub ends its plugins on
    /// stdin EOF.
    pub struct Job {
        group: libc::pid_t,
    }

    impl Job {
        /// Spawns `command` as the leader of a new process group.
        pub fn spawn(command: &mut Command) -> io::Result<(Child, Job, Containment)> {
            command.process_group(0);
            let child = command.spawn()?;
            let group = child.id() as libc::pid_t;
            Ok((child, Job { group }, Containment::default()))
        }

        /// Empty: listing a process group needs `ps`, so tests follow the pids the hub reports.
        pub fn pids(&self) -> Vec<u32> {
            Vec::new()
        }

        /// No limits without a Job Object.
        pub fn limits(&self) -> io::Result<u32> {
            Ok(0)
        }

        /// Kills every process left in the hub's group.
        pub fn terminate(&self) -> io::Result<()> {
            if unsafe { libc::kill(-self.group, libc::SIGKILL) } == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }
    }
}
