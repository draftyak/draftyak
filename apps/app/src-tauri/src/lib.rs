#![forbid(unsafe_code)]

#[cfg(any(feature = "desktop", feature = "desktop-tests"))]
pub mod shell;
#[cfg(any(feature = "desktop", feature = "desktop-tests"))]
pub mod window_security;

#[cfg(feature = "desktop")]
mod profile;

#[cfg(feature = "desktop")]
pub fn run() -> Result<(), &'static str> {
    let choice = profile::selection::select_native_profile(std::env::args_os().skip(1))
        .map_err(|_| "DESKTOP_PROFILE_UNAVAILABLE")?;
    let mut context = tauri::generate_context!();
    profile::context::configure_context(&mut context, &choice)
        .map_err(|_| "DESKTOP_PROFILE_UNAVAILABLE")?;
    let isolation = window_security::prepare_context(&mut context)?;
    shell::configure(tauri::Builder::default(), isolation)
        .setup(move |app| {
            profile::context::validate_app(app.handle(), &choice)?;
            shell::open_main(app.handle())?;
            Ok(())
        })
        .run(context)
        .map_err(|_| "DESKTOP_STARTUP_FAILED")
}
