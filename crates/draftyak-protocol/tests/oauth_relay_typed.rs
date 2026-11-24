use draftyak_protocol::oauth_relay::{
    self as relay, GmailFlowAuthorization, GmailFlowAuthorizeRequest, GmailFlowClientRequest,
    GmailFlowRelayRequest, OAuthRelayError,
};
use serde_json::{Value, json};

const FLOW: &str = "01JAZ3W3B6Q8M2V0G5T9K4X7RC";
const CLIENT: &str = "DYTEST-google-desktop";
const REDIRECT: &str = "http://127.0.0.1:54321/oauth/google/callback";
const WIDEST_REDIRECT: &str = "http://127.0.0.1:65535/oauth/google/callback";
const SECRET: &str = "DYTEST-secret-canary-7f3a";
const CODE: &str = "DYTEST-code-canary-91b2";
// The 32 bytes 0..=31.
const STATE: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

fn authorization_url() -> String {
    format!(
        "{}{}?client_id={CLIENT}&state={STATE}&code_challenge={CODE}",
        relay::GOOGLE_AUTHORIZATION_ORIGIN,
        relay::GOOGLE_AUTHORIZATION_PATH
    )
}

fn assert_hidden(text: &str) {
    for private in [SECRET, CODE, STATE] {
        assert!(!text.contains(private), "{text}");
    }
}

#[test]
fn debug_output_leaves_out_the_secret_the_code_and_the_state() {
    let client = GmailFlowClientRequest::new(FLOW, CLIENT, Some(SECRET), REDIRECT).unwrap();
    let request = GmailFlowRelayRequest::new(FLOW, STATE, CODE, REDIRECT).unwrap();
    let view = GmailFlowAuthorization::from_json(
        json!({
            "id": FLOW,
            "authorizationUrl": authorization_url(),
            "expiresAt": 1_767_225_600_000_u64,
            "remainingMs": 600_000,
        })
        .to_string()
        .as_bytes(),
    )
    .unwrap();
    assert_eq!(view.authorization_url(), authorization_url());
    for text in [
        format!("{client:?}"),
        format!("{client:#?}"),
        format!("{request:?}"),
        format!("{request:#?}"),
        format!("{view:?}"),
        format!("{view:#?}"),
    ] {
        assert_hidden(&text);
        assert!(text.contains("[redacted]") && text.contains(FLOW), "{text}");
    }
    let without = GmailFlowClientRequest::new(FLOW, CLIENT, None, REDIRECT).unwrap();
    assert!(format!("{without:?}").contains("client_secret: None"));
}

#[test]
fn refusals_carry_no_submitted_value() {
    let state = format!("{STATE}=");
    let failures = [
        GmailFlowClientRequest::new(FLOW, CLIENT, Some(&format!("{SECRET} ")), REDIRECT)
            .unwrap_err(),
        GmailFlowClientRequest::new(FLOW, &format!("{SECRET}\n"), None, REDIRECT).unwrap_err(),
        GmailFlowClientRequest::new(SECRET, CLIENT, Some(SECRET), REDIRECT).unwrap_err(),
        GmailFlowRelayRequest::new(FLOW, &state, CODE, REDIRECT).unwrap_err(),
        GmailFlowRelayRequest::new(FLOW, STATE, &format!("{CODE} "), REDIRECT).unwrap_err(),
        GmailFlowRelayRequest::new(FLOW, STATE, CODE, &format!("{REDIRECT}?code={CODE}"))
            .unwrap_err(),
        GmailFlowAuthorizeRequest::new(CODE).unwrap_err(),
        GmailFlowAuthorization::from_json(
            json!({
                "id": FLOW,
                "authorizationUrl": format!("https://evil.example/?state={STATE}"),
                "expiresAt": 1,
                "remainingMs": 1,
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap_err(),
        GmailFlowAuthorization::from_json(format!(r#"{{"{SECRET}":1,"{SECRET}":2}}"#).as_bytes())
            .unwrap_err(),
    ];
    for error in failures {
        assert_hidden(&error.to_string());
        assert_hidden(&format!("{error:?}"));
    }
    assert_eq!(
        OAuthRelayError::Request.to_string(),
        "OAuth relay request refused"
    );
    assert_eq!(
        OAuthRelayError::Response.to_string(),
        "OAuth relay response refused"
    );
}

#[test]
fn bodies_stay_within_their_caps_at_the_widest_escapes() {
    let client = GmailFlowClientRequest::new(
        FLOW,
        &"\"".repeat(512),
        Some(&"\\".repeat(4096)),
        WIDEST_REDIRECT,
    )
    .unwrap()
    .to_json()
    .unwrap();
    assert!(client.len() > 8192 && client.len() <= 32_768);
    assert!(relay::check_route_request_bytes("client", &client));
    let request = GmailFlowRelayRequest::new(FLOW, STATE, &"\"".repeat(256), WIDEST_REDIRECT)
        .unwrap()
        .to_json()
        .unwrap();
    assert!(request.len() > 512 && request.len() <= 2048);
    assert!(relay::check_route_request_bytes("relay", &request));
    let authorize = GmailFlowAuthorizeRequest::new(FLOW)
        .unwrap()
        .to_json()
        .unwrap();
    assert_eq!(authorize, format!(r#"{{"flowId":"{FLOW}"}}"#).into_bytes());
}

#[test]
fn the_authorization_view_counts_received_bytes_against_its_cap() {
    let base = json!({
        "id": FLOW,
        "authorizationUrl": authorization_url(),
        "expiresAt": 1,
        "remainingMs": 0,
    })
    .to_string();
    let mut bytes = base.into_bytes();
    bytes.resize(relay::RESPONSE_BYTES, b' ');
    assert!(GmailFlowAuthorization::from_json(&bytes).is_ok());
    bytes.push(b' ');
    assert_eq!(
        GmailFlowAuthorization::from_json(&bytes).unwrap_err(),
        OAuthRelayError::Response
    );
}

#[test]
fn value_and_received_authorizations_agree_on_number_forms() {
    for field in ["expiresAt", "remainingMs"] {
        for (literal, expected) in [
            ("0.0", Some(0)),
            ("-0.0", Some(0)),
            ("1.0", Some(1)),
            ("1e0", Some(1)),
            ("9007199254740991.0", Some(9_007_199_254_740_991)),
            ("-1.0", None),
            ("1.5", None),
            ("9007199254740992.0", None),
            ("1e100", None),
            ("null", None),
            ("true", None),
            (r#""1.0""#, None),
        ] {
            let expires_at = if field == "expiresAt" { literal } else { "1" };
            let remaining_ms = if field == "remainingMs" { literal } else { "1" };
            let body = format!(
                r#"{{"id":"{FLOW}","authorizationUrl":"{}","expiresAt":{expires_at},"remainingMs":{remaining_ms}}}"#,
                authorization_url()
            );
            let value: Value = serde_json::from_str(&body).unwrap();
            if expected.is_some() {
                assert!(value[field].is_f64(), "{field}: {literal}");
            }
            assert_eq!(
                relay::check_route_response("authorize", &value),
                expected.is_some(),
                "value {field}: {literal}"
            );
            assert_eq!(
                relay::check_route_response_bytes("authorize", body.as_bytes()),
                expected.is_some(),
                "bytes {field}: {literal}"
            );
            let typed = GmailFlowAuthorization::from_json(body.as_bytes());
            if let Some(expected) = expected {
                let typed = typed.unwrap();
                let actual = if field == "expiresAt" {
                    typed.expires_at()
                } else {
                    typed.remaining_ms()
                };
                assert_eq!(actual, expected, "{field}: {literal}");
            } else {
                assert_eq!(typed.unwrap_err(), OAuthRelayError::Response);
            }
        }
        for literal in ["NaN", "Infinity", "-Infinity", "1e309"] {
            let expires_at = if field == "expiresAt" { literal } else { "1" };
            let remaining_ms = if field == "remainingMs" { literal } else { "1" };
            let body = format!(
                r#"{{"id":"{FLOW}","authorizationUrl":"{}","expiresAt":{expires_at},"remainingMs":{remaining_ms}}}"#,
                authorization_url()
            );
            assert!(!relay::check_route_response_bytes(
                "authorize",
                body.as_bytes()
            ));
            assert_eq!(
                GmailFlowAuthorization::from_json(body.as_bytes()).unwrap_err(),
                OAuthRelayError::Response
            );
        }
    }
}
