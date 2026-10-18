//! The desktop shell around the hub (plan §7 Tray and Autostart): a tray with Open and Quit, the
//! main window and autostart. The app always starts in the tray, as plan §7's autostart does
//! ("starting minimized"); Open creates the main window from tauri.conf.json's `main` entry, and
//! closing it keeps the hub running. Quit closes the windows and exits the app, whose exit handler
//! stops the hub. M0.23b adds keep-awake and resume beside this, and their tray status.

use std::time::{Duration, Instant};
use std::{io, thread};

use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::plugin::TauriPlugin;
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewWindow, WebviewWindowBuilder, Wry};
use tauri_plugin_autostart::ManagerExt;

pub const TRAY: &str = "draftyak";
pub const TOOLTIP: &str = "DraftYak Spike Desktop";
pub const OPEN: &str = "open";
pub const QUIT: &str = "quit";
pub const MAIN: &str = "main";
/// The argument the autostart entry starts the app with.
pub const MINIMIZED: &str = "--minimized";

/// The tray icon and its menu, kept for the app's lifetime.
pub struct Tray {
    pub icon: TrayIcon,
    pub menu: Menu<Wry>,
}

/// The tray with Open and Quit.
pub fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN, "Open", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder =
        TrayIconBuilder::with_id(TRAY).menu(&menu).tooltip(TOOLTIP).on_menu_event(on_menu);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let icon = builder.build(app)?;
    app.manage(Tray { icon, menu });
    Ok(())
}

/// What the tray's items do. Tauri documents that building a window inside an event handler can
/// deadlock on Windows, so Open and Quit work on their own threads.
pub fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        OPEN => {
            let app = app.clone();
            let opened = thread::Builder::new().name("open-main".into()).spawn(move || {
                if let Err(error) = open_main(&app) {
                    eprintln!("app: the main window didn't open: {error}");
                }
            });
            if let Err(error) = opened {
                eprintln!("app: the main window didn't open: {error}");
            }
        }
        QUIT => {
            let handle = app.clone();
            let quitting = thread::Builder::new().name("quit".into()).spawn(move || quit(&handle));
            if let Err(error) = quitting {
                eprintln!("app: quitting with the windows open: {error}");
                app.exit(0);
            }
        }
        _ => {}
    }
}

/// Destroys every window, waits until they are gone, then exits. WebView2 holds a window's data
/// folder, inside the launch's store, until its webview is destroyed, and the exit handler that
/// removes the store runs while the windows still exist.
fn quit(app: &AppHandle) {
    for window in app.webview_windows().into_values() {
        if let Err(error) = window.destroy() {
            eprintln!("app: the {} window didn't close: {error}", window.label());
        }
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while !app.webview_windows().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    app.exit(0);
}

/// Shows the main window, creating it if it was never opened or was closed.
pub fn open_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(MAIN) {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(window);
    }
    let windows = &app.config().app.windows;
    let config = windows.iter().find(|window| window.label == MAIN).ok_or_else(|| {
        tauri::Error::Io(io::Error::other("tauri.conf.json has no main window entry"))
    })?;
    WebviewWindowBuilder::from_config(app, config)?
        .data_directory(crate::app::webview_data(app, MAIN))
        .on_navigation(|url| served_by(url, "tauri"))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()
}

/// The origin of the custom protocol `scheme`: wry serves it as `http://<scheme>.localhost` on
/// Windows and as `<scheme>://localhost` elsewhere.
pub fn origin(scheme: &str) -> String {
    if cfg!(windows) {
        format!("http://{scheme}.localhost")
    } else {
        format!("{scheme}://localhost")
    }
}

/// Whether `url` belongs to the custom protocol `scheme`, the only place a window may navigate.
pub fn served_by(url: &Url, scheme: &str) -> bool {
    url.port().is_none()
        && format!("{}://{}", url.scheme(), url.host_str().unwrap_or("")) == origin(scheme)
}

/// The autostart entry is named after the spike's identifier, so it never meets the product's
/// (`com.draftyak.client`): the value of that name under HKCU's Run key on Windows,
/// `~/Library/LaunchAgents/<identifier>.plist` on macOS and
/// `~/.config/autostart/<identifier>.desktop` on Linux, each starting the app with [`MINIMIZED`].
pub fn autostart_plugin(identifier: &str) -> TauriPlugin<Wry> {
    tauri_plugin_autostart::Builder::new().app_name(identifier).arg(MINIMIZED).build()
}

#[derive(Clone, Copy, Debug)]
pub enum Autostart {
    Status,
    Enable,
    Disable,
}

/// What [`autostart`] found: whether autostart is on, and on Windows after disabling, whether the
/// plugin had left its Task Manager entry behind for the app to remove.
pub struct AutostartState {
    pub enabled: bool,
    pub left_behind: Option<bool>,
}

/// Applies `action`. Enabling is refused while the app runs elevated on Windows: auto-launch 0.6.0,
/// under tauri-plugin-autostart 2.7.0, then writes the machine-wide HKLM Run key, which would start
/// this user's binary for every user. The plugin's own enable and disable commands skip this guard
/// and the cleanup, so no capability grants them. `pretend_elevated` lets the spike's control run
/// the refusal on a box that isn't elevated.
pub fn autostart(
    app: &AppHandle,
    action: Autostart,
    pretend_elevated: bool,
) -> Result<AutostartState, String> {
    let manager = app.autolaunch();
    let mut left_behind = None;
    match action {
        Autostart::Status => {}
        Autostart::Enable => {
            if pretend_elevated || elevated().map_err(|error| error.to_string())? {
                return Err(
                    "refused: the app runs elevated, so autostart would be machine-wide".into()
                );
            }
            manager.enable().map_err(|error| error.to_string())?;
        }
        Autostart::Disable => {
            manager.disable().map_err(|error| error.to_string())?;
            left_behind =
                forget_approval(&app.config().identifier).map_err(|error| error.to_string())?;
        }
    }
    let enabled = manager.is_enabled().map_err(|error| error.to_string())?;
    Ok(AutostartState { enabled, left_behind })
}

/// Enabling also writes the app's value under Explorer\StartupApproved\Run (Task Manager's
/// startup switch), which disabling leaves behind; this removes it. `Some(true)` if it was there.
#[cfg(windows)]
fn forget_approval(name: &str) -> io::Result<Option<bool>> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RegDeleteKeyValueW};

    let wide = |text: &str| text.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run");
    let value = wide(name);
    match unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr()) } {
        ERROR_SUCCESS => Ok(Some(true)),
        ERROR_FILE_NOT_FOUND => Ok(Some(false)),
        code => Err(io::Error::from_raw_os_error(code as i32)),
    }
}

#[cfg(not(windows))]
fn forget_approval(_name: &str) -> io::Result<Option<bool>> {
    Ok(None)
}

/// Whether this process runs elevated (always `false` off Windows, where autostart is per-user).
#[cfg(windows)]
pub fn elevated() -> io::Result<bool> {
    use std::ffi::c_void;
    use std::ptr;

    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::{
        GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut elevation = TOKEN_ELEVATION::default();
    let mut size = 0;
    let info = (&raw mut elevation).cast::<c_void>();
    let length = size_of::<TOKEN_ELEVATION>() as u32;
    let ok = unsafe { GetTokenInformation(token, TokenElevation, info, length, &mut size) };
    let error = io::Error::last_os_error();
    unsafe { CloseHandle(token) };
    if ok == 0 { Err(error) } else { Ok(elevation.TokenIsElevated != 0) }
}

#[cfg(not(windows))]
pub fn elevated() -> io::Result<bool> {
    Ok(false)
}
