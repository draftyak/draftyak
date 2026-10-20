use draftyak_protocol::flags::parse_flags;

#[test]
fn malformed_flags_never_repeat_input_diagnostics() {
    for input in [
        r#"[{"code":"PRIVATE_CANARY\nFIELD","severity":"ack"}]"#,
        r#"[{"code":"NEW_RECIPIENT","severity":"PRIVATE_CANARY"}]"#,
        r#"[{"code":"NEW_RECIPIENT","severity":"ack","PRIVATE_CANARY":true}]"#,
        r#"[{"code":"NEW_RECIPIENT","code":"PRIVATE_CANARY","severity":"ack"}]"#,
    ] {
        let error = parse_flags(input.as_bytes()).unwrap_err();
        assert_eq!(error.to_string(), "FLAGS_INVALID");
        assert!(!format!("{error:?}").contains("PRIVATE_CANARY"));
    }
    assert!(parse_flags(br#"[{"code":"NEW_RECIPIENT","severity":"ack"}]"#).is_ok());
}
