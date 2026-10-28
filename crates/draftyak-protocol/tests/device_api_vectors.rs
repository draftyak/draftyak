use draftyak_protocol::device_api as api;
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

fn received(case: &Value) -> Option<Vec<u8>> {
    if let Some(hex) = case["receivedHex"].as_str() {
        return (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
            .collect();
    }
    if case.get("padToBytes").is_some() {
        let mut bytes = serde_json::to_vec(&case["value"]).unwrap();
        let n = case["padToBytes"].as_u64().unwrap() as usize;
        assert!(n >= bytes.len(), "padding cannot truncate a value");
        bytes.resize(n, b' ');
        return Some(bytes);
    }
    None
}
fn run(case: &Value) -> bool {
    let route = case["route"].as_str().unwrap_or("");
    match case["action"].as_str().unwrap() {
        "schema" => api::check_schema(case["schema"].as_str().unwrap(), &case["value"]),
        "request" | "response"
            if case.get("receivedHex").is_some() || case.get("padToBytes").is_some() =>
        {
            let Some(bytes) = received(case) else {
                return false;
            };
            if case["action"] == "request" {
                api::check_route_request_bytes(route, Some(&bytes))
            } else {
                api::check_route_response_bytes(route, &bytes)
            }
        }
        "request" => api::check_route_request(
            route,
            if case["present"] == false {
                None
            } else {
                case.get("value")
            },
        ),
        "response" => api::check_route_response(route, &case["value"]),
        "length" => case["length"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .is_some_and(|n| {
                n <= api::STATEMENT_BYTES + 1 && api::check_statement_length(&vec![0; n])
            }),
        "cap" => case["length"].as_u64().is_some_and(|n| {
            api::check_route_length(route, case["direction"].as_str().unwrap(), n as usize)
        }),
        "frame-cap" => case["length"]
            .as_u64()
            .is_some_and(|n| api::check_frame_length(n as usize)),
        "stream" => case["frames"]
            .as_array()
            .is_some_and(|f| api::check_event_stream(f)),
        "challenge" => api::check_challenge(
            &case["challenge"],
            &case["review"],
            &case["request"],
            &case["context"],
        ),
        "access" => api::route_allows(route, &case["peer"], case.get("operation")),
        "error" if case.get("receivedHex").is_some() || case.get("padToBytes").is_some() => {
            let Some(bytes) = received(case) else {
                return false;
            };
            case["status"]
                .as_u64()
                .and_then(|n| u16::try_from(n).ok())
                .is_some_and(|n| api::check_api_error_bytes(&bytes, n))
        }
        "error" => case["status"]
            .as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .is_some_and(|n| api::check_api_error(&case["value"], n)),
        other => panic!("unhandled action {other}"),
    }
}
#[test]
fn all_shared_device_api_vectors() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/vectors/device-api");
    let mut paths: Vec<_> = fs::read_dir(directory)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    paths.sort();
    assert!(
        paths.len() >= 2,
        "catalogue and behavioral vectors required"
    );
    let mut count = 0;
    let mut catalogue = false;
    for path in paths {
        let document: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        if path.file_name().unwrap() == "catalogue.json" {
            assert_eq!(document["format"], "draftyak.vectors.device-api.v1");
            assert_eq!(document.as_object().unwrap().len(), 6);
            assert_eq!(
                api::catalogue(),
                json!({
                    "routes":document["routes"],"errors":document["errors"],
                    "capabilities":document["capabilities"],"presets":document["presets"]
                }),
                "catalogue must match every field"
            );
            catalogue = true;
            for (kind, capability) in document["capabilities"].as_object().unwrap() {
                assert_eq!(json!(api::required_capability(kind)), *capability);
            }
            assert_eq!(api::required_capability("unknown.v1"), None);
            assert_eq!(api::required_capability("hub-key-rotate.v1"), None);
        } else {
            assert_eq!(document["format"], "draftyak.vectors.device-api.v1");
            for case in document["cases"].as_array().unwrap() {
                assert_eq!(
                    run(case),
                    case["valid"].as_bool().unwrap(),
                    "{}: {}",
                    path.display(),
                    case["id"]
                );
                count += 1;
            }
        }
    }
    assert!(catalogue && count > 0);
}

#[test]
fn received_caps_and_strict_json() {
    let valid = br#"{"paused":true}"#;
    let mut exact = valid.to_vec();
    exact.resize(1024, b' ');
    assert!(api::check_route_request_bytes("sync-pause", Some(&exact)));
    exact.push(b' ');
    assert!(!api::check_route_request_bytes("sync-pause", Some(&exact)));
    assert!(!api::check_route_request_bytes(
        "sync-pause",
        Some(br#"{"paused":false,"paused":true}"#)
    ));
    assert!(!api::check_route_request_bytes("status", Some(b"")));
    assert!(api::check_statement_length(&vec![0; 16384]));
    assert!(!api::check_statement_length(&vec![0; 16385]));
    assert!(api::check_frame_length(65536));
    assert!(!api::check_frame_length(65537));
}

#[test]
fn full_string_pin_and_kind() {
    for suffix in ["\r", "\n", "\u{2028}", "\u{2029}"] {
        assert!(!api::check_schema(
            "BootstrapRequest",
            &json!({"pin":format!("123456{suffix}")})
        ));
        assert!(!api::check_schema(
            "EventFrame",
            &json!({"type":"event","cursor":"","kind":format!("outbox.changed{suffix}"),"ids":[]})
        ));
    }
    assert!(api::check_schema(
        "EventsRequest",
        &json!({"after":"\u{0}\r\n\u{7f}"})
    ));
}

const SESSION_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

fn session_case(subject: Value) -> (Value, Value, Value, Value, Value) {
    use draftyak_protocol::{hash::jcs_sha256, jcs::canonicalize, sign::base64url_encode};
    let mut authorization = subject["authorization"].clone();
    authorization.as_object_mut().unwrap().remove("target");
    let statement = json!({
        "v":1,"hub":"a".repeat(64),"device":SESSION_ID,"epoch":0,
        "nonce":"AAECAwQFBgcICQoLDA0ODw","iat":1000,"exp":121000,
        "session":SESSION_ID,"principal":subject["principal"],"account":subject["account"],
        "toolClass":subject["toolClass"],"authorization":authorization
    });
    let review = json!({"id":SESSION_ID,"kind":"agent-session",
        "digest":jcs_sha256(&subject).unwrap(),"subject":subject,
        "expiresAt":121000,"remainingMs":120000});
    let request = json!({"kind":"agent-session.v1","id":SESSION_ID});
    let challenge = json!({"kind":"agent-session.v1","id":SESSION_ID,
        "statement":base64url_encode(canonicalize(&statement).unwrap().as_bytes())});
    let context = json!({"hub":"a".repeat(64),"device":SESSION_ID});
    (review, request, challenge, context, statement)
}
fn session_subject(authorization: Value, class: &str) -> Value {
    json!({"principal":{"kind":"grant","id":SESSION_ID},"account":SESSION_ID,
        "toolClass":class,"authorization":authorization})
}
fn encoded_statement(value: &Value) -> Value {
    use draftyak_protocol::{jcs::canonicalize, sign::base64url_encode};
    json!(base64url_encode(canonicalize(value).unwrap().as_bytes()))
}

#[test]
fn agent_session_review_challenge_envelope_and_duration() {
    for duration in [900_000, 3_600_000, 28_800_000] {
        for class in ["read", "draft", "organize"] {
            let subject = session_subject(json!({"kind":"session","durationMs":duration}), class);
            let (review, request, challenge, context, _) = session_case(subject.clone());
            assert!(api::check_schema("AgentSessionReviewSubject", &subject));
            assert!(api::check_route_response("operation-review", &review));
            assert!(api::check_route_request("challenge", Some(&request)));
            assert!(api::check_route_response("challenge", &challenge));
            assert!(api::check_challenge(
                &challenge, &review, &request, &context
            ));
            let envelope = json!({"statement":challenge["statement"],"signature":
                draftyak_protocol::sign::base64url_encode(&[0;64]),"pin":"123456"});
            assert!(api::check_route_request("agent-session", Some(&envelope)));
            assert!(!api::check_route_request("send-approval", Some(&envelope)));
            let mut bytes = serde_json::to_vec(&envelope).unwrap();
            bytes.resize(32_768, b' ');
            assert!(api::check_route_request_bytes(
                "agent-session",
                Some(&bytes)
            ));
            bytes.push(b' ');
            assert!(!api::check_route_request_bytes(
                "agent-session",
                Some(&bytes)
            ));
        }
    }
}

#[test]
fn agent_session_binds_every_signed_pending_field_and_context() {
    let subject = session_subject(json!({"kind":"session","durationMs":900000}), "read");
    let (review, request, challenge, context, statement) = session_case(subject);
    for (pointer, value) in [
        ("/hub", json!("b".repeat(64))),
        ("/device", json!(OTHER_ID)),
        ("/session", json!(OTHER_ID)),
        ("/principal/kind", json!("token")),
        ("/principal/id", json!(OTHER_ID)),
        ("/account", json!(OTHER_ID)),
        ("/toolClass", json!("draft")),
        ("/authorization/durationMs", json!(3600000)),
    ] {
        let mut changed_statement = statement.clone();
        *changed_statement.pointer_mut(pointer).unwrap() = value;
        let mut changed = challenge.clone();
        changed["statement"] = encoded_statement(&changed_statement);
        assert!(
            api::check_schema("Challenge", &changed),
            "valid typed field {pointer}"
        );
        assert!(
            !api::check_challenge(&changed, &review, &request, &context),
            "bind {pointer}"
        );
    }
    let mut changed = review.clone();
    changed["digest"] = json!("b".repeat(64));
    assert!(!api::check_schema("OperationReview", &changed));
    assert!(!api::check_challenge(
        &challenge, &changed, &request, &context
    ));
    changed = review.clone();
    changed["id"] = json!(OTHER_ID);
    assert!(!api::check_challenge(
        &challenge, &changed, &request, &context
    ));
    let mut changed_request = request.clone();
    changed_request["id"] = json!(OTHER_ID);
    assert!(!api::check_challenge(
        &challenge,
        &review,
        &changed_request,
        &context
    ));
}

#[test]
fn agent_session_calls_preserve_merged_target_and_signed_authorization_rules() {
    for (method, target, class) in [
        ("tools/call", "accounts_list".to_owned(), "read"),
        ("tools/call", "draft_create".to_owned(), "draft"),
        (
            "resources/read",
            format!("draftyak://message/{SESSION_ID}"),
            "read",
        ),
    ] {
        let subject = session_subject(
            json!({"kind":"call","method":method,"target":target,
            "paramsDigest":"b".repeat(64),"validForMs":600000,"singleUse":true}),
            class,
        );
        let (review, request, challenge, context, statement) = session_case(subject.clone());
        assert!(api::check_challenge(
            &challenge, &review, &request, &context
        ));
        let mut changed_statement = statement.clone();
        changed_statement["authorization"]["paramsDigest"] = json!("c".repeat(64));
        let mut changed = challenge.clone();
        changed["statement"] = encoded_statement(&changed_statement);
        assert!(api::check_schema("Challenge", &changed));
        assert!(!api::check_challenge(&changed, &review, &request, &context));
        for (pointer, bad) in [
            ("/authorization/target", json!("send_now")),
            ("/authorization/validForMs", json!(600001)),
            ("/authorization/singleUse", json!(false)),
            ("/principal/kind", json!("host:sms")),
        ] {
            let mut bad_subject = subject.clone();
            *bad_subject.pointer_mut(pointer).unwrap() = bad;
            let mut bad_review = review.clone();
            bad_review["digest"] =
                json!(draftyak_protocol::hash::jcs_sha256(&bad_subject).unwrap());
            bad_review["subject"] = bad_subject.clone();
            assert!(!api::check_schema(
                "AgentSessionReviewSubject",
                &bad_subject
            ));
            assert!(
                !api::check_schema("OperationReview", &bad_review),
                "review {pointer}"
            );
            assert!(!api::check_challenge(
                &challenge,
                &bad_review,
                &request,
                &context
            ));
        }
        let mut unknown = subject.clone();
        unknown["extra"] = json!(true);
        assert!(!api::check_schema("AgentSessionReviewSubject", &unknown));
    }
    let subject = session_subject(
        json!({"kind":"call","method":"tools/call","target":"accounts_list",
        "paramsDigest":"b".repeat(64),"validForMs":600000,"singleUse":true}),
        "read",
    );
    let (review, request, mut challenge, context, mut statement) = session_case(subject);
    statement["authorization"]["method"] = json!("resources/read");
    challenge["statement"] = encoded_statement(&statement);
    assert!(api::check_schema("Challenge", &challenge));
    assert!(!api::check_challenge(
        &challenge, &review, &request, &context
    ));
}

#[test]
fn agent_session_access_has_no_device_creation_or_future_subject_expansion() {
    let peer = json!({"role":"device","known":true,"revoked":false,"epoch":0,"confirmedEpoch":0,
        "capabilities":["approve","admin"],"sidecarClaim":false,"bootstrapDone":false});
    assert!(api::route_allows(
        "challenge",
        &peer,
        Some(&json!({"kind":"agent-session.v1"}))
    ));
    assert!(api::route_allows(
        "operation-review",
        &peer,
        Some(&json!({"kind":"agent-session"}))
    ));
    assert!(!api::route_allows(
        "new-operation",
        &peer,
        Some(&json!({"kind":"agent-session"}))
    ));
    assert!(!api::check_schema(
        "OperationRequest",
        &json!({"kind":"agent-session","ids":[SESSION_ID]})
    ));
    for kind in ["login.v1", "admin.v1", "unknown.v1"] {
        assert!(!api::route_allows(
            "challenge",
            &peer,
            Some(&json!({"kind":kind}))
        ));
        assert!(!api::check_schema(
            "ChallengeRequest",
            &json!({"kind":kind,"id":SESSION_ID})
        ));
    }
    let mut no_approve = peer.clone();
    no_approve["capabilities"] = json!(["read"]);
    assert!(!api::route_allows(
        "challenge",
        &no_approve,
        Some(&json!({"kind":"agent-session.v1"}))
    ));
    let mut extra = json!({"kind":"agent-session.v1","id":SESSION_ID});
    extra["flagsAcked"] = json!([]);
    assert!(!api::check_schema("ChallengeRequest", &extra));
    assert_eq!(api::DEVICE_API_ROUTES.len(), 15);
}
