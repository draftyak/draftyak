use super::super::{NativeProfileError, NativeProfileLocation, ProfileChoice, ProfileName};
use super::{configure_config, validate_resolved_paths};
use std::path::PathBuf;
use tauri::utils::config::{AppDirectoriesOverride, Config};

// Pure Config/location DATA controls, without a native AppHandle, filesystem
// admission, directory creation, exclusive lease, marker or key operation.
fn baseline_config() -> Config {
    let mut config = Config::default();
    config.identifier = "com.draftyak.client".to_owned();
    config.product_name = Some("DYTEST-Profile-Context".to_owned());
    config
}

fn snapshot(config: &Config) -> serde_json::Value {
    serde_json::to_value(config).expect("DYTEST config serialization unavailable")
}

fn named(name: &str) -> ProfileChoice {
    ProfileChoice::Named(ProfileName::new(name).expect("DYTEST canonical profile refused"))
}

fn root_token(component: &str) -> PathBuf {
    let variable = if cfg!(windows) { "$LOCALDATA" } else { "$DATA" };
    PathBuf::from(variable).join(component)
}

#[test]
fn configures_exact_profile_identifiers_and_fixed_native_root_tokens() {
    for (choice, identifier, component) in [
        (ProfileChoice::Default, "com.draftyak.client", "draftyak"),
        (
            named("default"),
            "com.draftyak.client.default",
            "draftyak-default",
        ),
        (
            named("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            "com.draftyak.client.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "draftyak-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
    ] {
        let mut config = baseline_config();
        configure_config(&mut config, &choice).expect("DYTEST baseline context refused");
        assert_eq!(config.identifier, identifier);
        match config.app.app_directories_override.as_ref() {
            Some(AppDirectoriesOverride::Root(actual)) => {
                assert_eq!(actual, &root_token(component));
            }
            _ => panic!("DYTEST fixed native Root override missing"),
        }

        // Compare every other Config field, preserving nondefault sentinel DATA.
        // Root PathBuf equality above permits native separator representation.
        config.app.app_directories_override = None;
        let mut expected = baseline_config();
        expected.identifier = identifier.to_owned();
        assert_eq!(snapshot(&config), snapshot(&expected));
    }
}

#[test]
fn refuses_nonbaseline_identifiers_without_mutating_any_config_field() {
    for identifier in [
        "",
        "com.draftyak.client.work",
        "Com.draftyak.client",
        "com.draftyak.client.",
    ] {
        let mut config = baseline_config();
        config.identifier = identifier.to_owned();
        let before = snapshot(&config);
        assert!(matches!(
            configure_config(&mut config, &named("default")),
            Err(NativeProfileError::ContextMismatch)
        ));
        assert_eq!(snapshot(&config), before);
    }
}

#[test]
fn refuses_any_existing_root_override_without_clobbering_config() {
    for existing in [
        PathBuf::new(),
        root_token("draftyak"),
        root_token("draftyak-default"),
        PathBuf::from("DYTEST-existing-root"),
    ] {
        let mut config = baseline_config();
        config.app.app_directories_override = Some(AppDirectoriesOverride::Root(existing));
        let before = snapshot(&config);
        assert!(matches!(
            configure_config(&mut config, &named("default")),
            Err(NativeProfileError::ContextMismatch)
        ));
        assert_eq!(snapshot(&config), before);
    }
}

#[test]
fn resolved_paths_require_all_three_roots_and_both_exact_child_directories() {
    #[cfg(windows)]
    let base = PathBuf::from(r"C:\DYTEST-profile-context");
    #[cfg(not(windows))]
    let base = PathBuf::from("/DYTEST-profile-context");
    let location = NativeProfileLocation::from_native_parts(
        named("work-2"),
        base,
        "com.draftyak.client.work-2",
    )
    .expect("DYTEST location DATA fixture refused");
    let root = location.data_directory().to_path_buf();
    let paths = [
        root.clone(),
        root.clone(),
        root.clone(),
        root.join("caches"),
        root.join("logs"),
    ];
    validate_resolved_paths(&location, paths.clone()).expect("DYTEST exact resolver DATA refused");

    for index in 0..paths.len() {
        let mut changed = paths.clone();
        changed[index] = root.join(format!("DYTEST-drift-{index}"));
        assert_ne!(changed[index], paths[index]);
        assert!(matches!(
            validate_resolved_paths(&location, changed),
            Err(NativeProfileError::ContextMismatch)
        ));
    }
}
