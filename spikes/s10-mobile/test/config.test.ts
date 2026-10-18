import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { spikeDir } from "../src/cargo.ts";

const read = (file: string): string => readFileSync(path.join(spikeDir, file), "utf8");
const git = (...args: string[]): string =>
	spawnSync("git", args, { cwd: spikeDir, encoding: "utf8" }).stdout;

// The backlog's Version pins for M0.32 (keyring 4's stores come in through keyring-core 1.0.1).
const pins: Readonly<Record<string, string>> = {
	tauri: "2.12.4",
	"tauri-build": "2.7.3",
	tokio: "1.53.3",
	"tokio-rustls": "0.26.6",
	rustls: "0.23.46",
	ring: "0.17.14",
	"aws-lc-rs": "1.18.2",
	hyper: "1.12.0",
	"hyper-util": "0.1.21",
	"tokio-tungstenite": "0.30.0",
	"keyring-core": "1.0.1",
	"android-native-keyring-store": "1.0.0",
	"apple-native-keyring-store": "1.0.2",
	p256: "0.14.0",
	ecdsa: "0.17.0",
	hmac: "0.13.0",
	sha2: "0.11.1",
	rcgen: "0.14.10",
	serde_json_canonicalizer: "0.4.1",
	jiff: "0.2.38",
	"jiff-tzdb": "0.1.9",
};

interface Locked {
	readonly name: string;
	readonly version: string;
	readonly dependencies: readonly string[];
}

function lockfile(): Locked[] {
	return read("Cargo.lock")
		.split(/\r?\n\[\[package\]\]\r?\n/)
		.slice(1)
		.map((block) => ({
			name: /^name = "([^"]+)"/m.exec(block)?.[1] ?? "",
			version: /^version = "([^"]+)"/m.exec(block)?.[1] ?? "",
			dependencies: [
				...(/^dependencies = \[([^\]]*)\]/m.exec(block)?.[1] ?? "").matchAll(/"([^"]+)"/g),
			].map(([, entry]) => entry ?? ""),
		}));
}

// The entries of every [*dependencies] table, target-specific ones included.
function dependencies(manifest: string): { readonly name: string; readonly spec: string }[] {
	let inTable = false;
	const found: { name: string; spec: string }[] = [];
	for (const line of manifest.split(/\r?\n/)) {
		const section = /^\[(.+)\]$/.exec(line)?.[1];
		if (section !== undefined) inTable = /(?:^|\.)(?:dev-|build-)?dependencies$/.test(section);
		const [, name, spec] = /^([\w-]+) = (.+)$/.exec(line) ?? [];
		if (inTable && name && spec) found.push({ name, spec });
	}
	return found;
}

// The skeleton's RustCrypto crates move as one generation (the backlog's pin note).
const rustCrypto = [
	"base16ct",
	"block-buffer",
	"const-oid",
	"cpufeatures",
	"crypto-bigint",
	"crypto-common",
	"der",
	"digest",
	"ecdsa",
	"elliptic-curve",
	"ff",
	"group",
	"hmac",
	"hybrid-array",
	"p256",
	"pkcs8",
	"primeorder",
	"rand_core",
	"rfc6979",
	"sec1",
	"sha1",
	"sha2",
	"signature",
	"spki",
	"subtle",
];

const windowsTargets = Object.fromEntries(
	[
		"windows-targets",
		"windows_aarch64_gnullvm",
		"windows_aarch64_msvc",
		"windows_i686_gnu",
		"windows_i686_msvc",
		"windows_x86_64_gnu",
		"windows_x86_64_gnullvm",
		"windows_x86_64_msvc",
	].map((name) => [name, ["0.42.2", "0.52.6"]]),
);

// The backlog's "no crate in two majors per lockfile" can't hold with tauri 2.12.4 and these
// pins, so ADR 0012 records what Cargo.lock holds at several versions (every target's packages).
// What the skeleton reaches, none of it RustCrypto:
const transportDuplicates: Readonly<Record<string, readonly string[]>> = {
	...windowsTargets,
	base64: ["0.22.1", "0.23.1"],
	bitflags: ["1.3.2", "2.13.2"],
	getrandom: ["0.2.17", "0.4.3"],
	"jni-sys": ["0.3.1", "0.4.1"],
	syn: ["2.0.119", "3.0.9"],
	thiserror: ["1.0.69", "2.0.21"],
	"thiserror-impl": ["1.0.69", "2.0.21"],
	untrusted: ["0.7.1", "0.9.0"],
	"windows-sys": ["0.45.0", "0.52.0", "0.61.2"],
};

// The whole lockfile, the Tauri app included (its build-time crates, and sha2 0.10 for tauri).
const appDuplicates: Readonly<Record<string, readonly string[]>> = {
	...transportDuplicates,
	base64: ["0.21.7", "0.22.1", "0.23.1"],
	"bit-vec": ["0.8.0", "0.9.1"],
	"block-buffer": ["0.10.4", "0.12.1"],
	cpufeatures: ["0.2.17", "0.3.1"],
	"crypto-common": ["0.1.7", "0.2.2"],
	digest: ["0.10.7", "0.11.3"],
	getrandom: ["0.2.17", "0.3.4", "0.4.3"],
	hashbrown: ["0.12.3", "0.17.1"],
	heck: ["0.4.1", "0.5.0"],
	indexmap: ["1.9.3", "2.14.2"],
	miniz_oxide: ["0.8.9", "0.9.1"],
	png: ["0.17.16", "0.18.1"],
	"proc-macro-crate": ["1.3.1", "2.0.2", "3.5.0"],
	"r-efi": ["5.3.0", "6.0.0"],
	schemars: ["0.8.22", "0.9.0", "1.2.3"],
	serde_spanned: ["0.6.9", "1.1.2"],
	sha2: ["0.10.9", "0.11.1"],
	syn: ["1.0.109", "2.0.119", "3.0.9"],
	synstructure: ["0.13.2", "0.14.0"],
	toml: ["0.8.2", "1.1.8+spec-1.1.0"],
	toml_datetime: ["0.6.3", "1.1.2+spec-1.1.0"],
	toml_edit: ["0.19.15", "0.20.2", "0.25.17+spec-1.1.0"],
	winnow: ["0.5.40", "1.0.4"],
};

function duplicates(packages: readonly Locked[]): Record<string, string[]> {
	const versions = new Map<string, string[]>();
	for (const { name, version } of packages) {
		versions.set(name, [...(versions.get(name) ?? []), version]);
	}
	const several = [...versions].filter(([, list]) => list.length > 1);
	return Object.fromEntries(several.map(([name, list]) => [name, list.toSorted()]));
}

// Every package the skeleton can reach, on any target (Cargo.lock lists all of them).
function closure(packages: readonly Locked[], root: string): Locked[] {
	const find = (entry: string): Locked | undefined => {
		const [name, version] = entry.split(" ");
		return packages.find(
			(p) => p.name === name && (version === undefined || p.version === version),
		);
	};
	const seen = new Set<Locked>();
	const queue = packages.filter((p) => p.name === root);
	for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
		if (seen.has(next)) continue;
		seen.add(next);
		queue.push(...next.dependencies.flatMap((entry) => find(entry) ?? []));
	}
	return [...seen];
}

describe("the Tauri app's configuration", () => {
	const config = JSON.parse(read("src-tauri/tauri.conf.json"));

	it("is com.draftyak.client, with a version Android accepts", () => {
		expect(config.identifier).toBe("com.draftyak.client");
		expect(config.productName).toBe("DraftYak");
		expect(config.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(config.version).not.toBe("0.0.0");
		expect(config.bundle.android.minSdkVersion).toBe(24);
	});

	it("serves a local page under a strict CSP with a frozen prototype", () => {
		expect(
			existsSync(path.join(spikeDir, "src-tauri", config.build.frontendDist, "index.html")),
		).toBe(true);
		expect(config.build.devUrl).toBeUndefined();
		expect(config.app.security.csp).toMatch(/^default-src 'self';/);
		expect(config.app.security.freezePrototype).toBe(true);
		expect(config.plugins).toBeUndefined();
		for (const icon of config.bundle.icon)
			expect(existsSync(path.join(spikeDir, "src-tauri", icon))).toBe(true);
	});

	it("lets Gradle and Xcode call back through pnpm's tauri script", () => {
		expect(JSON.parse(read("package.json")).scripts.tauri).toBe("tauri");
	});

	it("never commits the generated gen/android and gen/apple projects (ADR 0012)", () => {
		expect(git("ls-files", "--", "src-tauri/gen")).toBe("");
		for (const dir of ["android", "apple"]) {
			const ignored = spawnSync("git", ["check-ignore", "-q", `src-tauri/gen/${dir}/x`], {
				cwd: spikeDir,
			});
			expect(ignored.status, `src-tauri/gen/${dir} is git-ignored`).toBe(0);
		}
	});
});

describe("the Rust pins", () => {
	it("pins every registry dependency exactly, to the backlog's versions", () => {
		for (const manifest of ["transport-skeleton/Cargo.toml", "src-tauri/Cargo.toml"]) {
			const deps = dependencies(read(manifest)).filter(({ spec }) => !spec.includes("path ="));
			expect(deps.length, manifest).toBeGreaterThan(0);
			for (const { name, spec } of deps) {
				const version = /^"([^"]+)"$/.exec(spec)?.[1] ?? /version = "([^"]+)"/.exec(spec)?.[1];
				expect(version, `${manifest}: ${name}`).toMatch(/^=\d+\.\d+\.\d+$/);
				if (pins[name] !== undefined) expect(version, name).toBe(`=${pins[name]}`);
			}
		}
	});

	it("locks each pinned crate once in the skeleton's graph, at its pin", () => {
		const packages = closure(lockfile(), "transport-skeleton");
		for (const [name, version] of Object.entries(pins)) {
			if (name.startsWith("tauri")) continue;
			expect(
				packages.filter((p) => p.name === name).map((p) => p.version),
				name,
			).toEqual([version]);
		}
	});

	it("keeps one RustCrypto generation in the skeleton's graph", () => {
		const packages = closure(lockfile(), "transport-skeleton");
		for (const name of rustCrypto) {
			expect(packages.filter((p) => p.name === name).length, name).toBe(1);
		}
	});

	it("holds exactly the recorded duplicates, in the skeleton's graph and the app's lockfile", () => {
		expect(duplicates(closure(lockfile(), "transport-skeleton"))).toEqual(transportDuplicates);
		expect(duplicates(lockfile())).toEqual(appDuplicates);
	});

	it("leaves only tauri's own sha2 0.10 beside the pins in the app's lockfile", () => {
		const packages = lockfile();
		for (const [name, version] of Object.entries(pins)) {
			const versions = packages.filter((p) => p.name === name).map((p) => p.version);
			expect(versions, name).toContain(version);
			if (name !== "sha2") expect(versions, name).toEqual([version]);
		}
		const older = packages.find((p) => p.name === "sha2" && p.version.startsWith("0.10."));
		const users = packages.filter((p) =>
			p.dependencies.some((d) => d === `sha2 ${older?.version}`),
		);
		expect(users.map((p) => p.name).toSorted()).toEqual(["tauri-codegen", "wry"]);
	});
});

describe("ci.json", () => {
	const ci = JSON.parse(read("ci.json"));

	it("adds Rust mobile targets only in the mobile jobs", () => {
		expect(ci.os["ubuntu-24.04"].rust.targets).toEqual(["aarch64-linux-android"]);
		expect(ci.os["macos-15"].rust.targets).toEqual(["aarch64-apple-ios-sim"]);
		expect(read("../../rust-toolchain.toml")).not.toMatch(/targets/);
	});

	it("runs the Android build with the SDK through setup-android and iOS as run B2", () => {
		expect(ci.os["ubuntu-24.04"].java).toBe(true);
		expect(ci.os["ubuntu-24.04"].android.packages).toContain("ndk;29.0.13846066");
		expect(ci.os["macos-15"].timeout).toBe(25);
		expect(Object.keys(ci.os).toSorted()).toEqual(["macos-15", "ubuntu-24.04"]);
	});
});
