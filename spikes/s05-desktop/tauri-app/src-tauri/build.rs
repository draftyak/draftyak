fn main() {
    // The tests find binaries/draftyak-node-<triple> by it, with or without the app feature.
    let triple = std::env::var("TARGET").expect("cargo sets TARGET");
    println!("cargo:rustc-env=DRAFTYAK_TARGET_TRIPLE={triple}");
    println!("cargo:rerun-if-changed=build.rs");
    #[cfg(feature = "app")]
    tauri_build::build();
}
