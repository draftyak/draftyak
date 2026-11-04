#![forbid(unsafe_code)]

#[cfg(feature = "desktop")]
fn main() {
    if draftyak_desktop::run().is_err() {
        eprintln!("DESKTOP_STARTUP_FAILED");
        std::process::exit(1);
    }
}

#[cfg(not(feature = "desktop"))]
fn main() {}
