use std::path::PathBuf;

use tauri::Manager;
use tauri::utils::config::{AppDirectoriesOverride, Config};

use super::{DEFAULT_IDENTIFIER, NativeProfileError, NativeProfileLocation, ProfileChoice};

/// Configures fixed directory DATA before any Builder or plugin is constructed.
/// This does not create or admit a directory or provide key/profile custody.
pub(crate) fn configure_context<R: tauri::Runtime>(
    context: &mut tauri::Context<R>,
    choice: &ProfileChoice,
) -> Result<(), NativeProfileError> {
    configure_config(context.config_mut(), choice)
}

fn configure_config(config: &mut Config, choice: &ProfileChoice) -> Result<(), NativeProfileError> {
    if config.identifier != DEFAULT_IDENTIFIER || config.app.app_directories_override.is_some() {
        return Err(NativeProfileError::ContextMismatch);
    }
    let native_base = if cfg!(target_os = "windows") {
        "$LOCALDATA"
    } else if cfg!(any(target_os = "macos", target_os = "linux")) {
        "$DATA"
    } else {
        return Err(NativeProfileError::InvalidLocation);
    };
    // Tauri resolves this fixed base-directory token through its original native
    // PathResolver. The validated name cannot add a path or another token.
    let root = PathBuf::from(native_base).join(choice.directory_component());
    let identifier = choice.application_identifier();
    config.identifier = identifier;
    config.app.app_directories_override = Some(AppDirectoriesOverride::Root(root));
    Ok(())
}

/// Checks the original AppHandle's resolved directories before opening the
/// explicit application window. Framework/plugin I/O may already have run.
pub(crate) fn validate_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    choice: &ProfileChoice,
) -> Result<(), NativeProfileError> {
    let location = NativeProfileLocation::from_app(app, choice.clone())?;
    let resolver = app.path();
    let paths = [
        resolver
            .app_config_dir()
            .map_err(|_| NativeProfileError::InvalidLocation)?,
        resolver
            .app_data_dir()
            .map_err(|_| NativeProfileError::InvalidLocation)?,
        resolver
            .app_local_data_dir()
            .map_err(|_| NativeProfileError::InvalidLocation)?,
        resolver
            .app_cache_dir()
            .map_err(|_| NativeProfileError::InvalidLocation)?,
        resolver
            .app_log_dir()
            .map_err(|_| NativeProfileError::InvalidLocation)?,
    ];
    validate_resolved_paths(&location, paths)
}

fn validate_resolved_paths(
    location: &NativeProfileLocation,
    paths: [PathBuf; 5],
) -> Result<(), NativeProfileError> {
    let root = location.data_directory();
    let expected = [
        root.to_path_buf(),
        root.to_path_buf(),
        root.to_path_buf(),
        root.join("caches"),
        root.join("logs"),
    ];
    if paths != expected {
        return Err(NativeProfileError::ContextMismatch);
    }
    Ok(())
}

#[cfg(test)]
#[path = "context/tests.rs"]
mod tests;
