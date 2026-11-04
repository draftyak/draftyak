use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Builder, Manager, Runtime, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::window_security::{self, IsolationOrigin, MAIN_LABEL, TRUSTED_LABEL, TRUSTED_SCHEME};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Hub,
    Connect,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
pub struct ShellSnapshot {
    mode: Option<Mode>,
}

#[derive(Default)]
struct ShellState(Mutex<ShellSnapshot>);

fn require_main<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), &'static str> {
    let url = window.url().map_err(|_| "SHELL_UNAVAILABLE")?;
    if window_security::may_navigate(window.label(), &url) && window.label() == MAIN_LABEL {
        Ok(())
    } else {
        Err("SHELL_FORBIDDEN")
    }
}

#[tauri::command]
fn shell_state<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, ShellState>,
) -> Result<ShellSnapshot, &'static str> {
    require_main(&window)?;
    state
        .inner()
        .0
        .lock()
        .map(|snapshot| *snapshot)
        .map_err(|_| "SHELL_UNAVAILABLE")
}

#[tauri::command]
fn shell_select_mode<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, ShellState>,
    mode: Mode,
) -> Result<ShellSnapshot, &'static str> {
    require_main(&window)?;
    let mut snapshot = state.inner().0.lock().map_err(|_| "SHELL_UNAVAILABLE")?;
    snapshot.mode = Some(mode);
    Ok(*snapshot)
}

/// Registers only process-local mode selection. Selection starts no hub or connection and
/// carries no credential, confirmation, PIN or authorization state.
pub fn configure<R: Runtime>(builder: Builder<R>, isolation: IsolationOrigin) -> Builder<R> {
    builder
        .manage(ShellState::default())
        .invoke_handler(tauri::generate_handler![shell_state, shell_select_mode])
        .register_uri_scheme_protocol(TRUSTED_SCHEME, move |context, request| {
            window_security::trusted_response(context.webview_label(), request, &isolation)
        })
}

pub fn open_main<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let directory = app.path().app_local_data_dir()?.join("webview/main");
    WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
        .title("DraftYak")
        .devtools(false)
        .data_directory(directory)
        .on_navigation(|url| window_security::may_navigate(MAIN_LABEL, url))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
}

/// A separate, commandless trusted-surface foundation. Opening it is a native operation;
/// there is deliberately no renderer command that opens or confirms a review.
pub fn open_trusted<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let url = format!("{}/index.html", window_security::trusted_origin())
        .parse()
        .expect("fixed trusted document URL");
    let directory = app.path().app_cache_dir()?.join("webview/approval");
    WebviewWindowBuilder::new(app, TRUSTED_LABEL, WebviewUrl::External(url))
        .title("DraftYak review")
        .devtools(false)
        .incognito(true)
        .data_directory(directory)
        .on_navigation(|url| window_security::may_navigate(TRUSTED_LABEL, url))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
}

#[cfg(all(test, windows, feature = "native-engine-tests"))]
mod native_engine_tests;
