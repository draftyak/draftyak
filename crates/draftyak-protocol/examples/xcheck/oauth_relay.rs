use draftyak_protocol::oauth_relay as relay;
use serde_json::{Map, Value, json};

pub const COMMANDS: &[(&str, super::Command)] = &[("oauth-relay", run)];

fn run(request: &Map<String, Value>) -> Result<Value, String> {
    let action = super::field(request, "action")?;
    let get = |name: &str| request.get(name).unwrap_or(&Value::Null);
    let text = |name: &str| get(name).as_str();
    let route = text("route").unwrap_or("");
    let valid = match action {
        "catalogue" => return Ok(relay::catalogue()),
        "build" => return Ok(build(route, request)),
        "authorization" => {
            let bytes = super::hex_field(request, "receivedHex")?;
            return Ok(match relay::GmailFlowAuthorization::from_json(&bytes) {
                Ok(view) => json!({
                    "id": view.id(),
                    "authorizationUrl": view.authorization_url(),
                    "expiresAt": view.expires_at(),
                    "remainingMs": view.remaining_ms(),
                }),
                Err(_) => json!({ "refused": true }),
            });
        }
        "access" => relay::route_allows(route, get("peer")),
        "cap" => get("length")
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .is_some_and(|n| relay::check_route_length(route, text("direction").unwrap_or(""), n)),
        "request" | "response" if request.contains_key("receivedHex") => {
            let bytes = super::hex_field(request, "receivedHex")?;
            if action == "request" {
                relay::check_route_request_bytes(route, &bytes)
            } else {
                relay::check_route_response_bytes(route, &bytes)
            }
        }
        "request" => relay::check_route_request(route, get("value")),
        "response" => relay::check_route_response(route, get("value")),
        "field" => {
            let check: fn(&str) -> bool = match text("field").unwrap_or("") {
                "redirectUri" => relay::check_redirect_uri,
                "state" => relay::check_state,
                "code" => relay::check_code,
                "clientId" => relay::check_client_id,
                "clientSecret" => relay::check_client_secret,
                "authorizationUrl" => relay::check_authorization_url,
                _ => return Err("unknown OAuth relay field".into()),
            };
            text("value").is_some_and(check)
        }
        _ => return Err("unknown OAuth relay action".into()),
    };
    Ok(json!({ "valid": valid }))
}

// The body a typed builder writes, as hex, or a refusal.
fn build(route: &str, request: &Map<String, Value>) -> Value {
    let text = |name: &str| request.get(name).and_then(Value::as_str);
    let field = |name: &str| text(name).unwrap_or("");
    let body = match route {
        "client" => relay::GmailFlowClientRequest::new(
            field("flowId"),
            field("clientId"),
            text("clientSecret"),
            field("redirectUri"),
        )
        .and_then(|request| request.to_json()),
        "authorize" => relay::GmailFlowAuthorizeRequest::new(field("flowId"))
            .and_then(|request| request.to_json()),
        "relay" => relay::GmailFlowRelayRequest::new(
            field("flowId"),
            field("state"),
            field("code"),
            field("redirectUri"),
        )
        .and_then(|request| request.to_json()),
        _ => return json!({ "refused": true }),
    };
    match body {
        Ok(bytes) => json!({ "hex": super::hex(&bytes) }),
        Err(_) => json!({ "refused": true }),
    }
}
