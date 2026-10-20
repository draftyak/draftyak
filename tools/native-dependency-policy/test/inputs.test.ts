import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectCargoGraph } from "../src/cargo-graph.ts";
import {
	assertNativeInputsUnchanged,
	bindNativeCargoPaths,
	captureNativeInputs,
	NativeInputsError,
	type NativeInputsSnapshot,
} from "../src/inputs.ts";

const opened = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: (...args: Parameters<typeof actual.open>) => {
			opened.push(String(args[0]));
			return actual.open(...args);
		},
	};
});

const members = [
	["crates/draftyak-protocol", "draftyak-protocol"],
	["crates/draftyak-desktop-pairing", "draftyak-desktop-pairing"],
	["crates/draftyak-transport", "draftyak-transport"],
	["apps/app/src-tauri", "draftyak-desktop"],
] as const;
const registry = "registry+https://github.com/rust-lang/crates.io-index";
type Row = Record<string, unknown>;
interface Fixture {
	base: string;
	repo: string;
	home: string;
	metadata: Row;
	packages: Row[];
}
const temporary: string[] = [];
const first = <T>(values: readonly T[]): T => {
	const value = values[0];
	if (value === undefined) throw new Error("empty synthetic fixture");
	return value;
};
async function write(filename: string, bytes: string | Uint8Array): Promise<void> {
	await fs.mkdir(path.dirname(filename), { recursive: true });
	await fs.writeFile(filename, bytes);
}
async function fixture(): Promise<Fixture> {
	const parent = await fs.realpath(os.tmpdir());
	const base = await fs.mkdtemp(path.join(parent, "native-inputs-"));
	temporary.push(base);
	const repo = path.join(base, "repo");
	const home = path.join(base, "cargo-home");
	await fs.mkdir(home);
	for (const name of [
		"crates/Cargo.toml",
		"crates/Cargo.lock",
		"crates/deny.toml",
		"rust-toolchain.toml",
	]) {
		await write(path.join(repo, name), `# synthetic ${name}\n`);
	}
	const packages: Row[] = [];
	for (const [directory, name] of members) {
		await write(
			path.join(repo, directory, "Cargo.toml"),
			`[package]\nname = "${name}"\nversion = "0.0.0"\n`,
		);
		await write(path.join(repo, directory, "src/lib.rs"), "// synthetic target, never opened\n");
		packages.push({
			id: `path+${repo}/${directory}#${name}@0.0.0`,
			name,
			version: "0.0.0",
			source: null,
			manifest_path: path.join(repo, directory, "Cargo.toml"),
			dependencies: [],
			targets: [
				{
					name: name.replaceAll("-", "_"),
					kind: ["lib"],
					crate_types: ["lib"],
					src_path: path.join(repo, directory, "src/lib.rs"),
					edition: "2024",
					doc: true,
					doctest: true,
					test: true,
				},
			],
			features: {},
			license: "MIT",
			edition: "2024",
			rust_version: "1.95",
			links: null,
			default_run: null,
		});
	}
	const ids = packages.map((pkg) => pkg.id);
	return {
		base,
		repo,
		home,
		packages,
		metadata: {
			version: 1,
			packages,
			workspace_root: path.join(repo, "crates"),
			workspace_members: ids,
			workspace_default_members: ids,
			target_directory: path.join(repo, "target"),
			build_directory: path.join(repo, "target"),
			metadata: null,
			resolve: {
				root: null,
				nodes: ids.map((id) => ({ id, features: [], dependencies: [], deps: [] })),
			},
		},
	};
}
const capture = (f: Fixture) => captureNativeInputs(f.repo, f.home);
const bind = (f: Fixture, snapshot: NativeInputsSnapshot) =>
	bindNativeCargoPaths(snapshot, f.metadata);
const targets = (pkg: Row): Row[] => pkg.targets as Row[];
async function refused(action: Promise<unknown>, code?: string): Promise<void> {
	await expect(action).rejects.toMatchObject({
		name: "NativeInputsError",
		message: "native dependency inputs refused",
		...(code ? { code } : {}),
	});
}
afterEach(async () => {
	opened.length = 0;
	for (const directory of temporary.splice(0)) {
		// Delete only the exact canonical directory created by this test, never a computed repository path.
		const parent = await fs.realpath(os.tmpdir());
		if (
			path.dirname(directory) !== parent ||
			!path.basename(directory).startsWith("native-inputs-")
		)
			throw new Error("unsafe synthetic cleanup");
		if (
			(await fs.lstat(directory)).isSymbolicLink() ||
			(await fs.realpath(directory)) !== directory
		)
			throw new Error("changed synthetic cleanup root");
		await fs.rm(directory, { recursive: true });
	}
});

describe("live native input binding", () => {
	it("binds all four roots, including the app outside workspace_root, to the graph projector", async () => {
		const f = await fixture();
		const snapshot = await capture(f);
		const mapping = await bind(f, snapshot);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(mapping)).toBe(true);
		expect(mapping.workspacePackages.map((p) => p.manifestPath).sort()).toEqual(
			members.map(([dir]) => `${dir}/Cargo.toml`).sort(),
		);
		expect(snapshot.lockDigest).toBe(
			createHash("sha256").update("# synthetic crates/Cargo.lock\n").digest("hex"),
		);
		expect(projectCargoGraph(f.metadata, mapping, []).digest).toMatch(/^[a-f0-9]{64}$/);
		await expect(assertNativeInputsUnchanged(snapshot)).resolves.toBeUndefined();
		expect(opened.every((filename) => !filename.endsWith(".rs"))).toBe(true);
	});
	it("uses a portable ordered digest and no local path or inode in its public capture", async () => {
		const a = await fixture();
		const b = await fixture();
		const one = await capture(a);
		const two = await capture(b);
		expect(one.inputDigest).toBe(two.inputDigest);
		const raw = [
			"crates/Cargo.toml",
			"crates/Cargo.lock",
			"crates/deny.toml",
			"rust-toolchain.toml",
		].map((name) => [name, `# synthetic ${name}\n`]);
		for (const [directory, name] of members)
			raw.push([`${directory}/Cargo.toml`, `[package]\nname = "${name}"\nversion = "0.0.0"\n`]);
		const rows: [string, string | null][] = raw.map(([name, bytes]) => [
			String(name),
			createHash("sha256").update(String(bytes)).digest("hex"),
		]);
		for (const directory of [
			"",
			"apps",
			"apps/app",
			"apps/app/src-tauri",
			"crates",
			...members.slice(0, 3).map(([dir]) => dir),
		]) {
			for (const name of ["config", "config.toml"])
				rows.push([`${directory ? `${directory}/` : ""}.cargo/${name}`, null]);
		}
		const order = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
		rows.sort(([a], [b]) => order(a, b));
		const tuple = [
			"inputs",
			1,
			rows,
			members.map(([dir]) => `${dir}/src/lib.rs`).sort(order),
			true,
		];
		expect(one.inputDigest).toBe(
			createHash("sha256")
				.update("draftyak/native-dependency-policy/inputs/v1\0")
				.update(JSON.stringify(tuple))
				.digest("hex"),
		);
		expect(Object.keys(one).sort()).toEqual(["inputDigest", "lockDigest"]);
		expect(JSON.stringify(one)).not.toContain(a.repo);
	});
	it("accepts one zero-byte configuration but binds its presence separately from absence", async () => {
		const f = await fixture();
		const absent = await capture(f);
		await write(path.join(f.repo, "crates/.cargo/config.toml"), "");
		const empty = await capture(f);
		expect(empty.inputDigest).not.toBe(absent.inputDigest);
		await bind(f, empty);
		await assertNativeInputsUnchanged(empty);
	});
	it.each(["serialized", "spread", "proxy"])(
		"refuses a %s imitation of live capture",
		async (kind) => {
			const f = await fixture();
			const original = await capture(f);
			const fake = (
				kind === "serialized"
					? JSON.parse(JSON.stringify(original))
					: kind === "spread"
						? { ...original }
						: new Proxy(original, {})
			) as NativeInputsSnapshot;
			await refused(bind(f, fake));
		},
	);
	it("requires binding before the post-check and refuses a second binding", async () => {
		const f = await fixture();
		const snapshot = await capture(f);
		await refused(assertNativeInputsUnchanged(snapshot));
		await bind(f, snapshot);
		await refused(bind(f, snapshot));
	});
	it("admits exactly one concurrent binding and never posts an incomplete binding", async () => {
		const f = await fixture();
		const snapshot = await capture(f);
		const one = bind(f, snapshot);
		await refused(assertNativeInputsUnchanged(snapshot));
		const results = await Promise.allSettled([one, bind(f, snapshot)]);
		expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
		await assertNativeInputsUnchanged(snapshot);
	});
	it("does not reuse a capture after a failed binding", async () => {
		const f = await fixture();
		const snapshot = await capture(f);
		const original = f.metadata.workspace_root;
		f.metadata.workspace_root = f.repo;
		await refused(bind(f, snapshot));
		f.metadata.workspace_root = original;
		await refused(bind(f, snapshot));
		await refused(assertNativeInputsUnchanged(snapshot));
	});
	it.each([
		"crates/Cargo.toml",
		"crates/Cargo.lock",
		"crates/deny.toml",
		"rust-toolchain.toml",
		"crates/draftyak-transport/Cargo.toml",
	])("binds raw bytes of %s before and after metadata", async (name) => {
		const f = await fixture();
		const snapshot = await capture(f);
		await bind(f, snapshot);
		await fs.appendFile(path.join(f.repo, name), "# changed\n");
		await refused(assertNativeInputsUnchanged(snapshot), "INPUTS_CHANGED");
	});
	it("refuses raw changes before binding", async () => {
		const f = await fixture();
		const snapshot = await capture(f);
		await fs.appendFile(path.join(f.repo, "crates/Cargo.lock"), "# changed\n");
		await refused(bind(f, snapshot), "INPUTS_CHANGED");
	});
	it("detects same-byte manifest replacement through private identity", async () => {
		const f = await fixture();
		const snapshot = await capture(f);
		await bind(f, snapshot);
		const filename = path.join(f.repo, "crates/deny.toml");
		const bytes = await fs.readFile(filename);
		await fs.rename(filename, `${filename}.old`);
		await fs.writeFile(filename, bytes);
		expect((await capture(f)).inputDigest).toBe(snapshot.inputDigest);
		await refused(assertNativeInputsUnchanged(snapshot), "INPUTS_CHANGED");
	});
	it("detects replacement of the checked repository and Cargo home directories", async () => {
		const f = await fixture();
		const snapshot = await capture(f);
		await bind(f, snapshot);
		await fs.rename(f.home, `${f.home}-old`);
		await fs.mkdir(f.home);
		await refused(assertNativeInputsUnchanged(snapshot), "INPUTS_CHANGED");
		const fresh = await capture(f);
		await bind(f, fresh);
		await fs.rename(f.repo, `${f.repo}-old`);
		await fs.cp(`${f.repo}-old`, f.repo, { recursive: true });
		await refused(assertNativeInputsUnchanged(fresh), "INPUTS_CHANGED");
	});
	it.each(["missing-file", "missing-member", "hardlink", "junction", "root-junction"])(
		"refuses %s filesystem inputs",
		async (kind) => {
			const f = await fixture();
			const manifest = path.join(f.repo, "crates/draftyak-transport/Cargo.toml");
			if (kind === "missing-file") await fs.unlink(manifest);
			if (kind === "missing-member")
				await fs.rename(path.dirname(manifest), path.join(f.base, "moved-member"));
			if (kind === "hardlink") await fs.link(manifest, path.join(f.base, "linked-manifest"));
			if (kind === "junction") {
				await fs.rename(path.dirname(manifest), path.join(f.base, "moved-member"));
				await fs.symlink(path.join(f.base, "moved-member"), path.dirname(manifest), "junction");
			}
			if (kind === "root-junction") {
				await fs.symlink(f.repo, path.join(f.base, "alias"), "junction");
				await refused(captureNativeInputs(path.join(f.base, "alias"), f.home));
			} else await refused(capture(f));
		},
	);
	it("refuses noncanonical component case and aliases", async () => {
		const f = await fixture();
		await refused(captureNativeInputs(path.join(f.base, "REPO"), f.home));
		await fs.rename(
			path.join(f.repo, "crates/draftyak-transport/src/lib.rs"),
			path.join(f.repo, "crates/draftyak-transport/src/LIB.RS"),
		);
		const snapshot = await capture(f);
		await refused(bind(f, snapshot));
	});
	it.each(["# unsupported", " ", "\n"])(
		"refuses nonempty Cargo configuration %j",
		async (bytes) => {
			const f = await fixture();
			await write(path.join(f.repo, ".cargo/config.toml"), bytes);
			await refused(capture(f), "CONFIGURATION_UNSUPPORTED");
		},
	);
	it.each(["crates/.cargo", "apps/app/.cargo", "apps/app/src-tauri/.cargo"])(
		"checks configuration at %s",
		async (directory) => {
			const f = await fixture();
			await write(
				path.join(f.repo, directory, "config"),
				"[source.crates-io]\nreplace-with='other'\n",
			);
			await refused(capture(f), "CONFIGURATION_UNSUPPORTED");
		},
	);
	it("refuses two config filenames and case-aliased config components", async () => {
		const f = await fixture();
		await write(path.join(f.repo, ".cargo/config"), "");
		await write(path.join(f.repo, ".cargo/config.toml"), "");
		await refused(capture(f), "CONFIGURATION_UNSUPPORTED");
		await fs.unlink(path.join(f.repo, ".cargo/config"));
		await fs.rename(
			path.join(f.repo, ".cargo/config.toml"),
			path.join(f.repo, ".cargo/CONFIG.TOML"),
		);
		await refused(capture(f));
	});
	it.each(["global", "above-repository"])(
		"refuses %s configuration by presence, without opening it",
		async (kind) => {
			const f = await fixture();
			const filename =
				kind === "global"
					? path.join(f.home, "config.toml")
					: path.join(f.base, ".cargo/config.toml");
			await write(filename, "synthetic closed configuration\n");
			opened.length = 0;
			await refused(capture(f), "CONFIGURATION_UNSUPPORTED");
			expect(opened).toEqual([]);
		},
	);
	it.each(["added", "deleted", "global-added"])(
		"detects %s configuration after capture",
		async (kind) => {
			const f = await fixture();
			const config = path.join(f.repo, "crates/.cargo/config.toml");
			if (kind === "deleted") await write(config, "");
			const snapshot = await capture(f);
			await bind(f, snapshot);
			if (kind === "deleted") await fs.unlink(config);
			else await write(kind === "added" ? config : path.join(f.home, "config"), "");
			await refused(assertNativeInputsUnchanged(snapshot));
		},
	);
	it.each(["added", "deleted", "replaced"])(
		"detects %s Rust target inventory without opening source bytes",
		async (kind) => {
			const f = await fixture();
			const snapshot = await capture(f);
			await bind(f, snapshot);
			const filename = path.join(f.repo, "crates/draftyak-transport/src/lib.rs");
			if (kind === "added")
				await write(
					path.join(f.repo, "crates/draftyak-transport/examples/new.rs"),
					"// synthetic\n",
				);
			if (kind === "deleted") await fs.unlink(filename);
			if (kind === "replaced") {
				await fs.rename(filename, `${filename}.old`);
				await write(filename, "// synthetic target, never opened\n");
			}
			await refused(assertNativeInputsUnchanged(snapshot));
			expect(opened.some((name) => name.endsWith(".rs"))).toBe(false);
		},
	);
	it.each([
		"git",
		"alternate-registry",
		"unknown-local",
		"wrong-name",
		"missing-root",
		"duplicate-root",
		"wrong-workspace",
		"unknown-member",
	])("refuses %s metadata", async (kind) => {
		const f = await fixture();
		const snapshot = await capture(f);
		const pkg = first(f.packages);
		if (kind === "git" || kind === "alternate-registry")
			f.packages.push({
				...pkg,
				id: "unapproved-external",
				source:
					kind === "git"
						? "git+https://example.invalid/project#deadbeef"
						: "registry+https://example.invalid/index",
			});
		if (kind === "unknown-local") pkg.manifest_path = path.join(f.base, "unknown/Cargo.toml");
		if (kind === "wrong-name") pkg.name = "other-package";
		if (kind === "missing-root") {
			f.packages.pop();
			(f.metadata.workspace_members as unknown[]).pop();
		}
		if (kind === "duplicate-root") f.packages.push({ ...pkg });
		if (kind === "wrong-workspace") f.metadata.workspace_root = f.repo;
		if (kind === "unknown-member") (f.metadata.workspace_members as unknown[])[0] = "unknown";
		await refused(bind(f, snapshot));
	});
	it.each(["git", "registry-override", "outside-path", "unknown-path", "source-less"])(
		"refuses %s declared dependency",
		async (kind) => {
			const f = await fixture();
			const snapshot = await capture(f);
			const dep: Row = { name: "dependency", source: registry, registry: null };
			if (kind === "git") dep.source = "git+https://example.invalid/project#deadbeef";
			if (kind === "registry-override") dep.registry = "https://example.invalid/index";
			if (kind === "outside-path" || kind === "unknown-path") {
				dep.source = null;
				dep.path = kind === "outside-path" ? f.base : path.join(f.repo, "unknown");
			}
			if (kind === "source-less") dep.source = null;
			first(f.packages).dependencies = [dep];
			await refused(bind(f, snapshot));
		},
	);
	it("accepts only an exact fixed-member local path dependency", async () => {
		const f = await fixture();
		const snapshot = await capture(f);
		first(f.packages).dependencies = [
			{
				name: "draftyak-transport",
				source: null,
				registry: null,
				path: path.join(f.repo, "crates/draftyak-transport"),
			},
		];
		await expect(bind(f, snapshot)).resolves.toHaveProperty("rootIds");
	});
	it("accepts the official registry identity without opening registry source or prose", async () => {
		const f = await fixture();
		const snapshot = await capture(f);
		f.packages.push({
			...first(f.packages),
			id: "registry-dependency",
			source: registry,
			manifest_path: path.join(f.base, "not-opened/Cargo.toml"),
			description: "synthetic unused prose",
		});
		first(f.packages).dependencies = [
			{ name: "registry-dependency", source: registry, registry: null },
		];
		await bind(f, snapshot);
		expect(opened.some((name) => name.includes("not-opened"))).toBe(false);
	});
	it.each([
		"outside-repo",
		"other-member",
		"missing",
		"added-after-capture",
		"ignored-directory",
		"duplicate",
		"empty",
		"wrong-extension",
	])("refuses %s target mapping", async (kind) => {
		const f = await fixture();
		if (kind === "ignored-directory")
			await write(path.join(f.repo, "crates/draftyak-protocol/target/hidden.rs"), "// synthetic\n");
		if (kind === "wrong-extension")
			await write(path.join(f.repo, "crates/draftyak-protocol/src/other.txt"), "synthetic\n");
		const snapshot = await capture(f);
		const pkg = first(f.packages);
		const target = first(targets(pkg));
		if (kind === "outside-repo") target.src_path = path.join(f.base, "outside.rs");
		if (kind === "other-member") target.src_path = first(targets(f.packages[1] as Row)).src_path;
		if (kind === "missing")
			target.src_path = path.join(f.repo, "crates/draftyak-protocol/src/missing.rs");
		if (kind === "added-after-capture") {
			target.src_path = path.join(f.repo, "crates/draftyak-protocol/src/added.rs");
			await write(String(target.src_path), "// synthetic\n");
		}
		if (kind === "ignored-directory")
			target.src_path = path.join(f.repo, "crates/draftyak-protocol/target/hidden.rs");
		if (kind === "wrong-extension")
			target.src_path = path.join(f.repo, "crates/draftyak-protocol/src/other.txt");
		if (kind === "duplicate") targets(pkg).push({ ...target });
		if (kind === "empty") pkg.targets = [];
		await refused(bind(f, snapshot));
	});
	it.each(["accessor", "proxy", "sparse", "symbol"])(
		"refuses hostile %s metadata without invoking an accessor",
		async (kind) => {
			const f = await fixture();
			const snapshot = await capture(f);
			const getter = vi.fn(() => {
				throw new Error("synthetic accessor must not run");
			});
			if (kind === "accessor") Object.defineProperty(f.metadata, "packages", { get: getter });
			if (kind === "proxy") f.metadata = new Proxy(f.metadata, { get: getter });
			if (kind === "sparse") f.packages.length++;
			if (kind === "symbol")
				Object.defineProperty(f.metadata, Symbol("synthetic"), { value: true });
			await refused(bind(f, snapshot));
			expect(getter).not.toHaveBeenCalled();
		},
	);
	it("bounds a raw file before opening it and the total captured raw bytes", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.repo, "crates/Cargo.lock"), Buffer.alloc(8 * 1024 * 1024 + 1));
		opened.length = 0;
		await refused(capture(f));
		expect(opened).not.toContain(path.join(f.repo, "crates/Cargo.lock"));
		await fs.writeFile(path.join(f.repo, "crates/Cargo.lock"), Buffer.alloc(8 * 1024 * 1024));
		await fs.writeFile(path.join(f.repo, "crates/deny.toml"), Buffer.alloc(8 * 1024 * 1024));
		await refused(capture(f));
	});
	it("bounds recursive target inventory depth", async () => {
		const f = await fixture();
		await write(
			path.join(
				f.repo,
				"crates/draftyak-transport",
				...Array<string>(26).fill("nested"),
				"target.rs",
			),
			"// synthetic\n",
		);
		await refused(capture(f));
	});
	it("returns fixed errors without path or untrusted filesystem text", async () => {
		const f = await fixture();
		await fs.unlink(path.join(f.repo, "crates/Cargo.lock"));
		try {
			await capture(f);
			throw new Error("expected refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(NativeInputsError);
			expect(String(error)).toBe("NativeInputsError: native dependency inputs refused");
			expect(JSON.stringify(error)).not.toContain(f.repo);
		}
	});
});
