use draftyak_protocol::{
    jcs::canonicalize,
    statements::{self, Statement},
};
use serde_json::{Value, json};

fn base() -> Value {
    json!({"v":1,"hub":"a".repeat(64),"epoch":1,"device":"01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "nonce":"AAECAwQFBgcICQoLDA0ODw","iat":1000,"exp":121000,
        "session":"01ARZ3NDEKTSV4RRFFQ69G5FAV","principal":{"kind":"grant","id":"01ARZ3NDEKTSV4RRFFQ69G5FAV"},
        "account":"01ARZ3NDEKTSV4RRFFQ69G5FAV","toolClass":"read","authorization":{"kind":"session","durationMs":900000}})
}
fn valid(value: &Value) -> bool {
    statements::parse_statement("agent-session.v1", canonicalize(value).unwrap().as_bytes())
        .is_some()
}
#[test]
fn principal_class_duration_and_challenge_lifetime_are_distinct() {
    for principal in ["grant", "token"] {
        for class in ["read", "draft", "organize"] {
            for duration in [900_000, 3_600_000, 28_800_000] {
                let mut body = base();
                body["principal"]["kind"] = json!(principal);
                body["toolClass"] = json!(class);
                body["authorization"]["durationMs"] = json!(duration);
                let Some(Statement::Agent(parsed)) = statements::parse_statement(
                    "agent-session.v1",
                    canonicalize(&body).unwrap().as_bytes(),
                ) else {
                    panic!("session");
                };
                assert!(parsed.is_fresh(1000));
                assert!(parsed.is_fresh(121000));
                assert!(!parsed.is_fresh(999));
                assert!(!parsed.is_fresh(121001));
            }
        }
    }
}
#[test]
fn single_call_is_exact_ten_minutes_and_resource_reads_are_read_only() {
    for method in ["tools/call", "resources/read"] {
        for class in ["read", "draft", "organize"] {
            let mut body = base();
            body["toolClass"] = json!(class);
            body["authorization"] = json!({"kind":"call","method":method,"paramsDigest":"b".repeat(64),"validForMs":600000,"singleUse":true});
            assert_eq!(valid(&body), method == "tools/call" || class == "read");
            for (field, bad) in [
                ("singleUse", json!(false)),
                ("validForMs", json!(600001)),
                ("paramsDigest", json!("B".repeat(64))),
                ("method", json!("prompts/get")),
            ] {
                let mut changed = body.clone();
                changed["authorization"][field] = bad;
                assert!(!valid(&changed));
            }
        }
    }
}
#[test]
fn unknown_fields_mixed_modes_and_widening_are_rejected() {
    for (field, value) in [
        ("session", json!("bad")),
        ("account", json!("bad")),
        ("toolClass", json!("send")),
        ("exp", json!(121001)),
        ("surprise", json!(true)),
    ] {
        let mut body = base();
        body[field] = value;
        assert!(!valid(&body));
    }
    for value in [
        json!({"kind":"host:sms","id":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}),
        json!({"kind":"token","id":"bad"}),
        json!({"kind":"grant","id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","scopes":["send"]}),
    ] {
        let mut body = base();
        body["principal"] = value;
        assert!(!valid(&body));
    }
    for value in [
        json!({"kind":"session","durationMs":900001}),
        json!({"kind":"session","durationMs":28800001}),
        json!({"kind":"session","durationMs":900000,"method":"tools/call"}),
        json!({"kind":"call","method":"tools/call","paramsDigest":"b".repeat(64)}),
    ] {
        let mut body = base();
        body["authorization"] = value;
        assert!(!valid(&body));
    }
}

#[test]
fn challenge_freshness_never_uses_access_duration_and_rechecks_mutated_fields() {
    use draftyak_protocol::statements::agent_session::AgentSessionStatement;
    for authorization in [
        json!({"kind":"session","durationMs":28800000}),
        json!({"kind":"call","method":"tools/call","paramsDigest":"b".repeat(64),"validForMs":600000,"singleUse":true}),
    ] {
        let mut value = base();
        value["authorization"] = authorization;
        let mut statement: AgentSessionStatement = serde_json::from_value(value).unwrap();
        assert!(statement.is_fresh(statement.iat));
        assert!(statement.is_fresh(statement.exp));
        for now in [
            statement.iat - 1,
            statement.exp + 1,
            statement.iat + 600_000,
            statement.iat + 28_800_000,
        ] {
            assert!(!statement.is_fresh(now));
        }
        statement.exp = statement.iat + 600_000;
        assert!(!statement.is_fresh(statement.iat));
    }
    for (field, value) in [
        ("iat", json!(-1)),
        ("iat", json!(0.5)),
        ("exp", json!(999)),
        ("exp", json!(9_007_199_254_740_992_u64)),
        ("scopes", json!(["approve"])),
        ("approved", json!(true)),
    ] {
        let mut body = base();
        body[field] = value;
        assert!(!valid(&body));
    }
}

#[test]
fn direct_decode_never_echoes_nested_authority_or_enum_values() {
    use draftyak_protocol::statements::agent_session::AgentSessionStatement;
    let mut top = base();
    top["PRIVATE_CANARY"] = json!(true);
    let mut principal = base();
    principal["principal"]["PRIVATE_CANARY"] = json!(true);
    let mut authorization = base();
    authorization["authorization"]["PRIVATE_CANARY"] = json!(true);
    let mut kind = base();
    kind["principal"]["kind"] = json!("PRIVATE_CANARY");
    let mut class = base();
    class["toolClass"] = json!("PRIVATE_CANARY");
    for body in [top, principal, authorization, kind, class] {
        let error = serde_json::from_value::<AgentSessionStatement>(body).unwrap_err();
        assert_eq!(error.to_string(), "STATEMENT_INVALID");
        assert!(!format!("{error:?}").contains("CANARY"));
    }
}

#[test]
fn review_subject_is_closed_and_shows_only_a_duration_or_method_target() {
    use draftyak_protocol::statements::agent_session::AgentSessionReviewSubject;
    let body = base();
    let subject = json!({"principal":body["principal"],"account":body["account"],
        "toolClass":"read","authorization":body["authorization"]});
    assert!(serde_json::from_value::<AgentSessionReviewSubject>(subject.clone()).is_ok());
    let call = json!({"kind":"call","method":"tools/call","paramsDigest":"b".repeat(64),
        "validForMs":600000,"singleUse":true,"target":"message_get"});
    let mut review = subject.clone();
    review["authorization"] = call.clone();
    assert!(serde_json::from_value::<AgentSessionReviewSubject>(review.clone()).is_ok());
    for (target, class) in [
        ("accounts_list", "read"),
        ("contacts_search", "read"),
        ("conversation_get", "read"),
        ("conversations_list", "read"),
        ("draft_get", "read"),
        ("drafts_list", "read"),
        ("message_get", "read"),
        ("messages_search", "read"),
        ("send_request_status", "read"),
        ("conversation_archive", "organize"),
        ("conversation_label", "organize"),
        ("conversation_mark_read", "organize"),
        ("draft_create", "draft"),
        ("draft_update", "draft"),
        ("draft_discard", "draft"),
        ("send_request_create", "draft"),
        ("send_request_cancel", "draft"),
    ] {
        let mut item = review.clone();
        item["toolClass"] = json!(class);
        item["authorization"]["target"] = json!(target);
        assert!(serde_json::from_value::<AgentSessionReviewSubject>(item).is_ok());
    }
    for kind in ["conversation", "message", "draft", "send-request"] {
        let mut item = review.clone();
        item["authorization"]["method"] = json!("resources/read");
        item["authorization"]["target"] =
            json!(format!("draftyak://{kind}/01ARZ3NDEKTSV4RRFFQ69G5FAV"));
        assert!(serde_json::from_value::<AgentSessionReviewSubject>(item).is_ok());
    }
    let mut unknown = review.clone();
    unknown["PRIVATE_CANARY"] = json!(true);
    let mut nested = review.clone();
    nested["authorization"]["PRIVATE_CANARY"] = json!(true);
    let mut wrong_target = review.clone();
    wrong_target["authorization"]["target"] = json!("draft_update");
    let mut missing_target = review.clone();
    missing_target["authorization"]
        .as_object_mut()
        .unwrap()
        .remove("target");
    let mut mixed = subject.clone();
    mixed["authorization"]["target"] = json!("message_get");
    for item in [unknown, nested, wrong_target, missing_target, mixed] {
        let error = serde_json::from_value::<AgentSessionReviewSubject>(item).unwrap_err();
        assert_eq!(error.to_string(), "STATEMENT_INVALID");
    }
    for target in [
        "draftyak://guide/agents",
        "ui://draftyak/draft-v1",
        "draftyak://message/01ARZ3NDEKTSV4RRFFQ69G5FAV?content=x",
        "PRIVATE_CANARY",
    ] {
        let mut item = review.clone();
        item["authorization"]["method"] = json!("resources/read");
        item["authorization"]["target"] = json!(target);
        assert!(serde_json::from_value::<AgentSessionReviewSubject>(item).is_err());
    }
}

#[test]
fn pending_match_binds_principal_method_digest_and_every_signed_item_field() {
    use draftyak_protocol::statements::agent_session::{
        AgentSessionReviewSubject, AgentSessionStatement,
    };
    let mut body = base();
    body["authorization"] = json!({"kind":"call","method":"tools/call","paramsDigest":"b".repeat(64),
        "validForMs":600000,"singleUse":true});
    let mut subject = json!({"principal":body["principal"],"account":body["account"],
        "toolClass":"read","authorization":body["authorization"]});
    subject["authorization"]["target"] = json!("message_get");
    let review: AgentSessionReviewSubject = serde_json::from_value(subject).unwrap();
    let statement: AgentSessionStatement = serde_json::from_value(body.clone()).unwrap();
    assert!(statement.matches_pending(&statement.session, &review));
    assert!(!statement.matches_pending("01JAZ3W3B6Q8M2V0G5T9K4X720", &review));
    for (field, value) in [
        (
            "principal",
            json!({"kind":"token","id":body["principal"]["id"]}),
        ),
        (
            "principal",
            json!({"kind":"grant","id":"01JAZ3W3B6Q8M2V0G5T9K4X720"}),
        ),
        ("account", json!("01JAZ3W3B6Q8M2V0G5T9K4X720")),
        ("toolClass", json!("organize")),
        (
            "authorization",
            json!({"kind":"call","method":"resources/read","paramsDigest":"b".repeat(64),"validForMs":600000,"singleUse":true}),
        ),
        (
            "authorization",
            json!({"kind":"call","method":"tools/call","paramsDigest":"c".repeat(64),"validForMs":600000,"singleUse":true}),
        ),
        (
            "authorization",
            json!({"kind":"session","durationMs":900000}),
        ),
    ] {
        let mut changed = body.clone();
        changed[field] = value;
        let parsed: AgentSessionStatement = serde_json::from_value(changed).unwrap();
        assert!(!parsed.matches_pending(&statement.session, &review));
    }
    let mut mutated_review = review.clone();
    mutated_review.account = "bad".into();
    assert!(!statement.matches_pending(&statement.session, &mutated_review));
}

fn matching_pending_call() -> (
    statements::agent_session::AgentSessionStatement,
    statements::agent_session::AgentSessionReviewSubject,
) {
    let mut body = base();
    body["authorization"] = json!({"kind":"call","method":"tools/call","paramsDigest":"b".repeat(64),
        "validForMs":600000,"singleUse":true});
    let mut subject = json!({"principal":body["principal"],"account":body["account"],
        "toolClass":"read","authorization":body["authorization"]});
    subject["authorization"]["target"] = json!("message_get");
    (
        serde_json::from_value(body).unwrap(),
        serde_json::from_value(subject).unwrap(),
    )
}

#[test]
fn pending_match_rechecks_mutated_statement_validity() {
    let (mut statement, review) = matching_pending_call();
    assert!(statement.valid());
    assert!(review.valid());
    assert!(statement.matches_pending(&statement.session, &review));

    statement.v = 0;
    assert!(!statement.valid());
    assert!(review.valid());
    assert!(!statement.matches_pending(&statement.session, &review));

    statement.v = 1;
    assert!(statement.matches_pending(&statement.session, &review));
}

#[test]
fn pending_match_rechecks_mutated_review_validity() {
    use statements::agent_session::AgentSessionReviewAuthorization;
    let (statement, mut review) = matching_pending_call();
    assert!(statement.valid());
    assert!(review.valid());
    assert!(statement.matches_pending(&statement.session, &review));

    let AgentSessionReviewAuthorization::Call { target, .. } = &mut review.authorization else {
        panic!("expected call review");
    };
    *target = "draft_update".into();
    assert!(statement.valid());
    assert!(!review.valid());
    assert!(!statement.matches_pending(&statement.session, &review));

    let AgentSessionReviewAuthorization::Call { target, .. } = &mut review.authorization else {
        panic!("expected call review");
    };
    *target = "message_get".into();
    assert!(statement.matches_pending(&statement.session, &review));
}
