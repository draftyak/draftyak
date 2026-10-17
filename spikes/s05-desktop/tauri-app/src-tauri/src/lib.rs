//! The S5b desktop shell: a Tauri 2 app whose only job so far is supervising the bundled hub
//! (plan §7 Bundled sidecar). Without the default `app` feature only [`sidecar`] builds.

pub mod sidecar;

#[cfg(feature = "app")]
mod app;

#[cfg(feature = "app")]
pub use app::run;
