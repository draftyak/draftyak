// Keep-awake and resume (src/power.rs): the controller over mocked layers, logind's refusal
// included; the app's wiring between the supervisor, the stub hub's keepAwake frames and the
// resumed frame; and this OS's own layer. The wiring tests need the staged draftyak-node and
// resources (scripts/stage-sidecar.ts). These tests need no Tauri: `cargo test --no-default-features`.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{env, fs, thread};

use draftyak_spike_desktop::power::{
    self, Layer, LogindRefuses, Power, Report, Wake, resumed_by_broadcast, resumed_by_logind,
};
use draftyak_spike_desktop::sidecar::{Config, Event, Policy, Secrets, Supervisor, ToHub};
use serde_json::{Value, json};

const WAIT: Duration = Duration::from_secs(10);
/// Windows execution state bits, as SystemExecutionState reports them for the whole machine.
const ES_SYSTEM_REQUIRED: u64 = 0x1;
const ES_DISPLAY_REQUIRED: u64 = 0x2;
/// logind's refusals by its policy (polkit), the only refusals accepted where a system bus exists.
const POLICY_REFUSALS: [&str; 2] = [
    "org.freedesktop.DBus.Error.AccessDenied",
    "org.freedesktop.DBus.Error.InteractiveAuthorizationRequired",
];

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

fn skip_or_fail(reason: &str) {
    if env::var("DRAFTYAK_STRICT_SKIPS").as_deref() == Ok("1") {
        panic!("cannot run: {reason} (DRAFTYAK_STRICT_SKIPS=1 turns this skip into a failure)");
    }
    eprintln!("skipped: {reason}");
}

/// A mocked layer that grants or refuses every hold and records what it was asked to do.
struct Mock {
    refuse: bool,
    calls: Arc<Mutex<Vec<&'static str>>>,
    wake: Option<Wake>,
}

impl Layer for Mock {
    fn method(&self) -> &'static str {
        "mock"
    }

    fn hold(&mut self) -> Result<(), String> {
        self.calls.lock().unwrap().push("hold");
        if self.refuse { Err("refused by the mock".into()) } else { Ok(()) }
    }

    fn release(&mut self) -> Result<(), String> {
        self.calls.lock().unwrap().push("release");
        Ok(())
    }

    fn listen(&mut self, wake: Wake) -> Result<Value, String> {
        self.wake = Some(wake);
        Ok(json!({ "via": "mock", "registered": true }))
    }

    fn simulate_wake(&mut self) -> Result<Vec<&'static str>, String> {
        (self.wake.as_ref().ok_or("no listener")?)("mock");
        Ok(vec!["mock"])
    }
}

fn mock(refuse: bool) -> (Box<dyn Layer>, Arc<Mutex<Vec<&'static str>>>) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    (Box::new(Mock { refuse, calls: calls.clone(), wake: None }), calls)
}

fn start(layer: Box<dyn Layer>) -> (Power, Receiver<Report>) {
    let (tx, rx) = mpsc::channel();
    let power = Power::start(layer, move |report| {
        let _ = tx.send(report);
    })
    .unwrap();
    (power, rx)
}

fn next(reports: &Receiver<Report>) -> Report {
    reports.recv_timeout(WAIT).expect("no power report")
}

fn quiet(reports: &Receiver<Report>) {
    if let Ok(report) = reports.recv_timeout(Duration::from_millis(300)) {
        panic!("unexpected report {report:?}");
    }
}

#[test]
fn reports_have_the_spike_shapes() {
    let held = Report::Held { generation: 2, until_ms: 5, method: "mock" };
    assert_eq!(
        held.to_json(),
        json!({ "event": "power", "action": "held", "generation": 2, "untilMs": 5, "method": "mock" })
    );
    let refused = Report::Refused { generation: 1, method: "m", error: "e".into() };
    assert_eq!(refused.to_json()["action"], "refused");
    let released = Report::Released { why: "null frame" }.to_json();
    assert_eq!(released, json!({ "event": "power", "action": "released", "why": "null frame" }));
    let resumed = Report::Resumed { via: "PBT_APMRESUMEAUTOMATIC", forwarded: true }.to_json();
    assert_eq!((&resumed["action"], &resumed["forwarded"]), (&json!("resumed"), &json!(true)));
}

#[test]
fn only_the_resume_codes_count_as_a_wake() {
    assert_eq!(resumed_by_broadcast(0x12), Some("PBT_APMRESUMEAUTOMATIC"));
    for other in [0x4, 0x7, 0xA, 0x8013] {
        assert_eq!(resumed_by_broadcast(other), None, "{other:#x}");
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND,
        };
        assert!(resumed_by_broadcast(PBT_APMRESUMEAUTOMATIC).is_some());
        assert!(resumed_by_broadcast(PBT_APMRESUMESUSPEND).is_none());
        assert!(resumed_by_broadcast(PBT_APMSUSPEND).is_none());
    }
    assert_eq!(resumed_by_logind(false), Some("PrepareForSleep(false)"));
    assert_eq!(resumed_by_logind(true), None);
}

#[test]
fn a_keep_awake_frame_holds_until_null_and_a_new_until_extends_it() {
    let (layer, calls) = mock(false);
    let (power, reports) = start(layer);
    assert!(matches!(next(&reports), Report::Listening { .. }));
    let handle = power.handle();
    let until = now_ms() + 60_000;
    handle.keep_awake(1, Some(until));
    assert_eq!(next(&reports), Report::Held { generation: 1, until_ms: until, method: "mock" });
    handle.keep_awake(1, Some(until + 1));
    assert_eq!(next(&reports), Report::Extended { generation: 1, until_ms: until + 1 });
    let status = power.status();
    assert_eq!((&status["held"], &status["holds"]), (&json!(true), &json!(1)));
    assert_eq!(status["untilMs"], json!(until + 1));
    handle.keep_awake(1, None);
    assert_eq!(next(&reports), Report::Released { why: "null frame" });
    handle.keep_awake(1, None);
    quiet(&reports);
    let status = power.status();
    assert_eq!((&status["held"], &status["releases"]), (&json!(false), &json!(1)));
    assert_eq!(*calls.lock().unwrap(), ["hold", "release"]);
}

#[test]
fn the_hold_ends_at_until_ms_with_the_hub_that_asked_and_on_stop() {
    let (layer, calls) = mock(false);
    let (power, reports) = start(layer);
    next(&reports);
    let handle = power.handle();
    handle.keep_awake(1, Some(now_ms() + 2_500));
    assert!(matches!(next(&reports), Report::Held { generation: 1, .. }));
    assert_eq!(next(&reports), Report::Released { why: "deadline" });
    handle.keep_awake(2, Some(now_ms().saturating_sub(1)));
    quiet(&reports);

    handle.follow(&Event::KeepAwake { generation: 2, until_ms: Some(now_ms() + 60_000) });
    assert!(matches!(next(&reports), Report::Held { generation: 2, .. }));
    handle.follow(&Event::Exited { generation: 1, pid: 1, code: Some(1) });
    quiet(&reports);
    handle.follow(&Event::Exited { generation: 2, pid: 2, code: Some(1) });
    assert_eq!(next(&reports), Report::Released { why: "hub exited" });

    handle.keep_awake(3, Some(now_ms() + 60_000));
    assert!(matches!(next(&reports), Report::Held { generation: 3, .. }));
    power.stop();
    assert_eq!(next(&reports), Report::Released { why: "shutdown" });
    assert_eq!(power.status(), Value::Null, "the controller ended");
    assert_eq!(calls.lock().unwrap().len(), 6);
}

#[test]
fn a_refused_inhibitor_is_logged_and_keep_awake_keeps_running() {
    let (power, reports) = start(Box::new(LogindRefuses::default()));
    let Report::Listening { detail } = next(&reports) else { panic!("no listener") };
    assert_eq!(detail["registered"], true);
    let handle = power.handle();
    for attempt in 1..=2 {
        handle.keep_awake(1, Some(now_ms() + 60_000));
        assert_eq!(
            next(&reports),
            Report::Refused {
                generation: 1,
                method: "logind Inhibit(idle, block), mocked",
                error: LogindRefuses::REFUSAL.into(),
            },
            "attempt {attempt}"
        );
    }
    handle.keep_awake(1, None);
    quiet(&reports);
    let status = power.status();
    assert_eq!((&status["held"], &status["refusals"]), (&json!(false), &json!(2)));
    assert_eq!(status["lastRefusal"], LogindRefuses::REFUSAL);

    let (resumed_tx, resumed) = mpsc::channel();
    assert_eq!(power.simulate_wake().unwrap(), ["PrepareForSleep(true)", "PrepareForSleep(false)"]);
    let via = "PrepareForSleep(false)";
    assert_eq!(next(&reports), Report::Resumed { via, forwarded: false });
    power.connect(move || resumed_tx.send(()).unwrap());
    power.simulate_wake().unwrap();
    assert_eq!(next(&reports), Report::Resumed { via, forwarded: true });
    resumed.recv_timeout(WAIT).unwrap();
    assert_eq!(power.status()["resumes"], 2);
}

#[test]
fn a_refused_hold_is_tried_again_by_the_next_frame() {
    let (layer, calls) = mock(true);
    let (power, reports) = start(layer);
    next(&reports);
    power.handle().keep_awake(1, Some(now_ms() + 60_000));
    assert!(matches!(next(&reports), Report::Refused { generation: 1, .. }));
    power.handle().keep_awake(1, Some(now_ms() + 60_000));
    assert!(matches!(next(&reports), Report::Refused { .. }));
    assert_eq!(*calls.lock().unwrap(), ["hold", "hold"]);
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

// The stub hub with its keep-awake hook, wired to `power` as the app wires them; the events, and
// the folder to remove.
fn wired(power: &Power, name: &str) -> (Supervisor, Receiver<Event>, PathBuf) {
    let data = env::temp_dir().join(format!("dy-s05-power-{name}-{}", std::process::id()));
    fs::create_dir_all(&data).unwrap();
    let env: Vec<(OsString, OsString)> = vec![
        ("DRAFTYAK_DATA_DIR".into(), data.clone().into()),
        ("DRAFTYAK_SPIKE_KEEP_AWAKE".into(), "1".into()),
    ];
    let hub = src_tauri().join("resources").join("hub.mjs");
    let secrets = Secrets { master_key: "11".repeat(32), bootstrap_secret: "22".repeat(16) };
    let policy = Policy { health_every: Duration::from_millis(200), ..Policy::default() };
    let config = Config { node: node(), hub, env, secrets, policy };
    let (tx, events) = mpsc::channel();
    let keep_awake = power.handle();
    let supervisor = Supervisor::start(config, move |event| {
        keep_awake.follow(&event);
        let _ = tx.send(event);
    })
    .unwrap();
    let frames = supervisor.frames();
    power.connect(move || frames.send(ToHub::Resumed));
    (supervisor, events, data)
}

fn wait(events: &Receiver<Event>, seen: &mut Vec<Event>, wanted: impl Fn(&Event) -> bool) -> Event {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(event) = seen.iter().find(|&event| wanted(event)) {
            return event.clone();
        }
        let left = deadline.saturating_duration_since(Instant::now());
        let event = events.recv_timeout(left).unwrap_or_else(|_| panic!("saw {seen:?}"));
        seen.push(event);
    }
}

// What the stub hub's L2 port answers to `line`.
fn ask(port: u16, line: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(WAIT)).unwrap();
    stream.write_all(line.as_bytes()).unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    answer
}

fn remove(dir: &PathBuf) {
    for _ in 0..50 {
        if fs::remove_dir_all(dir).is_ok() || !dir.exists() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn the_hubs_frames_drive_keep_awake_and_a_wake_reaches_the_hub() {
    let (layer, _) = mock(false);
    let (power, reports) = start(layer);
    next(&reports);
    let (supervisor, events, data) = wired(&power, "wired");
    let mut seen = Vec::new();
    let Event::Ready { l2_port, pid, .. } =
        wait(&events, &mut seen, |e| matches!(e, Event::Ready { generation: 1, .. }))
    else {
        unreachable!()
    };
    let until = now_ms() + 60_000;
    assert_eq!(ask(l2_port, &format!("keep-awake {until}\n")), "ok\n");
    assert_eq!(next(&reports), Report::Held { generation: 1, until_ms: until, method: "mock" });
    assert_eq!(ask(l2_port, "keep-awake null\n"), "ok\n");
    assert_eq!(next(&reports), Report::Released { why: "null frame" });
    assert_eq!(ask(l2_port, "draftyak-health\n"), "draftyak-health\n");

    power.simulate_wake().unwrap();
    assert_eq!(next(&reports), Report::Resumed { via: "mock", forwarded: true });
    let resumed =
        |e: &Event| matches!(e, Event::Log { generation: 1, line } if line == "hub: resumed");
    wait(&events, &mut seen, resumed);

    // A hub that dies holding keep-awake can't keep the system awake.
    assert_eq!(ask(l2_port, &format!("keep-awake {until}\n")), "ok\n");
    assert!(matches!(next(&reports), Report::Held { generation: 1, .. }));
    let pid = pid.to_string();
    let (program, args): (&str, &[&str]) =
        if cfg!(windows) { ("taskkill", &["/F", "/PID", &pid]) } else { ("kill", &["-9", &pid]) };
    let killed = std::process::Command::new(program).args(args).output().unwrap();
    assert!(killed.status.success(), "{killed:?}");
    assert_eq!(next(&reports), Report::Released { why: "hub exited" });
    wait(&events, &mut seen, |e| matches!(e, Event::Ready { generation: 2, .. }));
    supervisor.shutdown(Duration::from_secs(10));
    remove(&data);
}

#[test]
fn with_logind_refusing_the_hub_keeps_running_and_still_hears_of_a_wake() {
    let (power, reports) = start(Box::new(LogindRefuses::default()));
    next(&reports);
    let (supervisor, events, data) = wired(&power, "refused");
    let mut seen = Vec::new();
    let Event::Ready { l2_port, .. } =
        wait(&events, &mut seen, |e| matches!(e, Event::Ready { generation: 1, .. }))
    else {
        unreachable!()
    };
    for _ in 0..2 {
        assert_eq!(ask(l2_port, &format!("keep-awake {}\n", now_ms() + 60_000)), "ok\n");
        assert!(matches!(next(&reports), Report::Refused { generation: 1, .. }));
    }
    // Several health checks later the hub is still the first one, and answers.
    thread::sleep(Duration::from_secs(1));
    assert_eq!(ask(l2_port, "draftyak-health\n"), "draftyak-health\n");
    power.simulate_wake().unwrap();
    assert!(matches!(next(&reports), Report::Resumed { forwarded: true, .. }));
    let resumed = |e: &Event| matches!(e, Event::Log { line, .. } if line == "hub: resumed");
    wait(&events, &mut seen, resumed);
    supervisor.shutdown(Duration::from_secs(10));
    seen.extend(events.try_iter());
    let ended = seen.iter().filter(|e| matches!(e, Event::Unhealthy { .. } | Event::Exited { .. }));
    assert_eq!(ended.count(), 1, "only the shutdown's exit: {seen:?}");
    assert!(seen.iter().any(|e| matches!(e, Event::Exited { generation: 1, code: Some(0), .. })));
    remove(&data);
}

// Windows shows keep-awake only for the whole machine (SystemExecutionState): wait until no other
// process holds ES_SYSTEM_REQUIRED, so the state can show this hold; None if one never lets go.
fn clear_baseline(power: &Power) -> Option<Value> {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let observed = power.status()["observed"].clone();
        if observed["systemRequired"] == false {
            return Some(observed);
        }
        if Instant::now() > deadline {
            skip_or_fail(&format!(
                "machine-busy: another process holds ES_SYSTEM_REQUIRED ({observed}), and \
                 Windows shows keep-awake only for the whole machine"
            ));
            return None;
        }
        thread::sleep(Duration::from_millis(500));
    }
}

// This OS's layer: Windows and macOS must hold and register, and so must Linux where a system bus
// exists, unless logind's policy refuses the inhibitor; without a system bus (containers), the
// listener and the hold fail, and that is reported, never fatal.
#[test]
fn this_os_layer_registers_for_resumes_and_holds_or_reports_why_not() {
    let (power, reports) = start(power::native());
    let listening = next(&reports);
    let registered =
        matches!(&listening, Report::Listening { detail } if detail["registered"] == true);
    let system_bus = cfg!(target_os = "linux")
        && (env::var_os("DBUS_SYSTEM_BUS_ADDRESS").is_some()
            || Path::new("/run/dbus/system_bus_socket").exists());
    if cfg!(any(windows, target_os = "macos")) || system_bus {
        assert!(registered, "{listening:?}");
    }
    let before = if cfg!(windows) { clear_baseline(&power) } else { Some(Value::Null) };
    if let Some(before) = before {
        let handle = power.handle();
        handle.keep_awake(1, Some(now_ms() + 60_000));
        let held = match next(&reports) {
            Report::Held { .. } => true,
            Report::Refused { error, .. } if cfg!(target_os = "linux") => {
                let by_policy = POLICY_REFUSALS.iter().any(|name| {
                    error.strip_prefix(name).is_some_and(|rest| rest.starts_with(": "))
                });
                assert!(by_policy || !system_bus, "logind refused for another reason: {error}");
                eprintln!("keep-awake refused here: {error}");
                false
            }
            other => panic!("{other:?}"),
        };
        if held {
            let during = power.status();
            assert_eq!(during["held"], true);
            if cfg!(windows) {
                let state = |observed: &Value| observed["systemExecutionState"].as_u64();
                let (was, now) = (state(&before).unwrap(), state(&during["observed"]).unwrap());
                assert_eq!(now & ES_SYSTEM_REQUIRED, ES_SYSTEM_REQUIRED, "{during}");
                assert_eq!(now & ES_DISPLAY_REQUIRED, was & ES_DISPLAY_REQUIRED, "{during}");
            }
            handle.keep_awake(1, None);
            assert_eq!(next(&reports), Report::Released { why: "null frame" });
            if cfg!(windows) {
                assert_eq!(power.status()["observed"]["systemRequired"], false);
            }
        }
    }
    if registered {
        let sent = power.simulate_wake().unwrap();
        assert!(!sent.is_empty());
        let via = match next(&reports) {
            Report::Resumed { via, forwarded: false } => via,
            other => panic!("{other:?}"),
        };
        let expected = if cfg!(windows) {
            "PBT_APMRESUMEAUTOMATIC"
        } else if cfg!(target_os = "macos") {
            "NSWorkspaceDidWakeNotification"
        } else {
            "PrepareForSleep(false)"
        };
        assert_eq!(via, expected);
        quiet(&reports);
    }
}
