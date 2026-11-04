use super::{NativeProfileError, NativeProfileLocation, ProfileChoice, ProfileName};
use std::path::PathBuf;

// These private-constructor tests exercise location DATA, not a genuine AppHandle,
// filesystem admission, an exclusive lease, freshness or key custody.
fn native_base() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(r"C:\DYTEST-profile-base")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/DYTEST-profile-base")
    }
}

fn named(value: &str) -> ProfileChoice {
    ProfileChoice::Named(
        ProfileName::new(value).unwrap_or_else(|_| panic!("Valid profile fixture refused")),
    )
}

fn location(choice: ProfileChoice, base: PathBuf, identifier: &str) -> NativeProfileLocation {
    NativeProfileLocation::from_native_parts(choice, base, identifier)
        .unwrap_or_else(|_| panic!("Valid native context fixture refused"))
}

fn name_error(value: &str) -> NativeProfileError {
    match ProfileName::new(value) {
        Err(error) => error,
        Ok(_) => panic!("Invalid profile name accepted"),
    }
}

fn location_error(choice: ProfileChoice, base: PathBuf, identifier: &str) -> NativeProfileError {
    match NativeProfileLocation::from_native_parts(choice, base, identifier) {
        Err(error) => error,
        Ok(_) => panic!("Invalid native context accepted"),
    }
}

#[test]
fn default_profile_uses_the_fixed_shared_app_and_hub_component() {
    let base = native_base();
    let selected = location(ProfileChoice::Default, base.clone(), "com.draftyak.client");
    assert_eq!(selected.data_directory(), base.join("draftyak"));
    assert_eq!(selected.data_directory().parent(), Some(base.as_path()));
    assert_eq!(selected.profile_id().as_str(), "draftyak");
    assert_eq!(selected.application_identifier(), "com.draftyak.client");
}

#[test]
fn choices_supply_exact_application_identifiers_before_a_native_location_exists() {
    for (choice, expected) in [
        (ProfileChoice::Default, "com.draftyak.client"),
        (named("default"), "com.draftyak.client.default"),
        (
            named("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            "com.draftyak.client.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
    ] {
        assert_eq!(choice.application_identifier(), expected);
    }
}

#[test]
fn default_and_two_named_profiles_have_disjoint_paths_and_identifiers() {
    let base = native_base();
    let default = location(ProfileChoice::Default, base.clone(), "com.draftyak.client");
    let work = location(named("work"), base.clone(), "com.draftyak.client.work");
    let personal = location(
        named("personal"),
        base.clone(),
        "com.draftyak.client.personal",
    );
    assert_eq!(work.data_directory(), base.join("draftyak-work"));
    assert_eq!(personal.data_directory(), base.join("draftyak-personal"));
    assert_eq!(work.data_directory().parent(), Some(base.as_path()));
    assert_eq!(personal.data_directory().parent(), Some(base.as_path()));
    assert_eq!(work.profile_id().as_str(), "draftyak-work");
    assert_eq!(personal.profile_id().as_str(), "draftyak-personal");
    assert_eq!(work.application_identifier(), "com.draftyak.client.work");
    assert_eq!(
        personal.application_identifier(),
        "com.draftyak.client.personal"
    );
    for (left, right) in [(&default, &work), (&default, &personal), (&work, &personal)] {
        assert_ne!(left.data_directory(), right.data_directory());
        assert_ne!(left.profile_id().as_str(), right.profile_id().as_str());
        assert_ne!(
            left.application_identifier(),
            right.application_identifier()
        );
    }
}

#[test]
fn accepted_names_preserve_lowercase_digits_and_interior_hyphens_at_the_boundaries() {
    let longest = "a".repeat(32);
    for value in ["a", "0", "work-2", "a--b", longest.as_str()] {
        let selected = ProfileName::new(value).unwrap_or_else(|_| panic!("Valid name refused"));
        assert_eq!(selected.as_str(), value);
    }
}

#[test]
fn names_refuse_aliases_and_nonportable_components_instead_of_normalizing_them() {
    for value in [
        "",
        ".",
        "..",
        "../work",
        "work/child",
        r"work\child",
        "Work",
        "WORK",
        "work.",
        ".work",
        "work name",
        " work",
        "work ",
        "-work",
        "work-",
        "work_name",
        "a:b",
        "a\0b",
        "a\nb",
        "a\tb",
        "é",
        "е",
        "ａ",
        "a\u{0301}",
        "work\u{200d}",
    ] {
        assert!(matches!(name_error(value), NativeProfileError::InvalidName));
    }
}

#[test]
fn a_thirty_three_character_name_is_refused_without_truncation() {
    let too_long = "a".repeat(33);
    assert!(matches!(
        name_error(&too_long),
        NativeProfileError::InvalidName
    ));
    let exact = "a".repeat(32);
    let selected = location(
        named(&exact),
        native_base(),
        &format!("com.draftyak.client.{exact}"),
    );
    assert_eq!(selected.profile_id().as_str(), format!("draftyak-{exact}"));
}

#[test]
fn native_bases_must_be_absolute_nonroot_and_have_no_dot_components() {
    #[cfg(windows)]
    let root_only = PathBuf::from(r"C:\");
    #[cfg(not(windows))]
    let root_only = PathBuf::from("/");
    for base in [
        PathBuf::new(),
        PathBuf::from("relative"),
        PathBuf::from("./relative"),
        root_only,
        native_base().join("..").join("other"),
        native_base().join(".").join("child"),
    ] {
        assert!(matches!(
            location_error(ProfileChoice::Default, base, "com.draftyak.client"),
            NativeProfileError::InvalidLocation
        ));
    }
}

#[test]
fn native_context_identifier_must_match_the_exact_selected_profile() {
    for (choice, identifier) in [
        (ProfileChoice::Default, "com.draftyak.client.work"),
        (named("work"), "com.draftyak.client"),
        (named("work"), "com.draftyak.client.personal"),
        (named("work"), "Com.draftyak.client.work"),
        (named("work"), "com.draftyak.client.work."),
        (ProfileChoice::Default, ""),
    ] {
        assert!(matches!(
            location_error(choice, native_base(), identifier),
            NativeProfileError::ContextMismatch
        ));
    }
}

#[test]
fn a_unicode_native_base_is_preserved_while_only_the_profile_component_is_canonical() {
    let base = native_base().join("DYTEST-Δ-测试");
    let selected = location(named("work-2"), base.clone(), "com.draftyak.client.work-2");
    assert_eq!(selected.data_directory(), base.join("draftyak-work-2"));
    assert_eq!(
        selected.application_identifier(),
        "com.draftyak.client.work-2"
    );
}

#[test]
fn error_debug_and_display_do_not_echo_untrusted_names_bases_or_context() {
    let private_name = "DYTEST_PRIVATE_NAME_é";
    let private_base = native_base().join("DYTEST_PRIVATE_BASE").join("..");
    let private_identifier = "DYTEST_PRIVATE_IDENTIFIER";
    for error in [
        name_error(private_name),
        location_error(ProfileChoice::Default, private_base, "com.draftyak.client"),
        location_error(named("work"), native_base(), private_identifier),
    ] {
        for rendered in [format!("{error}"), format!("{error:?}")] {
            assert!(!rendered.contains("DYTEST_PRIVATE"));
            assert!(!rendered.contains("profile-base"));
            assert!(!rendered.contains(private_name));
            assert!(!rendered.contains(private_identifier));
        }
    }
}

#[test]
fn successful_location_debug_is_redacted_instead_of_disclosing_profile_data() {
    let base = native_base().join("DYTEST_PRIVATE_SUCCESS_BASE");
    let selected = location(
        named("secret-team"),
        base,
        "com.draftyak.client.secret-team",
    );
    let rendered = format!("{selected:?}");
    assert!(!rendered.contains("DYTEST_PRIVATE"));
    assert!(!rendered.contains("profile-base"));
    assert!(!rendered.contains("secret-team"));
    assert!(!rendered.contains("com.draftyak.client"));
}
