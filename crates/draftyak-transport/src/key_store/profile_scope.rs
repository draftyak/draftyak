//! Canonical profile record and service names, without native admission authority.

use std::fmt;

use super::{SERVICE, StoreError};

const RECORD_PREFIX: &str = "desktop-profile-identity-namespace-v1--";

/// A canonical desktop profile selection in a namespace separate from legacy records.
#[derive(Clone, Eq, PartialEq)]
pub struct NativeProfileScope {
    record_name: String,
    service_name: String,
}

impl NativeProfileScope {
    pub fn default_profile() -> Self {
        Self {
            record_name: format!("{RECORD_PREFIX}default"),
            service_name: format!("{SERVICE}.desktop-profile.default"),
        }
    }

    pub fn named_profile(name: &str) -> Result<Self, StoreError> {
        if name.is_empty()
            || name.len() > 32
            || name.starts_with('-')
            || name.ends_with('-')
            || !name
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return Err(StoreError::InvalidInput);
        }
        Ok(Self {
            record_name: format!("{RECORD_PREFIX}named-{name}"),
            service_name: format!("{SERVICE}.desktop-profile.named.{name}"),
        })
    }

    pub(super) fn backend_record_name(&self) -> &str {
        &self.record_name
    }

    pub(super) fn backend_service_name(&self) -> &str {
        &self.service_name
    }
}

impl fmt::Debug for NativeProfileScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NativeProfileScope([redacted])")
    }
}

#[cfg(test)]
mod tests;
