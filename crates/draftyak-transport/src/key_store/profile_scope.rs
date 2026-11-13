//! Canonical profile-to-record names. This data conveys no native admission authority.

use std::fmt;

use super::StoreError;

const RECORD_PREFIX: &str = "desktop-profile-identity-namespace-v1--";

/// A canonical desktop profile selection in a namespace separate from legacy records.
#[derive(Clone, Eq, PartialEq)]
pub struct NativeProfileScope {
    record_name: String,
}

impl NativeProfileScope {
    pub fn default_profile() -> Self {
        Self {
            record_name: format!("{RECORD_PREFIX}default"),
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
        })
    }

    pub(super) fn backend_record_name(&self) -> &str {
        &self.record_name
    }
}

impl fmt::Debug for NativeProfileScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NativeProfileScope([redacted])")
    }
}

#[cfg(test)]
mod tests;
