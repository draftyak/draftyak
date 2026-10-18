// Linux: src/power.rs's logind layer against a fake logind on a private D-Bus daemon, which stands
// in for the system bus through DBUS_SYSTEM_BUS_ADDRESS. It covers what the app's spike control
// can't reach: the Inhibit call's arguments, that a release closes the descriptor logind watches,
// one resume for each PrepareForSleep(true) and (false) pair through the real signal stream, and
// a refusal reported under its D-Bus error name. Needs dbus-daemon (CI's runners, the s05 image).
#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader, ErrorKind, Read};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{env, fs};

use draftyak_spike_desktop::power::{self, HOLDER, Power, REASON, Report};
use serde_json::json;
use zbus::blocking::connection;
use zbus::zvariant::OwnedFd;

const WAIT: Duration = Duration::from_secs(10);
const PATH: &str = "/org/freedesktop/login1";
const MANAGER: &str = "org.freedesktop.login1.Manager";

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

fn skip_or_fail(reason: &str) {
    if env::var("DRAFTYAK_STRICT_SKIPS").as_deref() == Ok("1") {
        panic!("cannot run: {reason} (DRAFTYAK_STRICT_SKIPS=1 turns this skip into a failure)");
    }
    eprintln!("skipped: {reason}");
}

/// What logind's Manager does for the layer: Inhibit hands out one end of a socket pair and keeps
/// the other, as logind keeps a FIFO's, so a closed descriptor shows; it refuses as polkit would
/// while `refuse` is set.
#[derive(Default)]
struct Logind {
    calls: Arc<Mutex<Vec<[String; 4]>>>,
    kept: Arc<Mutex<Vec<UnixStream>>>,
    refuse: Arc<AtomicBool>,
}

#[zbus::interface(name = "org.freedesktop.login1.Manager")]
impl Logind {
    fn inhibit(
        &self,
        what: String,
        who: String,
        why: String,
        mode: String,
    ) -> zbus::fdo::Result<OwnedFd> {
        self.calls.lock().unwrap().push([what, who, why, mode]);
        if self.refuse.load(Ordering::SeqCst) {
            return Err(zbus::fdo::Error::AccessDenied("Permission denied".into()));
        }
        let (kept, handed) =
            UnixStream::pair().map_err(|error| zbus::fdo::Error::IOError(error.to_string()))?;
        self.kept.lock().unwrap().push(kept);
        Ok(std::os::fd::OwnedFd::from(handed).into())
    }

    #[zbus(property)]
    fn preparing_for_sleep(&self) -> bool {
        false
    }
}

/// dbus-daemon with its session configuration, which lets any client own any name.
struct Bus {
    daemon: Child,
    dir: PathBuf,
    address: String,
}

impl Bus {
    fn start() -> Option<Bus> {
        let dir = env::temp_dir().join(format!("dy-s05-logind-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let listen = format!("--address=unix:path={}", dir.join("bus").display());
        let spawned = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1", &listen])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn();
        let mut daemon = match spawned {
            Ok(daemon) => daemon,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let _ = fs::remove_dir_all(&dir);
                skip_or_fail("no dbus-daemon on PATH");
                return None;
            }
            Err(error) => panic!("dbus-daemon: {error}"),
        };
        let mut address = String::new();
        let stdout = daemon.stdout.take().expect("piped");
        BufReader::new(stdout).read_line(&mut address).unwrap();
        let address = address.trim().to_string();
        assert!(address.starts_with("unix:"), "dbus-daemon printed {address:?}");
        Some(Bus { daemon, dir, address })
    }
}

impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn next(reports: &Receiver<Report>) -> Report {
    reports.recv_timeout(WAIT).expect("no power report")
}

fn quiet(reports: &Receiver<Report>) {
    if let Ok(report) = reports.recv_timeout(Duration::from_millis(800)) {
        panic!("unexpected report {report:?}");
    }
}

#[test]
fn the_logind_layer_holds_releases_resumes_and_reports_refusals_through_the_bus() {
    let Some(bus) = Bus::start() else { return };
    // SAFETY: the only test in this binary, and no thread of its own or of zbus's runs yet.
    unsafe { env::set_var("DBUS_SYSTEM_BUS_ADDRESS", &bus.address) };
    let logind = Logind::default();
    let (calls, kept, refuse) = (logind.calls.clone(), logind.kept.clone(), logind.refuse.clone());
    let server = connection::Builder::address(bus.address.as_str())
        .and_then(|builder| builder.serve_at(PATH, logind))
        .and_then(|builder| builder.name("org.freedesktop.login1"))
        .and_then(|builder| builder.build())
        .expect("the fake logind on the private bus");

    let (tx, reports) = mpsc::channel();
    let power = Power::start(power::native(), move |report| {
        let _ = tx.send(report);
    })
    .unwrap();
    let Report::Listening { detail } = next(&reports) else { panic!("no resume listener") };
    let listener = (&detail["registered"], &detail["preparingForSleep"]);
    assert_eq!(listener, (&json!(true), &json!(false)));

    let handle = power.handle();
    handle.keep_awake(1, Some(now_ms() + 60_000));
    let held = next(&reports);
    assert!(matches!(held, Report::Held { generation: 1, .. }), "{held:?}");
    let asked = ["idle", HOLDER, REASON, "block"].map(String::from);
    assert_eq!(*calls.lock().unwrap(), [asked]);
    let mut watched = kept.lock().unwrap().pop().expect("logind's end of the inhibitor");
    watched.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
    let open = watched.read(&mut [0; 1]).unwrap_err().kind();
    assert!(matches!(open, ErrorKind::WouldBlock | ErrorKind::TimedOut), "{open:?}");
    handle.keep_awake(1, None);
    assert_eq!(next(&reports), Report::Released { why: "null frame" });
    watched.set_read_timeout(Some(WAIT)).unwrap();
    let read = watched.read(&mut [0; 1]).unwrap();
    assert_eq!(read, 0, "the released inhibitor's descriptor is closed");

    for start in [true, false] {
        server.emit_signal(None::<&str>, PATH, MANAGER, "PrepareForSleep", &start).unwrap();
    }
    let via = "PrepareForSleep(false)";
    assert_eq!(next(&reports), Report::Resumed { via, forwarded: false });
    quiet(&reports);

    refuse.store(true, Ordering::SeqCst);
    handle.keep_awake(2, Some(now_ms() + 60_000));
    let Report::Refused { error, .. } = next(&reports) else { panic!("logind's refusal") };
    assert!(error.starts_with("org.freedesktop.DBus.Error.AccessDenied: "), "{error}");
    assert_eq!(power.status()["refusals"], 1);
    power.stop();
    drop(server);
}
