//! The S5 desktop shell: a Tauri 2 app that supervises the bundled hub (plan §7 Bundled sidecar),
//! with a tray, autostart and the approval window (plan §7 Tray and Autostart, §8). Without the
//! default `app` feature only [`sidecar`] builds.

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
