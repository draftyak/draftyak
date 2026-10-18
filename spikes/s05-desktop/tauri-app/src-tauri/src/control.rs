//! Spike-only test control, on with `--spike-control`; the product has no such channel. Each stdin
//! line is one JSON command, answered by one JSON line on stdout with `event` "control" (a name no
//! supervisor event uses), `cmd` the command, and the answer's fields or `error`:
//!
//! - `{"cmd":"tray"}`: the tray's items as Tauri and, on Windows, the native menu hold them, and
//!   whether the shell holds the icon.
//! - `{"cmd":"click","item":"open"|"quit"}`: on Windows, posts the tray's window the WM_COMMAND the
//!   shell sends when the owner picks that item, so muda's and Tauri's own dispatch runs; elsewhere
//!   it calls the menu handler.
//! - `{"cmd":"windows"}`; `{"cmd":"open","label":"main"|"approval"}`; `{"cmd":"close","label":…}`.
//! - `{"cmd":"autostart","action":"status"|"enable"|"disable"}`, where `"pretendElevated":true`
//!   runs the elevation refusal; `{"cmd":"npm-autostart"}`, the state as the main window reads it
//!   through @tauri-apps/plugin-autostart.
//! - `{"cmd":"approval"}`: [`approval_checks`].
//! - `{"cmd":"power"}`: keep-awake's state and the resume listener ([`Power::status`]).
//! - `{"cmd":"wake"}`: a suspend and resume, delivered as far as the app can without sleeping
//!   ([`Power::simulate_wake`]); the hub then gets `{power: "resumed"}`.

use std::io::{self, BufRead};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::app::emit;
use crate::power::Power;
use crate::shell::{self, Autostart};
use crate::{approval, sidecar};

pub const FLAG: &str = "--spike-control";
const WAIT: Duration = Duration::from_secs(30);
/// The label of a window the approval protocol must refuse.
const FOREIGN: &str = "foreign";

type Reply = Result<Value, String>;

fn text(error: impl ToString) -> String {
    error.to_string()
}

pub fn start(app: AppHandle) -> io::Result<()> {
    thread::Builder::new().name("spike-control".into()).spawn(move || {
        for line in io::stdin().lock().lines().map_while(Result::ok) {
            let command: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            let arg = |key: &str| command.get(key).and_then(Value::as_str).unwrap_or_default();
            let name = arg("cmd");
            let reply = match name {
                "tray" => tray(&app),
                "click" => click(&app, arg("item")),
                "windows" => Ok(windows(&app)),
                "open" => open(&app, arg("label")),
                "close" => close(&app, arg("label")),
                "autostart" => {
                    let pretend = command.get("pretendElevated") == Some(&json!(true));
                    autostart(&app, arg("action"), pretend)
                }
                "npm-autostart" => npm_autostart(&app),
                "approval" => approval_checks(&app),
                "power" => Ok(app.state::<Power>().status()),
                "wake" => app.state::<Power>().simulate_wake().map(|sent| json!({ "sent": sent })),
                _ => Err(format!("unknown command {line}")),
            };
            let mut reply = reply.unwrap_or_else(|error| json!({ "error": error }));
            reply["event"] = json!("control");
            reply["cmd"] = json!(name);
            emit(&reply);
        }
    })?;
    Ok(())
}

/// Waits until `done` holds, checking every 50 ms, or fails with `failure` after [`WAIT`].
fn poll(failure: &str, mut done: impl FnMut() -> bool) -> Result<(), String> {
    let deadline = Instant::now() + WAIT;
    while !done() {
        if Instant::now() > deadline {
            return Err(failure.into());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

fn tray(app: &AppHandle) -> Reply {
    let tray = app.state::<shell::Tray>();
    let mut items = Vec::new();
    for item in tray.menu.items().map_err(text)? {
        if let Some(item) = item.as_menuitem() {
            items.push(json!({ "id": item.id().as_ref(), "text": item.text().map_err(text)? }));
        }
    }
    Ok(json!({
        "id": tray.icon.id().as_ref(),
        "items": items,
        "native": native::items(&tray)?,
        "shellHoldsIcon": native::shell_holds(&tray),
        "rect": tray.icon.rect().ok().flatten().is_some(),
    }))
}

fn click(app: &AppHandle, item: &str) -> Reply {
    let label = match item {
        shell::OPEN => "Open",
        shell::QUIT => "Quit",
        _ => return Err(format!("no tray item {item:?}")),
    };
    let via = native::pick(app, item, label)?;
    Ok(json!({ "item": item, "via": via }))
}

fn origin_of(url: &Url) -> String {
    format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default())
}

fn windows(app: &AppHandle) -> Value {
    let mut windows: Vec<_> = app.webview_windows().into_iter().collect();
    windows.sort_by(|left, right| left.0.cmp(&right.0));
    let windows: Vec<Value> = windows
        .into_iter()
        .map(|(label, window)| {
            let url = window.url().ok();
            json!({
                "label": label,
                "visible": window.is_visible().ok(),
                "origin": url.as_ref().map(origin_of),
                "path": url.as_ref().map(Url::path),
            })
        })
        .collect();
    json!({ "windows": windows, "webviewVersion": tauri::webview_version().ok() })
}

fn open(app: &AppHandle, label: &str) -> Reply {
    let window = match label {
        shell::MAIN => shell::open_main(app).map_err(text)?,
        approval::LABEL => open_approval(app)?,
        _ => return Err(format!("no window {label:?}")),
    };
    Ok(json!({ "label": label, "origin": window.url().ok().as_ref().map(origin_of) }))
}

fn close(app: &AppHandle, label: &str) -> Reply {
    let window = app.get_webview_window(label).ok_or_else(|| format!("no window {label:?}"))?;
    window.close().map_err(text)?;
    gone(app, label)?;
    Ok(json!({ "label": label, "closed": true }))
}

fn gone(app: &AppHandle, label: &str) -> Result<(), String> {
    poll(&format!("the {label} window didn't close"), || app.get_webview_window(label).is_none())
}

fn autostart(app: &AppHandle, action: &str, pretend_elevated: bool) -> Reply {
    let applied = match action {
        "status" => Autostart::Status,
        "enable" => Autostart::Enable,
        "disable" => Autostart::Disable,
        _ => return Err(format!("no autostart action {action:?}")),
    };
    let elevated = shell::elevated().map_err(text)?;
    Ok(match shell::autostart(app, applied, pretend_elevated) {
        Ok(state) => json!({
            "action": action,
            "enabled": state.enabled,
            "leftBehind": state.left_behind,
            "elevated": elevated,
        }),
        Err(error) => json!({ "action": action, "error": error, "elevated": elevated }),
    })
}

const MAIN_READY: &str = "document.readyState === 'complete' && typeof window.dySpike === 'object'";

fn npm_autostart(app: &AppHandle) -> Reply {
    let main = shell::open_main(app).map_err(text)?;
    wait(&main, MAIN_READY)?;
    let enabled = probe(&main, "return await window.dySpike.autostartEnabled();")?;
    Ok(json!({ "enabled": enabled }))
}

// The answer of a JavaScript expression evaluated in the window's page. Windows hands the result
// back as JSON, so a string arrives quoted.
fn evaluate(window: &WebviewWindow, expression: &str) -> Reply {
    let (tx, rx) = mpsc::channel();
    window
        .eval_with_callback(expression, move |raw| {
            let _ = tx.send(raw);
        })
        .map_err(text)?;
    let raw = rx.recv_timeout(WAIT).map_err(|_| "no answer from the page".to_string())?;
    Ok(match serde_json::from_str(&raw) {
        Ok(Value::String(inner)) => serde_json::from_str(&inner).unwrap_or(Value::String(inner)),
        Ok(value) => value,
        Err(_) => Value::String(raw),
    })
}

fn wait(window: &WebviewWindow, condition: &str) -> Result<(), String> {
    let deadline = Instant::now() + WAIT;
    while evaluate(window, &format!("JSON.stringify(Boolean({condition}))"))? != json!(true) {
        if Instant::now() > deadline {
            return Err(format!("{} never had {condition}", window.label()));
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

// Runs `body`, an async function body, in the window's page and returns its value. Evaluating a
// script returns before its promises settle, so the result is polled.
fn probe(window: &WebviewWindow, body: &str) -> Reply {
    let id = sidecar::random_hex(8).map_err(text)?;
    let slot = format!("window.__dyProbe_{id}");
    window
        .eval(format!(
            "{slot} = null; (async () => {{ {PROBE_PRELUDE} {body} }})().then(\
             (value) => {{ {slot} = {{ value: value ?? null }}; }},\
             (error) => {{ {slot} = {{ error: String(error) }}; }});"
        ))
        .map_err(text)?;
    let deadline = Instant::now() + WAIT;
    loop {
        let answer = evaluate(window, &format!("JSON.stringify({slot})"))?;
        if let Some(value) = answer.get("value") {
            return Ok(value.clone());
        }
        if let Some(error) = answer.get("error") {
            return Err(format!("probe in {}: {error}", window.label()));
        }
        if Instant::now() > deadline {
            return Err(format!("probe in {} timed out", window.label()));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

const PROBE_PRELUDE: &str = r#"
const outcome = (promise) => promise.then(
  (value) => ({ ok: value ?? null }),
  (error) => ({ refused: error?.name ? `${error.name}: ${error.message}` : String(error) }));
const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
const count = (read) => {
  try { return read(); } catch (error) { return `blocked: ${error.name}`; }
};
"#;

// In the main window: its origin; the approval command and autostart changes refused by its
// capability; autostart read through the npm package; the approval page out of its reach.
const MAIN_PROBE: &str = r#"
document.cookie = "dy_main=1; Path=/; SameSite=Strict";
document.cookie = "dy_shared=1; Domain=localhost; Path=/; SameSite=Strict";
return {
  origin: location.origin,
  cookies: document.cookie.split("; ").filter(Boolean).length,
  approvalReady: await outcome(invoke("approval_ready", { report: { from: "main" } })),
  autostartDisable: await outcome(invoke("plugin:autostart|disable")),
  autostartViaNpm: await outcome(window.dySpike.autostartEnabled()),
  fetchApproval: await outcome(fetch(`${APPROVAL_ORIGIN}/approval.html`).then((r) => r.status)),
};
"#;

// In the approval window: its origin, service workers, the storage its origin holds, Trusted
// Types and eval under the CSP, and what its capability allows.
const APPROVAL_PROBE: &str = r#"
const worker = navigator.serviceWorker;
const serviceWorker = worker ? {
  api: true,
  register: await outcome(worker.register("/sw.js")),
  registrations: (await worker.getRegistrations()).length,
  controlled: worker.controller !== null,
} : { api: false };
return {
  origin: location.origin,
  secureContext: isSecureContext,
  serviceWorker,
  storage: {
    localStorage: count(() => localStorage.length),
    sessionStorage: count(() => sessionStorage.length),
    cookie: count(() => document.cookie),
    indexedDB: (await indexedDB.databases()).map((database) => database.name),
    caches: typeof caches === "undefined" ? null : (await caches.keys()).length,
  },
  trustedTypes: await outcome((async () => {
    document.createElement("p").innerHTML = "<b>x</b>";
  })()),
  eval: await outcome((async () => (0, eval)("1"))()),
  approvalReady: await outcome(invoke("approval_ready", { report: { from: "probe" } })),
  autostart: await outcome(invoke("plugin:autostart|is_enabled")),
};
"#;

// Writes to every store, so the next approval window can show none of it survived.
const WRITE_PROBE: &str = r#"
localStorage.setItem("dy", "1");
sessionStorage.setItem("dy", "1");
document.cookie = "dy_approval=1; Path=/; SameSite=Strict";
await new Promise((resolve, reject) => {
  const request = indexedDB.open("dy");
  request.onupgradeneeded = () => request.result.createObjectStore("probe");
  request.onsuccess = () => { request.result.close(); resolve(); };
  request.onerror = () => reject(request.error);
});
if (typeof caches !== "undefined") await caches.open("dy");
return {
  localStorage: localStorage.length,
  sessionStorage: sessionStorage.length,
  cookie: document.cookie !== "",
  indexedDB: (await indexedDB.databases()).length,
  caches: typeof caches === "undefined" ? null : (await caches.keys()).length,
};
"#;

fn ready_count(app: &AppHandle) -> usize {
    app.state::<approval::Log>().ready.lock().map(|ready| ready.len()).unwrap_or_default()
}

// Opens the approval window and waits until its page reported in.
fn open_approval(app: &AppHandle) -> Result<WebviewWindow, String> {
    let before = ready_count(app);
    let window = approval::open(app).map_err(text)?;
    poll("the approval page never called approval_ready", || ready_count(app) > before)?;
    Ok(window)
}

// What the approval protocol answered the window `label`: (path, status).
fn served_to(app: &AppHandle, label: &str) -> Vec<(String, u16)> {
    let log = app.state::<approval::Log>();
    let served = log.served.lock().map(|served| served.clone()).unwrap_or_default();
    served
        .into_iter()
        .filter(|(by, ..)| by == label)
        .map(|(_, path, status)| (path, status))
        .collect()
}

fn refused_navigations(app: &AppHandle) -> Vec<String> {
    app.state::<approval::Log>().refused.lock().map(|refused| refused.clone()).unwrap_or_default()
}

// Points a hidden window labelled FOREIGN straight at the approval page, with no navigation pin and
// no CSP of its own, so only the protocol's label check stands in its way; returns what it got.
fn foreign_requests(app: &AppHandle) -> Result<Vec<(String, u16)>, String> {
    let url = WebviewUrl::CustomProtocol(approval::page_url());
    let window = WebviewWindowBuilder::new(app, FOREIGN, url)
        .visible(false)
        .incognito(true)
        .data_directory(crate::app::webview_data(app, FOREIGN))
        .build()
        .map_err(text)?;
    let failure = "the foreign window's request never reached the protocol";
    let reached = poll(failure, || !served_to(app, FOREIGN).is_empty());
    window.destroy().map_err(text)?;
    gone(app, FOREIGN)?;
    reached.map(|()| served_to(app, FOREIGN))
}

fn refused(outcome: &Value) -> bool {
    outcome.get("refused").is_some()
}

fn allowed(outcome: &Value) -> bool {
    outcome.get("ok").is_some()
}

fn empty_storage(storage: &Value) -> bool {
    let zero = |key: &str| storage[key] == json!(0);
    zero("localStorage")
        && zero("sessionStorage")
        && storage["cookie"] == json!("")
        && storage["indexedDB"] == json!([])
        && (storage["caches"].is_null() || zero("caches"))
}

fn no_service_worker(page: &Value) -> bool {
    let worker = &page["serviceWorker"];
    worker["api"] == json!(false)
        || (refused(&worker["register"])
            && worker["registrations"] == json!(0)
            && worker["controlled"] == json!(false))
}

/// The Rust-driven checks of the approval window (plan §8). Rust opens the main and the approval
/// window, runs probes in both pages and reads their answers, and checks: the two origins differ
/// (as Rust and each page see them); no service worker registers; the approval origin holds no
/// storage, none reaches it from the main window, and what one approval window writes is gone in
/// the next (in-private, its own data folder); only the approval window may call `approval_ready`,
/// and it may call nothing else; Trusted Types and the CSP refuse HTML sinks and eval; its
/// navigation handler refuses the main window's origin; and its protocol served its two files only
/// to it, refusing a window of another label that asked for the page directly.
fn approval_checks(app: &AppHandle) -> Reply {
    if app.get_webview_window(approval::LABEL).is_some() {
        close(app, approval::LABEL)?;
    }
    let main = shell::open_main(app).map_err(text)?;
    wait(&main, MAIN_READY)?;
    let approval_origin = shell::origin(approval::SCHEME);
    let main_page =
        probe(&main, &MAIN_PROBE.replace("APPROVAL_ORIGIN", &json!(approval_origin).to_string()))?;

    let first = open_approval(app)?;
    let urls = [main.url().map_err(text)?, first.url().map_err(text)?];
    let rust_origins = urls.iter().map(origin_of).collect::<Vec<_>>();
    let first_page = probe(&first, APPROVAL_PROBE)?;
    let first_cookies = first.cookies().map_err(text)?.len();
    let written = probe(&first, WRITE_PROBE)?;
    close(app, approval::LABEL)?;

    let second = open_approval(app)?;
    let second_page = probe(&second, APPROVAL_PROBE)?;
    let second_cookies = second.cookies().map_err(text)?.len();
    let main_url = format!("{}/index.html", shell::origin("tauri"));
    second.eval(format!("location.href = {};", json!(main_url))).map_err(text)?;
    let failure = "the approval window's navigation handler never refused the main origin";
    let refused_main = poll(failure, || refused_navigations(app).contains(&main_url)).is_ok();
    let stayed = refused_main && shell::served_by(&second.url().map_err(text)?, approval::SCHEME);
    close(app, approval::LABEL)?;
    let foreign = foreign_requests(app)?;

    let log = app.state::<approval::Log>();
    let served = log.served.lock().map_err(text)?.clone();
    let callers: Vec<String> =
        log.ready.lock().map_err(text)?.iter().map(|(label, _)| label.clone()).collect();

    let origins = rust_origins[0] == shell::origin("tauri")
        && rust_origins[1] == approval_origin
        && main_page["origin"] == json!(rust_origins[0])
        && first_page["origin"] == json!(rust_origins[1])
        && rust_origins[0] != rust_origins[1];
    let service_worker = no_service_worker(&first_page) && no_service_worker(&second_page);
    let storage = empty_storage(&first_page["storage"])
        && empty_storage(&second_page["storage"])
        && first_cookies == 0
        && second_cookies == 0
        && written["localStorage"] == json!(1)
        && written["indexedDB"] == json!(1)
        && written["cookie"] == json!(true);
    let capabilities = callers.iter().all(|label| label == approval::LABEL)
        && allowed(&first_page["approvalReady"])
        && refused(&first_page["autostart"])
        && refused(&main_page["approvalReady"])
        && refused(&main_page["autostartDisable"])
        && main_page["autostartViaNpm"]["ok"].is_boolean();
    let csp = refused(&first_page["trustedTypes"]) && refused(&first_page["eval"]);
    let protocol = served.iter().all(|(label, path, status)| match label.as_str() {
        approval::LABEL => {
            matches!(path.as_str(), "/approval.html" | "/approval.js") && *status == 200
        }
        FOREIGN => *status == 403,
        _ => false,
    }) && foreign.contains(&("/approval.html".into(), 403))
        && refused(&main_page["fetchApproval"]);
    let pass = origins && service_worker && storage && capabilities && csp && protocol && stayed;
    let served: Vec<Value> = served
        .iter()
        .map(|(label, path, status)| json!({ "label": label, "path": path, "status": status }))
        .collect();
    Ok(json!({
        "pass": pass,
        "checks": {
            "originsDiffer": origins,
            "noServiceWorker": service_worker,
            "noStorage": storage,
            "onlyItsCapability": capabilities,
            "cspEnforced": csp,
            "servedOnlyToItself": protocol,
            "navigationPinned": stayed,
        },
        "origins": { "main": rust_origins[0], "approval": rust_origins[1] },
        "mainPage": main_page,
        "firstWindow": { "page": first_page, "cookies": first_cookies, "written": written },
        "secondWindow": { "page": second_page, "cookies": second_cookies },
        "csp": approval::CSP,
        "served": served,
        "readyCallers": callers,
        "refusedNavigations": refused_navigations(app),
    }))
}

#[cfg(windows)]
mod native {
    use std::io;

    use serde_json::{Value, json};
    use tauri::menu::ContextMenu;
    use tauri::{AppHandle, Manager};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetMenuItemCount, GetMenuItemID, GetMenuStringW, HMENU, MF_BYPOSITION, PostMessageW,
        WM_COMMAND,
    };

    use crate::shell::Tray;

    // The tray menu as Windows holds it: each item's text and command id.
    fn entries(tray: &Tray) -> Result<Vec<(String, u32)>, String> {
        let menu = tray.menu.hpopupmenu().map_err(|error| error.to_string())? as HMENU;
        let count = unsafe { GetMenuItemCount(menu) };
        if count < 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        let entry = |index: i32| {
            let mut text = [0u16; 128];
            let flags = MF_BYPOSITION;
            let length =
                unsafe { GetMenuStringW(menu, index as u32, text.as_mut_ptr(), 128, flags) };
            let command = unsafe { GetMenuItemID(menu, index) };
            (String::from_utf16_lossy(&text[..length.max(0) as usize]), command)
        };
        Ok((0..count).map(entry).collect())
    }

    pub fn items(tray: &Tray) -> Result<Value, String> {
        let items = entries(tray)?;
        Ok(items
            .into_iter()
            .map(|(text, command)| json!({ "text": text, "command": command }))
            .collect())
    }

    /// Shell_NotifyIcon(NIM_MODIFY), which setting the tooltip sends, fails for an icon the shell
    /// doesn't hold.
    pub fn shell_holds(tray: &Tray) -> Value {
        json!(tray.icon.set_tooltip(Some(crate::shell::TOOLTIP)).is_ok())
    }

    /// When the owner picks an item from the tray menu (TrackPopupMenu), the tray's window gets
    /// WM_COMMAND with the item's command id; muda's subclass of that window emits the menu event.
    pub fn pick(app: &AppHandle, _item: &str, text: &str) -> Result<&'static str, String> {
        let tray = app.state::<Tray>();
        let (_, command) = entries(&tray)?
            .into_iter()
            .find(|(label, _)| label == text)
            .ok_or_else(|| format!("the tray menu has no {text} item"))?;
        let window = tray
            .icon
            .with_inner_tray_icon(|inner| inner.window_handle() as isize)
            .map_err(|error| error.to_string())?;
        if unsafe { PostMessageW(window as HWND, WM_COMMAND, command as usize, 0) } == 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        Ok("WM_COMMAND")
    }
}

#[cfg(not(windows))]
mod native {
    use serde_json::Value;
    use tauri::AppHandle;
    use tauri::menu::MenuEvent;

    use crate::shell::{self, Tray};

    pub fn items(_tray: &Tray) -> Result<Value, String> {
        Ok(Value::Null)
    }

    pub fn shell_holds(_tray: &Tray) -> Value {
        Value::Null
    }

    pub fn pick(app: &AppHandle, item: &str, _text: &str) -> Result<&'static str, String> {
        shell::on_menu(app, MenuEvent { id: item.into() });
        Ok("handler")
    }
}
