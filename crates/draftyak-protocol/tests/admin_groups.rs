use draftyak_protocol::statements::admin::{ADMIN_GROUPS, ADMIN_KINDS};
use std::collections::BTreeSet;

const AI_KINDS: [&str; 2] = ["ai.credential-connect", "ai.credential-disconnect"];

fn group(name: &str) -> usize {
    ADMIN_GROUPS
        .iter()
        .position(|(group, _)| *group == name)
        .unwrap_or_else(|| panic!("missing admin group {name}"))
}

#[test]
fn ai_group_sits_between_data_and_sms() {
    let ai = group("ai");
    assert_eq!(group("data") + 1, ai);
    assert_eq!(ai + 1, group("sms"));
    assert_eq!(ADMIN_GROUPS[ai].1, AI_KINDS);
}

#[test]
fn admin_kinds_flatten_the_groups() {
    let flattened: Vec<&str> = ADMIN_GROUPS
        .iter()
        .flat_map(|(_, kinds)| kinds.iter().copied())
        .collect();
    assert_eq!(ADMIN_KINDS, flattened.as_slice());
    assert_eq!(
        ADMIN_KINDS.iter().collect::<BTreeSet<_>>().len(),
        ADMIN_KINDS.len()
    );
    for kind in AI_KINDS {
        let count = ADMIN_KINDS.iter().filter(|item| **item == kind).count();
        assert_eq!(count, 1, "{kind}");
    }
}

#[test]
fn near_miss_ai_kinds_are_not_admin_kinds() {
    for kind in [
        "ai.connect",
        "ai.credential-revoke",
        "ai.credential-transfer",
    ] {
        assert!(!ADMIN_KINDS.contains(&kind), "{kind}");
    }
}
