//! The approval window (plan §8 Approval window). `approval.html` comes from its own custom
//! protocol, so its origin (`http://approval.localhost` on Windows, `approval://localhost`
//! elsewhere) differs from the main window's. The protocol serves only the window labelled
//! [`LABEL`], with [`CSP`], which refuses service workers and enforces Trusted Types. The window is
//! in-private (`incognito`) with its own WebView data folder, so nothing it stores outlives it or
//! reaches the main window; it may navigate only within its origin; and only its capability
//! (`capabilities/approval.json`) allows the `approval_*` commands. The product's window renders
//! the snapshot in Rust and signs it there. The spike runs Tauri's default IPC pattern: the plan's
//! isolation pattern injects an iframe that this CSP's `frame-src 'none'` would block.

use std::sync::Mutex;

use serde_json::Value;
use tauri::http::{Method, Request, Response, StatusCode, header};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, State, UriSchemeContext, Url, Webview, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Wry,
};

use crate::shell;

pub const SCHEME: &str = "approval";
pub const LABEL: &str = "approval";
/// Only the page's own script, Tauri's IPC and nothing else: no workers, frames, plugins, forms or
/// base changes, and no strings into script or HTML sinks.
pub const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'none'; img-src 'none'; \
    font-src 'none'; media-src 'none'; connect-src ipc: http://ipc.localhost; worker-src 'none'; \
    child-src 'none'; frame-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none'; \
    form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; \
    trusted-types 'none'";
const PAGE: &[u8] = include_bytes!("../../approval/approval.html");
const SCRIPT: &[u8] = include_bytes!("../../approval/approval.js");

/// What the protocol served (webview label, path, status), who called `approval_ready`, and the
/// navigations the approval window refused.
#[derive(Default)]
pub struct Log {
    pub served: Mutex<Vec<(String, String, u16)>>,
    pub ready: Mutex<Vec<(String, Value)>>,
    pub refused: Mutex<Vec<String>>,
}

/// The `approval` protocol handler.
pub fn serve(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let label = ctx.webview_label();
    let path = request.uri().path();
    let (status, body, kind) = match (label == LABEL, request.method(), path) {
        (false, ..) => (StatusCode::FORBIDDEN, &b""[..], "text/plain"),
        (true, &Method::GET, "/approval.html") => {
            (StatusCode::OK, PAGE, "text/html; charset=utf-8")
        }
        (true, &Method::GET, "/approval.js") => (StatusCode::OK, SCRIPT, "text/javascript"),
        (true, &Method::GET, _) => (StatusCode::NOT_FOUND, &b""[..], "text/plain"),
        (true, ..) => (StatusCode::METHOD_NOT_ALLOWED, &b""[..], "text/plain"),
    };
    if let Ok(mut served) = ctx.app_handle().state::<Log>().served.lock() {
        served.push((label.into(), path.into(), status.as_u16()));
    }
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, kind)
        .header(header::CONTENT_SECURITY_POLICY, CSP)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(body.to_vec())
        .expect("a static response")
}

/// The page reports what it sees; the spike's checks read the log.
#[tauri::command]
pub fn approval_ready(webview: Webview, report: Value, log: State<'_, Log>) {
    if let Ok(mut ready) = log.ready.lock() {
        ready.push((webview.label().into(), report));
    }
}

/// Shows the approval window, creating it if needed.
pub fn open(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(LABEL) {
        window.show()?;
        window.set_focus()?;
        return Ok(window);
    }
    let handle = app.clone();
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::CustomProtocol(page_url()))
        .title("Approve")
        .inner_size(480.0, 360.0)
        .incognito(true)
        .data_directory(crate::app::webview_data(app, LABEL))
        .on_navigation(move |url| {
            let pinned = shell::served_by(url, SCHEME);
            if !pinned && let Ok(mut refused) = handle.state::<Log>().refused.lock() {
                refused.push(url.to_string());
            }
            pinned
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()
}

/// The page's URL, which wry turns into `http://approval.localhost/approval.html` on Windows.
pub fn page_url() -> Url {
    format!("{SCHEME}://localhost/approval.html").parse().expect("a valid URL")
}
