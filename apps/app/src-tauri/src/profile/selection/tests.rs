use super::super::ProfileChoice;
use super::{ProfileSelectionError, select_native_profile};
use std::cell::Cell;
use std::ffi::OsString;

fn arguments(values: &[&str]) -> Vec<OsString> {
    values.iter().map(|value| OsString::from(*value)).collect()
}

fn selected(values: &[&str]) -> ProfileChoice {
    select_native_profile(arguments(values))
        .unwrap_or_else(|_| panic!("Valid native profile arguments refused"))
}

fn assert_named(choice: &ProfileChoice, expected: &str) {
    match choice {
        ProfileChoice::Named(name) => assert_eq!(name.as_str(), expected),
        ProfileChoice::Default => panic!("Named launch arguments selected the default profile"),
    }
}

fn refused(values: Vec<OsString>) -> ProfileSelectionError {
    match select_native_profile(values) {
        Err(error) => error,
        Ok(_) => panic!("Invalid native profile arguments accepted"),
    }
}

#[test]
fn no_native_arguments_selects_only_the_default_profile() {
    let choice = select_native_profile(std::iter::empty::<OsString>())
        .unwrap_or_else(|_| panic!("Empty native launch refused"));
    assert!(matches!(&choice, ProfileChoice::Default));
    assert_eq!(choice.application_identifier(), "com.draftyak.client");
}

#[test]
fn exact_named_launches_keep_two_profile_identities_separate_before_context_creation() {
    let work = selected(&["--profile", "work"]);
    let personal = selected(&["--profile", "personal"]);
    assert_named(&work, "work");
    assert_named(&personal, "personal");
    assert_eq!(work.application_identifier(), "com.draftyak.client.work");
    assert_eq!(
        personal.application_identifier(),
        "com.draftyak.client.personal"
    );
    assert_ne!(
        work.application_identifier(),
        personal.application_identifier()
    );
}

#[test]
fn canonical_name_boundaries_are_preserved_without_magic_default_aliases() {
    let longest = "a".repeat(32);
    for name in [
        "a",
        "0",
        "work-2",
        "a--b",
        "default",
        "draftyak",
        longest.as_str(),
    ] {
        assert_named(&selected(&["--profile", name]), name);
    }
}

#[test]
fn invalid_names_refuse_instead_of_falling_back_or_normalizing() {
    let too_long = "a".repeat(33);
    for name in [
        "",
        "Work",
        "WORK",
        "work ",
        " work",
        "work.",
        ".",
        "..",
        "../work",
        "work/child",
        r"work\child",
        "work_name",
        "-work",
        "work-",
        "a b",
        "a:b",
        "é",
        "е",
        "ａ",
        "a\u{0301}",
        "a\0b",
        too_long.as_str(),
    ] {
        refused(arguments(&["--profile", name]));
    }
}

#[test]
fn missing_duplicate_and_extra_arguments_are_all_refused() {
    for values in [
        vec!["--profile"],
        vec!["--profile", "--profile"],
        vec!["--profile", "work", "extra"],
        vec!["--profile", "work", "--profile", "personal"],
        vec!["--profile", "work", "--DYTEST-unknown"],
    ] {
        refused(arguments(&values));
    }
}

#[test]
fn unknown_flags_aliases_and_an_included_executable_are_not_forwarded() {
    for values in [
        vec!["--DYTEST-unknown"],
        vec!["work"],
        vec!["--profile=work"],
        vec!["--PROFILE", "work"],
        vec!["-p", "work"],
        vec!["--"],
        vec![" --profile", "work"],
        vec!["--profile ", "work"],
        vec!["DYTEST-executable", "--profile", "work"],
    ] {
        refused(arguments(&values));
    }
}

#[test]
fn malformed_argument_tails_are_not_drained_past_the_third_read() {
    let reads = Cell::new(0);
    let values = std::iter::from_fn(|| {
        let index = reads.get();
        reads.set(index + 1);
        Some(OsString::from(match index {
            0 => "--profile",
            1 => "work",
            2 => "--DYTEST-extra",
            _ => panic!("Native profile parser drained an unaccepted tail"),
        }))
    });
    assert!(select_native_profile(values).is_err());
    assert_eq!(reads.get(), 3);
}

#[test]
fn selection_errors_are_fixed_and_redact_every_argument_value() {
    for values in [
        vec!["--profile", "DYTEST_PRIVATE_NAME_é"],
        vec!["--DYTEST_PRIVATE_FLAG"],
        vec!["/DYTEST_PRIVATE_PATH"],
    ] {
        let error = refused(arguments(&values));
        assert_eq!(error.to_string(), "Native profile arguments unavailable");
        assert_eq!(format!("{error:?}"), "ProfileSelectionError");
        assert!(!error.to_string().contains("DYTEST_PRIVATE"));
        assert!(std::error::Error::source(&error).is_none());
    }
}

#[cfg(unix)]
#[test]
fn non_unicode_native_flags_and_names_are_refused_without_lossy_conversion() {
    use std::os::unix::ffi::OsStringExt;
    let value = OsString::from_vec(vec![0xff, 0xfe]);
    refused(vec![OsString::from("--profile"), value.clone()]);
    refused(vec![value, OsString::from("work")]);
}

#[cfg(windows)]
#[test]
fn non_unicode_native_flags_and_names_are_refused_without_lossy_conversion() {
    use std::os::windows::ffi::OsStringExt;
    let value = OsString::from_wide(&[0xd800]);
    refused(vec![OsString::from("--profile"), value.clone()]);
    refused(vec![value, OsString::from("work")]);
}
