#[cfg(feature = "desktop")]
#[path = "profile/context.rs"]
pub(crate) mod context;
#[path = "profile/selection.rs"]
pub(crate) mod selection;

use std::fmt;
use std::path::{Component, Path, PathBuf};

const DEFAULT_IDENTIFIER: &str = "com.draftyak.client";
const DEFAULT_DIRECTORY: &str = "draftyak";
const MAX_PROFILE_NAME_BYTES: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeProfileError {
    InvalidName,
    InvalidLocation,
    ContextMismatch,
}

impl fmt::Display for NativeProfileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidName => "Native profile name unavailable",
            Self::InvalidLocation => "Native profile location unavailable",
            Self::ContextMismatch => "Native profile context mismatch",
        })
    }
}

impl std::error::Error for NativeProfileError {}

/// Canonical profile selection DATA, without a path or native authority.
#[derive(Clone, Eq, Hash, PartialEq)]
pub struct ProfileName(String);

impl ProfileName {
    pub fn new(value: &str) -> Result<Self, NativeProfileError> {
        let bytes = value.as_bytes();
        let lower_alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
        if bytes.is_empty()
            || bytes.len() > MAX_PROFILE_NAME_BYTES
            || !lower_alphanumeric(bytes[0])
            || !lower_alphanumeric(bytes[bytes.len() - 1])
            || bytes
                .iter()
                .any(|byte| !lower_alphanumeric(*byte) && *byte != b'-')
        {
            return Err(NativeProfileError::InvalidName);
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProfileName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProfileName(..)")
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum ProfileChoice {
    #[default]
    Default,
    Named(ProfileName),
}

impl ProfileChoice {
    fn directory_component(&self) -> String {
        match self {
            Self::Default => DEFAULT_DIRECTORY.to_owned(),
            Self::Named(name) => format!("{DEFAULT_DIRECTORY}-{}", name.as_str()),
        }
    }

    /// Supplies the same application identity before a native handle exists.
    pub(crate) fn application_identifier(&self) -> String {
        match self {
            Self::Default => DEFAULT_IDENTIFIER.to_owned(),
            Self::Named(name) => format!("{DEFAULT_IDENTIFIER}.{}", name.as_str()),
        }
    }
}

/// Stable logical DATA identity; it proves no physical directory or custody.
#[derive(Clone, Eq, Hash, PartialEq)]
pub struct ProfileId(String);

impl ProfileId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProfileId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProfileId(..)")
    }
}

/// Native-derived LOCATION DATA only. This creates or admits no directory,
/// exclusive lease, fresh-profile state, marker, key or custody capability.
#[derive(Clone, Eq, PartialEq)]
pub struct NativeProfileLocation {
    data_directory: PathBuf,
    profile_id: ProfileId,
    application_identifier: String,
}

impl fmt::Debug for NativeProfileLocation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativeProfileLocation(..)")
    }
}

fn usable_native_base(base: &Path) -> bool {
    if !base.is_absolute() {
        return false;
    }
    let mut has_normal_component = false;
    for component in base.components() {
        match component {
            Component::CurDir | Component::ParentDir => return false,
            Component::Normal(_) => has_normal_component = true,
            _ => {}
        }
    }
    // Path::components elides interior dots. Check the original native encoding
    // too, without converting a native username/path through lossy UTF-8.
    let has_dot_segment = base
        .as_os_str()
        .as_encoded_bytes()
        .split(|byte| *byte == b'/' || (cfg!(windows) && *byte == b'\\'))
        .any(|segment| segment == b".");
    has_normal_component && !has_dot_segment
}

impl NativeProfileLocation {
    /// Uses the original application's native base-directory resolver and
    /// configured identifier. Named identifiers remain a startup integration
    /// proposal until the owning configuration adopts the same mapping.
    #[cfg(feature = "desktop")]
    pub fn from_app<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        choice: ProfileChoice,
    ) -> Result<Self, NativeProfileError> {
        use tauri::Manager;

        let base = if cfg!(target_os = "windows") {
            app.path().local_data_dir()
        } else if cfg!(any(target_os = "macos", target_os = "linux")) {
            app.path().data_dir()
        } else {
            return Err(NativeProfileError::InvalidLocation);
        }
        .map_err(|_| NativeProfileError::InvalidLocation)?;

        Self::from_native_parts(choice, base, &app.config().identifier)
    }

    fn from_native_parts(
        choice: ProfileChoice,
        native_base: PathBuf,
        configured_identifier: &str,
    ) -> Result<Self, NativeProfileError> {
        if !usable_native_base(&native_base) {
            return Err(NativeProfileError::InvalidLocation);
        }
        let application_identifier = choice.application_identifier();
        let directory = choice.directory_component();
        if configured_identifier != application_identifier {
            return Err(NativeProfileError::ContextMismatch);
        }
        Ok(Self {
            data_directory: native_base.join(&directory),
            profile_id: ProfileId(directory),
            application_identifier,
        })
    }

    pub fn data_directory(&self) -> &Path {
        &self.data_directory
    }

    pub fn profile_id(&self) -> &ProfileId {
        &self.profile_id
    }

    pub fn application_identifier(&self) -> &str {
        &self.application_identifier
    }
}

#[cfg(test)]
#[path = "profile/tests.rs"]
mod tests;
