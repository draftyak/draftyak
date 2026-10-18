// Offline guards for S5a's Rust workspace: the pairing exporter's literals, exact crate pins that
// the lockfile resolves, and the digest-pinned Linux image. The heavy tier runs the code.
import { readFileSync } from "node:fs";
import path from "node:path";
import { docker } from "@draftyak/spike-kit";
import { describe, expect, it } from "vitest";

const rustDir = path.resolve(import.meta.dirname, "..", "rust");
const read = (file: string): string => readFileSync(path.join(rustDir, file), "utf8");

// The census pins (docs/roadmap/m0.md, Version pins).
const pins: Readonly<Record<string, string>> = {
	tokio: "1.53.3",
	"tokio-rustls": "0.26.6",
	rustls: "0.23.46",
	ring: "0.17.14",
	"aws-lc-rs": "1.18.2",
	keyring: "4.2.0",
	"keyring-core": "1.0.1",
	"windows-native-keyring-store": "1.1.0",
	"zbus-secret-service-keyring-store": "1.0.1",
	"apple-native-keyring-store": "1.0.2",
	// Not a census pin: the keychain store's own version, which spike-keyring calls on macOS to
	// keep keychain prompts off (M0.23b).
	"security-framework": "3.7.0",
};

// name -> version requirement for every entry of every [*dependencies] table.
function dependencies(manifest: string): Map<string, string> {
	const found = new Map<string, string>();
	let inDependencies = false;
	for (const line of manifest.split(/\r?\n/)) {
		const table = /^\[(.+)\]\s*$/.exec(line)?.[1];
		if (table !== undefined) {
			inDependencies = /(?:^|\.)(?:dev-|build-)?dependencies$/.test(table);
			continue;
		}
		const entry = /^([\w-]+)\s*=\s*(?:"([^"]*)"|\{.*\bversion\s*=\s*"([^"]*)")/.exec(line);
		if (inDependencies && entry) found.set(entry[1] ?? "", entry[2] ?? entry[3] ?? "");
	}
	return found;
}

describe("S5a's Rust workspace", () => {
	it("exports the pairing EKM with plan section 7's label, a 16-byte pid and 32 bytes", () => {
		const lib = read("spike-ekm/src/lib.rs");
		expect(lib).toContain('pub const LABEL: &[u8] = b"EXPERIMENTAL-draftyak-pair-v1";');
		expect(lib).toContain("pub const EKM_LEN: usize = 32;");
		expect(lib).toContain("pub const PID_LEN: usize = 16;");
	});

	it("pins each dependency to the census version, and the lockfile resolves exactly that", () => {
		const declared = new Map([
			...dependencies(read("spike-ekm/Cargo.toml")),
			...dependencies(read("spike-keyring/Cargo.toml")),
		]);
		expect(Object.fromEntries(declared)).toEqual(
			Object.fromEntries(Object.entries(pins).map(([name, version]) => [name, `=${version}`])),
		);
		const lock = read("Cargo.lock");
		for (const [name, version] of Object.entries(pins)) {
			const locked = [...lock.matchAll(new RegExp(`^name = "${name}"\\nversion = "(.+)"$`, "gm"))];
			expect(
				locked.map((match) => match[1]),
				name,
			).toEqual([version]);
		}
		expect(read("Cargo.toml")).toMatch(/^resolver = "3"$/m);
	});

	// Version pins allow no crate in two majors per lockfile; these come in under the pinned crates
	// (ring, aws-lc-rs, tokio, the Secret Service store), and the owner confirms them. A new one
	// fails here.
	it("holds only the known crates in two majors", () => {
		const versions = new Map<string, string[]>();
		for (const [, name = "", version = ""] of read("Cargo.lock").matchAll(
			/^name = "(.+)"\nversion = "(.+)"$/gm,
		)) {
			versions.set(name, [...(versions.get(name) ?? []), version]);
		}
		expect(Object.fromEntries([...versions].filter(([, found]) => found.length > 1))).toEqual({
			getrandom: ["0.2.17", "0.4.3"],
			syn: ["2.0.119", "3.0.9"],
			untrusted: ["0.7.1", "0.9.0"],
			"windows-sys": ["0.52.0", "0.61.2"],
		});
	});

	it("builds its Linux image from the digest-pinned rust:1.95.0-bookworm", () => {
		const dockerfile = read("Dockerfile");
		expect(() => docker.checkDockerfile(dockerfile)).not.toThrow();
		expect(dockerfile).toMatch(/^FROM rust:1\.95\.0-bookworm@sha256:[0-9a-f]{64}$/m);
	});
});
