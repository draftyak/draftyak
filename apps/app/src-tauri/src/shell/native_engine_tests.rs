// Proposed private child module of shell.rs. Not installed or compiled.
use super::{Mode, ShellState, configure, open_main};
use crate::window_security;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, Context, Manager, WebviewWindow, Wry, utils::config::AppDirectoriesOverride,
};

// Native evaluation observes the actual SPA. It does not mount or replace the SPA.
const DOM_SNAPSHOT: &str = r#"(() => {
  const radios = [...document.querySelectorAll('input[name="hub-mode"]')];
  const fieldset = document.querySelector('fieldset');
  const save = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('Save choice'));
  const status = document.querySelector('.selection-status')?.textContent || '';
  return {
    mounted: document.getElementById('root')?.childElementCount > 0 && radios.length === 2 && !!save,
    enabled: !!fieldset && !fieldset.disabled,
    noAlert: !document.querySelector('[role="alert"]'),
    initialReadReady: status.includes('You can change this choice.'),
    hubChecked: !!radios.find(x => x.value === 'hub')?.checked,
    connectChecked: !!radios.find(x => x.value === 'connect')?.checked,
    saveEnabled: !!save && !save.disabled,
    hubSaved: status.includes('This computer') && status.includes('Saved for this session'),
    connectSaved: status.includes('Connect to a hub') && status.includes('Saved for this session')
  };
})()"#;

fn native_mode(handle: &AppHandle<Wry>) -> Result<Option<Mode>, &'static str> {
    let state = handle
        .try_state::<ShellState>()
        .ok_or("NATIVE_STATE_MISSING")?;
    let snapshot = state.0.lock().map_err(|_| "NATIVE_STATE_LOCK")?;
    Ok(snapshot.mode)
}

fn remaining(deadline: Instant) -> Result<Duration, &'static str> {
    deadline
        .checked_duration_since(Instant::now())
        .ok_or("NATIVE_SMOKE_DEADLINE")
}

fn evaluate(
    window: &WebviewWindow<Wry>,
    script: &str,
    deadline: Instant,
) -> Result<Value, &'static str> {
    let (tx, rx) = mpsc::sync_channel(1);
    window
        .eval_with_callback(script, move |json| {
            let _ = tx.send(json);
        })
        .map_err(|_| "NATIVE_EVAL_SCHEDULE")?;
    let serialized = rx
        .recv_timeout(remaining(deadline)?)
        .map_err(|_| "NATIVE_EVAL_RESULT")?;
    serde_json::from_str(&serialized).map_err(|_| "NATIVE_EVAL_JSON")
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}

fn wait_dom(
    window: &WebviewWindow<Wry>,
    deadline: Instant,
    predicate: impl Fn(&Value) -> bool,
) -> Result<(), &'static str> {
    loop {
        remaining(deadline)?;
        let snapshot = evaluate(window, DOM_SNAPSHOT, deadline)?;
        if predicate(&snapshot) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn click(
    window: &WebviewWindow<Wry>,
    selector: &str,
    deadline: Instant,
) -> Result<(), &'static str> {
    // Selectors are private fixed test constants, not renderer-supplied arguments.
    let selector = serde_json::to_string(selector).map_err(|_| "NATIVE_SELECTOR")?;
    let script = format!(
        "(() => {{ const element=document.querySelector({selector}); if(!element || element.disabled) return false; element.click(); return true; }})()"
    );
    if evaluate(window, &script, deadline)? != Value::Bool(true) {
        return Err("NATIVE_CLICK_TARGET");
    }
    Ok(())
}

fn save(window: &WebviewWindow<Wry>, deadline: Instant) -> Result<(), &'static str> {
    let script = r#"(() => { const button=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('Save choice')); if(!button || button.disabled) return false; button.click(); return true; })()"#;
    if evaluate(window, script, deadline)? != Value::Bool(true) {
        return Err("NATIVE_SAVE_TARGET");
    }
    Ok(())
}

fn drive_modes(
    handle: &AppHandle<Wry>,
    loaded: &AtomicBool,
    deadline: Instant,
) -> Result<(), &'static str> {
    while !loaded.load(Ordering::Acquire) {
        remaining(deadline)?;
        thread::sleep(Duration::from_millis(50));
    }
    let main = handle
        .get_webview_window(window_security::MAIN_LABEL)
        .ok_or("NATIVE_MAIN_MISSING")?;
    wait_dom(&main, deadline, |v| {
        flag(v, "mounted")
            && flag(v, "enabled")
            && flag(v, "noAlert")
            && flag(v, "initialReadReady")
            && !flag(v, "hubChecked")
            && !flag(v, "connectChecked")
            && !flag(v, "saveEnabled")
    })?;
    if native_mode(handle)? != None {
        return Err("NATIVE_INITIAL_MODE");
    }

    click(&main, r#"input[name="hub-mode"][value="hub"]"#, deadline)?;
    wait_dom(&main, deadline, |v| {
        flag(v, "hubChecked") && flag(v, "saveEnabled") && flag(v, "noAlert")
    })?;
    save(&main, deadline)?;
    wait_dom(&main, deadline, |v| {
        flag(v, "hubSaved") && !flag(v, "saveEnabled") && flag(v, "noAlert")
    })?;
    if native_mode(handle)? != Some(Mode::Hub) {
        return Err("NATIVE_HUB_ACK");
    }

    click(
        &main,
        r#"input[name="hub-mode"][value="connect"]"#,
        deadline,
    )?;
    wait_dom(&main, deadline, |v| {
        flag(v, "connectChecked") && flag(v, "saveEnabled") && flag(v, "noAlert")
    })?;
    save(&main, deadline)?;
    wait_dom(&main, deadline, |v| {
        flag(v, "connectSaved") && !flag(v, "saveEnabled") && flag(v, "noAlert")
    })?;
    if native_mode(handle)? != Some(Mode::Connect) {
        return Err("NATIVE_CONNECT_ACK");
    }
    Ok(())
}

#[test]
#[ignore = "requires coordinated Windows native engine session and isolated compiled test profile"]
fn windows_engine_mounts_spa_and_roundtrips_existing_modes() {
    let deadline = Instant::now() + Duration::from_secs(30);
    let expected_id = std::env::var("DRAFTYAK_SHELL_SMOKE_ID").expect("NATIVE_TEST_ID_REQUIRED");
    assert!(expected_id.starts_with("com.draftyak.test.shell"));
    let expected_profile = PathBuf::from(
        std::env::var_os("DRAFTYAK_SHELL_SMOKE_PROFILE").expect("NATIVE_TEST_PROFILE_REQUIRED"),
    );
    assert!(expected_profile.is_absolute());
    let temp = std::env::temp_dir()
        .canonicalize()
        .expect("NATIVE_TEMP_RESOLVE");
    let profile = expected_profile
        .canonicalize()
        .expect("NATIVE_PROFILE_RESOLVE");
    assert!(profile.starts_with(&temp) && profile != temp);
    let parent = profile.parent().expect("NATIVE_PROFILE_PARENT");
    assert!(
        parent
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("draftyak-shell-"))
    );
    let marker: Value = serde_json::from_slice(
        &std::fs::read(parent.join(".draftyak-shell-smoke-owned.json"))
            .expect("NATIVE_OWNERSHIP_MARKER"),
    )
    .expect("NATIVE_OWNERSHIP_JSON");
    assert_eq!(
        marker.get("identifier").and_then(Value::as_str),
        Some(expected_id.as_str())
    );

    let mut context: Context<Wry> = tauri::generate_context!();
    assert_eq!(context.config().identifier, expected_id);
    assert!(
        matches!(&context.config().app.app_directories_override, Some(AppDirectoriesOverride::Root(root)) if root == &expected_profile)
    );
    let isolation =
        window_security::prepare_context(&mut context).expect("NATIVE_SECURITY_CONTEXT");
    let loaded = Arc::new(AtomicBool::new(false));
    let observe = loaded.clone();
    let setup_profile = expected_profile.clone();
    let app = configure(tauri::Builder::<Wry>::default().any_thread(), isolation)
        .on_page_load(move |webview, payload| {
            if webview.label() == window_security::MAIN_LABEL
                && payload.event() == tauri::webview::PageLoadEvent::Finished
                && window_security::may_navigate(window_security::MAIN_LABEL, payload.url())
            {
                observe.store(true, Ordering::Release);
            }
        })
        .setup(move |app| {
            // Setup may execute during build. Validate actual resolved paths here,
            // immediately before the first native window is constructed.
            for (actual, expected) in [
                (app.path().app_config_dir()?, setup_profile.clone()),
                (app.path().app_data_dir()?, setup_profile.clone()),
                (app.path().app_local_data_dir()?, setup_profile.clone()),
                (app.path().app_cache_dir()?, setup_profile.join("caches")),
                (app.path().app_log_dir()?, setup_profile.join("logs")),
            ] {
                if actual != expected {
                    return Err("NATIVE_APP_DIRECTORY_MISMATCH".into());
                }
            }
            open_main(app.handle())?;
            Ok(())
        })
        .build(context)
        .expect("NATIVE_APP_BUILD");

    let handle = app.handle().clone();
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    let controller = thread::spawn(move || {
        let result = drive_modes(&handle, &loaded, deadline);
        let _ = result_tx.send(result);
        // A failed request_exit falls back to process::exit. Use a nonzero sentinel so
        // that fallback cannot masquerade as a passing Rust test process.
        handle.exit(77);
    });
    let exit_code = app.run_return(|_, _| {});
    controller.join().expect("NATIVE_CONTROLLER_JOIN");
    assert_eq!(result_rx.try_recv().expect("NATIVE_RESULT"), Ok(()));
    assert_eq!(exit_code, 77);
}
