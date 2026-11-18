use super::super::StoreError;
use super::NativeProfileScope;

const RECORD_PREFIX: &str = "desktop-profile-identity-namespace-v1--";

#[test]
fn default_profile_has_the_exact_reserved_record_name() {
    let scope = NativeProfileScope::default_profile();
    assert_eq!(
        scope.backend_record_name(),
        "desktop-profile-identity-namespace-v1--default"
    );
    assert_eq!(scope.backend_record_name().len(), 46);
    assert_eq!(
        NativeProfileScope::default_profile().backend_record_name(),
        scope.backend_record_name()
    );
}

#[test]
fn named_default_cannot_alias_the_default_profile() {
    let default = NativeProfileScope::default_profile();
    let named = NativeProfileScope::named_profile("default").expect("valid profile data");
    assert_eq!(
        named.backend_record_name(),
        "desktop-profile-identity-namespace-v1--named-default"
    );
    assert_eq!(named.backend_record_name().len(), 52);
    assert_ne!(default.backend_record_name(), named.backend_record_name());
}

#[test]
fn distinct_named_profiles_have_distinct_deterministic_record_names() {
    let alpha = NativeProfileScope::named_profile("alpha").expect("valid profile data");
    let beta = NativeProfileScope::named_profile("beta").expect("valid profile data");
    assert_eq!(
        alpha.backend_record_name(),
        "desktop-profile-identity-namespace-v1--named-alpha"
    );
    assert_eq!(
        beta.backend_record_name(),
        "desktop-profile-identity-namespace-v1--named-beta"
    );
    assert_ne!(alpha.backend_record_name(), beta.backend_record_name());
    assert_eq!(
        NativeProfileScope::named_profile("alpha")
            .expect("valid profile data")
            .backend_record_name(),
        alpha.backend_record_name()
    );
}

#[test]
fn one_character_lowercase_and_digit_profiles_are_accepted() {
    for (name, expected) in [
        ("a", "desktop-profile-identity-namespace-v1--named-a"),
        ("0", "desktop-profile-identity-namespace-v1--named-0"),
    ] {
        let scope = NativeProfileScope::named_profile(name).expect("valid boundary data");
        assert_eq!(scope.backend_record_name(), expected);
        assert_eq!(scope.backend_record_name().len(), 46);
    }
}

#[test]
fn digit_first_and_interior_hyphens_preserve_the_exact_name() {
    for name in ["0a", "1-default", "a-0", "0-a", "a--0"] {
        let scope = NativeProfileScope::named_profile(name).expect("valid canonical profile data");
        assert_eq!(
            scope.backend_record_name().strip_prefix(RECORD_PREFIX),
            Some(format!("named-{name}").as_str())
        );
    }
}

#[test]
fn the_32_byte_boundary_is_not_truncated_or_folded() {
    let first = "0123456789abcdefghijklmnopqrstuv";
    let second = "0123456789abcdefghijklmnopqrstuw";
    assert_eq!(first.len(), 32);
    assert_eq!(second.len(), 32);
    let first = NativeProfileScope::named_profile(first).expect("valid maximum profile data");
    let second = NativeProfileScope::named_profile(second).expect("valid maximum profile data");
    assert_eq!(
        first.backend_record_name(),
        "desktop-profile-identity-namespace-v1--named-0123456789abcdefghijklmnopqrstuv"
    );
    assert_eq!(first.backend_record_name().len(), 77);
    assert_eq!(second.backend_record_name().len(), 77);
    assert_ne!(first.backend_record_name(), second.backend_record_name());
}

#[test]
fn every_supported_length_retains_all_named_profile_bytes() {
    for length in 1..=32 {
        let name = "a".repeat(length);
        let scope = NativeProfileScope::named_profile(&name).expect("valid bounded profile data");
        assert_eq!(scope.backend_record_name().len(), 45 + length);
        assert_eq!(
            scope.backend_record_name().strip_prefix(RECORD_PREFIX),
            Some(format!("named-{name}").as_str())
        );
    }
}

#[test]
fn noncanonical_names_and_alias_spellings_are_rejected() {
    let too_long = "a".repeat(33);
    for name in [
        "",
        "-",
        "-a",
        "a-",
        "A",
        "aB",
        "DEFAULT",
        " a",
        "a ",
        "a b",
        "a\tb",
        "a\nb",
        "a\rb",
        "a\0b",
        ".",
        "..",
        "./a",
        "../a",
        "a/b",
        r"a\b",
        "a.b",
        "a_b",
        "c:a",
        "a%2fb",
        "é",
        "aé",
        "e\u{301}",
        "а",
        too_long.as_str(),
        "desktop-profile-identity-namespace-v1--default",
    ] {
        assert!(matches!(
            NativeProfileScope::named_profile(name),
            Err(StoreError::InvalidInput)
        ));
    }
}

#[test]
fn encoded_records_are_disjoint_from_every_legacy_name_length() {
    let default = NativeProfileScope::default_profile();
    assert!(default.backend_record_name().len() > 32);
    for length in 1..=32 {
        let scope = NativeProfileScope::named_profile(&"a".repeat(length))
            .expect("valid bounded profile data");
        assert!(scope.backend_record_name().is_ascii());
        assert!(scope.backend_record_name().starts_with(RECORD_PREFIX));
        assert!(scope.backend_record_name().len() > 32);
        assert!(scope.backend_record_name().len() <= 77);
    }
    // No legacy open call is made: this property must not touch a native backend.
}

#[test]
fn debug_output_redacts_both_profile_forms_and_the_backend_namespace() {
    for scope in [
        NativeProfileScope::default_profile(),
        NativeProfileScope::named_profile("dytest-scope-42").expect("valid profile data"),
    ] {
        let debug = format!("{scope:?}");
        assert_eq!(debug, "NativeProfileScope([redacted])");
        assert!(!debug.contains("dytest-scope-42"));
        assert!(!debug.contains(scope.backend_record_name()));
        assert!(!debug.contains(scope.backend_service_name()));
    }
}

#[test]
fn invalid_profile_errors_are_fixed_and_do_not_echo_the_input() {
    let input = "DYTEST-invalid/profile";
    let error =
        NativeProfileScope::named_profile(input).expect_err("invalid profile data must be refused");
    assert_eq!(error, StoreError::InvalidInput);
    assert_eq!(error.code(), "STORE_INVALID_INPUT");
    assert_eq!(error.to_string(), "invalid native store input");
    assert_eq!(format!("{error:?}"), "InvalidInput");
    assert!(!error.to_string().contains(input));
}

#[cfg(not(feature = "native-store"))]
#[test]
fn profile_open_without_the_native_feature_refuses_without_a_backend() {
    for scope in [
        NativeProfileScope::default_profile(),
        NativeProfileScope::named_profile("default").expect("valid profile data"),
    ] {
        assert!(matches!(
            super::super::NativeStore::open_profile(&scope),
            Err(StoreError::Unavailable)
        ));
    }
}

#[test]
fn profile_services_are_distinct_from_legacy_and_named_default() {
    let default = NativeProfileScope::default_profile();
    let named = NativeProfileScope::named_profile("default").expect("valid profile data");
    assert_eq!(
        default.backend_service_name(),
        "com.draftyak.transport.device.v1.desktop-profile.default"
    );
    assert_eq!(
        named.backend_service_name(),
        "com.draftyak.transport.device.v1.desktop-profile.named.default"
    );
    assert_ne!(default.backend_service_name(), super::super::SERVICE);
    assert_ne!(named.backend_service_name(), super::super::SERVICE);
    assert_ne!(default.backend_service_name(), named.backend_service_name());
}

#[test]
fn service_isolation_preserves_the_full_profile_boundary() {
    let mut services = std::collections::HashSet::new();
    services.insert(
        NativeProfileScope::default_profile()
            .backend_service_name()
            .to_owned(),
    );
    services.insert(
        NativeProfileScope::named_profile("default")
            .expect("valid profile data")
            .backend_service_name()
            .to_owned(),
    );
    for length in 1..=32 {
        for name in ["a".repeat(length), format!("{}b", "a".repeat(length - 1))] {
            let scope = NativeProfileScope::named_profile(&name).expect("valid profile data");
            assert!(scope.backend_service_name().is_ascii());
            assert!(
                scope
                    .backend_service_name()
                    .ends_with(&format!(".named.{name}"))
            );
            assert!(services.insert(scope.backend_service_name().to_owned()));
        }
    }
    assert_eq!(services.len(), 66);
}

#[test]
fn reconstructing_a_scope_keeps_both_persistent_names_stable() {
    for name in ["0", "default", "work-1", "0123456789abcdefghijklmnopqrstuv"] {
        let first = NativeProfileScope::named_profile(name).expect("valid profile data");
        let clone = first.clone();
        let restored = NativeProfileScope::named_profile(name).expect("valid profile data");
        assert_eq!(first.backend_service_name(), clone.backend_service_name());
        assert_eq!(
            first.backend_service_name(),
            restored.backend_service_name()
        );
        assert_eq!(first.backend_record_name(), restored.backend_record_name());
    }
}

#[cfg(not(feature = "native-store"))]
#[test]
fn per_profile_service_open_without_native_feature_refuses_without_fallback() {
    for scope in [
        NativeProfileScope::default_profile(),
        NativeProfileScope::named_profile("default").expect("valid profile data"),
    ] {
        assert!(matches!(
            super::super::NativeStore::open_profile_service(&scope),
            Err(StoreError::Unavailable)
        ));
    }
}

#[test]
fn hub_master_key_names_are_separate_without_changing_device_names() {
    let default = NativeProfileScope::default_profile();
    let named = NativeProfileScope::named_profile("default").expect("valid profile data");
    assert_eq!(
        default.backend_master_key_service_name(),
        "com.draftyak.transport.hub-master-key.v1.desktop-profile.default"
    );
    assert_eq!(
        named.backend_master_key_service_name(),
        "com.draftyak.transport.hub-master-key.v1.desktop-profile.named.default"
    );
    assert_eq!(
        default.backend_master_key_record_name(),
        "desktop-profile-hub-master-key-namespace-v1--default"
    );
    assert_eq!(
        named.backend_master_key_record_name(),
        "desktop-profile-hub-master-key-namespace-v1--named-default"
    );
    assert_eq!(
        default.backend_service_name(),
        "com.draftyak.transport.device.v1.desktop-profile.default"
    );
    assert_eq!(
        named.backend_record_name(),
        "desktop-profile-identity-namespace-v1--named-default"
    );
    assert_ne!(
        default.backend_master_key_service_name(),
        named.backend_master_key_service_name()
    );
    assert_ne!(
        default.backend_master_key_record_name(),
        named.backend_master_key_record_name()
    );
    for scope in [default, named] {
        assert_ne!(
            scope.backend_master_key_service_name(),
            super::super::SERVICE
        );
        assert_ne!(
            scope.backend_master_key_service_name(),
            scope.backend_service_name()
        );
        assert_ne!(
            scope.backend_master_key_record_name(),
            scope.backend_record_name()
        );
        assert!(scope.backend_master_key_record_name().len() > 32);
        let debug = format!("{scope:?}");
        assert!(!debug.contains(scope.backend_master_key_service_name()));
        assert!(!debug.contains(scope.backend_master_key_record_name()));
    }
}

#[test]
fn hub_master_key_names_keep_all_supported_lengths_distinct_and_bounded() {
    let mut services = std::collections::HashSet::new();
    let mut records = std::collections::HashSet::new();
    for scope in [
        NativeProfileScope::default_profile(),
        NativeProfileScope::named_profile("default").expect("valid profile data"),
    ] {
        assert!(services.insert(scope.backend_master_key_service_name().to_owned()));
        assert!(records.insert(scope.backend_master_key_record_name().to_owned()));
    }
    for length in 1..=32 {
        for name in ["0".repeat(length), format!("{}b", "a".repeat(length - 1))] {
            let scope =
                NativeProfileScope::named_profile(&name).expect("valid bounded profile data");
            let service = scope.backend_master_key_service_name();
            let record = scope.backend_master_key_record_name();
            assert!(service.is_ascii() && record.is_ascii());
            assert!(service.len() <= 95 && record.len() <= 83);
            assert!(service.len() <= 128 && record.len() <= 128);
            assert!(record.len() > 32);
            assert!(service.ends_with(&format!(".named.{name}")));
            assert!(record.ends_with(&format!("--named-{name}")));
            assert!(services.insert(service.to_owned()));
            assert!(records.insert(record.to_owned()));
            assert_ne!(service, scope.backend_service_name());
            assert_ne!(record, scope.backend_record_name());
        }
    }
    assert_eq!(services.len(), 66);
    assert_eq!(records.len(), 66);
}

#[test]
fn hub_master_key_names_preserve_the_32nd_byte_and_reconstruct_stably() {
    let first_name = "0123456789abcdefghijklmnopqrstuv";
    let second_name = "0123456789abcdefghijklmnopqrstuw";
    assert_eq!(first_name.len(), 32);
    assert_eq!(second_name.len(), 32);
    let first = NativeProfileScope::named_profile(first_name).expect("valid maximum profile data");
    let second =
        NativeProfileScope::named_profile(second_name).expect("valid maximum profile data");
    assert_ne!(
        first.backend_master_key_service_name(),
        second.backend_master_key_service_name()
    );
    assert_ne!(
        first.backend_master_key_record_name(),
        second.backend_master_key_record_name()
    );
    assert_eq!(first.backend_master_key_service_name().len(), 95);
    assert_eq!(first.backend_master_key_record_name().len(), 83);
    assert!(
        first
            .backend_master_key_service_name()
            .ends_with(first_name)
    );
    assert!(first.backend_master_key_record_name().ends_with(first_name));
    let restored =
        NativeProfileScope::named_profile(first_name).expect("same canonical profile data");
    let cloned = first.clone();
    assert_eq!(
        restored.backend_master_key_service_name(),
        first.backend_master_key_service_name()
    );
    assert_eq!(
        restored.backend_master_key_record_name(),
        first.backend_master_key_record_name()
    );
    assert_eq!(
        cloned.backend_master_key_service_name(),
        first.backend_master_key_service_name()
    );
    assert_eq!(
        cloned.backend_master_key_record_name(),
        first.backend_master_key_record_name()
    );
}
