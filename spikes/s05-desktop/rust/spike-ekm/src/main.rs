//! `spike-ekm client|server`: one TLS 1.3 connection with a peer on 127.0.0.1, printing this
//! side's view as one JSON line (test/ekm.heavy.test.ts compares it with Node's
//! `exportKeyingMaterial`). The server first prints `{"listening":<port>}`.

use std::net::{IpAddr, Ipv4Addr};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use spike_ekm::{PID_LEN, client_config, export, load_chain, load_key, server_config, unhex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_rustls::{TlsAcceptor, TlsConnector};

const USAGE: &str = "usage: spike-ekm client --port <n> --server-spki-sha256 <hex> | server, \
                     each with --pid <32 hex> --cert <pem> --key <pem>";
const STEP: Duration = Duration::from_secs(30);

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())
        .and_then(|runtime| runtime.block_on(run(&args)));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("spike-ekm: {error}");
            ExitCode::FAILURE
        }
    }
}

fn flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, String> {
    let at = args.iter().position(|arg| arg == name);
    at.and_then(|at| args.get(at + 1))
        .map(String::as_str)
        .ok_or_else(|| format!("missing {name}\n{USAGE}"))
}

async fn run(args: &[String]) -> Result<(), String> {
    let pid: [u8; PID_LEN] = unhex(flag(args, "--pid")?)?;
    let chain = load_chain(flag(args, "--cert")?)?;
    let key = load_key(flag(args, "--key")?)?;
    match args.first().map(String::as_str) {
        Some("client") => client(args, &pid, chain, key).await,
        Some("server") => server(&pid, chain, key).await,
        _ => Err(USAGE.to_string()),
    }
}

async fn within<T, E: ToString>(
    what: &str,
    step: impl Future<Output = Result<T, E>>,
) -> Result<T, String> {
    match timeout(STEP, step).await {
        Ok(result) => result.map_err(|error| format!("{what}: {}", error.to_string())),
        Err(_) => Err(format!("{what}: no answer in {} s", STEP.as_secs())),
    }
}

async fn client(
    args: &[String],
    pid: &[u8; PID_LEN],
    chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
) -> Result<(), String> {
    let port: u16 = flag(args, "--port")?.parse().map_err(|_| "bad --port")?;
    let pin = unhex(flag(args, "--server-spki-sha256")?)?;
    let config = client_config(pin, chain, key).map_err(|error| error.to_string())?;
    let tcp = within("connect", TcpStream::connect((Ipv4Addr::LOCALHOST, port))).await?;
    let name = ServerName::from(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let connector = TlsConnector::from(Arc::new(config));
    let mut tls = within("handshake", connector.connect(name, tcp)).await?;
    let exported = export(tls.get_ref().1, pid).map_err(|error| error.to_string())?;
    println!("{}", exported.to_json("client"));
    // The server closes once it has exported its side.
    let _ = timeout(STEP, tls.read_to_end(&mut Vec::new())).await;
    Ok(())
}

async fn server(
    pid: &[u8; PID_LEN],
    chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
) -> Result<(), String> {
    let config = server_config(chain, key).map_err(|error| error.to_string())?;
    let listener = within("bind", TcpListener::bind((Ipv4Addr::LOCALHOST, 0))).await?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    println!("{{\"listening\":{port}}}");
    let (tcp, _) = within("accept", listener.accept()).await?;
    let mut tls = within("handshake", TlsAcceptor::from(Arc::new(config)).accept(tcp)).await?;
    let exported = export(tls.get_ref().1, pid).map_err(|error| error.to_string())?;
    println!("{}", exported.to_json("server"));
    // The client closes once it has exported its side.
    let _ = timeout(STEP, tls.read_to_end(&mut Vec::new())).await;
    let _ = tls.shutdown().await;
    Ok(())
}
