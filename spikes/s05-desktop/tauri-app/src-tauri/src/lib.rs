//! The S5 desktop shell: a Tauri 2 app that supervises the bundled hub (plan §7 Bundled sidecar),
//! with a tray, autostart, the approval window, keep-awake and resume (plan §7 Tray, Keep-awake
//! and Autostart, §8). Without the default `app` feature only [`sidecar`] and [`power`] build.

pub mod power;
pub mod sidecar;

#[cfg(feature = "app")]
mod app;
#[cfg(feature = "app")]
mod approval;
#[cfg(feature = "app")]
mod control;
#[cfg(feature = "app")]
mod shell;

#[cfg(feature = "app")]
pub use app::run;
