# ADR 0012: S10 mobile compile and the transport skeleton

- **Status:** proposed
- **Date:** 2026-10-17
- **Spike:** S10
- **Plan:** §2 Rust, §7 pairing, §8, §11 `mobile.yml`, §15 S10
- **Owner decision:** no

## Context
§15 S10 asks for a minimal Tauri mobile app plus the `draftyak-transport` skeleton: an Android APK built on ubuntu with the NDK, and the iOS and iPad simulator built with `--no-sign` on macOS runners, using rustls' `ring` provider unless aws-lc-rs builds cleanly everywhere (§2). §8 fixes what the mobile app may never declare: SMS permissions or a notification listener; Android allows no cleartext, and iOS targets both device families (`TARGETED_DEVICE_FAMILY=1,2`). M1b builds the transport crate from §2's set: tokio-rustls and rustls, hyper, tokio-tungstenite, keyring 4 with per-platform stores, p256, ecdsa, hmac, sha2, rcgen, serde_json_canonicalizer and jiff with its bundled tz database.

`spikes/s10-mobile` is one Cargo workspace holding the app (`src-tauri`, Tauri 2.12.4, identifier `com.draftyak.client`, minSdk 24) and `transport-skeleton`, which wires every crate of that set together: TLS 1.3 only, with mTLS, SPKI pins in both directions and no session tickets; the pairing claim over HTTP/1.1 on the live connection, which the stand-in hub verifies with its own exporter (`EXPERIMENTAL-draftyak-pair-v1`) and the client certificate's SPKI; a WebSocket over the pinned stream; ES256 statements over JCS that refuse a repeated key; the SAS; send times from the bundled tz database; and a keyring store. The app links it through a Tauri command, the exported `draftyak_transport_check` keeps every call in the linked crate-table builds, and the CI checks find the exporter label, which only the transport code refers to, in the library the APK packages and in the iOS app's executable. `gen/android` and `gen/apple` are not committed: CI generates them with `tauri android init` and `tauri ios init` from @tauri-apps/cli 2.12.3.

Constraints: the dev box has the JDK, the SDK and only `android-sdk-license`, but no NDK and no Xcode, so local runs cover the Windows x64 host. Android runs on `ubuntu-24.04` and iOS as run B2 on `macos-15` (25 minutes) through `pnpm spikes:run`, after this item merges; CI's `full` job on this item's PR runs the Linux x64 host checks, so `spikes-run` spends its minutes on the mobile builds. Results go to the job summaries only (APK SHA-256 and size, merged-manifest permissions, the crate table per target and provider), so `spikes-run` uploads no artifact for S10.

## Options
- **Crypto provider:** `ring` 0.17.14 (§2's default) or aws-lc-rs 1.18.2 (rustls' default, with a FIPS path), whose aws-lc-sys 0.46.0 compiles AWS-LC's C and assembly for every target.
- **Keyring:** the keyring 4.2.0 crate, or keyring-core 1.0.1 with the store crates directly. keyring 4.2.0's `v1` API returns an "Invalid platform" error on Android and iOS, and only its `cli` feature reaches the Android and protected-data stores, at the cost of every store in the lockfile (db-keystore on Turso, the dbus store with a vendored libdbus, linux-keyutils, the sample store). Its documentation tells apps that pick their stores to link keyring-core and those stores.
- **Statement parsing:** serde_json_canonicalizer's `pipe()`, whose serde_json parse keeps the last of two equal keys, or a parse that refuses a repeated key before JCS serializes the value.
- **gen/android and gen/apple:** generate them in CI for every build, or commit them and review tauri-cli template changes as diffs.
- **WebSocket TLS:** tokio-tungstenite's own rustls features (a private `__rustls-tls` plus a root-store feature), or `client_async` over the transport's own tokio-rustls stream, which keeps the exporter on the live connection and needs no root store.
- **Android SDK licences in CI:** route (a), CI answers yes to `sdkmanager --licenses`, accepting every licence the runner's sdkmanager presents, then installs the packages it needs; or route (b), only preinstalled components.

## Decision
Not run

Plan changes: M1b links keyring-core 1.0.1 and the store crates instead of the keyring 4.2.0 crate (§2, §8); M1b's statement verifier refuses duplicate JSON keys while parsing, before JCS, as the skeleton's `statement_message` does (§7, §9.3); tokio-tungstenite runs over the transport's tokio-rustls stream (§2); M10 commits `gen/android` and `gen/apple` (§11 `mobile.yml`); `ring` stays the provider, because aws-lc-rs everywhere is no for now (§2).

### Pending: the Android and iOS runs
The decision stays `Not run` until `pnpm spikes:run --spikes s10 --os ubuntu-24.04` and run B2 (`--os macos-15`) report. Both builds ok with `ring` makes it `Go`; a build that needs a Fallback below makes it `Go with fallback`; their run ids go into Evidence. The local runs answer only the Windows x64 host row, and CI's `full` job on this item's PR adds the Linux x64 host row.

### Licence route (a)
The owner chose route (a) on 2026-10-17. In the ubuntu job, `android-actions/setup-android` (v4.0.4, `accept-android-sdk-licenses: true`) answers yes to `sdkmanager --licenses`, which accepts every SDK licence the runner's sdkmanager presents, and to each package install; it then installs ci.json's `platforms;android-37.0`, `build-tools;37.0.0` and `ndk;29.0.13846066`, the NDK tauri-cli 2.12.3 installs by default. The dev box keeps only `android-sdk-license`, which the owner accepted.

### aws-lc-rs everywhere: no
It builds and passes the transport tests on the Windows x64 host, with aws-lc-sys's CC builder and its prebuilt NASM objects, but the Linux, Android, iOS, M0.21 Windows and M0.23b macOS rows are still pending (Evidence), so M1b keeps `ring`, §2's default. M0.41 turns this into yes only if every row shows aws-lc-rs building with no extra tools: aws-lc-sys's builder is CC, never CMake (it falls back to CMake when the CC builder can't build a target, which passes unnoticed wherever cmake is installed, as on GitHub's runners), and Windows x64 uses the prebuilt NASM objects. Each crate table's aws-lc-rs line and the host evidence's `awsLcSys` record both. The iOS device target (`aarch64-apple-ios`) and every Android ABI M10 ships must be green too, so yes can come no earlier than M10's first `mobile.yml` run.

### The changes in detail
- **Keyring (M1b `crates/draftyak-transport`):** link keyring-core 1.0.1 and the store crates (android-native 1.0.0 on Android, apple-native 1.0.2 with `protected` on iOS and `keychain` on macOS, windows-native 1.1.0, zbus-secret-service 1.0.1), not the keyring 4.2.0 crate. Desktop targets use the S5 stores, never the mock: the skeleton links no desktop store, and keyring-core's in-memory mock comes only with its `mock-store` feature, which only its tests turn on (§7: a mock store is e2e-only, and `release-guard` checks it's absent). The Android store needs `ndk-context` initialized with the application context (the crate exports a JNI `initializeNdkContext` for that); M10 wires it or confirms that Tauri's activity already does.
- **Statements (M1b):** serde_json_canonicalizer 0.4.1 refuses duplicate keys only while serializing. Its `pipe()` parses with serde_json, which keeps the last duplicate, so it never sees untrusted input. The skeleton's `statement_message` parses with a visitor that refuses a repeated key at any depth, escaped spellings included, and then serializes the parsed value with JCS; the kept test pins both behaviours. The census note that 0.4 "rejects duplicate keys" holds for serialization only.
- **Pairing claim (M1b):** the device posts `hex(pubs).hex(proof)` to `/pair/v1/claim` on the live connection, with `pubs` = the SHA-256 of its certificate's SPKI followed by its SEC1 approval key and the proof over its EKM. The hub checks `transport_pub` against the client certificate's SPKI on that connection and the proof against its own EKM. `spec/pairing-v1.md` fixes the real encoding.
- **TLS (M1b):** rustls and tokio-rustls without their `tls12` features, so TLS 1.2 isn't compiled in; configs from `builder_with_provider`, with no process-default provider; and no session tickets from the hub (`send_tls13_tickets = 0`). The kept test checks all three and that the negotiated suite is the compiled provider's.
- **WebSocket (M1b):** `client_async` over the transport's tokio-rustls stream, so no tokio-tungstenite TLS feature and no root store are linked.
- **gen/ (M10 `mobile.yml`):** commit `apps/app/src-tauri/gen/android` and `gen/apple`, an exception to the root `**/gen/` ignore. The generated Android project uses AGP 9.3.1, Kotlin 2.2.10 and a Gradle 9.6.1 wrapper without `distributionSha256Sum`, and its debug build type turns cleartext on. M10 pins the wrapper checksum, turns cleartext off in every build type, adds the network security config and `ACCESS_LOCAL_NETWORK` (§7), and runs `android-manifest-guard` on the merged manifest; regenerating would drop those edits, so a tauri-cli bump regenerates into a branch and the diff is reviewed. `tauri ios init` installs XcodeGen with Homebrew when the runner lacks it: an unpinned tool, a deviation from the exact-pin rule. Run B2's summary records the Xcode and XcodeGen versions and where XcodeGen came from; M10 pins XcodeGen, or records the deviation, before it regenerates `gen/apple`.
- **Android manifest (M6b `tools/android-manifest-guard/`, run by M10):** the spike's check pairs a denylist over the merged manifest (SMS, MMS, WAP push, cell broadcast and Telephony entries; the default-SMS-app components, meaning respond-via-message and `sms:`, `smsto:`, `mms:` and `mmsto:` links; a notification listener or assistant; the sensitive-notification and companion permissions behind OTP and companion exemptions) with a permission allowlist (`INTERNET`, the app's `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` and §7's `ACCESS_LOCAL_NETWORK`), which M10 extends as it adds plugins.
- **Duplicate crates (the backlog's pin note):** "no crate in two majors per lockfile" can't hold with tauri 2.12.4 and these pins. Cargo.lock (496 packages, every target's) holds 37 crate names at two or three versions: crates that tauri and its build tools pull at older versions (syn 1, 2 and 3; toml 0.8 and 1.1 with toml_edit, toml_datetime, serde_spanned and winnow; proc-macro-crate, schemars, heck, indexmap, hashbrown, png, miniz_oxide, bit-vec, synstructure), a second RustCrypto generation that only tauri-codegen and wry pull (sha2 0.10.9, digest 0.10.7, crypto-common 0.1.7, block-buffer 0.10.4, cpufeatures 0.2.17), and getrandom, base64, thiserror, untrusted, bitflags, jni-sys, r-efi and the windows-sys family. The transport crate's own graph (194 packages) keeps one RustCrypto generation but holds 17 of them: base64 0.22.1 (android-native-keyring-store) and 0.23.1 (hyper-util, pem); bitflags 1 (defmt, through jiff) and 2; getrandom 0.2.17 (ring) and 0.4.3; jni-sys 0.3.1 and 0.4.1; syn 2 and 3; thiserror and thiserror-impl 1 (jni) and 2; untrusted 0.7.1 (aws-lc-rs) and 0.9.0 (ring, rustls-webpki); and windows-sys 0.45 (jni), 0.52 (ring) and 0.61 (tokio), with windows-targets 0.42 and 0.52 and its seven platform crates. So the rule holds only for the pinned crates and the RustCrypto generation. `config.test.ts` checks those and both duplicate sets exactly as listed here. M1b's cargo-deny (`rust.yml`) can deny `bans.multiple-versions` only with a `skip` entry for each crate in the transport set, so it denies and skips exactly that set, and any new duplicate fails.

## Fallback
- **aws-lc-rs:** `ring` is already the choice; nothing switches. If a later rustls drops `ring`, aws-lc-rs needs every row green first.
- **Android build fails in CI:** pin the NDK tauri-cli picks (`NDK_HOME` is already explicit) or move to the NDK the ubuntu image preinstalls; a Gradle or AGP failure moves the decision on committed `gen/android` forward to M0 and pins the wrapper there. The trigger is a red `spikes-run` on `ubuntu-24.04`.
- **iOS build fails in run B2:** the app falls back to a committed `gen/apple` with an explicit `TARGETED_DEVICE_FAMILY: 1,2` in `project.yml` (through `bundle.iOS.template`). The trigger is `iOS simulator build: fail` or a timeout; B2 already builds only the simulator, and device builds start in M10.
- **keyring stores at runtime (M10):** if the Android store can't get its context or the protected-data store refuses an unsigned build, M10 keeps the transport keys in app storage wrapped by a platform key, as S12's Keystore fallback does, and records the `key_class`.

## Evidence
- `spikes/s10-mobile/evidence/host-win32-x64.json`: the Windows x64 host (dev box, Rust 1.95.0). Both providers link the skeleton as a cdylib with every crate of the set compiled and the other provider's crates absent. `cargo test` (11 tests: the full check; TLS 1.3 only, without session tickets, on the compiled provider; wrong-hub and wrong-device pins; the pairing claim bound to its connection and certificate; proof and SAS vectors; JCS and repeated keys; the bundled tz database; hub ids) and `cargo clippy -D warnings` (all targets, and the library without the tests' mock store) pass for both; rustfmt and the app crate's clippy pass. `awsLcRs: builds`, with aws-lc-sys's CC builder and the prebuilt NASM objects (`awsLcSys`).
- Pending, in job summaries only (the backlog asks for no artifact): `pnpm spikes:run --spikes s10 --os ubuntu-24.04` (the APK's SHA-256 and size; merged-manifest permissions with no SMS or notification-listener entries and none outside the allowlist; the packaged library holding the transport code; the `aarch64-linux-android` crate table), then run B2 with `--os macos-15` (`iOS simulator build: ok`, UIDeviceFamily 1,2, the Xcode and XcodeGen versions, the `aarch64-apple-ios-sim` crate table), and CI's `full` job on this item's PR (the Linux x64 host crate table, `cargo test` and clippy).
- aws-lc-rs per row:

  | Where | From | aws-lc-rs |
  |---|---|---|
  | Windows x64 host, transport set | this spike, `host-win32-x64.json` | builds (CC builder, prebuilt NASM); tests and clippy pass |
  | Linux x64 host, transport set | CI `full` on this item's PR | pending |
  | Android `aarch64-linux-android` | `spikes-run` on ubuntu-24.04 | pending |
  | iOS simulator `aarch64-apple-ios-sim` | run B2 | pending |
  | iOS device `aarch64-apple-ios` | M10 `mobile.yml` | not built in M0 |
  | Android ABIs other than arm64 that M10 ships | M10 `mobile.yml` | not built in M0 |
  | Windows, S5 desktop set | M0.21 | pending, for M0.41 |
  | macOS, S5 desktop set | M0.23b | pending, for M0.41 |

## Kept test
- **Path:** `spikes/s10-mobile/transport-skeleton/tests/check.rs`
- **Command:** `pnpm --filter @draftyak/spike-s10-mobile test:heavy`
- **Guards:** TLS 1.3 only (TLS 1.2 not compiled in), without session tickets, on the compiled provider with no process default; mTLS with SPKI pins both ways (a wrong hub or device is refused); the pairing claim, accepted only with this connection's EKM, the client certificate's own SPKI and the window's secret; proof and SAS vectors; exporter equality, HTTP/1.1 and a WebSocket over the pinned stream; ES256 statements over JCS that refuse a repeated key while parsing; the bundled tz database and a keyring-core store round trip; with `ring` and with aws-lc-rs.
- **Destination:** M1b `crates/draftyak-transport/tests/`
- **Path:** `spikes/s10-mobile/test/build.heavy.test.ts`
- **Command:** `pnpm spikes:run --spikes s10 --os ubuntu-24.04`, then `--os macos-15` for run B2
- **Guards:** the APK builds, its merged manifest has no SMS or notification-listener entries and no permission outside the allowlist, and the library it packages holds the transport code; the iPhone and iPad simulator app builds unsigned, with the Xcode and XcodeGen versions recorded; the crate table per target and provider, with no stray provider and aws-lc-sys's builder.
- **Destination:** M10 `.github/workflows/mobile.yml`
- **Path:** `spikes/s10-mobile/test/android.test.ts`
- **Command:** `pnpm --filter @draftyak/spike-s10-mobile test`
- **Guards:** the merged-manifest check against real aapt2 2.20 output: the denylist above (SMS, MMS, WAP push, cell broadcast and Telephony entries, default-SMS-app components, a notification listener or assistant, OTP and companion exemptions) and the permission allowlist; and the APK reader.
- **Destination:** M6b `tools/android-manifest-guard/`
- **Path:** `spikes/s10-mobile/test/config.test.ts`
- **Command:** `pnpm --filter @draftyak/spike-s10-mobile test`
- **Guards:** identifier `com.draftyak.client`; exact pins at the backlog's versions; one version of each pinned crate and of each RustCrypto crate in the transport graph; both duplicate sets exactly as recorded above; and no committed `gen/` (for M0; the spike's `turbo.json` makes the root `.gitignore` an input of the cached test).
- **Destination:** M10 `apps/app/src-tauri/` (configuration) and M1b `crates/draftyak-transport/` (pins)
