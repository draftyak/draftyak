use std::collections::BTreeSet;

use draftyak_protocol::{
    device_api::{DEVICE_API_ROUTES, STATEMENT_BYTES, admin::ADMIN_REVIEW_KINDS},
    jcs::{self, JCS_MAX_DEPTH, JcsError},
    statements::{self, Statement, admin::ADMIN_KINDS, common::MAX_SAFE, send::SendStatement},
};
use draftyak_transport::statements::{
    PreparedStatement, RETAINED_ADMIN_KINDS, RETAINED_TYPES, RetainedStatement, StatementError,
};
use serde_json::Value;

const SEND: &str = include_str!("../../../spec/vectors/statements/approval.send.v1.json");
const ADMIN: &str = include_str!("../../../spec/vectors/statements/admin.v1.json");
const PAIR: &str = include_str!("../../../spec/vectors/statements/pair-confirm.v1.json");
const LOGIN: &str = include_str!("../../../spec/vectors/statements/login.v1.json");
const AGENT: &str = include_str!("../../../spec/vectors/statements/agent-session.v1.json");
const ROTATE: &str = include_str!("../../../spec/vectors/statements/hub-key-rotate.v1.json");
const REFUSALS: &str = include_str!("../../../spec/vectors/jcs/refusals.json");
const SOURCE: &str = include_str!("../src/statements.rs");
const RETAINED: [(&str, &str); 3] = [
    ("approval.send.v1", SEND),
    ("admin.v1", ADMIN),
    ("pair-confirm.v1", PAIR),
];
const POSTPONED: [(&str, &str); 3] = [
    ("login.v1", LOGIN),
    ("agent-session.v1", AGENT),
    ("hub-key-rotate.v1", ROTATE),
];
const BACKSLASH: char = '\\';

fn vectors(json: &str) -> Value {
    serde_json::from_str(json).expect("vector document")
}
fn cases(document: &Value) -> &[Value] {
    document["cases"].as_array().expect("vector cases")
}
fn by_id<'a>(document: &'a Value, id: &str) -> &'a Value {
    cases(document)
        .iter()
        .find(|case| case["id"] == id)
        .expect("vector case")
}
fn unhex(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2), "hex length");
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex digits"))
        .collect()
}
fn received(case: &Value) -> Vec<u8> {
    unhex(case["receivedHex"].as_str().expect("received bytes"))
}
fn utf8(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).expect("UTF-8 statement")
}
fn refused(typ: &str, bytes: &[u8]) -> StatementError {
    PreparedStatement::from_received(typ, bytes).expect_err("refused statement")
}
fn signing_input(typ: &str, bytes: &[u8]) -> Vec<u8> {
    [format!("draftyak/v1/{typ}\n").as_bytes(), bytes].concat()
}
/// The received bytes of the first vector case of `typ` that prepares.
fn signable(typ: &str) -> Vec<u8> {
    let (_, json) = RETAINED
        .iter()
        .find(|(retained, _)| *retained == typ)
        .expect("retained type");
    cases(&vectors(json))
        .iter()
        .map(received)
        .find(|bytes| PreparedStatement::from_received(typ, bytes).is_ok())
        .expect("a signable vector case")
}
/// What the protocol's public readers say about received bytes, in the order they are checked.
fn expected(typ: &str, bytes: &[u8]) -> Result<(), StatementError> {
    jcs::parse_strict(bytes).map_err(StatementError::Parse)?;
    match statements::parse_statement(typ, bytes) {
        None => Err(StatementError::Invalid),
        Some(Statement::Admin(admin)) if !ADMIN_REVIEW_KINDS.contains(&admin.kind.as_str()) => {
            Err(StatementError::Unavailable)
        }
        Some(_) if !jcs::is_canonical(bytes) => Err(StatementError::NonCanonical),
        Some(_) => Ok(()),
    }
}
/// `inner` wrapped in `levels` containers, alternating arrays and objects.
fn nested(levels: usize, inner: &str) -> String {
    (0..levels).fold(inner.to_owned(), |value, level| {
        if level.is_multiple_of(2) {
            format!("[{value}]")
        } else {
            format!("{{\"n\":{value}}}")
        }
    })
}
fn escaped(name: &str) -> String {
    format!("{BACKSLASH}u{:04x}{}", name.as_bytes()[0], &name[1..])
}

#[test]
fn native_admin_signing_keeps_the_exact_reviewed_kind_set() {
    let expected = [
        "account.disconnect",
        "account.mode-full",
        "security.device-capabilities",
        "data.backup",
    ];
    assert_eq!(RETAINED_ADMIN_KINDS, expected);
    assert_eq!(ADMIN_REVIEW_KINDS, expected);
    let document = vectors(ADMIN);
    for kind in ADMIN_KINDS {
        let bytes = received(by_id(&document, &format!("kind-{kind}")));
        if expected.contains(kind) {
            assert!(
                PreparedStatement::from_received("admin.v1", &bytes).is_ok(),
                "{kind}"
            );
        } else {
            assert_eq!(
                refused("admin.v1", &bytes),
                StatementError::Unavailable,
                "{kind}"
            );
        }
    }
}

#[test]
fn only_retained_device_statement_types_prepare() {
    let routed: BTreeSet<&str> = DEVICE_API_ROUTES
        .iter()
        .filter_map(|route| route.statement_type)
        .collect();
    let postponed = BTreeSet::from(["agent-session.v1", "consent.v1", "login.v1"]);
    assert!(
        routed.difference(&postponed).copied().eq(RETAINED_TYPES),
        "the retained types are the routed device statements apart from the postponed ones"
    );
    for typ in RETAINED_TYPES {
        assert!(statements::TYPES.contains(&typ), "{typ}");
    }
    let send = signable("approval.send.v1");
    let oversize = vec![b'['; STATEMENT_BYTES + 1];
    let probes: [&[u8]; 4] = [&send, &oversize, b"{", b""];
    for (typ, json) in POSTPONED {
        let document = vectors(json);
        for case in cases(&document) {
            assert_eq!(
                refused(typ, &received(case)),
                StatementError::Unavailable,
                "{typ} {}",
                case["id"]
            );
        }
        let statement = statements::parse_statement(typ, &received(by_id(&document, "valid")))
            .expect("a valid postponed statement");
        assert!(matches!(
            RetainedStatement::try_from(statement),
            Err(StatementError::Unavailable)
        ));
        for bytes in probes {
            assert_eq!(refused(typ, bytes), StatementError::Unavailable, "{typ}");
        }
    }
    for typ in [
        "consent.v1",
        "send-ticket.v1",
        "send-receipt.v1",
        "approval.send.v2",
        "Approval.send.v1",
        "approval.send.v1\n",
        " admin.v1",
        "admin",
        "",
        "__proto__",
    ] {
        for bytes in probes {
            assert_eq!(refused(typ, bytes), StatementError::Unavailable, "{typ:?}");
        }
    }
    for (typ, _) in RETAINED {
        for (other, json) in RETAINED.iter().chain(&POSTPONED) {
            if *other != typ {
                let bytes = received(by_id(&vectors(json), "valid"));
                assert_eq!(
                    refused(typ, &bytes),
                    StatementError::Invalid,
                    "{other} as {typ}"
                );
            }
        }
    }
}

#[test]
fn shared_vectors_prepare_exactly_their_canonical_available_statements() {
    for (typ, json) in RETAINED {
        let document = vectors(json);
        let mut prepared_ids = Vec::new();
        for case in cases(&document) {
            let id = case["id"].as_str().expect("case id");
            assert_eq!(case["typ"], typ, "{id}");
            let bytes = received(case);
            match (
                PreparedStatement::from_received(typ, &bytes),
                expected(typ, &bytes),
            ) {
                (Ok(prepared), Ok(())) => {
                    prepared_ids.push(id);
                    assert_eq!(prepared.typ(), typ);
                    assert_eq!(prepared.statement().typ(), typ);
                    assert_eq!(prepared.bytes(), bytes, "{id}");
                    assert_eq!(prepared.signing_input(), signing_input(typ, &bytes), "{id}");
                    let vector_input = unhex(case["signingInputHex"].as_str().expect("input"));
                    assert_eq!(
                        prepared.signing_input() == vector_input,
                        id != "wrong-domain",
                        "{id}: only wrong-domain signs under another type"
                    );
                    let rebuilt =
                        PreparedStatement::from_statement(prepared.statement().clone()).unwrap();
                    assert_eq!(rebuilt.bytes(), bytes, "{id}");
                    assert_eq!(rebuilt.signing_input(), prepared.signing_input(), "{id}");
                    let typed = statements::parse_statement(typ, &bytes)
                        .map(RetainedStatement::try_from)
                        .expect("typed statement")
                        .expect("retained statement");
                    let typed = PreparedStatement::from_statement(typed).unwrap();
                    assert_eq!(typed.bytes(), bytes, "{id}");
                }
                (Err(error), Err(reason)) => assert_eq!(error, reason, "{typ} {id}"),
                (actual, reason) => panic!("{typ} {id}: {:?} for {reason:?}", actual.map(|_| ())),
            }
        }
        match typ {
            "approval.send.v1" => assert_eq!(prepared_ids.len(), 15, "{prepared_ids:?}"),
            "pair-confirm.v1" => assert_eq!(prepared_ids.len(), 18, "{prepared_ids:?}"),
            _ => {
                let reviewed: Vec<String> = ADMIN_REVIEW_KINDS
                    .iter()
                    .map(|kind| format!("kind-{kind}"))
                    .collect();
                assert!(
                    reviewed
                        .iter()
                        .all(|id| prepared_ids.contains(&id.as_str()))
                );
                assert!(prepared_ids.len() >= ADMIN_REVIEW_KINDS.len());
            }
        }
    }
}

#[test]
fn pinned_vector_cases_keep_their_reasons() {
    use StatementError::*;
    for (typ, json) in RETAINED {
        let document = vectors(json);
        let check = |id: &str, reason: Result<(), StatementError>| {
            let actual = PreparedStatement::from_received(typ, &received(by_id(&document, id)));
            assert_eq!(actual.map(|_| ()), reason, "{typ} {id}");
        };
        // An admin kind signs once its review subject is merged; refusing the rest comes first.
        let reviewed = |id: &str| {
            by_id(&document, id)["statement"]["kind"]
                .as_str()
                .is_none_or(|kind| ADMIN_REVIEW_KINDS.contains(&kind))
        };
        let base = reviewed("valid");
        let gated =
            |reason: Result<(), StatementError>| if base { reason } else { Err(Unavailable) };
        check("duplicate-member", Err(Parse(JcsError::DuplicateKey)));
        for id in [
            "unknown-field",
            "positional",
            "fraction",
            "unsafe-integer",
            "lifetime-too-long",
            "expiry-before-issue",
            "nonce-padding",
            "epoch-negative",
        ] {
            check(id, Err(Invalid));
        }
        for id in ["noncanonical-space", "noncanonical-order"] {
            check(id, gated(Err(NonCanonical)));
        }
        for id in [
            "valid",
            "epoch-zero",
            "wrong-domain",
            "wrong-key",
            "statement-flipped",
        ] {
            check(id, gated(Ok(())));
        }
        let ids = cases(&document)
            .iter()
            .filter_map(|case| case["id"].as_str());
        match typ {
            "approval.send.v1" => {
                for id in [
                    "duplicate-ack",
                    "unknown-ack",
                    "object-form-ack",
                    "missing-not-before",
                ] {
                    check(id, Err(Invalid));
                }
                // Flag and window agreement is checked against the review, not here.
                for id in [
                    "flags-acked-flipped",
                    "missing-required-ack",
                    "flags-detail-changed",
                    "window-mismatch",
                    "legacy-chat-current-window-refused",
                ] {
                    check(id, Ok(()));
                }
            }
            "admin.v1" => {
                check("unknown-admin-kind", Err(Invalid));
                assert_eq!(
                    ids.filter(|id| id.starts_with("kind-")).count(),
                    ADMIN_KINDS.len()
                );
                let kinds = ADMIN_KINDS.iter().map(|kind| format!("kind-{kind}"));
                for id in kinds.chain(["advertised-addresses".to_owned()]) {
                    let id = id.as_str();
                    check(id, reviewed(id).then_some(()).ok_or(Unavailable));
                }
                assert!(ADMIN_KINDS.len() > ADMIN_REVIEW_KINDS.len());
            }
            _ => {
                let mut reordered = 0;
                for id in ids {
                    if id.starts_with("reordered-") {
                        check(id, Err(Invalid));
                        reordered += 1;
                    } else if id.starts_with("ordered-") {
                        check(id, Ok(()));
                    }
                }
                assert!(reordered >= 12);
                for id in [
                    "duplicate-capability",
                    "empty-capabilities",
                    "self-confirmation",
                    "preset-excluded",
                    "user-id-excluded",
                    "host-role-refused",
                    "host-capability-refused",
                    "unknown-role",
                    "unknown-capability",
                    "object-form-role",
                    "object-form-capability",
                ] {
                    check(id, Err(Invalid));
                }
                for id in [
                    "mobile-capabilities",
                    "cli-capabilities",
                    "canonical-subset",
                ] {
                    check(id, Ok(()));
                }
            }
        }
    }
}

#[test]
fn every_strict_parser_refusal_keeps_its_code_for_each_retained_type() {
    let document = vectors(REFUSALS);
    let mut refusals = 0;
    for case in cases(&document) {
        let Some(code) = case["error"].as_str() else {
            continue;
        };
        let bytes = match (case["input"].as_str(), case["inputHex"].as_str()) {
            (Some(text), None) => text.as_bytes().to_vec(),
            (None, Some(hex)) => unhex(hex),
            _ => panic!("{}", case["id"]),
        };
        for typ in RETAINED_TYPES {
            let error = refused(typ, &bytes);
            assert!(
                matches!(error, StatementError::Parse(_)),
                "{typ} {}",
                case["id"]
            );
            assert_eq!(error.code(), code, "{typ} {}", case["id"]);
        }
        refusals += 1;
    }
    assert!(refusals >= 43, "{refusals}");
}

#[test]
fn repeated_and_escaped_member_names_refuse_at_every_depth() {
    use StatementError::*;
    for typ in RETAINED_TYPES {
        let bytes = signable(typ);
        let base = utf8(&bytes);
        let value = jcs::parse_strict(&bytes).unwrap();
        let names: Vec<&String> = value
            .as_object()
            .expect("statement object")
            .keys()
            .collect();
        assert!(names.len() >= 10, "{typ}");
        for name in names {
            for written in [name.clone(), escaped(name)] {
                let first = base.replacen('{', &format!("{{\"{written}\":0,"), 1);
                let last = format!("{},\"{written}\":0}}", &base[..base.len() - 1]);
                for repeated in [first, last] {
                    assert_eq!(
                        refused(typ, repeated.as_bytes()),
                        Parse(JcsError::DuplicateKey),
                        "{typ} {written}"
                    );
                }
            }
            let renamed = base.replacen(
                &format!("\"{name}\":"),
                &format!("\"{}\":", escaped(name)),
                1,
            );
            assert_ne!(renamed, base);
            assert_eq!(
                refused(typ, renamed.as_bytes()),
                NonCanonical,
                "{typ} {name}"
            );
        }
        let rest = &base[1..];
        for depth in 2..=JCS_MAX_DEPTH {
            for inner in [
                "{\"a\":1,\"a\":2}".to_owned(),
                format!("{{\"a\":1,\"{}\":2}}", escaped("a")),
            ] {
                let added = format!("{{\"zz\":{},{rest}", nested(depth - 2, &inner));
                assert_eq!(
                    refused(typ, added.as_bytes()),
                    Parse(JcsError::DuplicateKey),
                    "{typ} at depth {depth}"
                );
            }
        }
        let deep = format!(
            "{{\"zz\":{},{rest}",
            nested(JCS_MAX_DEPTH - 1, "{\"a\":1,\"a\":2}")
        );
        assert_eq!(refused(typ, deep.as_bytes()), Parse(JcsError::TooDeep));
        let lone = base.replacen("\"nonce\":\"", &format!("\"nonce\":\"{BACKSLASH}ud800"), 1);
        assert_eq!(
            refused(typ, lone.as_bytes()),
            Parse(JcsError::LoneSurrogate)
        );
        let at = base.find("\"nonce\":\"").unwrap() + 9;
        let invalid = [&bytes[..at], &[0xff], &bytes[at..]].concat();
        assert_eq!(refused(typ, &invalid), Parse(JcsError::InvalidUtf8));
        for trailing in [&b"x"[..], b"{}", b",", b"]"] {
            let extended = [&bytes[..], trailing].concat();
            assert_eq!(refused(typ, &extended), Parse(JcsError::Syntax));
        }
        for spaced in [[&bytes[..], b"\n"].concat(), [&b" "[..], &bytes].concat()] {
            assert_eq!(refused(typ, &spaced), NonCanonical);
        }
        let padded = |length: usize| {
            let mut padded = bytes.clone();
            padded.resize(length, b' ');
            padded
        };
        assert_eq!(refused(typ, &padded(STATEMENT_BYTES)), NonCanonical);
        assert_eq!(refused(typ, &padded(STATEMENT_BYTES + 1)), TooLarge);
        assert_eq!(
            refused(typ, &vec![b'['; STATEMENT_BYTES]),
            Parse(JcsError::TooDeep)
        );
        assert_eq!(refused(typ, &vec![b'['; STATEMENT_BYTES + 1]), TooLarge);
    }
}

#[test]
fn typed_statements_prepare_their_jcs_and_received_bytes_are_never_recanonicalized() {
    // Moved from the skeleton's statements_sign_the_jcs_form onto the retained types.
    for typ in RETAINED_TYPES {
        let bytes = signable(typ);
        let base = utf8(&bytes);
        let typed = statements::parse_statement(typ, &bytes)
            .map(RetainedStatement::try_from)
            .unwrap()
            .unwrap();
        let prepared = PreparedStatement::from_statement(typed).unwrap();
        assert_eq!(prepared.bytes(), bytes);
        assert_eq!(prepared.signing_input(), signing_input(typ, &bytes));
        let value = jcs::parse_strict(&bytes).unwrap();
        let reversed = format!(
            "{{{}}}",
            value
                .as_object()
                .unwrap()
                .iter()
                .rev()
                .map(|(name, value)| format!("{}:{value}", Value::from(name.as_str())))
                .collect::<Vec<_>>()
                .join(",")
        );
        let epoch = base.find("\"epoch\":").unwrap() + 8;
        let digits = epoch + base[epoch..].find(|c: char| !c.is_ascii_digit()).unwrap();
        let hub = base.find("\"hub\":\"").unwrap() + 7;
        for variant in [
            reversed,
            base.replacen(':', ": ", 1),
            base.replacen(',', " ,", 1),
            format!("{}.0{}", &base[..digits], &base[digits..]),
            format!("{}e0{}", &base[..digits], &base[digits..]),
            format!(
                "{}{}{}",
                &base[..hub],
                escaped(&base[hub..hub + 1]),
                &base[hub + 1..]
            ),
        ] {
            assert_ne!(variant, base);
            let same =
                statements::parse_statement(typ, variant.as_bytes()).expect("same statement");
            assert_eq!(jcs::canonicalize(&same).unwrap(), base, "{variant}");
            assert_eq!(
                refused(typ, variant.as_bytes()),
                StatementError::NonCanonical,
                "{variant}"
            );
        }
    }
    // Moved from jcs_refuses_duplicate_keys_only_when_serializing: serde_json keeps the last of a
    // repeated member, and the transport refuses the input instead of signing either value.
    let base = utf8(&signable("approval.send.v1"));
    let repeated = format!("{},\"epoch\":7}}", &base[..base.len() - 1]);
    let lenient: Value = serde_json::from_str(&repeated).unwrap();
    assert_eq!(lenient["epoch"], 7);
    assert_eq!(
        refused("approval.send.v1", repeated.as_bytes()),
        StatementError::Parse(JcsError::DuplicateKey)
    );
    // Moved from statements_that_repeat_a_key_are_refused_while_parsing.
    let escaped_repeat = format!("[{{\"a\":1,\"{}\":2}}]", escaped("a"));
    assert_eq!(escaped_repeat.len(), 20);
    for typ in RETAINED_TYPES {
        for repeated in [
            "{\"a\":1,\"a\":2}",
            "{\"a\":{\"b\":1,\"b\":2}}",
            escaped_repeat.as_str(),
        ] {
            assert_eq!(
                refused(typ, repeated.as_bytes()),
                StatementError::Parse(JcsError::DuplicateKey),
                "{typ} {repeated}"
            );
        }
    }
}

#[test]
fn caller_built_statements_are_checked_as_received_bytes_are() {
    use StatementError::*;
    let Some(Statement::Send(send)) =
        statements::parse_statement("approval.send.v1", &signable("approval.send.v1"))
    else {
        panic!("send statement");
    };
    assert!(PreparedStatement::from_statement(RetainedStatement::Send(send.clone())).is_ok());
    let edits: [fn(&mut SendStatement); 6] = [
        |s| s.epoch = MAX_SAFE + 1,
        |s| s.hub = s.hub.to_uppercase(),
        |s| s.exp = s.iat + 120_001,
        |s| s.nonce.push('A'),
        |s| s.flags_acked.extend(s.flags_acked.clone()),
        |s| s.hub = "a".repeat(STATEMENT_BYTES + 1),
    ];
    for (index, edit) in edits.into_iter().enumerate() {
        let mut statement = send.clone();
        edit(&mut statement);
        assert_eq!(
            PreparedStatement::from_statement(RetainedStatement::Send(statement)).unwrap_err(),
            Invalid,
            "edit {index}"
        );
    }
    let Some(Statement::Admin(admin)) =
        statements::parse_statement("admin.v1", &signable("admin.v1"))
    else {
        panic!("admin statement");
    };
    let unreviewed = ADMIN_KINDS
        .iter()
        .copied()
        .find(|kind| !ADMIN_REVIEW_KINDS.contains(kind))
        .unwrap();
    for (kind, reason) in [
        (unreviewed, Unavailable),
        ("unregistered-test-operation", Invalid),
    ] {
        let mut statement = admin.clone();
        statement.kind = kind.to_owned();
        assert_eq!(
            PreparedStatement::from_statement(RetainedStatement::Admin(statement)).unwrap_err(),
            reason,
            "{kind}"
        );
    }
    let Some(Statement::Pair(pair)) =
        statements::parse_statement("pair-confirm.v1", &signable("pair-confirm.v1"))
    else {
        panic!("pair-confirm statement");
    };
    let mut own = pair.clone();
    own.candidate = own.device.clone();
    let mut empty = pair.clone();
    empty.capabilities.clear();
    let mut reversed = pair.clone();
    reversed.capabilities.reverse();
    for statement in [own, empty, reversed] {
        assert_eq!(
            PreparedStatement::from_statement(RetainedStatement::PairConfirm(statement))
                .unwrap_err(),
            Invalid
        );
    }
}

#[test]
fn errors_and_prepared_statements_have_fixed_content_free_diagnostics() {
    use StatementError::*;
    for (error, code, display, debug) in [
        (
            TooLarge,
            "STATEMENT_TOO_LARGE",
            "statement too large",
            "TooLarge",
        ),
        (Invalid, "STATEMENT_INVALID", "invalid statement", "Invalid"),
        (
            NonCanonical,
            "STATEMENT_NONCANONICAL",
            "statement bytes are not canonical",
            "NonCanonical",
        ),
        (
            Unavailable,
            "STATEMENT_UNAVAILABLE",
            "statement type or kind unavailable",
            "Unavailable",
        ),
        (
            OtherHub,
            "STATEMENT_OTHER_HUB",
            "statement names another hub",
            "OtherHub",
        ),
        (
            SigningFailed,
            "STATEMENT_SIGNING_FAILED",
            "statement signing failed",
            "SigningFailed",
        ),
    ] {
        assert_eq!(error.code(), code);
        assert_eq!(error.to_string(), display);
        assert_eq!(format!("{error:?}"), debug);
    }
    for (parse, code, debug) in [
        (JcsError::Syntax, "JCS_SYNTAX", "Parse(Syntax)"),
        (
            JcsError::InvalidUtf8,
            "JCS_INVALID_UTF8",
            "Parse(InvalidUtf8)",
        ),
        (
            JcsError::LoneSurrogate,
            "JCS_LONE_SURROGATE",
            "Parse(LoneSurrogate)",
        ),
        (
            JcsError::DuplicateKey,
            "JCS_DUPLICATE_KEY",
            "Parse(DuplicateKey)",
        ),
        (
            JcsError::NumberRange,
            "JCS_NUMBER_RANGE",
            "Parse(NumberRange)",
        ),
        (JcsError::TooDeep, "JCS_TOO_DEEP", "Parse(TooDeep)"),
        (
            JcsError::UnsupportedValue,
            "JCS_UNSUPPORTED_VALUE",
            "Parse(UnsupportedValue)",
        ),
    ] {
        let error = Parse(parse);
        assert_eq!(error.code(), code);
        assert_eq!(error.to_string(), "statement is not strict JSON");
        assert_eq!(format!("{error:?}"), debug);
    }
    const MARKER: &str = "DYTEST-MARKER";
    let base = utf8(&signable("approval.send.v1"));
    let marked: [(String, Vec<u8>); 6] = [
        (
            "consent.v1".to_owned(),
            format!("{{\"{MARKER}\":\"{MARKER}\"}}").into_bytes(),
        ),
        (format!("{MARKER}.v1"), base.clone().into_bytes()),
        (
            "approval.send.v1".to_owned(),
            base.replacen('{', &format!("{{\"{MARKER}\":\"{MARKER}\","), 1)
                .into_bytes(),
        ),
        (
            "admin.v1".to_owned(),
            format!("{{\"{MARKER}\":1,\"{MARKER}\":2}}").into_bytes(),
        ),
        (
            "pair-confirm.v1".to_owned(),
            [format!("{{\"{MARKER}\":\"").as_bytes(), &[0xff], b"\"}"].concat(),
        ),
        (
            "approval.send.v1".to_owned(),
            MARKER
                .repeat(STATEMENT_BYTES / MARKER.len() + 1)
                .into_bytes(),
        ),
    ];
    let mut codes = BTreeSet::new();
    for (typ, bytes) in &marked {
        let error = refused(typ, bytes);
        codes.insert(error.code());
        for shown in [
            error.code().to_owned(),
            error.to_string(),
            format!("{error:?}"),
        ] {
            assert!(!shown.contains("DYTEST"), "{shown}");
            assert!(shown.is_ascii() && shown.len() <= 40, "{shown}");
            assert!(!shown.chars().any(char::is_control), "{shown}");
        }
    }
    assert_eq!(
        codes,
        BTreeSet::from([
            "JCS_DUPLICATE_KEY",
            "JCS_INVALID_UTF8",
            "STATEMENT_INVALID",
            "STATEMENT_TOO_LARGE",
            "STATEMENT_UNAVAILABLE",
        ])
    );
    for typ in RETAINED_TYPES {
        let prepared = PreparedStatement::from_received(typ, &signable(typ)).unwrap();
        assert_eq!(
            format!("{prepared:?}"),
            format!("PreparedStatement {{ typ: {typ:?}, .. }}")
        );
    }
}

#[test]
fn the_module_parses_and_signs_only_through_the_protocol_crate() {
    let text: String = SOURCE.split_whitespace().collect();
    for banned in [
        "serde_json",
        "canonicalize(",
        "is_canonical(",
        "from_slice",
        "from_str",
        "from_value",
        "ecdsa",
        "SigningKey",
        "unsafe",
    ] {
        assert!(!text.contains(banned), "statements.rs uses {banned}");
    }
    for (at, _) in text.match_indices("sign::") {
        let call = &text[at + "sign::".len()..];
        assert!(
            ["sign(", "signing_input(", "verify("]
                .iter()
                .any(|allowed| call.starts_with(allowed)),
            "statements.rs calls sign::{}",
            &call[..call.len().min(24)]
        );
    }
    assert!(text.contains("jcs::parse_strict(received)"));
    assert!(text.contains("statements::parse_statement(typ,received)"));
    assert!(text.contains("ADMIN_REVIEW_KINDS.contains("));
    assert_eq!(text.matches("signing_handle()").count(), 1);
    let signed = text
        .find("sign::sign(identity.signing_handle(),self.typ(),&self.statement)")
        .expect("one signing call with the stored key");
    let verified = text
        .find("sign::verify(self.typ(),&self.bytes,&signature,&identity.signing_public_key()")
        .expect("the signature is verified over the exact bytes");
    let returned = text.find("Ok(SignedStatement{").expect("the signed result");
    assert!(signed < verified && verified < returned);
}

#[cfg(feature = "mock-store")]
#[path = "support/statement_verifier.rs"]
mod verifier;

#[cfg(feature = "mock-store")]
mod stored_key {
    use super::{
        verifier::{Opening, open_in_typescript},
        *,
    };
    use draftyak_protocol::sign;
    use draftyak_transport::{
        key_store::{StoredIdentity, testing::TestStore},
        statements::SignedStatement,
    };
    use rcgen::{KeyPair, PKCS_ECDSA_P256_SHA256};
    use serde_json::json;

    const HUB: [u8; 32] = [0xaa; 32];

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
    fn key(document: &Value, name: &str, field: &str) -> Vec<u8> {
        sign::base64url_decode(document["keys"][name][field].as_str().expect("vector key"))
            .expect("canonical vector key")
    }
    /// A stored identity whose approval key is a vector's test-only key, beside a new transport
    /// key.
    fn vector_identity(
        backend: &TestStore,
        profile: &str,
        pkcs8: &[u8],
        hid: [u8; 32],
    ) -> StoredIdentity {
        let transport = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)
            .unwrap()
            .serialize_der();
        let record = jcs::canonicalize(&json!({
            "hid": hex(&hid),
            "signingKey": sign::base64url_encode(pkcs8),
            "transportKey": sign::base64url_encode(&transport),
            "v": 1,
        }))
        .unwrap();
        backend.replace_record(profile, record.as_bytes()).unwrap();
        backend.open(profile).unwrap().load_identity().unwrap()
    }
    fn flip_hub(bytes: &[u8]) -> Vec<u8> {
        let text = utf8(bytes);
        let hub = format!("\"hub\":\"{}\"", "a".repeat(64));
        assert!(text.contains(&hub));
        text.replacen(&hub, &format!("\"hub\":\"{}b\"", "a".repeat(63)), 1)
            .into_bytes()
    }

    #[test]
    fn vector_keys_reproduce_each_rfc6979_signature_of_a_signable_case() {
        let backend = TestStore::new();
        for (typ, json) in RETAINED {
            let document = vectors(json);
            let signer = key(&document, "signer", "publicKeySpki");
            let identity = vector_identity(
                &backend,
                "dytest-statements-vector",
                &key(&document, "signer", "privateKeyPkcs8"),
                HUB,
            );
            assert_eq!(identity.signing_public_key().as_slice(), signer);
            let (mut signed, mut reproduced) = (0, 0);
            for case in cases(&document) {
                let id = case["id"].as_str().unwrap();
                let bytes = received(case);
                let Ok(prepared) = PreparedStatement::from_received(typ, &bytes) else {
                    continue;
                };
                let statement = prepared.sign(&identity).unwrap();
                signed += 1;
                assert_eq!(statement.typ(), typ);
                assert_eq!(statement.bytes(), bytes, "{id}");
                assert!(
                    sign::verify(typ, &bytes, statement.signature(), &signer)
                        .unwrap()
                        .is_some(),
                    "{id}"
                );
                let opened =
                    statements::open_typed_statement(typ, &bytes, statement.signature(), &signer)
                        .expect("the protocol opens the signature");
                assert_eq!(jcs::canonicalize(&opened).unwrap().as_bytes(), bytes);
                if let Some(vector) = case["rfc6979Signature"].as_str() {
                    let vector = sign::base64url_decode(vector).unwrap();
                    let same_input = prepared.signing_input()
                        == unhex(case["signingInputHex"].as_str().unwrap());
                    assert_eq!(
                        statement.signature().as_slice() == vector,
                        same_input,
                        "{typ} {id}"
                    );
                    reproduced += usize::from(same_input);
                }
            }
            match typ {
                "approval.send.v1" => assert_eq!((signed, reproduced), (15, 11)),
                "pair-confirm.v1" => assert_eq!((signed, reproduced), (18, 15)),
                _ => assert!(reproduced >= ADMIN_REVIEW_KINDS.len() && signed >= reproduced),
            }
            let other = vector_identity(
                &backend,
                "dytest-statements-other",
                &key(&document, "other", "privateKeyPkcs8"),
                HUB,
            );
            let statement = PreparedStatement::from_received(typ, &signable(typ))
                .unwrap()
                .sign(&other)
                .unwrap();
            let opens = |spki: &[u8]| {
                sign::verify(typ, statement.bytes(), statement.signature(), spki)
                    .unwrap()
                    .is_some()
            };
            assert!(
                !opens(signer.as_slice()),
                "{typ}: another key's signature fails"
            );
            assert!(opens(key(&document, "other", "publicKeySpki").as_slice()));
        }
    }

    #[test]
    fn stored_key_signatures_open_alike_in_rust_and_the_merged_typescript_reader() {
        let backend = TestStore::new();
        let identity = backend
            .open("dytest-statements-node")
            .unwrap()
            .create_identity(HUB)
            .unwrap();
        let spki = identity.signing_public_key();
        let other = key(&vectors(SEND), "other", "publicKeySpki");
        let mut signed: Vec<SignedStatement> = Vec::new();
        for (typ, json) in RETAINED {
            for case in cases(&vectors(json)) {
                if let Ok(prepared) = PreparedStatement::from_received(typ, &received(case)) {
                    signed.push(prepared.sign(&identity).unwrap());
                }
            }
        }
        assert!(signed.len() >= 37, "{}", signed.len());
        let flipped: Vec<Vec<u8>> = signed.iter().map(|s| flip_hub(s.bytes())).collect();
        let mut openings = Vec::new();
        for (statement, flipped) in signed.iter().zip(&flipped) {
            let typ = statement.typ();
            let elsewhere = RETAINED_TYPES
                .iter()
                .copied()
                .find(|candidate| *candidate != typ)
                .unwrap();
            for (typ, bytes, key) in [
                (typ, statement.bytes(), &spki[..]),
                (elsewhere, statement.bytes(), &spki[..]),
                (typ, flipped.as_slice(), &spki[..]),
                (typ, statement.bytes(), other.as_slice()),
            ] {
                openings.push(Opening {
                    typ,
                    bytes,
                    signature: statement.signature(),
                    key,
                });
            }
        }
        let typescript = open_in_typescript(&openings);
        for (index, (opening, opened)) in openings.iter().zip(&typescript).enumerate() {
            let rust = statements::open_typed_statement(
                opening.typ,
                opening.bytes,
                opening.signature,
                opening.key,
            )
            .map(|statement| jcs::canonicalize(&statement).unwrap());
            assert_eq!(opened, &rust, "opening {index}");
            assert_eq!(opened.is_some(), index.is_multiple_of(4), "opening {index}");
            if let Some(opened) = opened {
                assert_eq!(opened.as_bytes(), opening.bytes);
            }
        }
    }

    #[test]
    fn only_the_pinned_hub_signs_and_a_reloaded_identity_signs_identical_bytes() {
        let backend = TestStore::new();
        let prepared: Vec<PreparedStatement> = RETAINED_TYPES
            .iter()
            .map(|typ| PreparedStatement::from_received(typ, &signable(typ)).unwrap())
            .collect();
        let first: Vec<SignedStatement> = {
            let identity = backend
                .open("dytest-statements-reload")
                .unwrap()
                .create_identity(HUB)
                .unwrap();
            prepared
                .iter()
                .map(|statement| statement.sign(&identity).unwrap())
                .collect()
        };
        let reloaded = backend
            .open("dytest-statements-reload")
            .unwrap()
            .load_identity()
            .unwrap();
        for (statement, signed) in prepared.iter().zip(&first) {
            let again = statement.sign(&reloaded).unwrap();
            assert_eq!(again.signature(), signed.signature(), "{}", signed.typ());
            assert_eq!(again.bytes(), signed.bytes());
        }
        let elsewhere = backend
            .open("dytest-statements-elsewhere")
            .unwrap()
            .create_identity([0xab; 32])
            .unwrap();
        for statement in &prepared {
            assert_eq!(
                statement.sign(&elsewhere).unwrap_err(),
                StatementError::OtherHub,
                "{}",
                statement.typ()
            );
        }
        let Some(Statement::Send(mut send)) =
            statements::parse_statement("approval.send.v1", &signable("approval.send.v1"))
        else {
            panic!("send statement");
        };
        send.hub = "ab".repeat(32);
        let moved = PreparedStatement::from_statement(RetainedStatement::Send(send)).unwrap();
        assert!(moved.sign(&elsewhere).is_ok());
        assert_eq!(moved.sign(&reloaded).unwrap_err(), StatementError::OtherHub);
    }

    #[test]
    fn postponed_and_unreviewed_kinds_refuse_with_their_vector_key_loaded() {
        let backend = TestStore::new();
        let send =
            PreparedStatement::from_received("approval.send.v1", &signable("approval.send.v1"))
                .unwrap();
        for (typ, json) in POSTPONED {
            let document = vectors(json);
            let valid = by_id(&document, "valid");
            let hub = valid["statement"]["hub"].as_str().unwrap();
            let hid: [u8; 32] = unhex(hub).try_into().unwrap();
            let identity = vector_identity(
                &backend,
                "dytest-statements-postponed",
                &key(&document, "signer", "privateKeyPkcs8"),
                hid,
            );
            for case in cases(&document) {
                assert_eq!(
                    refused(typ, &received(case)),
                    StatementError::Unavailable,
                    "{typ} {}",
                    case["id"]
                );
            }
            let statement = statements::parse_statement(typ, &received(valid)).unwrap();
            assert!(matches!(
                RetainedStatement::try_from(statement),
                Err(StatementError::Unavailable)
            ));
            // The loaded key still signs a retained statement for its own hub.
            let result = send.sign(&identity);
            if hid == HUB {
                let signed = result.unwrap();
                let signer = key(&document, "signer", "publicKeySpki");
                assert!(
                    sign::verify(signed.typ(), signed.bytes(), signed.signature(), &signer)
                        .unwrap()
                        .is_some()
                );
            } else {
                assert_eq!(result.unwrap_err(), StatementError::OtherHub);
            }
        }
        let document = vectors(ADMIN);
        let identity = vector_identity(
            &backend,
            "dytest-statements-admin",
            &key(&document, "signer", "privateKeyPkcs8"),
            HUB,
        );
        for kind in ADMIN_KINDS
            .iter()
            .copied()
            .filter(|kind| !ADMIN_REVIEW_KINDS.contains(kind))
        {
            let bytes = received(by_id(&document, &format!("kind-{kind}")));
            assert_eq!(refused("admin.v1", &bytes), StatementError::Unavailable);
            let Some(Statement::Admin(statement)) = statements::parse_statement("admin.v1", &bytes)
            else {
                panic!("admin statement");
            };
            assert_eq!(
                PreparedStatement::from_statement(RetainedStatement::Admin(statement)).unwrap_err(),
                StatementError::Unavailable,
                "{kind}"
            );
        }
        let reviewed = PreparedStatement::from_received("admin.v1", &signable("admin.v1")).unwrap();
        assert!(reviewed.sign(&identity).is_ok());
    }

    #[test]
    fn no_diagnostic_shows_the_stored_key() {
        let backend = TestStore::new();
        for (typ, json) in RETAINED {
            let document = vectors(json);
            let pkcs8 = key(&document, "signer", "privateKeyPkcs8");
            let encoded = document["keys"]["signer"]["privateKeyPkcs8"]
                .as_str()
                .unwrap();
            let identity = vector_identity(&backend, "dytest-statements-diagnostic", &pkcs8, HUB);
            let elsewhere =
                vector_identity(&backend, "dytest-statements-elsewhere", &pkcs8, [0xab; 32]);
            let prepared = PreparedStatement::from_received(typ, &signable(typ)).unwrap();
            let signed = prepared.sign(&identity).unwrap();
            let error = prepared.sign(&elsewhere).unwrap_err();
            let shown = [
                format!("{identity:?}"),
                format!("{elsewhere:?}"),
                format!("{prepared:?}"),
                format!("{signed:?}"),
                format!("{error:?}"),
                error.to_string(),
                error.code().to_owned(),
            ];
            assert_eq!(
                shown,
                [
                    "StoredIdentity([redacted])".to_owned(),
                    "StoredIdentity([redacted])".to_owned(),
                    format!("PreparedStatement {{ typ: {typ:?}, .. }}"),
                    format!("SignedStatement {{ typ: {typ:?}, .. }}"),
                    "OtherHub".to_owned(),
                    "statement names another hub".to_owned(),
                    "STATEMENT_OTHER_HUB".to_owned(),
                ]
            );
            for text in &shown {
                assert!(!text.contains(encoded) && !text.contains(&hex(&pkcs8)));
            }
        }
    }
}
