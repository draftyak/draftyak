use draftyak_desktop::window_security::{
    IsolationOrigin, MAIN_LABEL, TRUSTED_LABEL, main_origin, may_navigate, prepare_context,
    trusted_origin, trusted_response,
};
use tauri::{
    Context, Url, WebviewUrl,
    http::{self, HeaderValue, Method, StatusCode, header},
    test::{MockRuntime, mock_context, noop_assets},
    utils::config::{Csp, FrontendDist, WindowConfig},
};

fn context() -> Context<MockRuntime> {
    tauri::generate_context!()
}

fn isolation() -> IsolationOrigin {
    prepare_context(&mut context()).unwrap()
}

fn request(method: Method, uri: &str, origin: Option<&str>) -> http::Request<Vec<u8>> {
    let mut builder = http::Request::builder().method(method).uri(uri);
    if let Some(origin) = origin {
        builder = builder.header(header::ORIGIN, origin);
    }
    builder.body(b"ignored request body".to_vec()).unwrap()
}

fn assert_refusal(response: http::Response<std::borrow::Cow<'static, [u8]>>) {
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(&response.body()[..], b"FORBIDDEN");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
}

#[test]
fn compiled_isolation_context_installs_its_exact_frame_policy() {
    let mut context = context();
    let schema = match context.pattern() {
        tauri::Pattern::Isolation { schema, .. } => schema.to_string(),
        _ => panic!("compiled isolation pattern is required"),
    };
    let isolation = prepare_context(&mut context).unwrap();
    let origin = if cfg!(windows) {
        format!("http://{schema}.localhost")
    } else {
        format!("{schema}://localhost")
    };
    let policy = isolation.csp();
    assert!(policy.contains(&format!("frame-src {origin}; child-src {origin};")));
    for directive in [
        "default-src 'none'",
        "worker-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "require-trusted-types-for 'script'",
        "trusted-types 'none'",
    ] {
        assert!(policy.contains(directive));
    }
    for installed in [
        &context.config().app.security.csp,
        &context.config().app.security.dev_csp,
    ] {
        assert!(matches!(installed, Some(Csp::Policy(value)) if value == &policy));
    }
}

#[test]
fn brownfield_context_cannot_substitute_for_compiled_isolation() {
    let mut context: Context<MockRuntime> = mock_context(noop_assets());
    context.config_mut().app.security.freeze_prototype = true;
    assert_eq!(
        prepare_context(&mut context).err(),
        Some("DESKTOP_ISOLATION_REQUIRED")
    );
}

#[test]
fn unsafe_context_configuration_is_refused_before_startup() {
    let mutations: [fn(&mut Context<MockRuntime>); 6] = [
        |context| context.config_mut().app.security.freeze_prototype = false,
        |context| context.config_mut().app.with_global_tauri = true,
        |context| {
            context.config_mut().build.dev_url =
                Some(Url::parse("https://untrusted.invalid").unwrap())
        },
        |context| {
            context.config_mut().build.frontend_dist = Some(FrontendDist::Url(
                Url::parse("https://untrusted.invalid").unwrap(),
            ))
        },
        |context| {
            context
                .config_mut()
                .app
                .windows
                .push(WindowConfig::default())
        },
        |context| {
            let mut window = WindowConfig::default();
            window.url = WebviewUrl::External(Url::parse("https://untrusted.invalid").unwrap());
            context.config_mut().app.windows.push(window);
        },
    ];
    for mutation in mutations {
        let mut context = context();
        mutation(&mut context);
        assert_eq!(
            prepare_context(&mut context).err(),
            Some("DESKTOP_SECURITY_CONFIGURATION")
        );
    }
}

#[test]
fn navigation_policy_is_specific_to_each_window_and_document() {
    for path in ["/", "/index.html"] {
        assert!(may_navigate(
            MAIN_LABEL,
            &Url::parse(&format!("{}{path}", main_origin())).unwrap()
        ));
    }
    assert!(may_navigate(
        TRUSTED_LABEL,
        &Url::parse(&format!("{}/index.html", trusted_origin())).unwrap()
    ));
    for label in [MAIN_LABEL, TRUSTED_LABEL, "other"] {
        for url in [
            "https://untrusted.invalid/index.html".to_string(),
            format!("{}/index.html?next=x", main_origin()),
            format!("{}/ready.js", trusted_origin()),
        ] {
            assert!(!may_navigate(label, &Url::parse(&url).unwrap()));
        }
    }
    assert!(!may_navigate(
        MAIN_LABEL,
        &Url::parse(&format!("{}/index.html", trusted_origin())).unwrap()
    ));
    assert!(!may_navigate(
        TRUSTED_LABEL,
        &Url::parse(&format!("{}/index.html", main_origin())).unwrap()
    ));
    assert!(!may_navigate(
        "other",
        &Url::parse(&format!("{}/index.html", main_origin())).unwrap()
    ));
    for suffix in [":123/index.html", ".invalid/index.html"] {
        assert!(!may_navigate(
            MAIN_LABEL,
            &Url::parse(&format!("{}{suffix}", main_origin())).unwrap()
        ));
    }
}

#[test]
fn trusted_documents_have_fixed_bodies_and_restrictive_response_headers() {
    let isolation = isolation();
    for (path, body, mime) in [
        (
            "/index.html",
            include_bytes!("../approval/index.html").as_slice(),
            "text/html; charset=utf-8",
        ),
        (
            "/ready.js",
            include_bytes!("../approval/ready.js").as_slice(),
            "text/javascript; charset=utf-8",
        ),
    ] {
        for origin in [None, Some(trusted_origin())] {
            let response = trusted_response(
                TRUSTED_LABEL,
                request(
                    Method::GET,
                    &format!("{}{path}", trusted_origin()),
                    origin.as_deref(),
                ),
                &isolation,
            );
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(&response.body()[..], body);
            assert_eq!(response.headers()[header::CONTENT_TYPE], mime);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(
                response.headers()[header::CONTENT_SECURITY_POLICY]
                    .to_str()
                    .unwrap(),
                isolation.csp()
            );
            assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
            assert_eq!(response.headers()["Referrer-Policy"], "no-referrer");
            assert_eq!(
                response.headers()["Cross-Origin-Resource-Policy"],
                "same-origin"
            );
        }
    }
}

#[test]
fn trusted_protocol_refuses_wrong_runtime_label_regardless_of_headers() {
    for label in [MAIN_LABEL, "other"] {
        let mut request = request(
            Method::GET,
            &format!("{}/index.html", trusted_origin()),
            Some(&trusted_origin()),
        );
        request
            .headers_mut()
            .insert("X-Webview-Label", HeaderValue::from_static("approval"));
        assert_refusal(trusted_response(label, request, &isolation()));
    }
}

#[test]
fn trusted_protocol_refuses_foreign_origins_and_noncanonical_paths() {
    let isolation = isolation();
    let uri = format!("{}/index.html", trusted_origin());
    for origin in [
        main_origin(),
        "https://untrusted.invalid".into(),
        "null".into(),
    ] {
        assert_refusal(trusted_response(
            TRUSTED_LABEL,
            request(Method::GET, &uri, Some(&origin)),
            &isolation,
        ));
    }
    let mut duplicate = request(Method::GET, &uri, Some(&trusted_origin()));
    duplicate.headers_mut().append(
        header::ORIGIN,
        HeaderValue::from_static("https://untrusted.invalid"),
    );
    assert_refusal(trusted_response(TRUSTED_LABEL, duplicate, &isolation));
    let mut invalid = request(Method::GET, &uri, None);
    invalid
        .headers_mut()
        .insert(header::ORIGIN, HeaderValue::from_bytes(&[0xff]).unwrap());
    assert_refusal(trusted_response(TRUSTED_LABEL, invalid, &isolation));
    for uri in [
        format!("{}/index.html", main_origin()),
        "https://untrusted.invalid/index.html".into(),
        format!("{}/", trusted_origin()),
        format!("{}/missing.js", trusted_origin()),
        format!("{}/index.html?next=x", trusted_origin()),
        format!("{}/nested/../index.html", trusted_origin()),
        format!("{}/%69ndex.html", trusted_origin()),
        format!("{}:123/index.html", trusted_origin()),
    ] {
        assert_refusal(trusted_response(
            TRUSTED_LABEL,
            request(Method::GET, &uri, None),
            &isolation,
        ));
    }
}

#[test]
fn trusted_documents_do_not_accept_mutating_or_preflight_methods() {
    let isolation = isolation();
    for method in [
        Method::POST,
        Method::PUT,
        Method::DELETE,
        Method::PATCH,
        Method::OPTIONS,
        Method::HEAD,
    ] {
        let response = trusted_response(
            TRUSTED_LABEL,
            request(method, &format!("{}/index.html", trusted_origin()), None),
            &isolation,
        );
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(&response.body()[..], b"METHOD_NOT_ALLOWED");
    }
}
