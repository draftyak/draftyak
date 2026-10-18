// M0.23b, offline: keep-awake's and the keychain probe's crates are the versions tauri's and
// keyring's lockfiles already resolve, one version each; ci.json asks for run B1 and the Linux run
// under xvfb; and the app names the frames and the OS hooks as plan §7 does.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const spikeDir = path.resolve(import.meta.dirname, "..");
const tauriDir = path.join(spikeDir, "tauri-app", "src-tauri");
const rustDir = path.join(spikeDir, "rust");
const read = (...parts: string[]): string => fs.readFileSync(path.join(...parts), "utf8");

// Every version of `crate` in a Cargo.lock.
const versions = (lock: string, crate: string): string[] =>
	[...lock.matchAll(/^name = "(.+)"\nversion = "(.+)"$/gm)]
		.filter((match) => match[1] === crate)
		.map((match) => match[2] ?? "");

describe("keep-awake and keychain pins", () => {
	const manifest = read(tauriDir, "Cargo.toml");
	const lock = read(tauriDir, "Cargo.lock");

	it("pins zbus, block2 and objc2's AppKit and Foundation at the versions already locked", () => {
		const pins = {
			zbus: /^zbus = "=(.+)"$/m,
			block2: /^block2 = "=(.+)"$/m,
			"objc2-app-kit": /^objc2-app-kit = \{ version = "=(.+?)", default-features = false/m,
			"objc2-foundation": /^objc2-foundation = \{ version = "=(.+?)", default-features = false/m,
		};
		for (const [crate, pin] of Object.entries(pins)) {
			const pinned = pin.exec(manifest)?.[1];
			expect(pinned, crate).toBeDefined();
			expect(versions(lock, crate), crate).toEqual([pinned]);
		}
		// One zbus across S5's two workspaces: the Secret Service store's (rust/) and the app's.
		expect(versions(read(rustDir, "Cargo.lock"), "zbus")).toEqual(versions(lock, "zbus"));
		expect(manifest).toMatch(/^\[target\.'cfg\(target_os = "linux"\)'\.dependencies\]\nzbus = /m);
		expect(manifest).toMatch(/^\[target\.'cfg\(target_os = "macos"\)'\.dependencies\]\nblock2 = /m);
	});

	it("turns on windows-sys's power APIs, and only versions tauri already resolves", () => {
		for (const feature of ["Win32_System_Power", "Win32_System_SystemServices"]) {
			expect(manifest).toContain(`"${feature}",`);
		}
		expect(manifest).toMatch(/^windows-sys = \{ version = "=0\.61\.2", features = \[/m);
		expect(versions(lock, "windows-sys")).toContain("0.61.2");
	});

	it("pins the keychain probe's security-framework at the version the keychain store locks", () => {
		const keyring = read(rustDir, "spike-keyring", "Cargo.toml");
		const pinned = /^security-framework = "=(.+)"$/m.exec(keyring)?.[1];
		expect(versions(read(rustDir, "Cargo.lock"), "security-framework")).toEqual([pinned]);
	});
});

describe("cross-OS runs", () => {
	it("asks for run B1 on macos-15 (30 minutes) and the ubuntu-24.04 run under xvfb", () => {
		// The ubuntu run, at a tenth of B1's rate, also lints the macOS code (sidecar.heavy).
		expect(JSON.parse(read(spikeDir, "ci.json"))).toEqual({
			os: {
				"macos-15": { timeout: 30, rust: {} },
				"ubuntu-24.04": {
					timeout: 45,
					tauriLinux: true,
					docker: true,
					rust: { targets: ["aarch64-apple-darwin"] },
				},
			},
		});
	});
});

describe("plan §7 names", () => {
	const power = read(tauriDir, "src", "power.rs");

	it("holds the system awake with the plan's API on each OS and listens for its resume", () => {
		for (const name of [
			"PowerSetRequest(PowerRequestSystemRequired)",
			"PowerRegisterSuspendResumeNotification",
			"PBT_APMRESUMEAUTOMATIC",
			"IOPMAssertionCreateWithName(PreventUserIdleSystemSleep)",
			"NSWorkspaceDidWakeNotification",
			"logind Inhibit(idle, block)",
			'("idle", HOLDER, REASON, "block")',
			"PrepareForSleep(false)",
		]) {
			expect(power, name).toContain(name);
		}
	});

	it("sends the hub only the plan's resumed frame, and the hub sends keepAwake only when asked", () => {
		const sidecar = read(tauriDir, "src", "sidecar.rs");
		expect(sidecar).toContain('ToHub::Resumed => json!({ "power": "resumed" })');
		const hub = read(tauriDir, "resources", "hub.mjs");
		expect(hub).toContain('process.env.DRAFTYAK_SPIKE_KEEP_AWAKE === "1"');
		expect(hub).toMatch(/send\(\{ keepAwake: until === "null" \? null : Number\(until\) \}\)/);
		const control = read(tauriDir, "src", "control.rs");
		expect(control).toMatch(/"power" => Ok\(app\.state::<Power>\(\)\.status\(\)\)/);
		expect(control).toMatch(/"wake" => app\.state::<Power>\(\)\.simulate_wake\(\)/);
	});
});
