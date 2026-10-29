use draftyak_protocol::scheduled_summary::{
    self as summary, ScheduledItem, ScheduledSummary, parse_scheduled_summary,
};
use serde_json::Value;
use std::{fs, path::PathBuf};

fn directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/vectors/scheduled-summary")
}
fn cases() -> Vec<Value> {
    let document: Value =
        serde_json::from_slice(&fs::read(directory().join("cases.json")).unwrap()).unwrap();
    assert_eq!(document["format"], "draftyak.vectors.scheduled-summary.v1");
    document["cases"].as_array().unwrap().clone()
}
fn case(id: &str) -> Value {
    cases()
        .into_iter()
        .find(|case| case["id"] == id)
        .unwrap_or_else(|| panic!("no case {id}"))["value"]
        .clone()
}

#[test]
fn all_shared_scheduled_summary_vectors() {
    let mut names: Vec<String> = fs::read_dir(directory())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    // scope-hash.json binds members only the hub holds, so only TypeScript computes it.
    assert_eq!(names, ["cases.json", "scope-hash.json"]);
    let cases = cases();
    for case in &cases {
        assert_eq!(case["action"], "schema");
        let valid = match case["schema"].as_str().unwrap() {
            "ScheduledSummary" => {
                serde_json::from_value::<ScheduledSummary>(case["value"].clone()).is_ok()
            }
            "ScheduledItem" => {
                serde_json::from_value::<ScheduledItem>(case["value"].clone()).is_ok()
            }
            other => panic!("unhandled schema {other}"),
        };
        assert_eq!(valid, case["valid"].as_bool().unwrap(), "{}", case["id"]);
    }
    assert!(cases.len() > 100);
}

#[test]
fn items_show_no_body_subject_statement_or_credential() {
    let item: ScheduledItem = serde_json::from_value(case("item-base")).unwrap();
    let shown = serde_json::to_value(&item).unwrap();
    let mut names: Vec<_> = shown.as_object().unwrap().keys().cloned().collect();
    names.sort();
    assert_eq!(
        names,
        [
            "accountId",
            "alias",
            "deliverBy",
            "destination",
            "destinationTruncated",
            "moreRecipients",
            "outboxId",
            "schedule"
        ]
    );
    for name in &names {
        let lower = name.to_ascii_lowercase();
        for word in [
            "body",
            "subject",
            "statement",
            "credential",
            "secret",
            "token",
        ] {
            assert!(!lower.contains(word), "{name}");
        }
    }
    assert_eq!(shown, case("item-base"));
}

#[test]
fn summary_answer_capped_before_parsing_and_compared_by_scope() {
    let value = case("summary-bounded-page");
    let body = serde_json::to_vec(&value).unwrap();
    let parsed = parse_scheduled_summary(&body).unwrap();
    assert_eq!(parsed.scheduled_count(), 6);
    assert_eq!(parsed.items().len(), summary::MAX_SCHEDULED_ITEMS);
    assert_eq!(
        parsed.pending_approval_ids().len(),
        summary::MAX_PENDING_APPROVAL_IDS
    );
    assert!(
        parsed
            .items()
            .windows(2)
            .all(|pair| pair[0].not_before() < pair[1].not_before())
    );
    let mut padded = body.clone();
    padded.resize(8192, b' ');
    assert!(parse_scheduled_summary(&padded).is_some());
    padded.push(b' ');
    assert!(parse_scheduled_summary(&padded).is_none());
    let largest = serde_json::to_vec(&case("summary-largest")).unwrap();
    assert!(largest.len() <= 8192);
    assert!(parse_scheduled_summary(&largest).is_some());

    let again: ScheduledSummary = serde_json::from_value(value.clone()).unwrap();
    assert!(parsed.same_scope(&again));
    let mut changed = value;
    changed["scopeHash"] = Value::from("0".repeat(64));
    let changed: ScheduledSummary = serde_json::from_value(changed).unwrap();
    assert!(!parsed.same_scope(&changed));
    assert_eq!(changed.scheduling(), parsed.scheduling());
}
