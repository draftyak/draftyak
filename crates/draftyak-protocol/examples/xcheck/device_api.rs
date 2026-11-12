use draftyak_protocol::{device_api as api, hash::jcs_sha256};
use serde_json::{Map, Value, json};

pub const COMMANDS: &[(&str, super::Command)] = &[("device-api", run)];

fn run(request: &Map<String, Value>) -> Result<Value, String> {
    let action = super::field(request, "action")?;
    let get = |name: &str| request.get(name).unwrap_or(&Value::Null);
    let number = |name: &str| get(name).as_u64().and_then(|n| usize::try_from(n).ok());
    let route = get("route").as_str().unwrap_or("");
    if action == "catalogue" {
        return Ok(api::catalogue());
    }
    if action == "hash" {
        return Ok(json!({"hash":jcs_sha256(get("value")).map_err(|_|"invalid hash input")?}));
    }
    let valid = match action {
        "schema" => api::check_schema(get("schema").as_str().unwrap_or(""), get("value")),
        "request" | "response" if request.contains_key("receivedHex") => {
            let bytes = super::hex_field(request, "receivedHex")?;
            if action == "request" {
                api::check_route_request_bytes(route, Some(&bytes))
            } else {
                api::check_route_response_bytes(route, &bytes)
            }
        }
        "request" => api::check_route_request(
            route,
            if get("present") == false {
                None
            } else {
                request.get("value")
            },
        ),
        "response" => api::check_route_response(route, get("value")),
        "challenge" => api::check_challenge(
            get("challenge"),
            get("review"),
            get("request"),
            get("context"),
        ),
        "stream" => get("frames")
            .as_array()
            .is_some_and(|frames| api::check_event_stream(frames)),
        "length" => number("length").is_some_and(|n| {
            n <= api::STATEMENT_BYTES + 1 && api::check_statement_length(&vec![0; n])
        }),
        "frame-cap" => number("length").is_some_and(api::check_frame_length),
        "cap" => number("length").is_some_and(|n| {
            api::check_route_length(route, get("direction").as_str().unwrap_or(""), n)
        }),
        "access" => api::route_allows(route, get("peer"), request.get("operation")),
        "error" if request.contains_key("receivedHex") => {
            let bytes = super::hex_field(request, "receivedHex")?;
            get("status")
                .as_u64()
                .and_then(|n| u16::try_from(n).ok())
                .is_some_and(|n| api::check_api_error_bytes(&bytes, n))
        }
        "error" => get("status")
            .as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .is_some_and(|n| api::check_api_error(get("value"), n)),
        _ => return Err("unknown device API action".into()),
    };
    Ok(json!({"valid":valid}))
}
