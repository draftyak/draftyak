use super::{ProfileChoice, ProfileName};
use std::ffi::{OsStr, OsString};
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ProfileSelectionError;

impl fmt::Display for ProfileSelectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Native profile arguments unavailable")
    }
}

impl std::error::Error for ProfileSelectionError {}

/// Parse native arguments after the executable name, before creating the app
/// context, builder or plugins. Unknown arguments are never forwarded.
/// This selects profile DATA; it admits no path, instance, lease or key.
pub(crate) fn select_native_profile(
    arguments: impl IntoIterator<Item = OsString>,
) -> Result<ProfileChoice, ProfileSelectionError> {
    let mut arguments = arguments.into_iter();
    let Some(flag) = arguments.next() else {
        return Ok(ProfileChoice::Default);
    };
    if flag.as_os_str() != OsStr::new("--profile") {
        return Err(ProfileSelectionError);
    }
    let name = arguments.next().ok_or(ProfileSelectionError)?;
    // The only accepted forms are zero arguments or this exact two-argument
    // pair. Inspect at most one trailing argument rather than draining input.
    if arguments.next().is_some() {
        return Err(ProfileSelectionError);
    }
    let name = name.as_os_str().to_str().ok_or(ProfileSelectionError)?;
    ProfileName::new(name)
        .map(ProfileChoice::Named)
        .map_err(|_| ProfileSelectionError)
}

#[cfg(test)]
#[path = "selection/tests.rs"]
mod tests;
