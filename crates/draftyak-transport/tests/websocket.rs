#[path = "support/websocket-peer.rs"]
mod peer;

use draftyak_transport::{
    tls::{Identity, PinnedConnection},
    websocket::{
        MAX_CONTROL_BYTES, MAX_FRAME_BYTES, MAX_HANDSHAKE_BYTES, MAX_MESSAGE_BYTES,
        MAX_SUBPROTOCOL_BYTES, MAX_TARGET_BYTES, Timeouts, WebSocketConnection, WebSocketError,
        WebSocketMessage,
    },
};
use peer::Peer;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

fn timeouts() -> Timeouts {
    Timeouts {
        upgrade: Duration::from_secs(3),
        read: Duration::from_secs(3),
        write: Duration::from_secs(1),
        close: Duration::from_secs(1),
    }
}

async fn pinned(peer: &Peer) -> PinnedConnection {
    PinnedConnection::connect(peer.address, &Identity::generate().unwrap(), peer.pin)
        .await
        .unwrap()
}

async fn upgrade(peer: &Peer) -> WebSocketConnection {
    WebSocketConnection::upgrade(pinned(peer).await, "/opaque?cursor=0", None, timeouts())
        .await
        .unwrap()
}

fn binary(message: Option<WebSocketMessage>) -> Vec<u8> {
    match message {
        Some(WebSocketMessage::Binary(value)) => value,
        _ => panic!("expected opaque binary message"),
    }
}

#[tokio::test]
async fn one_pinned_tls_stream_carries_client_certificate_authority_and_masked_opaque_bytes() {
    let mut peer = Peer::start(json!({"mode":"echo"}));
    let identity = Identity::generate().unwrap();
    let expected = identity.spki_hash();
    let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
        .await
        .unwrap();
    let mut ws = WebSocketConnection::upgrade(connection, "/opaque?cursor=0", None, timeouts())
        .await
        .unwrap();
    let tls = peer.event("tls");
    assert_eq!(tls["version"], "TLSv1.3");
    assert_eq!(
        tls["clientPin"],
        expected
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<String>()
    );
    let request = peer.event("upgrade");
    assert_eq!(request["host"], peer.address.to_string());
    assert_eq!(request["target"], "/opaque?cursor=0");
    let bytes = vec![0, 255, 128, b'{', b'\n', b'}'];
    ws.send_binary(&bytes).await.unwrap();
    assert_eq!(binary(ws.receive().await.unwrap()), bytes);
    let frame = peer.event("frame");
    assert_eq!(frame["masked"], true);
    assert_eq!(frame["length"], bytes.len());
    assert_eq!(
        frame["digest"],
        Sha256::digest(&bytes)
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<String>()
    );
    ws.close().await.unwrap();
    peer.event("socket-closed");
    let summary = peer.stop();
    assert_eq!(summary["requests"], 1);
    assert_eq!(summary["connections"], 1);
}

#[tokio::test]
async fn full_spki_pin_refuses_before_any_http_or_application_byte() {
    let mut peer = Peer::start(json!({"mode":"echo"}));
    let mut wrong = peer.pin;
    wrong[31] ^= 1;
    assert!(
        PinnedConnection::connect(peer.address, &Identity::generate().unwrap(), wrong)
            .await
            .is_err()
    );
    let summary = peer.stop();
    assert_eq!(summary["requests"], 0);
    assert_eq!(summary["applicationBytes"], 0);
}

#[tokio::test]
async fn empty_binary_and_unicode_text_are_opaque_round_trips() {
    let mut peer = Peer::start(json!({"mode":"echo"}));
    let mut ws = upgrade(&peer).await;
    ws.send_binary(&[]).await.unwrap();
    assert!(binary(ws.receive().await.unwrap()).is_empty());
    ws.send_text("DYTEST-opaque π 🦆 {not-json}").await.unwrap();
    match ws.receive().await.unwrap() {
        Some(WebSocketMessage::Text(value)) => assert_eq!(value, "DYTEST-opaque π 🦆 {not-json}"),
        _ => panic!("expected UTF-8 text"),
    }
    ws.close().await.unwrap();
    peer.stop();
}

#[tokio::test]
async fn exact_message_cap_sends_and_receives_but_local_overcap_never_writes() {
    assert_eq!(MAX_HANDSHAKE_BYTES, 16384);
    assert_eq!(MAX_TARGET_BYTES, 2048);
    assert_eq!(MAX_SUBPROTOCOL_BYTES, 128);
    assert_eq!(MAX_FRAME_BYTES, 65536);
    assert_eq!(MAX_MESSAGE_BYTES, 65536);
    assert_eq!(MAX_CONTROL_BYTES, 125);
    let mut peer = Peer::start(json!({"mode":"echo"}));
    let mut ws = upgrade(&peer).await;
    assert_eq!(
        ws.send_binary(&vec![9; MAX_MESSAGE_BYTES + 1]).await,
        Err(WebSocketError::TooLarge)
    );
    assert_eq!(
        ws.send_text(&"é".repeat(MAX_MESSAGE_BYTES / 2 + 1)).await,
        Err(WebSocketError::TooLarge)
    );
    let exact = vec![255; MAX_MESSAGE_BYTES];
    ws.send_binary(&exact).await.unwrap();
    assert_eq!(binary(ws.receive().await.unwrap()), exact);
    let frame = peer.event("frame");
    assert_eq!(frame["length"], MAX_MESSAGE_BYTES);
    assert_eq!(frame["opcode"], 2);
    ws.close().await.unwrap();
    assert_eq!(
        peer.stop()["frames"],
        2,
        "only legal data and close reached the peer"
    );
}

#[tokio::test]
async fn coalesced_exact_header_and_first_exact_frame_preserve_all_bytes() {
    let mut peer = Peer::start(json!({"headerBytes":MAX_HANDSHAKE_BYTES,
        "frames":[{"opcode":2,"length":MAX_FRAME_BYTES,"byte":173}]}));
    let mut ws = upgrade(&peer).await;
    assert_eq!(
        binary(ws.receive().await.unwrap()),
        vec![173; MAX_MESSAGE_BYTES]
    );
    ws.close().await.unwrap();
    peer.stop();
}

#[tokio::test]
async fn handshake_cap_plus_one_refuses_and_closes_native_stream() {
    let mut peer = Peer::start(json!({"headerBytes":MAX_HANDSHAKE_BYTES+1}));
    let result =
        WebSocketConnection::upgrade(pinned(&peer).await, "/opaque", None, timeouts()).await;
    assert_eq!(result.err(), Some(WebSocketError::TooLarge));
    peer.event("socket-closed");
    peer.stop();
}

#[tokio::test]
async fn split_handshake_terminator_preserves_coalesced_frame() {
    let mut peer = Peer::start(json!({"headerBytes":MAX_HANDSHAKE_BYTES,
        "headerSplit":MAX_HANDSHAKE_BYTES-1,"frames":[{"opcode":2,"length":3,"byte":4}]}));
    let mut ws = upgrade(&peer).await;
    assert_eq!(binary(ws.receive().await.unwrap()), vec![4; 3]);
    ws.close().await.unwrap();
    peer.stop();
}

#[tokio::test]
async fn declared_frame_cap_plus_one_refuses_before_withheld_payload_deadline() {
    let mut peer = Peer::start(
        json!({"frames":[{"opcode":2,"declared":MAX_FRAME_BYTES+1,"headerOnly":true}]}),
    );
    let mut ws = upgrade(&peer).await;
    assert_eq!(ws.receive().await.err(), Some(WebSocketError::TooLarge));
    assert_eq!(
        ws.send_binary(b"after-error").await,
        Err(WebSocketError::Closed)
    );
    peer.event("socket-closed");
    peer.stop();
}

#[tokio::test]
async fn fragmented_aggregate_accepts_exact_cap_and_refuses_cap_plus_one() {
    for extra in [0, 1] {
        let mut peer = Peer::start(json!({"frames":[
            {"opcode":2,"fin":false,"length":32768,"byte":11},
            {"opcode":0,"length":32768+extra,"byte":22}]}));
        let mut ws = upgrade(&peer).await;
        if extra == 0 {
            let mut expected = vec![11; 32768];
            expected.extend(vec![22; 32768]);
            assert_eq!(binary(ws.receive().await.unwrap()), expected);
            ws.close().await.unwrap();
        } else {
            assert_eq!(ws.receive().await.err(), Some(WebSocketError::TooLarge));
            assert_eq!(
                ws.send_text("after-error").await,
                Err(WebSocketError::Closed)
            );
        }
        peer.stop();
    }
}

#[tokio::test]
async fn malformed_handshakes_and_unexpected_statuses_are_not_opaque_successes() {
    for config in [
        json!({"mode":"bad-accept"}),
        json!({"mode":"missing-upgrade"}),
        json!({"status":200}),
        json!({"status":403}),
        json!({"status":302}),
    ] {
        let mut peer = Peer::start(config.clone());
        let result =
            WebSocketConnection::upgrade(pinned(&peer).await, "/opaque", None, timeouts()).await;
        assert_eq!(
            result.err(),
            Some(WebSocketError::InvalidResponse),
            "{config}"
        );
        peer.event("socket-closed");
        assert_eq!(peer.stop()["requests"], 1, "no redirect or second request");
    }
}

#[tokio::test]
async fn selected_subprotocol_must_be_one_exact_requested_token() {
    let token = "x".repeat(MAX_SUBPROTOCOL_BYTES);
    let mut peer = Peer::start(json!({}));
    let ws = WebSocketConnection::upgrade(pinned(&peer).await, "/opaque", Some(&token), timeouts())
        .await
        .unwrap();
    assert_eq!(peer.event("upgrade")["protocol"], token);
    ws.close().await.unwrap();
    peer.stop();
    for (selection, requested, duplicate) in [
        ("", Some("opaque"), false),
        ("other", Some("opaque"), false),
        ("opaque", None, false),
        ("opaque, other", Some("opaque"), false),
        ("opaque", Some("opaque"), true),
    ] {
        let mut peer = Peer::start(json!({"selection":selection,"duplicateProtocol":duplicate}));
        let result =
            WebSocketConnection::upgrade(pinned(&peer).await, "/opaque", requested, timeouts())
                .await;
        assert_eq!(result.err(), Some(WebSocketError::InvalidResponse));
        peer.event("socket-closed");
        peer.stop();
    }
}

#[tokio::test]
async fn unsolicited_extension_is_not_negotiated_by_a_plain_client() {
    let mut peer = Peer::start(json!({"extension":"permessage-deflate"}));
    let result =
        WebSocketConnection::upgrade(pinned(&peer).await, "/opaque", None, timeouts()).await;
    assert_eq!(result.err(), Some(WebSocketError::InvalidResponse));
    peer.event("socket-closed");
    peer.stop();
}

#[tokio::test]
async fn origin_form_target_exact_cap_is_preserved() {
    let target = format!("/{}", "x".repeat(MAX_TARGET_BYTES - 1));
    let mut peer = Peer::start(json!({}));
    let ws = WebSocketConnection::upgrade(pinned(&peer).await, &target, None, timeouts())
        .await
        .unwrap();
    assert_eq!(peer.event("upgrade")["target"], target);
    ws.close().await.unwrap();
    peer.stop();
}

#[tokio::test]
async fn invalid_target_and_subprotocol_refuse_before_http_bytes() {
    let over = format!("/{}", "x".repeat(MAX_TARGET_BYTES));
    for target in [
        "",
        "opaque",
        "//elsewhere.invalid/path",
        "https://elsewhere.invalid/",
        "/a#b",
        "/a b",
        "/a\r\nHost: elsewhere.invalid",
        "/π",
        &over,
    ] {
        let mut peer = Peer::start(json!({}));
        let result =
            WebSocketConnection::upgrade(pinned(&peer).await, target, None, timeouts()).await;
        assert_eq!(
            result.err(),
            Some(WebSocketError::InvalidInput),
            "{target:?}"
        );
        peer.event("socket-closed");
        assert_eq!(peer.stop()["applicationBytes"], 0);
    }
    let over = "x".repeat(MAX_SUBPROTOCOL_BYTES + 1);
    for token in ["", "a,b", "a b", "a\r\nHost:x", "π", &over] {
        let mut peer = Peer::start(json!({}));
        let result =
            WebSocketConnection::upgrade(pinned(&peer).await, "/opaque", Some(token), timeouts())
                .await;
        assert_eq!(
            result.err(),
            Some(WebSocketError::InvalidInput),
            "{token:?}"
        );
        peer.event("socket-closed");
        assert_eq!(peer.stop()["applicationBytes"], 0);
    }
}

#[tokio::test]
async fn malformed_frames_and_invalid_utf8_refuse_then_close() {
    for spec in [
        json!({"opcode":2,"masked":true,"length":1}),
        json!({"opcode":0,"length":1}),
        json!({"opcode":2,"rsv":64,"length":0}),
        json!({"opcode":9,"fin":false,"length":1}),
        json!({"opcode":9,"length":126}),
        json!({"opcode":1,"length":1,"byte":255}),
    ] {
        let mut peer = Peer::start(json!({"frames":[spec.clone()]}));
        let mut ws = upgrade(&peer).await;
        assert_eq!(
            ws.receive().await.err(),
            Some(WebSocketError::InvalidResponse),
            "{spec}"
        );
        assert_eq!(ws.send_binary(&[]).await, Err(WebSocketError::Closed));
        peer.event("socket-closed");
        peer.stop();
    }
}

#[tokio::test]
async fn automatic_pong_is_flushed_before_ping_is_returned() {
    let mut peer = Peer::start(json!({"frames":[{"opcode":9,"length":125,"byte":7}]}));
    let mut ws = upgrade(&peer).await;
    match ws.receive().await.unwrap() {
        Some(WebSocketMessage::Ping(bytes)) => assert_eq!(bytes, vec![7; 125]),
        _ => panic!("expected Ping"),
    }
    let pong = peer.observe("frame");
    assert!(
        pong.is_some(),
        "automatic Pong must be flushed before returning Ping"
    );
    let pong = pong.unwrap();
    assert_eq!(pong["opcode"], 10);
    assert_eq!(pong["length"], 125);
    assert_eq!(pong["masked"], true);
    ws.close().await.unwrap();
    peer.stop();
}

#[tokio::test]
async fn fragmented_utf8_scalar_with_interleaved_ping_is_valid() {
    let mut peer = Peer::start(json!({"frames":[{"opcode":1,"fin":false,"hex":"cf"},
        {"opcode":9,"text":"control"},{"opcode":0,"hex":"80"}]}));
    let mut ws = upgrade(&peer).await;
    assert!(matches!(
        ws.receive().await.unwrap(),
        Some(WebSocketMessage::Ping(_))
    ));
    assert_eq!(peer.event("frame")["opcode"], 10);
    match ws.receive().await.unwrap() {
        Some(WebSocketMessage::Text(value)) => assert_eq!(value, "π"),
        _ => panic!("expected fragmented UTF-8 text"),
    }
    ws.close().await.unwrap();
    peer.stop();
}

#[tokio::test]
async fn local_ping_bound_preserves_state_and_pong_payload() {
    let mut peer = Peer::start(json!({}));
    let mut ws = upgrade(&peer).await;
    assert_eq!(
        ws.ping(&[0; MAX_CONTROL_BYTES + 1]).await,
        Err(WebSocketError::TooLarge)
    );
    ws.ping(&[8; MAX_CONTROL_BYTES]).await.unwrap();
    match ws.receive().await.unwrap() {
        Some(WebSocketMessage::Pong(bytes)) => assert_eq!(bytes, vec![8; MAX_CONTROL_BYTES]),
        _ => panic!("expected Pong"),
    }
    ws.close().await.unwrap();
    assert_eq!(peer.stop()["frames"], 2);
}

#[tokio::test]
async fn peer_close_is_terminal_and_native_socket_shuts_down() {
    let mut peer = Peer::start(json!({"frames":[{"opcode":8,"length":0}]}));
    let mut ws = upgrade(&peer).await;
    assert!(ws.receive().await.unwrap().is_none());
    assert_eq!(ws.receive().await.err(), Some(WebSocketError::Closed));
    assert_eq!(ws.ping(&[]).await, Err(WebSocketError::Closed));
    peer.event("socket-closed");
    peer.stop();
}

#[tokio::test]
async fn silent_upgrade_and_read_have_operation_deadlines_and_drop_stream() {
    let mut peer = Peer::start(json!({"mode":"silent-upgrade"}));
    let mut limits = timeouts();
    limits.upgrade = Duration::from_millis(150);
    let connection = pinned(&peer).await;
    let started = Instant::now();
    let result = WebSocketConnection::upgrade(connection, "/opaque", None, limits).await;
    assert_eq!(result.err(), Some(WebSocketError::TimedOut));
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "configured upgrade deadline"
    );
    peer.event("socket-closed");
    peer.stop();
    let mut peer = Peer::start(json!({}));
    limits = timeouts();
    limits.read = Duration::from_millis(150);
    let mut ws = WebSocketConnection::upgrade(pinned(&peer).await, "/opaque", None, limits)
        .await
        .unwrap();
    let started = Instant::now();
    assert_eq!(ws.receive().await.err(), Some(WebSocketError::TimedOut));
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "configured read deadline"
    );
    assert_eq!(
        ws.send_text("after-timeout").await,
        Err(WebSocketError::Closed)
    );
    peer.event("socket-closed");
    peer.stop();
}

#[tokio::test]
async fn cancelling_pending_receive_drops_native_stream_and_cannot_be_reused() {
    let mut peer = Peer::start(json!({}));
    let mut ws = upgrade(&peer).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(50), ws.receive())
            .await
            .is_err()
    );
    assert_eq!(
        ws.send_text("after-cancel").await,
        Err(WebSocketError::Closed)
    );
    peer.event("socket-closed");
    peer.stop();
}

#[tokio::test]
async fn silent_peer_close_has_one_total_deadline_and_drops_socket() {
    let mut peer = Peer::start(json!({"mode":"silent-close"}));
    let mut limits = timeouts();
    limits.close = Duration::from_millis(150);
    let ws = WebSocketConnection::upgrade(pinned(&peer).await, "/opaque", None, limits)
        .await
        .unwrap();
    let started = Instant::now();
    assert_eq!(ws.close().await, Err(WebSocketError::TimedOut));
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "configured close deadline"
    );
    peer.event("socket-closed");
    peer.stop();
}

#[tokio::test]
async fn chatty_peer_cannot_renew_total_close_deadline() {
    let mut peer = Peer::start(json!({"mode":"chatty-close"}));
    let mut limits = timeouts();
    limits.close = Duration::from_millis(150);
    let ws = WebSocketConnection::upgrade(pinned(&peer).await, "/opaque", None, limits)
        .await
        .unwrap();
    assert_eq!(ws.close().await, Err(WebSocketError::TimedOut));
    peer.event("socket-closed");
    peer.stop();
}

#[tokio::test]
async fn cancelled_upgrade_and_close_drop_the_owned_socket() {
    let mut peer = Peer::start(json!({"mode":"silent-upgrade"}));
    let connection = pinned(&peer).await;
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            WebSocketConnection::upgrade(connection, "/opaque", None, timeouts())
        )
        .await
        .is_err()
    );
    peer.event("upgrade");
    peer.event("socket-closed");
    peer.stop();
    let mut peer = Peer::start(json!({"mode":"silent-close"}));
    let ws = upgrade(&peer).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(50), ws.close())
            .await
            .is_err()
    );
    peer.event("socket-closed");
    peer.stop();
}

#[tokio::test]
async fn dropping_idle_connection_releases_native_socket() {
    let mut peer = Peer::start(json!({}));
    let ws = upgrade(&peer).await;
    drop(ws);
    peer.event("socket-closed");
    peer.stop();
}

#[tokio::test]
async fn cancelling_pending_write_leaves_terminal_state_and_releases_socket() {
    let mut peer = Peer::start(json!({"mode":"backpressure"}));
    let mut ws = upgrade(&peer).await;
    let payload = vec![255; MAX_MESSAGE_BYTES];
    assert!(
        tokio::time::timeout(Duration::from_millis(150), async {
            for _ in 0..2048 {
                ws.send_binary(&payload).await.unwrap();
            }
            panic!("peer pause must exhaust bounded native buffers");
        })
        .await
        .is_err()
    );
    assert_eq!(ws.send_binary(&[]).await, Err(WebSocketError::Closed));
    peer.stop();
}

#[tokio::test]
async fn stalled_peer_write_is_bounded_and_terminal() {
    let mut peer = Peer::start(json!({"mode":"backpressure"}));
    let mut limits = timeouts();
    limits.write = Duration::from_millis(150);
    let mut ws = WebSocketConnection::upgrade(pinned(&peer).await, "/opaque", None, limits)
        .await
        .unwrap();
    let payload = vec![255; MAX_MESSAGE_BYTES];
    let started = Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        for _ in 0..2048 {
            if let Err(error) = ws.send_binary(&payload).await {
                return error;
            }
        }
        panic!("peer pause must exhaust bounded native buffers");
    })
    .await
    .expect("bounded write test deadline");
    assert_eq!(result, WebSocketError::TimedOut);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "configured write deadline"
    );
    assert_eq!(
        ws.send_text("after-timeout").await,
        Err(WebSocketError::Closed)
    );
    peer.stop();
}

#[tokio::test]
async fn zero_or_overmaximum_operation_timeout_is_invalid_before_http() {
    for field in 0..4 {
        for value in [Duration::ZERO, Duration::from_secs(301)] {
            let mut limits = timeouts();
            match field {
                0 => limits.upgrade = value,
                1 => limits.read = value,
                2 => limits.write = value,
                _ => limits.close = value,
            }
            let mut peer = Peer::start(json!({}));
            let result =
                WebSocketConnection::upgrade(pinned(&peer).await, "/opaque", None, limits).await;
            assert_eq!(result.err(), Some(WebSocketError::InvalidInput));
            peer.event("socket-closed");
            assert_eq!(peer.stop()["applicationBytes"], 0);
        }
    }
}

#[test]
fn diagnostics_redact_opaque_message_content() {
    for message in [
        WebSocketMessage::Text("DYTEST-private-frame-marker".into()),
        WebSocketMessage::Binary(b"DYTEST-private-frame-marker".to_vec()),
        WebSocketMessage::Ping(b"DYTEST-private-frame-marker".to_vec()),
        WebSocketMessage::Pong(b"DYTEST-private-frame-marker".to_vec()),
    ] {
        assert!(!format!("{message:?}").contains("DYTEST-private-frame-marker"));
    }
    assert_eq!(
        WebSocketError::InvalidResponse.to_string(),
        "invalid WebSocket response"
    );
}
