//! Bounded opaque WebSocket messages over an already pinned native TLS connection.

use std::{
    fmt, io,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::TcpStream,
};
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::{
    WebSocketStream, client_async_with_config,
    tungstenite::{
        self, Message,
        client::IntoClientRequest,
        http::{
            Uri,
            header::{SEC_WEBSOCKET_EXTENSIONS, SEC_WEBSOCKET_PROTOCOL},
        },
        protocol::WebSocketConfig,
    },
};

use crate::tls::PinnedConnection;

pub const MAX_HANDSHAKE_BYTES: usize = 16_384;
pub const MAX_TARGET_BYTES: usize = 2_048;
pub const MAX_SUBPROTOCOL_BYTES: usize = 128;
pub const MAX_FRAME_BYTES: usize = 65_536;
pub const MAX_MESSAGE_BYTES: usize = 65_536;
pub const MAX_WRITE_BUFFER_BYTES: usize = 66_560;
pub const MAX_CONTROL_BYTES: usize = 125;

#[derive(Clone, Copy, Debug)]
pub struct Timeouts {
    pub upgrade: Duration,
    pub read: Duration,
    pub write: Duration,
    pub close: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            upgrade: Duration::from_secs(10),
            read: Duration::from_secs(60),
            write: Duration::from_secs(10),
            close: Duration::from_secs(3),
        }
    }
}

impl Timeouts {
    fn valid(self) -> bool {
        [
            (self.upgrade, 10),
            (self.read, 300),
            (self.write, 10),
            (self.close, 3),
        ]
        .into_iter()
        .all(|(value, maximum)| !value.is_zero() && value <= Duration::from_secs(maximum))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WebSocketError {
    InvalidInput,
    ConnectionFailed,
    TimedOut,
    InvalidResponse,
    Closed,
    TooLarge,
}

impl fmt::Display for WebSocketError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidInput => "invalid WebSocket input",
            Self::ConnectionFailed => "WebSocket connection failed",
            Self::TimedOut => "WebSocket deadline exceeded",
            Self::InvalidResponse => "invalid WebSocket response",
            Self::Closed => "WebSocket closed",
            Self::TooLarge => "WebSocket byte limit exceeded",
        })
    }
}
impl std::error::Error for WebSocketError {}

#[derive(Clone, Eq, PartialEq)]
pub enum WebSocketMessage {
    Text(String),
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Pong(Vec<u8>),
}

impl fmt::Debug for WebSocketMessage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Text(_) => "Text([redacted])",
            Self::Binary(_) => "Binary([redacted])",
            Self::Ping(_) => "Ping([redacted])",
            Self::Pong(_) => "Pong([redacted])",
        })
    }
}

type Socket = WebSocketStream<HandshakeStream>;

pub struct WebSocketConnection {
    stream: Option<Socket>,
    timeouts: Timeouts,
}

impl fmt::Debug for WebSocketConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WebSocketConnection([redacted])")
    }
}

impl WebSocketConnection {
    /// Consumes the actual pinned stream. This does not grant device or application authority.
    pub async fn upgrade(
        pinned: PinnedConnection,
        target: &str,
        subprotocol: Option<&str>,
        timeouts: Timeouts,
    ) -> Result<Self, WebSocketError> {
        if !timeouts.valid()
            || !valid_target(target)
            || subprotocol.is_some_and(|p| !valid_token(p))
        {
            return Err(WebSocketError::InvalidInput);
        }
        let (stream, authority) = pinned.into_stream();
        let mut request = format!("wss://{authority}{target}")
            .into_client_request()
            .map_err(|_| WebSocketError::InvalidInput)?;
        if let Some(protocol) = subprotocol {
            request.headers_mut().insert(
                SEC_WEBSOCKET_PROTOCOL,
                protocol.parse().map_err(|_| WebSocketError::InvalidInput)?,
            );
        }
        let operation = async {
            let (socket, response) = client_async_with_config(
                request,
                HandshakeStream::new(stream),
                Some(bounded_config()),
            )
            .await
            .map_err(classify_error)?;
            if response.headers().contains_key(SEC_WEBSOCKET_EXTENSIONS) {
                return Err(WebSocketError::InvalidResponse);
            }
            let mut selected = response.headers().get_all(SEC_WEBSOCKET_PROTOCOL).iter();
            let first = selected.next();
            if selected.next().is_some()
                || match (subprotocol, first) {
                    (None, None) => false,
                    (Some(wanted), Some(actual)) => actual.as_bytes() != wanted.as_bytes(),
                    _ => true,
                }
            {
                return Err(WebSocketError::InvalidResponse);
            }
            Ok(Self {
                stream: Some(socket),
                timeouts,
            })
        };
        tokio::time::timeout(timeouts.upgrade, operation)
            .await
            .map_err(|_| WebSocketError::TimedOut)?
    }

    /// One finite idle/read operation; a successful message does not end the connection lifetime.
    /// Cancellation, timeout or peer errors drop the owned stream and make this object terminal.
    pub async fn receive(&mut self) -> Result<Option<WebSocketMessage>, WebSocketError> {
        let mut socket = self.stream.take().ok_or(WebSocketError::Closed)?;
        let operation = async {
            match socket.next().await.transpose().map_err(classify_error)? {
                Some(Message::Text(text)) => Ok(Some(WebSocketMessage::Text(text.to_string()))),
                Some(Message::Binary(bytes)) => Ok(Some(WebSocketMessage::Binary(bytes.to_vec()))),
                Some(Message::Ping(bytes)) => {
                    socket.flush().await.map_err(classify_error)?;
                    Ok(Some(WebSocketMessage::Ping(bytes.to_vec())))
                }
                Some(Message::Pong(bytes)) => Ok(Some(WebSocketMessage::Pong(bytes.to_vec()))),
                Some(Message::Close(_)) | None => {
                    flush_close(&mut socket).await?;
                    Ok(None)
                }
                Some(Message::Frame(_)) => Err(WebSocketError::InvalidResponse),
            }
        };
        let result = tokio::time::timeout(self.timeouts.read, operation)
            .await
            .map_err(|_| WebSocketError::TimedOut)
            .and_then(|result| result);
        if matches!(&result, Ok(Some(_))) {
            self.stream = Some(socket);
        }
        result
    }

    pub async fn send_text(&mut self, text: &str) -> Result<(), WebSocketError> {
        self.check_outgoing_length(text.len(), MAX_MESSAGE_BYTES)?;
        self.transmit(Message::Text(text.to_owned().into())).await
    }

    pub async fn send_binary(&mut self, bytes: &[u8]) -> Result<(), WebSocketError> {
        self.check_outgoing_length(bytes.len(), MAX_MESSAGE_BYTES)?;
        self.transmit(Message::Binary(bytes.to_vec().into())).await
    }

    pub async fn ping(&mut self, bytes: &[u8]) -> Result<(), WebSocketError> {
        self.check_outgoing_length(bytes.len(), MAX_CONTROL_BYTES)?;
        self.transmit(Message::Ping(bytes.to_vec().into())).await
    }

    fn check_outgoing_length(&self, length: usize, maximum: usize) -> Result<(), WebSocketError> {
        if self.stream.is_none() {
            return Err(WebSocketError::Closed);
        }
        if length > maximum {
            return Err(WebSocketError::TooLarge);
        }
        Ok(())
    }

    async fn transmit(&mut self, message: Message) -> Result<(), WebSocketError> {
        let mut socket = self.stream.take().ok_or(WebSocketError::Closed)?;
        let result = tokio::time::timeout(self.timeouts.write, socket.send(message))
            .await
            .map_err(|_| WebSocketError::TimedOut)
            .and_then(|result| result.map_err(classify_error));
        if result.is_ok() {
            self.stream = Some(socket);
        }
        result
    }

    /// Completes the WebSocket close and native shutdown under one total deadline.
    pub async fn close(mut self) -> Result<(), WebSocketError> {
        let mut socket = self.stream.take().ok_or(WebSocketError::Closed)?;
        let operation = async {
            socket.close(None).await.map_err(classify_error)?;
            loop {
                match socket.next().await {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {
                        socket.flush().await.map_err(classify_error)?;
                    }
                    Some(Err(
                        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed,
                    )) => break,
                    Some(Err(error)) => return Err(classify_error(error)),
                    Some(Ok(_)) => return Err(WebSocketError::InvalidResponse),
                }
            }
            flush_close(&mut socket).await
        };
        tokio::time::timeout(self.timeouts.close, operation)
            .await
            .map_err(|_| WebSocketError::TimedOut)?
    }
}

async fn flush_close(socket: &mut Socket) -> Result<(), WebSocketError> {
    match socket.flush().await {
        Ok(()) | Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {}
        Err(error) => return Err(classify_error(error)),
    }
    socket
        .get_mut()
        .shutdown()
        .await
        .map_err(|_| WebSocketError::ConnectionFailed)
}

fn valid_target(target: &str) -> bool {
    target.len() <= MAX_TARGET_BYTES
        && target.starts_with('/')
        && !target.starts_with("//")
        && !target.contains('#')
        && target.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        && target
            .parse::<Uri>()
            .is_ok_and(|uri| uri.scheme().is_none() && uri.authority().is_none())
}

fn valid_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= MAX_SUBPROTOCOL_BYTES
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
}

fn bounded_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .read_buffer_size(4_096)
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_WRITE_BUFFER_BYTES)
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_FRAME_BYTES))
        .accept_unmasked_frames(false)
}

fn classify_error(error: tungstenite::Error) -> WebSocketError {
    match error {
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
            WebSocketError::Closed
        }
        tungstenite::Error::Capacity(_) | tungstenite::Error::WriteBufferFull(_) => {
            WebSocketError::TooLarge
        }
        tungstenite::Error::Io(error)
            if error
                .get_ref()
                .is_some_and(|error| error.is::<HandshakeLimit>()) =>
        {
            WebSocketError::TooLarge
        }
        tungstenite::Error::Io(_) | tungstenite::Error::Tls(_) => WebSocketError::ConnectionFailed,
        _ => WebSocketError::InvalidResponse,
    }
}

#[derive(Debug)]
struct HandshakeLimit;
impl fmt::Display for HandshakeLimit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WebSocket handshake byte limit exceeded")
    }
}
impl std::error::Error for HandshakeLimit {}

struct HandshakeStream {
    inner: TlsStream<TcpStream>,
    header_bytes: usize,
    header_suffix: u32,
    headers_complete: bool,
}

impl HandshakeStream {
    fn new(inner: TlsStream<TcpStream>) -> Self {
        Self {
            inner,
            header_bytes: 0,
            header_suffix: 0,
            headers_complete: false,
        }
    }
}

impl AsyncRead for HandshakeStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.headers_complete || buf.remaining() == 0 {
            return Pin::new(&mut self.inner).poll_read(cx, buf);
        }
        let remaining = MAX_HANDSHAKE_BYTES.saturating_sub(self.header_bytes);
        if remaining == 0 {
            return Poll::Ready(Err(io::Error::other(HandshakeLimit)));
        }
        let mut scratch = [0; 4_096];
        let limit = scratch.len().min(remaining).min(buf.remaining());
        let mut bounded = ReadBuf::new(&mut scratch[..limit]);
        match Pin::new(&mut self.inner).poll_read(cx, &mut bounded) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Ready(Ok(())) => {
                for byte in bounded.filled() {
                    if self.headers_complete {
                        break;
                    }
                    self.header_bytes += 1;
                    self.header_suffix = (self.header_suffix << 8) | u32::from(*byte);
                    if self.header_suffix == u32::from_be_bytes(*b"\r\n\r\n") {
                        self.headers_complete = true;
                    }
                }
                buf.put_slice(bounded.filled());
                Poll::Ready(Ok(()))
            }
        }
    }
}

impl AsyncWrite for HandshakeStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_retains_finite_allocations_and_protocol_bounds() {
        let config = bounded_config();
        assert_eq!(config.read_buffer_size, 4_096);
        assert_eq!(config.write_buffer_size, 0);
        assert_eq!(config.max_write_buffer_size, 66_560);
        assert_eq!(config.max_frame_size, Some(65_536));
        assert_eq!(config.max_message_size, Some(65_536));
        assert!(!config.accept_unmasked_frames);
    }

    #[test]
    fn deadlines_are_positive_finite_and_allow_a_real_caller_idle_policy() {
        assert!(Timeouts::default().valid());
        for index in 0..4 {
            for seconds in [0, 301] {
                let mut timeouts = Timeouts::default();
                match index {
                    0 => timeouts.upgrade = Duration::from_secs(seconds),
                    1 => timeouts.read = Duration::from_secs(seconds),
                    2 => timeouts.write = Duration::from_secs(seconds),
                    _ => timeouts.close = Duration::from_secs(seconds),
                }
                assert!(!timeouts.valid());
            }
        }
        assert!(
            Timeouts {
                read: Duration::from_secs(300),
                ..Timeouts::default()
            }
            .valid()
        );
    }

    #[test]
    fn local_target_and_subprotocol_tokens_cannot_change_the_connected_authority() {
        assert!(valid_target("/device/v1/events?after=cursor"));
        assert!(valid_target(&format!("/{}", "a".repeat(2_047))));
        for target in [
            "",
            "//other.invalid/",
            "wss://other.invalid/",
            "/#fragment",
            "/a\r\nHost:other",
            "/é",
            "/a b",
        ] {
            assert!(!valid_target(target));
        }
        assert!(!valid_target(&format!("/{}", "a".repeat(2_048))));
        assert!(valid_token(&"a".repeat(128)));
        for token in ["", "a,b", "a b", "é", "x\r\nInjected:yes"] {
            assert!(!valid_token(token));
        }
        assert!(!valid_token(&"a".repeat(129)));
    }

    #[test]
    fn message_and_low_level_failure_diagnostics_never_expose_content() {
        let canary = "synthetic private frame";
        for message in [
            WebSocketMessage::Text(canary.into()),
            WebSocketMessage::Binary(canary.as_bytes().to_vec()),
            WebSocketMessage::Ping(canary.as_bytes().to_vec()),
            WebSocketMessage::Pong(canary.as_bytes().to_vec()),
        ] {
            assert!(!format!("{message:?}").contains(canary));
        }
        for error in [
            tungstenite::Error::Utf8(canary.into()),
            tungstenite::Error::Io(io::Error::other(canary)),
        ] {
            let public = classify_error(error);
            assert!(!format!("{public:?}: {public}").contains(canary));
        }
    }
}
