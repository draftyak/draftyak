use std::borrow::Cow;

use tauri::{
    Context, Runtime, Url, http,
    utils::config::{Csp, FrontendDist},
};

pub const MAIN_LABEL: &str = "main";
pub const TRUSTED_LABEL: &str = "approval";
pub const TRUSTED_SCHEME: &str = "approval";
// The exact style injected by Tauri 2.12.4 to hide its isolation iframe.
const ISOLATION_STYLE: &str = "'sha256-YEercZJImS+vUX2bz7vkQ0aA4rtBIPLuCEWz+yraQ/g='";
const REVIEW_HTML: &[u8] = include_bytes!("../approval/index.html");
const REVIEW_SCRIPT: &[u8] = include_bytes!("../approval/ready.js");

#[derive(Clone)]
pub struct IsolationOrigin(String);

impl IsolationOrigin {
    fn from_schema(schema: &str) -> Result<Self, &'static str> {
        if schema.is_empty()
            || !schema.starts_with(|c: char| c.is_ascii_lowercase())
            || !schema
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err("DESKTOP_ISOLATION_REQUIRED");
        }
        Ok(Self(platform_origin(schema)))
    }

    pub fn csp(&self) -> String {
        format!(
            "default-src 'none'; script-src 'self'; style-src 'self' {ISOLATION_STYLE}; \
             img-src 'self'; connect-src ipc: http://ipc.localhost; \
             frame-src {}; child-src {}; worker-src 'none'; object-src 'none'; \
             base-uri 'none'; form-action 'none'; frame-ancestors 'none'; \
             require-trusted-types-for 'script'; trusted-types 'none'",
            self.0, self.0
        )
    }
}

/// Derives the iframe allowance from the actual generated isolation context. A config-only
/// declaration without the compiled isolation feature is refused rather than using brownfield.
pub fn prepare_context<R: Runtime>(
    context: &mut Context<R>,
) -> Result<IsolationOrigin, &'static str> {
    if !context.config().app.security.freeze_prototype
        || context.config().app.with_global_tauri
        || context.config().build.dev_url.is_some()
        || !context.config().app.windows.is_empty()
        || matches!(
            context.config().build.frontend_dist.as_ref(),
            Some(FrontendDist::Url(_))
        )
    {
        return Err("DESKTOP_SECURITY_CONFIGURATION");
    }
    let isolation = match context.pattern() {
        tauri::Pattern::Isolation { schema, .. } => IsolationOrigin::from_schema(schema)?,
        _ => return Err("DESKTOP_ISOLATION_REQUIRED"),
    };
    let policy = Some(Csp::Policy(isolation.csp()));
    context.config_mut().app.security.csp = policy.clone();
    context.config_mut().app.security.dev_csp = policy;
    Ok(isolation)
}

fn platform_origin(scheme: &str) -> String {
    if cfg!(windows) {
        format!("http://{scheme}.localhost")
    } else {
        format!("{scheme}://localhost")
    }
}

pub fn main_origin() -> String {
    platform_origin("tauri")
}

pub fn trusted_origin() -> String {
    platform_origin(TRUSTED_SCHEME)
}

fn document_at(url: &Url, origin: &str, paths: &[&str]) -> bool {
    let Ok(expected) = Url::parse(origin) else {
        return false;
    };
    url.scheme() == expected.scheme()
        && url.host_str() == expected.host_str()
        && url.port() == expected.port()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && paths.contains(&url.path())
}

pub fn may_navigate(label: &str, url: &Url) -> bool {
    match label {
        MAIN_LABEL => document_at(url, &main_origin(), &["/index.html", "/"]),
        TRUSTED_LABEL => document_at(url, &trusted_origin(), &["/index.html"]),
        _ => false,
    }
}

/// The registered custom-protocol handler's response core. The caller passes the runtime's
/// actual webview label, never a request header claiming a window identity.
pub fn trusted_response(
    label: &str,
    request: http::Request<Vec<u8>>,
    isolation: &IsolationOrigin,
) -> http::Response<Cow<'static, [u8]>> {
    use http::{Method, StatusCode, header};
    let url = Url::parse(&request.uri().to_string()).ok();
    let allowed = label == TRUSTED_LABEL
        && url.as_ref().is_some_and(|url| {
            document_at(url, &trusted_origin(), &["/index.html", "/ready.js"])
                && url.fragment().is_none()
        })
        && request.uri().query().is_none()
        && matches!(request.uri().path(), "/index.html" | "/ready.js")
        && request
            .headers()
            .get_all(header::ORIGIN)
            .iter()
            .all(|value| value.to_str().is_ok_and(|value| value == trusted_origin()));
    let (status, mime, body): (_, _, Cow<'static, [u8]>) = if !allowed {
        (
            StatusCode::FORBIDDEN,
            "text/plain",
            Cow::Borrowed(b"FORBIDDEN"),
        )
    } else if request.method() != Method::GET {
        (
            StatusCode::METHOD_NOT_ALLOWED,
            "text/plain",
            Cow::Borrowed(b"METHOD_NOT_ALLOWED"),
        )
    } else if request.uri().path() == "/index.html" {
        (
            StatusCode::OK,
            "text/html; charset=utf-8",
            Cow::Borrowed(REVIEW_HTML),
        )
    } else {
        (
            StatusCode::OK,
            "text/javascript; charset=utf-8",
            Cow::Borrowed(REVIEW_SCRIPT),
        )
    };
    http::Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_SECURITY_POLICY, isolation.csp())
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .body(body)
        .expect("fixed trusted response headers")
}
