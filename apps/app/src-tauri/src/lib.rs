#![forbid(unsafe_code)]

#[cfg(any(feature = "desktop", feature = "desktop-tests"))]
pub mod shell;
#[cfg(any(feature = "desktop", feature = "desktop-tests"))]
pub mod window_security;

#[cfg(feature = "desktop")]
pub fn run() -> Result<(), &'static str> {
    let mut context = tauri::generate_context!();
    let isolation = window_security::prepare_context(&mut context)?;
    shell::configure(tauri::Builder::default(), isolation)
        .setup(|app| {
            shell::open_main(app.handle())?;
            Ok(())
        })
        .run(context)
        .map_err(|_| "DESKTOP_STARTUP_FAILED")
}
