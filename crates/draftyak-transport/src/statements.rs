//! Native signing of the exact reviewed bytes of a retained typed statement with the stored
//! approval key. It never receives a PIN, builds no envelope or ticket and makes no consent,
//! authority, challenge or freshness decision; those stay with the caller's native flow and the
//! hub. Parsing, canonical form and signing all go through the protocol crate.

use std::fmt;

use draftyak_protocol::{
    device_api::{self, admin::ADMIN_REVIEW_KINDS},
    jcs::{self, JcsError},
    sign,
    statements::{
        self, Statement, admin::AdminStatement, pair_confirm::PairConfirmStatement,
        send::SendStatement,
    },
};
use serde::Serialize;

use crate::{codec, key_store::StoredIdentity};

/// The statement types this crate signs. Login, agent-session and consent signing are postponed
/// for the pilot; every type outside this list is refused as unavailable.
pub const RETAINED_TYPES: [&str; 3] = ["admin.v1", "approval.send.v1", "pair-confirm.v1"];
/// Native review integration is explicit even when the public contract later gains kinds.
pub const RETAINED_ADMIN_KINDS: [&str; 4] = [
    "account.disconnect",
    "account.mode-full",
    "security.device-capabilities",
    "data.backup",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StatementError {
    TooLarge,
    Parse(JcsError),
    Invalid,
    NonCanonical,
    Unavailable,
    OtherHub,
    SigningFailed,
}
impl StatementError {
    pub fn code(self) -> &'static str {
        match self {
            Self::TooLarge => "STATEMENT_TOO_LARGE",
            Self::Parse(error) => error.code(),
            Self::Invalid => "STATEMENT_INVALID",
            Self::NonCanonical => "STATEMENT_NONCANONICAL",
            Self::Unavailable => "STATEMENT_UNAVAILABLE",
            Self::OtherHub => "STATEMENT_OTHER_HUB",
            Self::SigningFailed => "STATEMENT_SIGNING_FAILED",
        }
    }
}
impl fmt::Display for StatementError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::TooLarge => "statement too large",
            Self::Parse(_) => "statement is not strict JSON",
            Self::Invalid => "invalid statement",
            Self::NonCanonical => "statement bytes are not canonical",
            Self::Unavailable => "statement type or kind unavailable",
            Self::OtherHub => "statement names another hub",
            Self::SigningFailed => "statement signing failed",
        })
    }
}
impl std::error::Error for StatementError {}

/// A typed statement of a retained type.
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum RetainedStatement {
    Send(SendStatement),
    Admin(AdminStatement),
    PairConfirm(PairConfirmStatement),
}
impl RetainedStatement {
    pub fn typ(&self) -> &'static str {
        match self {
            Self::Send(_) => "approval.send.v1",
            Self::Admin(_) => "admin.v1",
            Self::PairConfirm(_) => "pair-confirm.v1",
        }
    }
    fn hub(&self) -> &str {
        match self {
            Self::Send(statement) => &statement.hub,
            Self::Admin(statement) => &statement.hub,
            Self::PairConfirm(statement) => &statement.hub,
        }
    }
    fn valid(&self) -> bool {
        match self {
            Self::Send(statement) => statement.valid(),
            Self::Admin(statement) => statement.valid(),
            Self::PairConfirm(statement) => statement.valid(),
        }
    }
    // Both the merged review contract and this native integration must admit the kind.
    fn available(&self) -> bool {
        match self {
            Self::Admin(statement) => {
                ADMIN_REVIEW_KINDS.contains(&statement.kind.as_str())
                    && RETAINED_ADMIN_KINDS.contains(&statement.kind.as_str())
            }
            Self::Send(_) | Self::PairConfirm(_) => true,
        }
    }
}
impl TryFrom<Statement> for RetainedStatement {
    type Error = StatementError;
    fn try_from(statement: Statement) -> Result<Self, StatementError> {
        match statement {
            Statement::Send(statement) => Ok(Self::Send(statement)),
            Statement::Admin(statement) => Ok(Self::Admin(statement)),
            Statement::Pair(statement) => Ok(Self::PairConfirm(statement)),
            _ => Err(StatementError::Unavailable),
        }
    }
}

/// The exact canonical bytes of one valid retained statement, ready to sign.
#[derive(Clone)]
pub struct PreparedStatement {
    statement: RetainedStatement,
    bytes: Vec<u8>,
    input: Vec<u8>,
}
impl fmt::Debug for PreparedStatement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PreparedStatement")
            .field("typ", &self.typ())
            .finish_non_exhaustive()
    }
}
impl PreparedStatement {
    /// The reviewed `received` bytes of a `typ` statement, accepted only when they are exactly
    /// the canonical JCS of a valid retained statement of an available kind. Nothing is
    /// re-canonicalized.
    pub fn from_received(typ: &str, received: &[u8]) -> Result<Self, StatementError> {
        if !RETAINED_TYPES.contains(&typ) {
            return Err(StatementError::Unavailable);
        }
        if !device_api::check_statement_length(received) {
            return Err(StatementError::TooLarge);
        }
        jcs::parse_strict(received).map_err(StatementError::Parse)?;
        let statement = statements::parse_statement(typ, received)
            .ok_or(StatementError::Invalid)
            .and_then(RetainedStatement::try_from)?;
        if !statement.available() {
            return Err(StatementError::Unavailable);
        }
        let input = sign::signing_input(typ, &statement).map_err(|_| StatementError::Invalid)?;
        if statement_bytes(&input)? != received {
            return Err(StatementError::NonCanonical);
        }
        Ok(Self {
            statement,
            bytes: received.to_vec(),
            input,
        })
    }
    /// A statement the caller built, as the canonical bytes it signs, checked as received bytes
    /// are.
    pub fn from_statement(statement: RetainedStatement) -> Result<Self, StatementError> {
        // Reject invalid caller-built fields through the protocol before serializing them.
        if !statement.valid() {
            return Err(StatementError::Invalid);
        }
        let typ = statement.typ();
        let input = sign::signing_input(typ, &statement).map_err(|_| StatementError::Invalid)?;
        let bytes = statement_bytes(&input)?;
        Self::from_received(typ, bytes)
    }
    pub fn typ(&self) -> &'static str {
        self.statement.typ()
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn statement(&self) -> &RetainedStatement {
        &self.statement
    }
    pub fn signing_input(&self) -> &[u8] {
        &self.input
    }
    /// Signs these bytes with the identity's stored approval key when the statement names the
    /// identity's pinned hub. The signature is returned only after the protocol's verification
    /// opens these exact bytes with it under the stored public key.
    pub fn sign(&self, identity: &StoredIdentity) -> Result<SignedStatement, StatementError> {
        if self.statement.hub() != codec::hex(&identity.hub_pin()) {
            return Err(StatementError::OtherHub);
        }
        let signature = sign::sign(identity.signing_handle(), self.typ(), &self.statement)
            .map_err(|_| StatementError::SigningFailed)?;
        match sign::verify(
            self.typ(),
            &self.bytes,
            &signature,
            &identity.signing_public_key(),
        ) {
            Ok(Some(_)) => Ok(SignedStatement {
                typ: self.typ(),
                bytes: self.bytes.clone(),
                signature,
            }),
            _ => Err(StatementError::SigningFailed),
        }
    }
}
// The protocol owns the entire signing domain and JCS form. Its input has one prefix line;
// consume that API's returned statement bytes without reconstructing a second signing formula.
fn statement_bytes(input: &[u8]) -> Result<&[u8], StatementError> {
    input
        .splitn(2, |byte| *byte == b'\n')
        .nth(1)
        .ok_or(StatementError::NonCanonical)
}

/// The exact statement bytes and the stored approval key's 64-byte r||s signature over their
/// signing input. The caller builds the envelope and adds the PIN.
#[derive(Clone)]
pub struct SignedStatement {
    typ: &'static str,
    bytes: Vec<u8>,
    signature: [u8; 64],
}
impl fmt::Debug for SignedStatement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SignedStatement")
            .field("typ", &self.typ)
            .finish_non_exhaustive()
    }
}
impl SignedStatement {
    pub fn typ(&self) -> &'static str {
        self.typ
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn signature(&self) -> &[u8; 64] {
        &self.signature
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key_store::testing::TestStore;
    use draftyak_protocol::statements::admin::ADMIN_KINDS;

    fn admin(hub: &str, kind: &str) -> RetainedStatement {
        RetainedStatement::Admin(AdminStatement {
            v: 1,
            hub: hub.to_owned(),
            epoch: 1,
            device: "01JAZ3W3B6Q8M2V0G5T9K4X7RH".to_owned(),
            nonce: "AAECAwQFBgcICQoLDA0ODw".to_owned(),
            iat: 1_792_342_800_000,
            exp: 1_792_342_920_000,
            op: "01JAZ3W3B6Q8M2V0G5T9K4X7RJ".to_owned(),
            kind: kind.to_owned(),
            digest: "b".repeat(64),
        })
    }

    #[test]
    fn the_stored_key_signs_only_for_its_pinned_hub_and_signs_again_after_reload() {
        let reviewed = ADMIN_REVIEW_KINDS[0];
        let unreviewed = ADMIN_KINDS
            .iter()
            .copied()
            .find(|kind| !ADMIN_REVIEW_KINDS.contains(kind))
            .expect("an admin kind without a review subject");
        let backend = TestStore::new();
        let identity = backend
            .open("dytest-statements-unit")
            .unwrap()
            .create_identity([0xaa; 32])
            .unwrap();
        let prepared = PreparedStatement::from_statement(admin(&"a".repeat(64), reviewed))
            .expect("a reviewed admin kind");
        let signed = prepared.sign(&identity).unwrap();
        let key = identity.signing_public_key();
        assert_eq!(signed.typ(), "admin.v1");
        assert_eq!(signed.bytes(), prepared.bytes());
        assert!(
            sign::verify("admin.v1", signed.bytes(), signed.signature(), &key)
                .unwrap()
                .is_some()
        );
        assert!(matches!(
            statements::open_typed_statement("admin.v1", signed.bytes(), signed.signature(), &key),
            Some(Statement::Admin(_))
        ));
        assert_eq!(
            format!("{signed:?}"),
            "SignedStatement { typ: \"admin.v1\", .. }"
        );
        drop(identity);
        let reloaded = backend
            .open("dytest-statements-unit")
            .unwrap()
            .load_identity()
            .unwrap();
        assert_eq!(
            prepared.sign(&reloaded).unwrap().signature(),
            signed.signature()
        );

        let other = backend
            .open("dytest-statements-other")
            .unwrap()
            .create_identity([0xbb; 32])
            .unwrap();
        assert_eq!(prepared.sign(&other).unwrap_err(), StatementError::OtherHub);
        let own = PreparedStatement::from_statement(admin(&"b".repeat(64), reviewed)).unwrap();
        assert!(own.sign(&other).is_ok());
        assert_eq!(own.sign(&reloaded).unwrap_err(), StatementError::OtherHub);
        assert_eq!(
            PreparedStatement::from_statement(admin(&"a".repeat(64), unreviewed)).unwrap_err(),
            StatementError::Unavailable
        );
    }
}
