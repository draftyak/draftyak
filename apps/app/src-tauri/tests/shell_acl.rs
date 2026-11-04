use draftyak_desktop::{shell, window_security};
use serde_json::{Value, json};
use tauri::{
    App, Context, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    http::HeaderMap,
    ipc::{CallbackFn, InvokeBody},
    test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder},
    webview::InvokeRequest,
};

fn app() -> App<MockRuntime> {
    let mut context: Context<MockRuntime> = tauri::generate_context!();
    context.config_mut().identifier = "com.draftyak.tests.shell".into();
    let isolation = window_security::prepare_context(&mut context).unwrap();
    shell::configure(mock_builder(), isolation)
        .build(context)
        .unwrap()
}

fn invoke(
    window: &WebviewWindow<MockRuntime>,
    origin: &str,
    command: &str,
    body: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: Url::parse(origin).unwrap(),
            body: InvokeBody::Json(body),
            headers: HeaderMap::new(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map(|response| response.deserialize().unwrap())
}

fn state(window: &WebviewWindow<MockRuntime>) -> Value {
    invoke(
        window,
        &window_security::main_origin(),
        "shell_state",
        json!({}),
    )
    .unwrap()
}

#[test]
fn compiled_main_capability_allows_only_local_mode_selection() {
    let app = app();
    let main = shell::open_main(app.handle()).unwrap();
    assert_eq!(state(&main), json!({"mode": null}));
    for mode in ["hub", "connect"] {
        assert_eq!(
            invoke(
                &main,
                &window_security::main_origin(),
                "shell_select_mode",
                json!({"mode": mode}),
            )
            .unwrap(),
            json!({"mode": mode})
        );
        assert_eq!(state(&main), json!({"mode": mode}));
    }
}

#[test]
fn remote_request_origin_cannot_use_the_main_capability() {
    let app = app();
    let main = shell::open_main(app.handle()).unwrap();
    for command in ["shell_state", "shell_select_mode"] {
        assert!(
            invoke(
                &main,
                "https://untrusted.invalid",
                command,
                json!({"mode": "hub"})
            )
            .is_err()
        );
    }
    assert_eq!(state(&main), json!({"mode": null}));
}

#[test]
fn local_origin_does_not_grant_an_unlisted_window_a_capability() {
    let app = app();
    let main = shell::open_main(app.handle()).unwrap();
    let other = WebviewWindowBuilder::new(&app, "other", WebviewUrl::App("index.html".into()))
        .build()
        .unwrap();
    for command in ["shell_state", "shell_select_mode"] {
        assert!(
            invoke(
                &other,
                &window_security::main_origin(),
                command,
                json!({"mode": "hub"})
            )
            .is_err()
        );
    }
    assert_eq!(state(&main), json!({"mode": null}));
}

#[test]
fn approval_window_has_no_shell_or_native_approval_commands() {
    let app = app();
    let main = shell::open_main(app.handle()).unwrap();
    let approval = shell::open_trusted(app.handle()).unwrap();
    for origin in [
        window_security::trusted_origin(),
        window_security::main_origin(),
    ] {
        for command in [
            "shell_state",
            "shell_select_mode",
            "approve",
            "confirm",
            "open_trusted",
        ] {
            assert!(invoke(&approval, &origin, command, json!({"mode": "hub"})).is_err());
        }
    }
    assert_eq!(state(&main), json!({"mode": null}));
}

#[test]
fn main_label_does_not_authorize_a_different_local_document() {
    let app = app();
    let url: Url = format!("{}/index.html", window_security::trusted_origin())
        .parse()
        .unwrap();
    let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::External(url))
        .build()
        .unwrap();
    for command in ["shell_state", "shell_select_mode"] {
        let error = invoke(
            &main,
            &window_security::trusted_origin(),
            command,
            json!({"mode": "hub"}),
        )
        .unwrap_err();
        assert_eq!(error, json!("SHELL_FORBIDDEN"));
    }
}

#[test]
fn malformed_modes_and_unknown_commands_cannot_mutate_selection() {
    let app = app();
    let main = shell::open_main(app.handle()).unwrap();
    for body in [
        json!({}),
        json!({"mode": null}),
        json!({"mode": 1}),
        json!({"mode": "Hub"}),
        json!({"mode": "approve"}),
    ] {
        assert!(
            invoke(
                &main,
                &window_security::main_origin(),
                "shell_select_mode",
                body
            )
            .is_err()
        );
        assert_eq!(state(&main), json!({"mode": null}));
    }
    for command in ["unknown", "approve", "confirm", "open_trusted"] {
        assert!(invoke(&main, &window_security::main_origin(), command, json!({})).is_err());
    }
    assert_eq!(state(&main), json!({"mode": null}));
}

#[test]
fn selection_is_fresh_for_each_application() {
    {
        let app = app();
        let main = shell::open_main(app.handle()).unwrap();
        invoke(
            &main,
            &window_security::main_origin(),
            "shell_select_mode",
            json!({"mode": "hub"}),
        )
        .unwrap();
        assert_eq!(state(&main), json!({"mode": "hub"}));
    }
    let app = app();
    assert_eq!(
        state(&shell::open_main(app.handle()).unwrap()),
        json!({"mode": null})
    );
}
