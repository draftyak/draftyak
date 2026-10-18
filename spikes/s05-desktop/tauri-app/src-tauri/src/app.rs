//! The spike app: no window and one supervised hub. It prints every supervisor [`Event`] as one
//! JSON line on stdout for the tests; the hub's stderr arrives as log events.

use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::path::BaseDirectory;
use tauri::{Manager, RunEvent};

use crate::sidecar::{self, Config, Event, STOP_GRACE, Secrets, Supervisor};

/// The hub's store folder, passed to the hub.
const DATA_DIR: &str = "DRAFTYAK_DATA_DIR";
/// Spike-only switches the app passes on to the hub.
const SPIKE_HOOKS: &str = "DRAFTYAK_SPIKE_";

struct Hub {
    supervisor: Mutex<Option<Supervisor>>,
    store: Store,
}

/// The spike's master key is new on every launch, so its store is too: `DRAFTYAK_DATA_DIR` if it
/// holds no store yet, else a new folder under the OS temp folder that the app removes when it
/// exits (a killed app leaves it behind).
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

pub fn run() {
    let app = tauri::Builder::default()
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
            let supervisor = Supervisor::start(config, print)?;
            app.manage(Hub { supervisor: Mutex::new(Some(supervisor)), store });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the spike app failed to start");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            let hub = app.state::<Hub>();
            let supervisor = hub.supervisor.lock().ok().and_then(|mut slot| slot.take());
            if let Some(supervisor) = supervisor {
                supervisor.shutdown(STOP_GRACE);
            }
            if hub.store.temporary {
                let _ = fs::remove_dir_all(&hub.store.dir);
            }
        }
    });
}

fn print(event: Event) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{}", event.to_json());
    let _ = out.flush();
}
