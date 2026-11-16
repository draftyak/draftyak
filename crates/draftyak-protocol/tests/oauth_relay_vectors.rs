use draftyak_protocol::oauth_relay as relay;
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

fn directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/vectors/oauth-relay")
}

fn document(name: &str) -> Value {
    serde_json::from_slice(&fs::read(directory().join(name)).unwrap()).unwrap()
}

fn received(case: &Value) -> Option<Vec<u8>> {
    if let Some(hex) = case["receivedHex"].as_str() {
        return (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
            .collect();
    }
    let length = usize::try_from(case.get("padToBytes")?.as_u64()?).ok()?;
    let mut bytes = serde_json::to_vec(&case["value"]).unwrap();
    assert!(length >= bytes.len(), "padding cannot truncate a value");
    bytes.resize(length, b' ');
    Some(bytes)
}

fn run(case: &Value) -> bool {
    let route = case["route"].as_str().unwrap_or("");
    let action = case["action"].as_str().unwrap();
    match action {
        "access" => relay::route_allows(route, &case["peer"]),
        "cap" => case["length"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .is_some_and(|n| {
                relay::check_route_length(route, case["direction"].as_str().unwrap(), n)
            }),
        "request" | "response" => {
            if case.get("receivedHex").is_some() || case.get("padToBytes").is_some() {
                let bytes = received(case).expect("received bytes");
                return if action == "request" {
                    relay::check_route_request_bytes(route, &bytes)
                } else {
                    relay::check_route_response_bytes(route, &bytes)
                };
            }
            let value = &case["value"];
            let json = serde_json::to_vec(value).unwrap();
            let (by_value, by_bytes) = if action == "request" {
                (
                    relay::check_route_request(route, value),
                    relay::check_route_request_bytes(route, &json),
                )
            } else {
                (
                    relay::check_route_response(route, value),
                    relay::check_route_response_bytes(route, &json),
                )
            };
            assert_eq!(by_bytes, by_value, "{} as received JSON", case["id"]);
            by_value
        }
        other => panic!("unhandled action {other}"),
    }
}

#[test]
fn all_shared_oauth_relay_vectors() {
    let mut names: Vec<_> = fs::read_dir(directory())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".json"))
        .collect();
    names.sort();
    assert_eq!(names, ["cases.json", "routes.json"]);
    let routes = document("routes.json");
    assert_eq!(
        relay::catalogue(),
        json!({ "routes": routes["routes"] }),
        "the route table must equal routes.json"
    );
    let mut count = 0;
    for name in names {
        let file = document(&name);
        assert_eq!(file["format"], "draftyak.vectors.oauth-relay.v1");
        for case in file["cases"].as_array().unwrap() {
            assert_eq!(
                run(case),
                case["valid"].as_bool().unwrap(),
                "{name}: {}",
                case["id"]
            );
            count += 1;
        }
    }
    assert!(count > 300);
}

#[test]
fn each_route_admits_a_confirmed_admin_and_refuses_one_without_admin() {
    let cases = document("routes.json")["cases"].clone();
    for route in relay::OAUTH_RELAY_ROUTES {
        for (suffix, valid) in [("confirmed-admin", true), ("missing-admin", false)] {
            let id = format!("access-{}-{suffix}", route.id);
            let case = cases
                .as_array()
                .unwrap()
                .iter()
                .find(|case| case["id"] == id.as_str())
                .unwrap_or_else(|| panic!("{id} is missing"));
            assert_eq!(relay::route_allows(route.id, &case["peer"]), valid, "{id}");
        }
    }
}

// The members of an object with exactly these names, in this order.
fn exact<'a, const N: usize>(value: &'a Value, names: [&str; N]) -> Option<[&'a Value; N]> {
    let object = value.as_object()?;
    if object.len() != N {
        return None;
    }
    let found: Vec<&Value> = names
        .iter()
        .map(|name| object.get(*name))
        .collect::<Option<_>>()?;
    found.try_into().ok()
}

// Every request value the typed builders can express: all members present, strings or a null
// secret. Padded and raw received bodies test the received bytes, not the value.
#[test]
fn typed_builders_accept_exactly_the_valid_request_values() {
    let cases = document("cases.json")["cases"].clone();
    let mut built = 0;
    for case in cases.as_array().unwrap() {
        if case["action"] != "request" || case.get("padToBytes").is_some() {
            continue;
        }
        let Some(value) = case.get("value") else {
            continue;
        };
        let result = match case["route"].as_str().unwrap() {
            "client" => {
                let Some([flow, client, redirect]) =
                    exact(value, ["flowId", "client", "redirectUri"])
                else {
                    continue;
                };
                let Some([client_id, secret]) = exact(client, ["clientId", "clientSecret"]) else {
                    continue;
                };
                let (Some(flow), Some(client_id), Some(redirect)) =
                    (flow.as_str(), client_id.as_str(), redirect.as_str())
                else {
                    continue;
                };
                let secret = match secret {
                    Value::Null => None,
                    Value::String(secret) => Some(secret.as_str()),
                    _ => continue,
                };
                relay::GmailFlowClientRequest::new(flow, client_id, secret, redirect)
                    .and_then(|request| request.to_json())
            }
            "authorize" => {
                let Some([Value::String(flow)]) = exact(value, ["flowId"]) else {
                    continue;
                };
                relay::GmailFlowAuthorizeRequest::new(flow).and_then(|request| request.to_json())
            }
            "relay" => {
                let Some(
                    [
                        Value::String(flow),
                        Value::String(state),
                        Value::String(code),
                        Value::String(redirect),
                    ],
                ) = exact(value, ["flowId", "state", "code", "redirectUri"])
                else {
                    continue;
                };
                relay::GmailFlowRelayRequest::new(flow, state, code, redirect)
                    .and_then(|request| request.to_json())
            }
            other => panic!("unknown route {other}"),
        };
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["id"]
        );
        if let Ok(bytes) = result {
            let canonical = draftyak_protocol::jcs::canonicalize(value).unwrap();
            assert_eq!(bytes, canonical.into_bytes(), "{}", case["id"]);
        }
        built += 1;
    }
    assert!(
        built > 150,
        "only {built} request cases reached the builders"
    );
}

#[test]
fn the_authorization_view_parses_only_within_its_cap() {
    let cases = document("cases.json")["cases"].clone();
    let mut parsed = 0;
    for case in cases.as_array().unwrap() {
        if case["action"] != "response" || case["route"] != "authorize" {
            continue;
        }
        let bytes = received(case).unwrap_or_else(|| serde_json::to_vec(&case["value"]).unwrap());
        let result = relay::GmailFlowAuthorization::from_json(&bytes);
        assert_eq!(result.is_ok(), case["valid"] == true, "{}", case["id"]);
        if let (Ok(view), Some(value)) = (result, case.get("value")) {
            assert_eq!(view.id(), value["id"]);
            assert_eq!(view.authorization_url(), value["authorizationUrl"]);
            assert_eq!(json!(view.expires_at()), value["expiresAt"]);
            assert_eq!(json!(view.remaining_ms()), value["remainingMs"]);
        }
        parsed += 1;
    }
    assert!(parsed > 60);
}
