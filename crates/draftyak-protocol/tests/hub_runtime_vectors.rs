use draftyak_protocol::hub_runtime as runtime;
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

fn directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/vectors/hub-runtime")
}
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
        "schema" => {
            assert_eq!(case["schema"], "SchedulingStatus");
            serde_json::from_value::<runtime::SchedulingStatus>(case["value"].clone()).is_ok()
        }
        "access" => runtime::route_allows(route, &case["peer"]),
        "cap" => case["length"].as_u64().is_some_and(|n| {
            runtime::check_route_length(route, case["direction"].as_str().unwrap(), n as usize)
        }),
        "request" if case["present"] == false => runtime::check_route_request_bytes(route, None),
        "request" => {
            let bytes = received(case).expect("a request case without present: false has a body");
            runtime::check_route_request_bytes(route, Some(&bytes))
        }
        "response" => match received(case) {
            Some(bytes) => runtime::check_route_response_bytes(route, &bytes),
            None => runtime::check_route_response(route, &case["value"]),
        },
        other => panic!("unhandled action {other}"),
    }
}

#[test]
fn all_shared_hub_runtime_vectors() {
    let mut names: Vec<String> = fs::read_dir(directory())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".json"))
        .collect();
    names.sort();
    assert_eq!(names, ["routes.json", "status.json"]);
    let mut count = 0;
    for name in names {
        let document: Value =
            serde_json::from_slice(&fs::read(directory().join(&name)).unwrap()).unwrap();
        assert_eq!(document["format"], "draftyak.vectors.hub-runtime.v1");
        if name == "routes.json" {
            assert_eq!(
                runtime::catalogue(),
                json!({ "routes": document["routes"] }),
                "the catalogue must match every column"
            );
        }
        for case in document["cases"].as_array().unwrap() {
            assert_eq!(
                run(case),
                case["valid"].as_bool().unwrap(),
                "{name}: {}",
                case["id"]
            );
            count += 1;
        }
    }
    assert!(count > 50);
}

#[test]
fn exactly_two_read_only_routes() {
    let routes: Vec<_> = runtime::HUB_RUNTIME_ROUTES
        .iter()
        .map(|r| (r.method, r.path, r.response_bytes))
        .collect();
    assert_eq!(
        routes,
        [
            ("GET", "/device/v1/scheduling", 4096),
            ("GET", "/device/v1/scheduling/outbox", 8192)
        ]
    );
    for r in runtime::HUB_RUNTIME_ROUTES {
        assert_eq!(
            (
                r.role,
                r.capability,
                r.confirmation,
                r.request,
                r.request_bytes
            ),
            ("device", "read", "confirmed", "none", 0)
        );
        assert!(runtime::check_route_request_bytes(r.id, None));
        assert!(!runtime::check_route_request_bytes(r.id, Some(b"")));
    }
}

#[test]
fn status_answer_capped_before_parsing() {
    let body = br#"{"mode":"service","scheduler":"unavailable","syncPaused":true}"#;
    let status = runtime::parse_scheduling_status(body).unwrap();
    assert_eq!(
        status,
        runtime::SchedulingStatus {
            mode: runtime::HubMode::Service,
            scheduler: runtime::SchedulerState::Unavailable,
            sync_paused: true,
        }
    );
    let mut padded = body.to_vec();
    padded.resize(runtime::SCHEDULING_STATUS_BYTES, b' ');
    assert!(runtime::parse_scheduling_status(&padded).is_some());
    padded.push(b' ');
    assert!(runtime::parse_scheduling_status(&padded).is_none());
    for text in [
        r#"{"mode":"service","scheduler":"unavailable"}"#,
        r#"{"mode":"service","scheduler":"unavailable","syncPaused":"true"}"#,
        r#"{"mode":"service","scheduler":"unavailable","syncPaused":true,"syncPaused":true}"#,
        r#"["service","unavailable",true]"#,
    ] {
        assert!(
            runtime::parse_scheduling_status(text.as_bytes()).is_none(),
            "{text}"
        );
    }
}
