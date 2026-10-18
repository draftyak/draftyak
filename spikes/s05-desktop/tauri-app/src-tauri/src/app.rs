//! The spike app: one supervised hub, a tray with Open and Quit, the main window (created on Open),
//! the approval window ([`crate::shell`], [`crate::approval`]), and keep-awake and resume
//! ([`crate::power`]). It prints every supervisor [`Event`](crate::sidecar::Event) and power
//! [`Report`](crate::power::Report) as one JSON line on stdout for the tests, as does the
//! spike-only test control ([`crate::control`]); the hub's stderr arrives as log events.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, RunEvent};

use crate::power::{self, Layer, LogindRefuses, Power};
use crate::sidecar::{self, Config, STOP_GRACE, Secrets, Supervisor, ToHub};
use crate::{approval, control, shell};

/// The hub's store folder, passed to the hub.
const DATA_DIR: &str = "DRAFTYAK_DATA_DIR";
/// Spike-only switches the app passes on to the hub.
const SPIKE_HOOKS: &str = "DRAFTYAK_SPIKE_";
/// Spike-only: `logind-refuses` puts the mocked layer that refuses every hold in place of the OS's.
const POWER_HOOK: &str = "DRAFTYAK_SPIKE_POWER";

struct Hub {
    supervisor: Mutex<Option<Supervisor>>,
    store: Store,
}

/// The spike's master key is new on every launch, so its store is too: `DRAFTYAK_DATA_DIR` if it
/// holds no store yet, else a new folder under the OS temp folder that the app removes when it
/// exits (a killed app leaves it behind). The windows keep their WebView data in it as well, which
/// is why Quit destroys them before exiting ([`shell::on_menu`]).
struct Store {
    dir: PathBuf,
    temporary: bool,
}

impl Store {
    fn for_launch() -> io::Result<Store> {
        if let Some(dir) = std::env::var_os(DATA_DIR).map(PathBuf::from) {
            if dir.join("hub.db").exists() {
                return Err(io::Error::other(format!(
                    "{DATA_DIR} holds a store from an earlier launch, whose master key is gone; \
                     give each launch an empty folder"
                )));
            }
            fs::create_dir_all(&dir)?;
            return Ok(Store { dir, temporary: false });
        }
        let dir = std::env::temp_dir()
            .join(format!("draftyak-spike-desktop-{}", sidecar::random_hex(8)?));
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut fs::DirBuilder::new(), 0o700).create(&dir)?;
        #[cfg(not(unix))]
        fs::create_dir(&dir)?;
        Ok(Store { dir, temporary: true })
    }
}

/// Where a window keeps its WebView data: inside this launch's store, never under the user's
/// application data (Tauri's default on Windows and Linux).
pub fn webview_data(app: &AppHandle, label: &str) -> PathBuf {
    app.state::<Hub>().store.dir.join("webview").join(label)
}

pub fn run() {
    let context = tauri::generate_context!();
    let autostart = shell::autostart_plugin(&context.config().identifier);
    let app = tauri::Builder::default()
        .plugin(autostart)
        .register_uri_scheme_protocol(approval::SCHEME, approval::serve)
        .invoke_handler(tauri::generate_handler![approval::approval_ready])
        .manage(approval::Log::default())
        .setup(|app| {
            let node = sidecar::sibling_binary("draftyak-node")?;
            let hub = app.path().resolve("resources/hub.mjs", BaseDirectory::Resource)?;
            let mut config = Config::new(node, hub, Secrets::generate()?);
            config.env.extend(
                std::env::vars_os()
                    .filter(|(name, _)| name.to_string_lossy().starts_with(SPIKE_HOOKS)),
            );
            let store = Store::for_launch()?;
            config.env.push((DATA_DIR.into(), store.dir.clone().into()));
            let layer: Box<dyn Layer> = match std::env::var(POWER_HOOK).as_deref() {
                Ok("logind-refuses") => Box::new(LogindRefuses::default()),
                Ok(other) => return Err(format!("{POWER_HOOK} {other:?} isn't known").into()),
                Err(_) => power::native(),
            };
            let power = Power::start(layer, |report| emit(&report.to_json()))?;
            let keep_awake = power.handle();
            let supervisor = Supervisor::start(config, move |event| {
                keep_awake.follow(&event);
                emit(&event.to_json());
            })?;
            let frames = supervisor.frames();
            power.connect(move || frames.send(ToHub::Resumed));
            app.manage(power);
            app.manage(Hub { supervisor: Mutex::new(Some(supervisor)), store });
            shell::tray(app.handle())?;
            if std::env::args().any(|arg| arg == control::FLAG) {
                control::start(app.handle().clone())?;
            }
            Ok(())
        })
        .build(context)
        .expect("the spike app failed to start");
    app.run(|app, event| match event {
        // Closing the last window keeps the app, and with it the hub, running (plan §7 Tray);
        // only Quit, through app.exit, ends both.
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        RunEvent::Exit => {
            let hub = app.state::<Hub>();
            let supervisor = hub.supervisor.lock().ok().and_then(|mut slot| slot.take());
            if let Some(supervisor) = supervisor {
                supervisor.shutdown(STOP_GRACE);
            }
            // After the hub, whose exit already ended any hold it had asked for.
            app.state::<Power>().stop();
            if hub.store.temporary {
                remove_store(&hub.store.dir);
            }
        }
        _ => {}
    });
}

// WebView2's processes hold files in the store for a moment after their webviews are destroyed.
fn remove_store(dir: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while fs::remove_dir_all(dir).is_err() && dir.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Prints one JSON line on stdout.
pub fn emit(value: &Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}
