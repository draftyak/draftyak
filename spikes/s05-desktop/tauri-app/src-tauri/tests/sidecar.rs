// The frame codec, the restart policy, the Job Object and the supervisor against real processes:
// the staged draftyak-node (run scripts/stage-sidecar.ts first) with the stub hub or small
// stand-in scripts. The stub hub always starts a plugin that ignores stdin EOF and its IPC channel
// closing, so only a kill ends it. These tests need no Tauri: `cargo test --no-default-features`.

use std::ffi::OsString;
use std::io::{self, Cursor};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};
use std::{env, fs, thread};

use draftyak_spike_desktop::sidecar::{
    Config, Containment, Event, FromHub, KEEP_ENV, MAX_FRAME, Policy, Restarts, Secrets,
    Supervisor, ToHub, read_frame, write_frame,
};
use serde_json::{Value, json};

fn secrets() -> Secrets {
    Secrets { master_key: "11".repeat(32), bootstrap_secret: "22".repeat(16) }
}

#[test]
fn frames_round_trip_and_bad_lengths_fail() {
    let mut pipe = Vec::new();
    write_frame(&mut pipe, br#"{"a":1}"#).unwrap();
    write_frame(&mut pipe, b"").unwrap();
    assert_eq!(&pipe[..4], &7u32.to_be_bytes());
    let mut input = Cursor::new(pipe);
    assert_eq!(read_frame(&mut input).unwrap().unwrap(), br#"{"a":1}"#);
    assert_eq!(read_frame(&mut input).unwrap().unwrap(), b"");
    assert!(read_frame(&mut input).unwrap().is_none());

    let too_big = vec![b' '; MAX_FRAME + 1];
    assert_eq!(
        write_frame(&mut Vec::new(), &too_big).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    let header = ((MAX_FRAME + 1) as u32).to_be_bytes();
    let error = read_frame(&mut Cursor::new(header.to_vec())).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    for truncated in [vec![0, 0], vec![0, 0, 0, 5, b'{']] {
        let error = read_frame(&mut Cursor::new(truncated)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }
}

#[test]
fn app_frames_have_the_plan_shapes() {
    let json = |frame: ToHub| serde_json::from_slice::<Value>(&frame.encode()).unwrap();
    assert_eq!(
        json(ToHub::Unlock(secrets())),
        json!({ "masterKey": "11".repeat(32), "bootstrapSecret": "22".repeat(16) })
    );
    assert_eq!(json(ToHub::Resumed), json!({ "power": "resumed" }));
    assert_eq!(json(ToHub::Shutdown), json!({ "shutdown": true }));
    let shown = format!("{:?} {:?}", secrets(), ToHub::Unlock(secrets()));
    assert!(!shown.contains("1111") && !shown.contains("2222"), "{shown}");
}

#[test]
fn hub_frames_parse_strictly() {
    let ready = br#"{"ready":true,"l2Port":47614,"hubId":"DYK-AB12-CD34-EF56-7890"}"#;
    let hub_id = "DYK-AB12-CD34-EF56-7890".to_string();
    assert_eq!(FromHub::parse(ready), Ok(FromHub::Ready { l2_port: 47614, hub_id }));
    let until = Some(1_800_000_000_000);
    assert_eq!(
        FromHub::parse(br#"{"keepAwake":1800000000000}"#),
        Ok(FromHub::KeepAwake { until_ms: until })
    );
    assert_eq!(FromHub::parse(br#"{"keepAwake":null}"#), Ok(FromHub::KeepAwake { until_ms: None }));
    for bad in [
        &br#"{"ready":true,"l2Port":0,"hubId":"DYK-AB12-CD34-EF56-7890"}"#[..],
        br#"{"ready":true,"l2Port":70000,"hubId":"DYK-AB12-CD34-EF56-7890"}"#,
        br#"{"ready":true,"l2Port":47614,"hubId":"DYK-ab12-CD34-EF56-7890"}"#,
        br#"{"ready":true,"l2Port":47614}"#,
        br#"{"keepAwake":"soon"}"#,
        br#"{"keepAwake":-1}"#,
        br#"{"ready":false}"#,
        br#"{}"#,
        br#"[]"#,
        b"not json",
    ] {
        assert!(FromHub::parse(bad).is_err(), "{}", String::from_utf8_lossy(bad));
    }
}

#[test]
fn policy_defaults_follow_the_plan() {
    let policy = Policy::default();
    let seconds = |duration: Duration| duration.as_secs();
    assert_eq!(seconds(policy.health_every), 10);
    assert_eq!((seconds(policy.backoff_min), seconds(policy.backoff_max)), (1, 60));
    assert_eq!((policy.max_restarts, seconds(policy.restart_window)), (5, 300));
    let started = Event::Started { policy }.to_json();
    assert_eq!(
        (started["healthEveryMs"].as_u64(), started["maxRestarts"].as_u64()),
        (Some(10_000), Some(5))
    );
}

#[test]
fn backoff_doubles_up_to_the_cap_within_the_budget() {
    let policy = Policy::default();
    let mut restarts = Restarts::new(&policy);
    let start = Instant::now();
    let delays: Vec<u64> = (0..5)
        .map(|i| restarts.next(start + Duration::from_secs(i), Duration::ZERO).unwrap().as_secs())
        .collect();
    assert_eq!(delays, [1, 2, 4, 8, 16]);
    assert_eq!(restarts.next(start + Duration::from_secs(10), Duration::ZERO), None);
    let after_window = restarts.next(start + Duration::from_secs(301), Duration::ZERO).unwrap();
    assert_eq!(after_window, Duration::from_secs(32));

    let mut spread = Restarts::new(&policy);
    let mut at = start;
    let mut last = Duration::ZERO;
    for _ in 0..9 {
        at += Duration::from_secs(120);
        last = spread.next(at, Duration::from_secs(30)).unwrap();
    }
    assert_eq!(last, Duration::from_secs(60));
    let stable = spread.next(at + Duration::from_secs(120), Duration::from_secs(60)).unwrap();
    assert_eq!(stable, Duration::from_secs(1));
}

fn src_tauri() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn node() -> PathBuf {
    let triple = env!("DRAFTYAK_TARGET_TRIPLE");
    let name = format!("draftyak-node-{triple}{}", env::consts::EXE_SUFFIX);
    let node = src_tauri().join("binaries").join(name);
    assert!(node.is_file(), "{} is missing: run scripts/stage-sidecar.ts", node.display());
    node
}

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        let dir = env::temp_dir().join(format!("dy-s05-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    fn script(&self, name: &str, source: &str) -> PathBuf {
        let file = self.0.join(name);
        fs::write(&file, source).unwrap();
        file
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        for _ in 0..50 {
            if fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}

// The supervisor's events, kept so a test can look back at them.
struct Events {
    rx: Receiver<Event>,
    seen: Vec<Event>,
}

impl Events {
    fn wait(&mut self, within: Duration, mut wanted: impl FnMut(&Event) -> bool) -> Event {
        if let Some(event) = self.seen.iter().find(|&event| wanted(event)) {
            return event.clone();
        }
        let deadline = Instant::now() + within;
        loop {
            match self.rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(event) => {
                    self.seen.push(event.clone());
                    if wanted(&event) {
                        return event;
                    }
                }
                Err(_) => panic!("no such event within {within:?}; saw:\n{}", self.shown()),
            }
        }
    }

    // The JSON of a generation's "hub: report" log line.
    fn report(&mut self, generation: u32) -> Value {
        let event = self.wait(Duration::from_secs(30), |event| {
            matches!(event, Event::Log { generation: g, line } if *g == generation && line.starts_with("hub: report "))
        });
        let Event::Log { line, .. } = event else { unreachable!() };
        serde_json::from_str(&line["hub: report ".len()..]).unwrap()
    }

    fn drain(&mut self) -> &[Event] {
        self.seen.extend(self.rx.try_iter());
        &self.seen
    }

    fn shown(&self) -> String {
        self.seen.iter().map(|event| event.to_json().to_string()).collect::<Vec<_>>().join("\n")
    }
}

fn start(hub: &Path, env: Vec<(OsString, OsString)>, policy: Policy) -> (Supervisor, Events) {
    let (tx, rx) = mpsc::channel();
    let config = Config { node: node(), hub: hub.to_path_buf(), env, secrets: secrets(), policy };
    let supervisor = Supervisor::start(config, move |event| {
        let _ = tx.send(event);
    })
    .unwrap();
    (supervisor, Events { rx, seen: Vec::new() })
}

// Running and not a zombie.
fn alive(pid: u32) -> bool {
    let pid = pid.to_string();
    if cfg!(windows) {
        let filter = format!("PID eq {pid}");
        let out =
            Command::new("tasklist").args(["/FI", &filter, "/FO", "CSV", "/NH"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .any(|row| row.split("\",\"").nth(1) == Some(pid.as_str()))
    } else {
        let out = Command::new("ps").args(["-o", "stat=", "-p", &pid]).output().unwrap();
        let state = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        !state.is_empty() && !state.starts_with('Z')
    }
}

fn kill(pid: u32) -> bool {
    let pid = pid.to_string();
    let killed = if cfg!(windows) {
        Command::new("taskkill").args(["/F", "/PID", &pid]).output().map(|out| out.status)
    } else {
        Command::new("kill").args(["-9", &pid]).status()
    };
    killed.is_ok_and(|status| status.success())
}

// Fails if any of the pids still runs after `within`, killing them first: a survivor would hold
// the test's output pipes open and stall cargo test.
fn assert_gone(pids: &[u32], within: Duration) {
    let deadline = Instant::now() + within;
    while pids.iter().any(|&pid| alive(pid)) {
        if Instant::now() >= deadline {
            let left: Vec<u32> = pids.iter().copied().filter(|&pid| alive(pid)).collect();
            for &pid in &left {
                kill(pid);
            }
            panic!("still running after {within:?}: {left:?}");
        }
        thread::sleep(Duration::from_millis(100));
    }
}

const PLUGIN: &str = r#"process.send({ execArgv: process.execArgv });
process.on("disconnect", () => {});
process.stdin.on("data", () => {});
process.stdin.on("end", () => {});
setInterval(() => {}, 60_000);
setTimeout(() => process.exit(3), 600_000);
"#;

// The stub hub with a new store folder and a plugin that only a kill ends.
fn stub_hub(scratch: &Scratch) -> (PathBuf, Vec<(OsString, OsString)>) {
    let resources = src_tauri().join("resources");
    let wrapper = resources.join("sqlite3mc").join("lib").join("index.js");
    assert!(wrapper.is_file(), "{} is missing: run scripts/stage-sidecar.ts", wrapper.display());
    let data = scratch.0.join("data");
    let plugin = scratch.0.join("plugin");
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&plugin).unwrap();
    let entry = plugin.join("plugin.mjs");
    fs::write(&entry, PLUGIN).unwrap();
    let argv = json!(["--permission", format!("--allow-fs-read={}", plugin.display()), entry]);
    let env = vec![
        ("DRAFTYAK_DATA_DIR".into(), data.into()),
        ("DRAFTYAK_SPIKE_PLUGIN_ARGV".into(), argv.to_string().into()),
    ];
    (resources.join("hub.mjs"), env)
}

fn plugin_pid(report: &Value) -> u32 {
    let pid = report["plugin"]["pid"].as_u64().unwrap_or_else(|| panic!("no plugin: {report}"));
    u32::try_from(pid).unwrap()
}

#[cfg(windows)]
fn expected_containment() -> Containment {
    use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
    Containment {
        creation_flags: CREATE_SUSPENDED | CREATE_NO_WINDOW,
        job_limits: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        resumed_threads: 1,
        suspend_count: 1,
    }
}

#[cfg(not(windows))]
fn expected_containment() -> Containment {
    Containment::default()
}

fn ready(event: &Event, generation: u32) -> bool {
    matches!(event, Event::Ready { generation: g, .. } if *g == generation)
}

#[test]
fn the_hub_unlocks_reports_ready_passes_health_checks_and_exits_on_shutdown() {
    let scratch = Scratch::new("ready");
    let (hub, env) = stub_hub(&scratch);
    let policy = Policy { health_every: Duration::from_millis(100), ..Policy::default() };
    let (supervisor, mut events) = start(&hub, env, policy);
    let Event::Started { policy } =
        events.wait(Duration::from_secs(5), |e| matches!(e, Event::Started { .. }))
    else {
        unreachable!()
    };
    assert_eq!(policy.health_every, Duration::from_millis(100));
    let Event::Spawned { pid, containment, .. } =
        events.wait(Duration::from_secs(30), |e| matches!(e, Event::Spawned { .. }))
    else {
        unreachable!()
    };
    assert_eq!(containment, expected_containment());
    let Event::Ready { l2_port, hub_id, contained, .. } =
        events.wait(Duration::from_secs(60), |e| ready(e, 1))
    else {
        unreachable!()
    };
    assert!(l2_port > 0 && hub_id.starts_with("DYK-"));
    let report = events.report(1);
    let plugin = plugin_pid(&report);
    assert!(alive(plugin));
    if cfg!(windows) {
        assert!(contained.contains(&pid) && contained.contains(&plugin), "{contained:?}");
    }
    thread::sleep(Duration::from_secs(1));
    supervisor.send(ToHub::Resumed);
    events.wait(
        Duration::from_secs(10),
        |e| matches!(e, Event::Log { line, .. } if line == "hub: resumed"),
    );
    supervisor.shutdown(Duration::from_secs(10));
    let events = events.drain();
    assert!(!events.iter().any(|e| matches!(e, Event::Unhealthy { .. })), "{events:?}");
    assert!(events.iter().any(|e| matches!(e, Event::Exited { code: Some(0), .. })), "{events:?}");
    assert!(matches!(events.last(), Some(Event::Stopped)), "{events:?}");
    assert_gone(&[pid, plugin], Duration::from_secs(5));
    assert_gone(&contained, Duration::from_secs(5));
}

#[test]
fn a_killed_hub_restarts_with_its_identity_and_its_plugin_ends() {
    let scratch = Scratch::new("restart");
    let (hub, env) = stub_hub(&scratch);
    let (supervisor, mut events) = start(&hub, env, Policy::default());
    let Event::Ready { pid, hub_id, contained, .. } =
        events.wait(Duration::from_secs(60), |e| ready(e, 1))
    else {
        unreachable!()
    };
    let first_plugin = plugin_pid(&events.report(1));
    if cfg!(windows) {
        assert!(contained.len() >= 4, "hub and plugin with their console hosts: {contained:?}");
    }
    let killed = Instant::now();
    assert!(kill(pid), "couldn't kill the hub");
    events.wait(Duration::from_secs(10), |e| matches!(e, Event::Exited { generation: 1, .. }));
    let Event::Restarting { delay, .. } =
        events.wait(Duration::from_secs(10), |e| matches!(e, Event::Restarting { .. }))
    else {
        unreachable!()
    };
    assert_eq!(delay, Duration::from_secs(1));
    let Event::Ready { pid: second, hub_id: again, .. } =
        events.wait(Duration::from_secs(60), |e| ready(e, 2))
    else {
        unreachable!()
    };
    assert!(killed.elapsed() < Duration::from_secs(60));
    assert_eq!(again, hub_id);
    assert_gone(&[first_plugin], Duration::from_secs(5));
    assert_gone(&contained, Duration::from_secs(5));
    let second_plugin = plugin_pid(&events.report(2));
    assert!(alive(second_plugin));
    supervisor.shutdown(Duration::from_secs(10));
    assert_gone(&[second, second_plugin], Duration::from_secs(5));
}

const READY: &str = r#"
const frame = (value) => {
	const body = Buffer.from(JSON.stringify(value));
	const head = Buffer.alloc(4);
	head.writeUInt32BE(body.length);
	process.stdout.write(Buffer.concat([head, body]));
};
const echo = (socket) => socket.once("data", (probe) => socket.end(probe));
"#;

#[test]
fn the_hub_gets_only_the_kept_environment() {
    let scratch = Scratch::new("env");
    let script = format!(
        r#"{READY}
import inspector from "node:inspector";
import net from "node:net";
const seen = {{ env: Object.keys(process.env), nodeOptions: process.env.NODE_OPTIONS ?? null, inspector: inspector.url() ?? null }};
process.stderr.write(`env ${{JSON.stringify(seen)}}\n`);
const l2 = net.createServer(echo);
l2.listen(0, "127.0.0.1", () => frame({{ ready: true, l2Port: l2.address().port, hubId: "DYK-0000-0000-0000-0004" }}));
process.stdin.on("data", () => {{}});
process.stdin.on("end", () => process.exit(0));
"#
    );
    let hub = scratch.script("env.mjs", &script);
    let extra = vec![("DRAFTYAK_TEST_EXTRA".into(), "1".into())];
    let (supervisor, mut events) = start(&hub, extra, Policy::default());
    let event = events.wait(
        Duration::from_secs(30),
        |e| matches!(e, Event::Log { line, .. } if line.starts_with("env ")),
    );
    let Event::Log { line, .. } = event else { unreachable!() };
    let seen: Value = serde_json::from_str(&line["env ".len()..]).unwrap();
    let names: Vec<&str> =
        seen["env"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    let kept = |name: &str| {
        KEEP_ENV
            .iter()
            .any(|kept| if cfg!(windows) { kept.eq_ignore_ascii_case(name) } else { *kept == name })
    };
    assert!(names.contains(&"DRAFTYAK_TEST_EXTRA"), "{names:?}");
    assert!(names.iter().all(|name| *name == "DRAFTYAK_TEST_EXTRA" || kept(name)), "{names:?}");
    if cfg!(windows) {
        assert!(names.iter().any(|name| name.eq_ignore_ascii_case("SystemRoot")), "{names:?}");
    }
    assert_eq!((&seen["nodeOptions"], &seen["inspector"]), (&Value::Null, &Value::Null));
    supervisor.shutdown(Duration::from_secs(5));
}

#[test]
fn a_hung_hub_fails_its_health_checks_and_is_restarted() {
    let scratch = Scratch::new("hung");
    let script = format!(
        r#"{READY}
import net from "node:net";
const l2 = net.createServer(echo);
l2.listen(0, "127.0.0.1", () => {{
	frame({{ ready: true, l2Port: l2.address().port, hubId: "DYK-0000-0000-0000-0003" }});
	setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000), 2000);
}});
"#
    );
    let hub = scratch.script("hung.mjs", &script);
    let policy = Policy {
        health_every: Duration::from_millis(200),
        health_timeout: Duration::from_millis(300),
        unhealthy_after: 2,
        backoff_min: Duration::from_millis(50),
        ..Policy::default()
    };
    let (supervisor, mut events) = start(&hub, Vec::new(), policy);
    let Event::Ready { pid, .. } = events.wait(Duration::from_secs(30), |e| ready(e, 1)) else {
        unreachable!()
    };
    let ready_at = Instant::now();
    let event = events.wait(Duration::from_secs(30), |e| matches!(e, Event::Unhealthy { .. }));
    assert!(
        matches!(event, Event::Unhealthy { generation: 1, ref reason } if reason == "2 failed health checks"),
        "{event:?}"
    );
    assert!(ready_at.elapsed() >= Duration::from_millis(1800), "probes failed before the hub hung");
    events.wait(Duration::from_secs(30), |e| matches!(e, Event::Restarting { generation: 2, .. }));
    assert_gone(&[pid], Duration::from_secs(5));
    supervisor.shutdown(Duration::from_secs(1));
}

#[test]
fn a_hub_without_ready_is_restarted_then_given_up() {
    let scratch = Scratch::new("silent");
    let hub = scratch.script("silent.mjs", "setInterval(() => {}, 60000);\n");
    let policy = Policy {
        ready_within: Duration::from_millis(800),
        backoff_min: Duration::from_millis(50),
        max_restarts: 2,
        ..Policy::default()
    };
    let (supervisor, mut events) = start(&hub, Vec::new(), policy);
    for generation in 1..=3 {
        let event = events.wait(
            Duration::from_secs(30),
            |e| matches!(e, Event::Unhealthy { generation: g, .. } if *g == generation),
        );
        assert!(
            matches!(event, Event::Unhealthy { ref reason, .. } if reason == "no ready frame"),
            "{event:?}"
        );
    }
    events.wait(Duration::from_secs(30), |e| matches!(e, Event::GaveUp { restarts: 2 }));
    supervisor.shutdown(Duration::from_secs(1));
}

#[test]
fn failed_health_checks_restart_the_hub() {
    let scratch = Scratch::new("health");
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let script = format!(
        "{READY}\nframe({{ ready: true, l2Port: {closed}, hubId: \"DYK-0000-0000-0000-0002\" }});\nsetInterval(() => {{}}, 60000);\n"
    );
    let hub = scratch.script("deaf.mjs", &script);
    let policy = Policy {
        health_every: Duration::from_millis(200),
        health_timeout: Duration::from_millis(200),
        unhealthy_after: 2,
        backoff_min: Duration::from_millis(50),
        ..Policy::default()
    };
    let (supervisor, mut events) = start(&hub, Vec::new(), policy);
    let event = events.wait(Duration::from_secs(30), |e| matches!(e, Event::Unhealthy { .. }));
    assert!(
        matches!(event, Event::Unhealthy { generation: 1, ref reason } if reason == "2 failed health checks")
    );
    events.wait(Duration::from_secs(30), |e| matches!(e, Event::Restarting { generation: 2, .. }));
    supervisor.shutdown(Duration::from_secs(1));
}

#[test]
fn stray_stdout_ends_the_hub() {
    let scratch = Scratch::new("stray");
    let hub = scratch.script(
        "chatty.mjs",
        "process.stdout.write('not a frame');\nsetInterval(() => {}, 60000);\n",
    );
    let (supervisor, mut events) = start(
        &hub,
        Vec::new(),
        Policy { backoff_min: Duration::from_millis(50), ..Policy::default() },
    );
    let event = events.wait(Duration::from_secs(30), |e| matches!(e, Event::Unhealthy { .. }));
    assert!(
        matches!(event, Event::Unhealthy { generation: 1, ref reason } if reason.starts_with("bad stdout")),
        "{event:?}"
    );
    supervisor.shutdown(Duration::from_secs(1));
}

// Windows only: the Job Object itself.
#[cfg(windows)]
mod windows {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    use draftyak_spike_desktop::sidecar::job;

    use super::*;

    #[test]
    fn closing_the_job_ends_what_ignores_stdin_detached_children_included() {
        let scratch = Scratch::new("close");
        let script = scratch.script(
            "stubborn.mjs",
            r#"import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { detached: true, stdio: "ignore" });
process.stdin.on("data", () => {});
process.stdin.on("end", () => {});
process.stdout.write(`${child.pid}\n`);
setTimeout(() => process.exit(3), 120000);
"#,
        );
        let mut command = Command::new(node());
        command
            .arg(&script)
            .env_clear()
            .env("SystemRoot", env::var_os("SystemRoot").unwrap())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        let (mut child, job, _) = job::Job::spawn(&mut command).unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let detached: u32 = line.trim().parse().unwrap();
        let pids = job.pids();
        assert!(pids.contains(&child.id()) && pids.contains(&detached), "{pids:?}");
        drop(job);
        assert_gone(&[child.id(), detached], Duration::from_secs(5));
        child.wait().unwrap();
    }

    #[test]
    fn the_job_ends_children_that_ignore_stdin() {
        let scratch = Scratch::new("job");
        let script = format!(
            r#"{READY}
import {{ spawn }} from "node:child_process";
import net from "node:net";
spawn(process.execPath, ["-e", "setTimeout(() => {{}}, 120000)"], {{ detached: true, stdio: "ignore" }});
process.stdin.on("data", () => {{}});
process.stdin.on("end", () => {{}});
const l2 = net.createServer(echo);
l2.listen(0, "127.0.0.1", () => frame({{ ready: true, l2Port: l2.address().port, hubId: "DYK-0000-0000-0000-0001" }}));
setTimeout(() => process.exit(3), 120000);
"#
        );
        let hub = scratch.script("stubborn.mjs", &script);
        let (supervisor, mut events) = start(&hub, Vec::new(), Policy::default());
        let Event::Ready { pid, contained, .. } =
            events.wait(Duration::from_secs(60), |e| ready(e, 1))
        else {
            unreachable!()
        };
        assert!(
            contained.contains(&pid) && contained.len() >= 3,
            "hub, console host, child: {contained:?}"
        );
        supervisor.shutdown(Duration::from_millis(500));
        let events = events.drain();
        assert!(
            events.iter().any(|e| matches!(e, Event::Exited { code: Some(1), .. })),
            "{events:?}"
        );
        assert_gone(&contained, Duration::from_secs(5));
    }
}
