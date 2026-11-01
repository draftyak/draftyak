import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { egressDigest, manifestDigest, sendTemplateDigest } from "@draftyak/protocol/digests";
import { type PluginManifestV1, validateManifest } from "@draftyak/protocol/manifest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledBundle } from "../../src/artifacts/index.ts";
import * as artifacts from "../../src/artifacts/index.ts";
import {
	BUNDLED_PLUGIN_IDS,
	type BundledPluginId,
	openPluginInstaller,
	PluginInstallError,
	type PluginInstallerOptions,
} from "../../src/plugins/installer/index.ts";
import { admitManifest } from "../../src/plugins/installer/policy.ts";
import { trusted, unchanged } from "../../src/plugins/installer/tree.ts";
import { makePinnedPackage, packageEntries } from "../artifacts/fixtures.ts";
import {
	type Bundle,
	bundle,
	EXECUTED,
	entryBody,
	type Fixture,
	finalName,
	fixture,
	helperBody,
	manifest,
	removeFixtures,
} from "./installer-fixtures.ts";

const globals = globalThis as Record<symbol, unknown>;
const refusal = new PluginInstallError();

afterEach(async () => {
	vi.restoreAllMocks();
	await removeFixtures();
	delete globals[EXECUTED];
});

async function refuses(f: Fixture, item: Bundle): Promise<void> {
	const installer = await f.open([item]);
	await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
		refusal,
	);
	expect(readdirSync(f.root)).toEqual([]);
}

/** Runs `after` on the staged tree once the real verification has passed. */
function afterVerification(after: (installed: InstalledBundle) => void | Promise<void>): void {
	const verify = artifacts.verifyBundle;
	vi.spyOn(artifacts, "verifyBundle").mockImplementation(async (installed) => {
		const entry = await verify(installed);
		await after(installed);
		return entry;
	});
}

/** Counts event-loop turns until stopped. */
function ticker(): { readonly count: () => number; stop(): void } {
	let ticks = 0;
	let ticking = true;
	const tick = (): void => {
		ticks++;
		if (ticking) setImmediate(tick);
	};
	setImmediate(tick);
	return {
		count: () => ticks,
		stop: () => {
			ticking = false;
		},
	};
}

/** Waits past a coarse file system clock's tick, so a later change moves the times it sets. */
const pastClockTick = (): Promise<void> => delay(25);

/** A bundle with 20 extra files, each in its own folder: 25 files and 22 folders in all. */
function spread(): { readonly item: Bundle; readonly files: number; readonly folders: number } {
	const extras = Array.from({ length: 20 }, (_, index) => ({
		name: `package/folder-${index}/file.mjs`,
		body: `export const index = ${index};\n`,
	}));
	return {
		item: bundle("channel-gmail", { extras }),
		files: extras.length + 5,
		folders: extras.length + 2,
	};
}

function gate(): { readonly open: Promise<void>; release(): void } {
	let release = (): void => {};
	const open = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { open, release };
}

const unfinished = (name: string): boolean => !name.startsWith(".staging-");

/** The install's staging folder in the fixture root, once there is one. */
function stagingFolder(f: Fixture): string | undefined {
	const name = readdirSync(f.root).find((entry) => entry.startsWith(".staging-"));
	return name === undefined ? undefined : path.join(f.root, name);
}

/** Calls `step` once per event-loop turn until `pending` settles. */
async function eachTurn(pending: Promise<unknown>, step: () => void): Promise<void> {
	let settled = false;
	const done = (): void => {
		settled = true;
	};
	void pending.then(done, done);
	while (!settled) {
		await new Promise((resolve) => setImmediate(resolve));
		step();
	}
}

describe("bundled plugin installation", () => {
	it("admits exactly the five pinned first-party packages without executing them", async () => {
		const f = fixture();
		const packages = BUNDLED_PLUGIN_IDS.map((id) => bundle(id));
		const installer = await f.open(packages);
		for (const item of packages) {
			expect(validateManifest(item.manifest).ok).toBe(true);
			const installed = await installer.install(item.id, item.lock.version, item.archive);
			expect(installed.manifest.id).toBe(item.id);
			expect(installed.bundle.directory).toBe(path.join(f.root, finalName(item)));
			expect(installed.bundle.inventory).toMatchObject(item.lock);
			expect(installed.bundle.inventory.files.map(({ path }) => path)).toEqual([
				"draftyak.plugin.json",
				"empty",
				"index.mjs",
				"lib/helper.mjs",
				"package.json",
			]);
			expect(await artifacts.verifyBundle(installed.bundle)).toBe(
				path.join(installed.bundle.directory, "index.mjs"),
			);
			expect(readFileSync(path.join(installed.bundle.directory, "index.mjs"), "utf8")).toBe(
				entryBody,
			);
			expect(installed.digests.manifest).toBe(manifestDigest(item.manifest));
			expect(installed.digests.egress).toBe(egressDigest(item.manifest.egress));
			expect(installed.digests.send).toBe(
				item.id.startsWith("channel-") ? sendTemplateDigest(item.manifest.send) : null,
			);
			expect(Object.isFrozen(installed.manifest.auth)).toBe(true);
			expect(Object.isFrozen(installed.bundle.inventory.files)).toBe(true);
			for (const row of installed.bundle.inventory.files) {
				const filename = path.join(installed.bundle.directory, ...row.path.split("/"));
				expect(lstatSync(filename).mode & 0o222).toBe(0);
				expect(row.sha256).toBe(createHash("sha256").update(readFileSync(filename)).digest("hex"));
			}
			if (process.platform !== "win32") {
				expect(lstatSync(installed.bundle.directory).mode & 0o222).toBe(0);
				expect(lstatSync(path.join(installed.bundle.directory, "lib")).mode & 0o222).toBe(0);
			}
		}
		expect(readdirSync(f.root).sort()).toEqual(packages.map(finalName).sort());
		expect(globals[EXECUTED]).toBeUndefined();
	});

	it("takes no master key or extension host and exposes only artifact operations and close", async () => {
		const f = fixture();
		const item = bundle();
		for (const extra of [{ extensions: {} }, { masterKey: {} }]) {
			const options = { ...f.options([item]), ...extra } as PluginInstallerOptions;
			await expect(openPluginInstaller(options)).rejects.toEqual(refusal);
		}
		const installer = await f.open([item]);
		expect(Reflect.ownKeys(installer).sort()).toEqual(["close", "inspect", "install"]);
		expect(Object.isFrozen(installer)).toBe(true);
	});

	it("stages an upgrade beside the old version without overwriting it", async () => {
		const f = fixture();
		const first = bundle();
		const next = bundle("channel-gmail", { version: "1.1.0" });
		const installer = await f.open([first, next]);
		const old = await installer.install(first.id, first.lock.version, first.archive);
		const upgraded = await installer.install(next.id, next.lock.version, next.archive);
		expect(upgraded.bundle.directory).not.toBe(old.bundle.directory);
		expect(upgraded.manifest.version).toBe("1.1.0");
		expect(upgraded.digests.manifest).not.toBe(old.digests.manifest);
		await expect(artifacts.verifyBundle(old.bundle)).resolves.toBe(
			path.join(old.bundle.directory, "index.mjs"),
		);
		await expect(installer.install(first.id, first.lock.version, first.archive)).rejects.toEqual(
			refusal,
		);
		expect(readdirSync(f.root)).toHaveLength(2);
	});

	it("snapshots native release pins and archive bytes instead of trusting later mutation", async () => {
		const f = fixture();
		const item = bundle();
		const options = f.options([item]);
		const installer = await openPluginInstaller(options);
		f.installers.push(installer);
		Object.assign(item.lock, { integrity: `sha512-${Buffer.alloc(64).toString("base64")}` });
		options.bundles.splice(0);
		const pending = installer.install(item.id, "1.0.0", item.archive);
		item.archive.fill(0);
		const installed = await pending;
		expect(installed.manifest.id).toBe(item.id);
		await expect(artifacts.verifyBundle(installed.bundle)).resolves.toBe(
			path.join(installed.bundle.directory, "index.mjs"),
		);
	});

	it("accepts omitted Node runtime and the retained Gmail read-only declaration", async () => {
		const raw = manifest();
		delete raw.runtime;
		delete raw.send;
		raw.egress = { profile: "gmail-readonly-v1" };
		const item = bundle("channel-gmail", { manifest: raw });
		const f = fixture();
		const installer = await f.open([item]);
		const installed = await installer.install(item.id, item.lock.version, item.archive);
		expect(Object.hasOwn(installed.manifest, "runtime")).toBe(false);
		expect(installed.digests.egress).toBe(egressDigest({ profile: "gmail-readonly-v1" }));
		expect(installed.digests.send).toBeNull();
	});

	it("yields to the event loop before each file and folder while writing and sealing", async () => {
		const f = fixture();
		const { item, files, folders } = spread();
		const installer = await f.open([item]);
		let atVerification = -1;
		const verify = artifacts.verifyBundle;
		const turns = ticker();
		vi.spyOn(artifacts, "verifyBundle").mockImplementation(async (installed) => {
			atVerification = turns.count();
			return verify(installed);
		});
		try {
			await installer.install(item.id, item.lock.version, item.archive);
		} finally {
			turns.stop();
		}
		expect(atVerification).toBeGreaterThanOrEqual(files + folders - 2);
	});

	it("yields to the event loop before each file and folder while removing a failed install", async () => {
		const f = fixture();
		const { item, files, folders } = spread();
		const installer = await f.open([item]);
		let atFailure = -1;
		const turns = ticker();
		vi.spyOn(artifacts, "verifyBundle").mockImplementation(async () => {
			atFailure = turns.count();
			throw new Error("DYTEST failure");
		});
		try {
			await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
				refusal,
			);
		} finally {
			turns.stop();
		}
		// POSIX first makes each folder writable again.
		const passes = process.platform === "win32" ? 1 : 2;
		expect(turns.count() - atFailure).toBeGreaterThanOrEqual(files + passes * folders - 2);
		expect(readdirSync(f.root)).toEqual([]);
	});
});

describe("excluded packages and declarations", () => {
	it.each(["channel-hello", "@example/third-party"])(
		"refuses the excluded package id %s",
		async (id) => {
			const f = fixture();
			const raw = { ...manifest(), id };
			expect(validateManifest(raw).ok).toBe(true);
			const name = id === "channel-hello" ? `@draftyak/${id}` : id;
			const packaged = makePinnedPackage(
				packageEntries({ name, version: "1.0.0", type: "module" }, [
					{ name: "package/draftyak.plugin.json", body: JSON.stringify(raw) },
				]),
				{ name, version: "1.0.0" },
			);
			expect(() => artifacts.preparePinnedPackage(packaged.archive, packaged.lock)).not.toThrow();
			const options = f.options([{ ...packaged, id: id as BundledPluginId, manifest: raw }]);
			await expect(openPluginInstaller(options)).rejects.toEqual(refusal);
			expect(readdirSync(f.root)).toEqual([]);
		},
	);

	it("refuses an unpinned version or unknown install id before archive parsing", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const prepare = vi.spyOn(artifacts, "preparePinnedPackage");
		await expect(installer.install(item.id, "1.0.1", item.archive)).rejects.toEqual(refusal);
		await expect(
			installer.install("channel-hello" as BundledPluginId, "1.0.0", item.archive),
		).rejects.toEqual(refusal);
		expect(prepare).not.toHaveBeenCalled();
		expect(readdirSync(f.root)).toEqual([]);
	});

	it.each([
		["Python runtime", { runtime: "python" }],
		["nonstandard isolation", { isolation: "direct" }],
		["unknown manifest field", { unexpected: true }],
		["wrong plugin identity", { id: "channel-slack" }],
		["wrong manifest version", { version: "1.0.1" }],
		["a provider under a channel id", { ...manifest("ai-responses-api"), id: "channel-gmail" }],
	])("refuses %s before creating any files", async (_name, patch) => {
		await refuses(fixture(), bundle("channel-gmail", { manifest: { ...manifest(), ...patch } }));
	});

	it.each([
		["channel-slack", "channel-gmail"],
		["channel-gmail", "channel-slack"],
	] as const)("refuses a valid declaration bound to another channel under %s", async (id, from) => {
		const raw = { ...manifest(from), id };
		expect(validateManifest(raw).ok).toBe(true);
		await refuses(fixture(), bundle(id, { manifest: raw }));
	});

	it("refuses a schema-valid URL-secret declaration", async () => {
		const raw = manifest();
		raw.auth = { kind: "url-secret", scopes: [], requiredGrantedScopes: [] };
		expect(validateManifest(raw).ok).toBe(true);
		await refuses(fixture(), bundle("channel-gmail", { manifest: raw }));
	});

	it("refuses a schema-valid tool kind even when its egress is empty", async () => {
		const raw = {
			...manifest(),
			kind: "tool",
			contract: { extension: "io.github.draftyak/tool", version: 1 },
			auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
			dataClasses: ["tool.calendar.freebusy"],
			egress: { rules: [] },
			tool: {
				kinds: [
					{
						kind: "calendar.freebusy",
						inputs: ["window", "tz"],
						output: { dataClass: "tool.calendar.freebusy", maxBytes: 20480 },
					},
				],
			},
		};
		delete (raw as Record<string, unknown>).send;
		expect(validateManifest(raw).ok).toBe(true);
		await refuses(fixture(), bundle("channel-gmail", { manifest: raw }));
	});

	it("refuses URL-secret declarations even without URL-secret auth", async () => {
		const raw = manifest();
		raw.credentials = {
			mode: "brokered",
			urlSecrets: [{ name: "address", label: "Address", help: "DYTEST address" }],
		};
		expect(validateManifest(raw).ok).toBe(true);
		await refuses(fixture(), bundle("channel-gmail", { manifest: raw }));
	});

	it("refuses a schema-valid json-template send", async () => {
		const raw = {
			...manifest(),
			dataClasses: ["fixture.content"],
			egress: {
				rules: [
					{
						class: "send",
						method: "POST",
						host: "chat.example.com",
						pathTemplate: "/channels/{chat.channelId}/messages",
						maxBytes: 32768,
						timeoutMs: 10000,
					},
				],
			},
			send: {
				render: "json-template",
				constants: {},
				template: {
					rule: 0,
					path: ["channels", { bind: "chat.channelId" }, "messages"],
					query: {},
					headers: { "content-type": "application/json" },
					body: { text: { bind: "body.text" }, footer: { bind: "body.footer" } },
				},
			},
		};
		expect(validateManifest(raw).ok).toBe(true);
		await refuses(fixture(), bundle("channel-gmail", { manifest: raw }));
	});

	it("refuses a schema-valid but wrong first-party provider profile", async () => {
		const raw = manifest("ai-responses-api");
		raw.egress = { profile: "messages-api-v1" };
		expect(validateManifest(raw).ok).toBe(true);
		await refuses(fixture(), bundle("ai-responses-api", { manifest: raw }));
	});

	it("refuses missing, duplicate-member and malformed manifest bytes", async () => {
		for (const options of [
			{ missingManifest: true },
			{ manifestText: '{"id":"channel-gmail","id":"channel-gmail"}' },
			{ manifestText: "DYTEST invalid JSON" },
		]) {
			await refuses(fixture(), bundle("channel-gmail", options));
		}
	});

	it("rejects a package with the right manifest but the wrong metadata identity", async () => {
		await refuses(
			fixture(),
			bundle("channel-gmail", { metadata: { name: "@example/third-party" } }),
		);
	});

	it.each([
		["scripts", { scripts: {} }],
		["install script", { scripts: { install: "DYTEST not executed" } }],
		["runtime dependency", { dependencies: { "fixture-child": "1.0.0" } }],
		["optional dependency", { optionalDependencies: { "fixture-child": "1.0.0" } }],
		["peer dependency", { peerDependencies: { "fixture-child": "1.0.0" } }],
		["bundled dependencies", { bundledDependencies: ["fixture-child"] }],
		["native build", { gypfile: false }],
	])("refuses %s without running package scripts", async (_name, metadata) => {
		await refuses(fixture(), bundle("channel-gmail", { metadata }));
		expect(globals[EXECUTED]).toBeUndefined();
	});

	it.each([
		"addon.node",
		"native.DLL",
		"native.so",
		"lib/addon.so.1",
		"lib/libnative.so.2.0.1",
		"native.dylib",
		"binding.gyp",
		"NODE_MODULES/child.mjs",
	])("refuses non-self-contained member %s", async (name) => {
		await refuses(
			fixture(),
			bundle("channel-gmail", { extras: [{ name: `package/${name}`, body: "DYTEST" }] }),
		);
	});

	it.each(["1", "2"])("rejects archive link type %s without materializing it", async (type) => {
		await refuses(
			fixture(),
			bundle("channel-gmail", {
				extras: [{ name: "package/linked", type, linkname: "package/index.mjs" }],
			}),
		);
	});

	it("checks exact compressed integrity before unpack or filesystem writes", async () => {
		const f = fixture();
		const item = bundle();
		const other = bundle("channel-gmail", {
			extras: [{ name: "package/unpinned", body: "DYTEST" }],
		});
		const installer = await f.open([item]);
		await expect(installer.install(item.id, item.lock.version, other.archive)).rejects.toEqual(
			refusal,
		);
		expect(readdirSync(f.root)).toEqual([]);
	});
});

describe("the installer's own manifest policy", () => {
	const checked = (raw: Record<string, unknown>): PluginManifestV1 => {
		const result = validateManifest(raw);
		if (!result.ok) throw new Error("DYTEST fixture manifest is invalid");
		return result.manifest;
	};
	const refusedBy = (value: object, id: BundledPluginId = "channel-gmail"): void => {
		expect(() => admitManifest(value as PluginManifestV1, id)).toThrow(refusal);
	};

	it("admits each first-party declaration under its own id", () => {
		for (const id of BUNDLED_PLUGIN_IDS)
			expect(() => admitManifest(checked(manifest(id)), id)).not.toThrow();
	});

	it("refuses a Python runtime and non-standard isolation in the schema and on its own", () => {
		expect(validateManifest({ ...manifest(), runtime: "python" })).toEqual({
			ok: false,
			problems: [{ code: "RUNTIME_UNSUPPORTED" }],
		});
		expect(validateManifest({ ...manifest(), isolation: "direct" })).toEqual({
			ok: false,
			problems: [{ code: "MANIFEST_INVALID" }],
		});
		refusedBy({ ...checked(manifest()), runtime: "python" });
		refusedBy({ ...checked(manifest()), isolation: "direct" });
	});

	it("refuses a tool kind and a json-template send even under a first-party profile", () => {
		const gmail = checked(manifest());
		const send = { render: "json-template", constants: {}, template: { rule: 0 } };
		expect(validateManifest({ ...manifest(), kind: "tool" }).ok).toBe(false);
		expect(validateManifest({ ...manifest(), send }).ok).toBe(false);
		refusedBy({ ...gmail, kind: "tool" });
		refusedBy({ ...gmail, send });
	});
});

describe("release pins and options", () => {
	it("refuses an accessor or proxy catalog without evaluating it", async () => {
		const f = fixture();
		let calls = 0;
		const options = f.options([bundle()]);
		Object.defineProperty(options.bundles[0], "package", {
			enumerable: true,
			get() {
				calls++;
				return {};
			},
		});
		await expect(openPluginInstaller(options)).rejects.toEqual(refusal);
		const proxied = f.options([bundle()]);
		proxied.bundles = new Proxy(proxied.bundles, {
			get() {
				calls++;
				throw new Error("DYTEST must not be evaluated");
			},
		});
		await expect(openPluginInstaller(proxied)).rejects.toEqual(refusal);
		expect(calls).toBe(0);
	});

	it("refuses duplicate version pins and a foreign package name", async () => {
		const f = fixture();
		const item = bundle();
		await expect(f.open([item, item])).rejects.toEqual(refusal);
		const options = f.options([item]);
		Object.assign(options.bundles[0]?.package ?? {}, { name: "@example/third-party" });
		await expect(openPluginInstaller(options)).rejects.toEqual(refusal);
		expect(readdirSync(f.root)).toEqual([]);
	});

	it("pins only an ES module entry", async () => {
		const f = fixture();
		for (const entry of ["index.cjs", "index.json"])
			await expect(f.open([bundle("channel-gmail", { entry })])).rejects.toEqual(refusal);
		const item = bundle("channel-gmail", { entry: "index.js" });
		const installer = await f.open([item]);
		const installed = await installer.install(item.id, item.lock.version, item.archive);
		await expect(artifacts.verifyBundle(installed.bundle)).resolves.toBe(
			path.join(installed.bundle.directory, "index.js"),
		);
	});

	it("accepts at most 64 release pins", async () => {
		const f = fixture();
		const pins = (count: number): PluginInstallerOptions["bundles"] =>
			Array.from({ length: count }, (_, index) => ({
				id: "channel-gmail",
				package: {
					name: "@draftyak/channel-gmail",
					version: `1.0.${index}`,
					integrity: `sha512-${Buffer.alloc(64, index).toString("base64")}`,
					entry: "index.mjs",
				},
			}));
		f.installers.push(await openPluginInstaller({ directory: f.root, bundles: pins(64) }));
		await expect(openPluginInstaller({ directory: f.root, bundles: pins(65) })).rejects.toEqual(
			refusal,
		);
	});
});

describe("native installation boundaries", () => {
	it("refuses a linked install root and a root replaced after startup", async () => {
		const f = fixture();
		const alias = path.join(f.dir, "alias");
		symlinkSync(f.root, alias, process.platform === "win32" ? "junction" : "dir");
		const item = bundle();
		await expect(openPluginInstaller({ ...f.options([item]), directory: alias })).rejects.toEqual(
			refusal,
		);
		const installer = await f.open([item]);
		renameSync(f.root, path.join(f.dir, "previous"));
		mkdirSync(f.root, { mode: 0o700 });
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(readdirSync(f.root)).toEqual([]);
	});

	it.each(["missing", "tampered", "extra", "hard link", "junction"])(
		"refuses an installed tree with a %s member",
		async (damage) => {
			const f = fixture();
			const item = bundle();
			const installer = await f.open([item]);
			const installed = await installer.install(item.id, item.lock.version, item.archive);
			await artifacts.verifyBundle(installed.bundle);
			const root = installed.bundle.directory;
			const child = path.join(root, "lib");
			const file = path.join(child, "helper.mjs");
			chmodSync(root, 0o700);
			chmodSync(child, 0o700);
			chmodSync(file, 0o600);
			if (damage === "extra") writeFileSync(path.join(root, ".DS_Store"), "DYTEST");
			else if (damage === "tampered") writeFileSync(file, "DYTEST changed");
			else {
				unlinkSync(file);
				if (damage === "hard link") {
					const target = path.join(f.dir, "outside.mjs");
					writeFileSync(target, helperBody);
					linkSync(target, file);
					expect(lstatSync(file).nlink).toBe(2);
				} else if (damage === "junction") {
					rmdirSync(child);
					const target = path.join(f.dir, "outside");
					mkdirSync(target);
					writeFileSync(path.join(target, "helper.mjs"), helperBody);
					symlinkSync(target, child, process.platform === "win32" ? "junction" : "dir");
				}
			}
			await expect(artifacts.verifyBundle(installed.bundle)).rejects.toThrow(
				"Artifact verification refused.",
			);
		},
	);

	it("refuses an installed tree with a symlinked member", {
		tags: ["requires:symlink-privilege"],
	}, async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const installed = await installer.install(item.id, item.lock.version, item.archive);
		const child = path.join(installed.bundle.directory, "lib");
		const file = path.join(child, "helper.mjs");
		const target = path.join(f.dir, "outside.mjs");
		writeFileSync(target, helperBody);
		chmodSync(child, 0o700);
		chmodSync(file, 0o600);
		unlinkSync(file);
		symlinkSync(target, file, "file");
		expect(lstatSync(file).isSymbolicLink()).toBe(true);
		await expect(artifacts.verifyBundle(installed.bundle)).rejects.toThrow(
			"Artifact verification refused.",
		);
	});

	it("requires final native verification and leaves unlisted names untouched on refusal", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const verify = artifacts.verifyBundle;
		let extra = "";
		vi.spyOn(artifacts, "verifyBundle").mockImplementation(async (installed) => {
			chmodSync(installed.directory, 0o700);
			extra = path.join(installed.directory, ".DS_Store");
			writeFileSync(extra, "DYTEST unlisted");
			return verify(installed);
		});
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(readFileSync(extra, "utf8")).toBe("DYTEST unlisted");
		expect(readdirSync(f.root).filter(unfinished)).toEqual([]);
	});

	it("normalizes verification errors and removes only its own staged files", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		vi.spyOn(artifacts, "verifyBundle").mockRejectedValue(new Error("DYTEST private detail"));
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(readdirSync(f.root)).toEqual([]);
	});

	it("does not chmod or remove a substituted hard link while cleaning up", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const target = path.join(f.dir, "outside.mjs");
		writeFileSync(target, helperBody, { mode: 0o400 });
		const verify = artifacts.verifyBundle;
		let substituted = "";
		vi.spyOn(artifacts, "verifyBundle").mockImplementation(async (installed) => {
			const folder = path.join(installed.directory, "lib");
			chmodSync(folder, 0o700);
			substituted = path.join(folder, "helper.mjs");
			chmodSync(substituted, 0o600);
			unlinkSync(substituted);
			linkSync(target, substituted);
			return verify(installed);
		});
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(readFileSync(target, "utf8")).toBe(helperBody);
		expect(lstatSync(target).mode & 0o222).toBe(0);
		expect(lstatSync(substituted).nlink).toBe(2);
	});

	it("refuses a member made writable after verification and removes the staged tree", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		afterVerification((installed) => {
			chmodSync(path.join(installed.directory, "lib", "helper.mjs"), 0o600);
		});
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(readdirSync(f.root)).toEqual([]);
	});

	it.each([
		["longer", `${helperBody}// DYTEST\n`],
		["same-length", helperBody.toUpperCase()],
	])(
		"refuses a member rewritten in place after verification with a %s body and its mode put back",
		async (kind, body) => {
			expect(body.length === helperBody.length).toBe(kind === "same-length");
			const f = fixture();
			const item = bundle();
			const installer = await f.open([item]);
			const seen: { body?: string; mode?: number } = {};
			afterVerification(async (installed) => {
				const member = path.join(installed.directory, "lib", "helper.mjs");
				await pastClockTick();
				chmodSync(member, 0o600);
				writeFileSync(member, body);
				chmodSync(member, 0o400);
				seen.body = readFileSync(member, "utf8");
				seen.mode = lstatSync(member).mode & 0o222;
			});
			await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
				refusal,
			);
			expect(seen).toEqual({ body, mode: 0 });
			expect(readdirSync(f.root)).toEqual([]);
		},
	);

	it("refuses a staged folder changed after verification with its entries and mode put back", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const seen: { names?: string[]; modes?: number[] } = {};
		afterVerification(async (installed) => {
			const lib = path.join(installed.directory, "lib");
			const mode = lstatSync(lib).mode & 0o777;
			const extra = path.join(lib, "extra.mjs");
			await pastClockTick();
			chmodSync(lib, 0o700);
			writeFileSync(extra, "DYTEST");
			unlinkSync(extra);
			chmodSync(lib, mode);
			seen.names = readdirSync(lib);
			seen.modes = [mode, lstatSync(lib).mode & 0o777];
		});
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		const sealed = process.platform === "win32" ? 0o666 : 0o500;
		expect(seen).toEqual({ names: ["helper.mjs"], modes: [sealed, sealed] });
		expect(readdirSync(f.root)).toEqual([]);
	});

	it("refuses a same-content file renamed in after verification, keeps it and still installs the pin later", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const outside = path.join(f.dir, "outside.mjs");
		let member = "";
		let substitute = -1n;
		afterVerification((installed) => {
			const lib = path.join(installed.directory, "lib");
			member = path.join(lib, "helper.mjs");
			chmodSync(lib, 0o700);
			chmodSync(member, 0o600);
			writeFileSync(outside, helperBody);
			substitute = lstatSync(outside, { bigint: true }).ino;
			renameSync(outside, member);
			chmodSync(member, 0o400);
			chmodSync(lib, 0o500);
		});
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(lstatSync(member, { bigint: true }).ino).toBe(substitute);
		expect(readFileSync(member, "utf8")).toBe(helperBody);
		expect(lstatSync(member).mode & 0o222).toBe(0);
		expect(readdirSync(f.root).filter(unfinished)).toEqual([]);
		vi.restoreAllMocks();
		const installed = await installer.install(item.id, item.lock.version, item.archive);
		expect(readdirSync(f.root).filter(unfinished)).toEqual([finalName(item)]);
		await expect(artifacts.verifyBundle(installed.bundle)).resolves.toBe(
			path.join(installed.bundle.directory, "index.mjs"),
		);
	});

	it("refuses a member hard-linked after verification without touching either link", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const outside = path.join(f.dir, "outside.mjs");
		afterVerification((installed) => {
			linkSync(path.join(installed.directory, "lib", "helper.mjs"), outside);
		});
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(lstatSync(outside).nlink).toBe(2);
		expect(lstatSync(outside).mode & 0o222).toBe(0);
		expect(readdirSync(f.root).filter(unfinished)).toEqual([]);
	});

	it("refuses a staged directory replaced after verification, even holding the original file", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		afterVerification((installed) => {
			const lib = path.join(installed.directory, "lib");
			const replacement = path.join(installed.directory, "replacement");
			chmodSync(installed.directory, 0o700);
			chmodSync(lib, 0o700);
			mkdirSync(replacement, { mode: 0o700 });
			renameSync(path.join(lib, "helper.mjs"), path.join(replacement, "helper.mjs"));
			rmdirSync(lib);
			renameSync(replacement, lib);
			chmodSync(lib, 0o500);
			chmodSync(installed.directory, 0o500);
		});
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(readdirSync(f.root).filter(unfinished)).toEqual([]);
	});

	it("never follows a replaced folder to remove a member moved out of the tree", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const outside = path.join(f.dir, "outside");
		mkdirSync(outside);
		afterVerification((installed) => {
			const lib = path.join(installed.directory, "lib");
			chmodSync(installed.directory, 0o700);
			chmodSync(lib, 0o700);
			renameSync(path.join(lib, "helper.mjs"), path.join(outside, "helper.mjs"));
			rmdirSync(lib);
			symlinkSync(outside, lib, process.platform === "win32" ? "junction" : "dir");
		});
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(readFileSync(path.join(outside, "helper.mjs"), "utf8")).toBe(helperBody);
		expect(readdirSync(f.root).filter(unfinished)).toEqual([]);
	});

	it.each([
		["a file", "package/lib/zz.mjs"],
		["a folder", "package/lib/sub/zz.mjs"],
	])(
		"never creates %s through a staged folder swapped for a link while writing",
		async (_kind, member) => {
			const f = fixture();
			const item = bundle("channel-gmail", { extras: [{ name: member, body: "DYTEST" }] });
			const installer = await f.open([item]);
			const outside = path.join(f.dir, "outside");
			mkdirSync(outside);
			let swapped = false;
			const pending = installer.install(item.id, item.lock.version, item.archive);
			await eachTurn(pending, () => {
				const top = stagingFolder(f);
				if (swapped || top === undefined) return;
				const lib = path.join(top, "lib");
				if (!existsSync(path.join(lib, "helper.mjs"))) return;
				expect(readdirSync(lib)).toEqual(["helper.mjs"]);
				renameSync(lib, path.join(f.dir, "moved"));
				symlinkSync(outside, lib, process.platform === "win32" ? "junction" : "dir");
				swapped = true;
			});
			await expect(pending).rejects.toEqual(refusal);
			expect(swapped).toBe(true);
			expect(readdirSync(outside)).toEqual([]);
		},
	);

	it("never creates a file through a staging folder moved out and linked back while writing", async () => {
		const f = fixture();
		const item = bundle("channel-gmail", {
			extras: [{ name: "package/lib/zz.mjs", body: "DYTEST" }],
		});
		const installer = await f.open([item]);
		const moved = path.join(f.dir, "moved");
		let swapped = false;
		const pending = installer.install(item.id, item.lock.version, item.archive);
		await eachTurn(pending, () => {
			const top = stagingFolder(f);
			if (swapped || top === undefined || !existsSync(path.join(top, "empty"))) return;
			expect(readdirSync(path.join(top, "lib"))).toEqual(["helper.mjs"]);
			renameSync(top, moved);
			symlinkSync(moved, top, process.platform === "win32" ? "junction" : "dir");
			swapped = true;
		});
		await expect(pending).rejects.toEqual(refusal);
		expect(swapped).toBe(true);
		expect(readdirSync(path.join(moved, "lib"))).toEqual(["helper.mjs"]);
	});

	it("refuses a staged directory made writable after verification", {
		tags: ["requires:posix"],
	}, async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		afterVerification((installed) => {
			chmodSync(path.join(installed.directory, "lib"), 0o700);
		});
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(readdirSync(f.root)).toEqual([]);
	});

	it.each([
		["folder", (name: string) => mkdirSync(name)],
		["file", (name: string) => writeFileSync(name, "DYTEST")],
	])("never adopts or replaces an existing final-name %s", async (_kind, create) => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const destination = path.join(f.root, finalName(item));
		create(destination);
		const birth = lstatSync(destination, { bigint: true }).ino;
		const verify = vi.spyOn(artifacts, "verifyBundle");
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(verify).not.toHaveBeenCalled();
		expect(readdirSync(f.root)).toEqual([finalName(item)]);
		expect(lstatSync(destination, { bigint: true }).ino).toBe(birth);
	});

	it.each([
		["folder", (name: string) => mkdirSync(name)],
		["file", (name: string) => writeFileSync(name, "DYTEST")],
	])("refuses a final-name %s that appears during the install", async (kind, create) => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const destination = path.join(f.root, finalName(item));
		afterVerification(() => create(destination));
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(readdirSync(f.root)).toEqual([finalName(item)]);
		expect(lstatSync(destination).isFile()).toBe(kind === "file");
		if (kind === "folder") expect(readdirSync(destination)).toEqual([]);
	});

	it("retries a final rename that a briefly open member blocks", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		let released: Promise<void> = Promise.resolve();
		afterVerification((installed) => {
			const fd = openSync(path.join(installed.directory, "index.mjs"), "r");
			released = new Promise<void>((resolve) =>
				setTimeout(() => {
					closeSync(fd);
					resolve();
				}, 50),
			);
		});
		try {
			const installed = await installer.install(item.id, item.lock.version, item.archive);
			expect(readdirSync(f.root)).toEqual([finalName(item)]);
			vi.restoreAllMocks();
			await expect(artifacts.verifyBundle(installed.bundle)).resolves.toBe(
				path.join(installed.bundle.directory, "index.mjs"),
			);
		} finally {
			await released;
		}
	});

	it("refuses a member rewritten while a blocked final rename waits to retry", {
		tags: ["requires:windows"],
	}, async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		let rewritten: Promise<boolean> = Promise.resolve(false);
		afterVerification((installed) => {
			const fd = openSync(path.join(installed.directory, "index.mjs"), "r");
			const member = path.join(installed.directory, "lib", "helper.mjs");
			rewritten = new Promise<boolean>((resolve) =>
				setTimeout(() => {
					closeSync(fd);
					const staged = existsSync(member);
					if (staged) {
						chmodSync(member, 0o600);
						writeFileSync(member, helperBody.toUpperCase());
						chmodSync(member, 0o400);
					}
					resolve(staged);
				}, 15),
			);
		});
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(await rewritten).toBe(true);
		expect(readdirSync(f.root)).toEqual([]);
	});

	it("installs one of two concurrent installs of a pin and cleans up the other", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const verify = artifacts.verifyBundle;
		const both = gate();
		let arrived = 0;
		vi.spyOn(artifacts, "verifyBundle").mockImplementation(async (installed) => {
			const entry = await verify(installed);
			if (++arrived === 2) both.release();
			await both.open;
			return entry;
		});
		const results = await Promise.allSettled([
			installer.install(item.id, item.lock.version, item.archive),
			installer.install(item.id, item.lock.version, item.archive),
		]);
		const installed = results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		);
		const refused = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		expect(installed).toHaveLength(1);
		expect(refused).toEqual([refusal]);
		expect(readdirSync(f.root)).toEqual([finalName(item)]);
		expect(readFileSync(path.join(f.root, finalName(item), "index.mjs"), "utf8")).toBe(entryBody);
	});

	it("trusts a POSIX root only when its owner alone can write it", () => {
		const stat = (uid: number, mode: number): { uid: bigint; mode: bigint } => ({
			uid: BigInt(uid),
			mode: BigInt(0o040000 | mode),
		});
		const cases: [number, number, boolean, boolean][] = [
			[1000, 0o700, true, true],
			[1000, 0o755, true, true],
			[1000, 0o770, true, false],
			[1000, 0o702, true, false],
			[1000, 0o1777, true, false],
			[0, 0o700, true, false],
			[1001, 0o700, true, false],
			[0, 0o755, false, true],
			[1000, 0o755, false, true],
			[0, 0o1777, false, true],
			[1000, 0o1775, false, true],
			[0, 0o777, false, false],
			[1000, 0o775, false, false],
			[1001, 0o755, false, false],
			[1001, 0o1777, false, false],
		];
		for (const [uid, mode, root, expected] of cases)
			expect(trusted(stat(uid, mode), 1000, root), `${uid} ${mode.toString(8)} ${root}`).toBe(
				expected,
			);
		expect(trusted(stat(0, 0o700), 0, true)).toBe(true);
	});

	it("treats a recorded entry as unchanged only with the same identity, links, mode, size and times", () => {
		const last = {
			dev: 1n,
			ino: 2n,
			nlink: 1n,
			mode: 0o100400n,
			size: 10n,
			mtimeNs: 20n,
			ctimeNs: 30n,
		};
		expect(unchanged(last, { ...last })).toBe(true);
		const changes: [keyof typeof last, bigint][] = [
			["dev", 9n],
			["ino", 9n],
			["nlink", 2n],
			["mode", 0o100600n],
			["size", 11n],
			["mtimeNs", 21n],
			["ctimeNs", 31n],
		];
		for (const [field, value] of changes)
			expect(unchanged(last, { ...last, [field]: value }), field).toBe(false);
		expect(unchanged({ ...last, ino: 0n }, { ...last, ino: 0n })).toBe(false);
	});

	it("refuses a POSIX root or ancestor another account could write", {
		tags: ["requires:posix"],
	}, async () => {
		const f = fixture();
		const item = bundle();
		chmodSync(f.root, 0o770);
		await expect(f.open([item])).rejects.toEqual(refusal);
		chmodSync(f.root, 0o700);
		chmodSync(f.dir, 0o777);
		await expect(f.open([item])).rejects.toEqual(refusal);
		chmodSync(f.dir, 0o1777);
		const installer = await f.open([item]);
		chmodSync(f.dir, 0o700);
		chmodSync(f.root, 0o702);
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		chmodSync(f.root, 0o700);
		expect(readdirSync(f.root)).toEqual([]);
	});
});

describe("closing", () => {
	it("refuses an install after close() without reading the archive", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		await installer.close();
		const prepare = vi.spyOn(artifacts, "preparePinnedPackage");
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(prepare).not.toHaveBeenCalled();
		expect(readdirSync(f.root)).toEqual([]);
	});

	it("stops an install that is still writing files when close() is called", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const verify = vi.spyOn(artifacts, "verifyBundle");
		const pending = installer.install(item.id, item.lock.version, item.archive);
		await installer.close();
		await expect(pending).rejects.toEqual(refusal);
		expect(verify).not.toHaveBeenCalled();
		expect(readdirSync(f.root)).toEqual([]);
	});

	it("waits for an in-flight install, which then refuses and removes its staged tree", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const verify = artifacts.verifyBundle;
		const held = gate();
		const reached = gate();
		vi.spyOn(artifacts, "verifyBundle").mockImplementation(async (installed) => {
			reached.release();
			await held.open;
			return verify(installed);
		});
		const pending = installer.install(item.id, item.lock.version, item.archive);
		await reached.open;
		let closed = false;
		const closing = installer.close().then(() => {
			closed = true;
		});
		for (let round = 0; round < 5; round++) await new Promise((resolve) => setImmediate(resolve));
		expect(closed).toBe(false);
		held.release();
		await expect(pending).rejects.toEqual(refusal);
		await closing;
		expect(closed).toBe(true);
		expect(readdirSync(f.root)).toEqual([]);
	});

	it("keeps a closing installer's in-flight cleanup away from a newer installer's tree", async () => {
		const f = fixture();
		const item = bundle();
		const stale = await f.open([item]);
		const verify = artifacts.verifyBundle;
		const held = gate();
		const reached = gate();
		let calls = 0;
		vi.spyOn(artifacts, "verifyBundle").mockImplementation(async (installed) => {
			const entry = await verify(installed);
			if (calls++ === 0) {
				reached.release();
				await held.open;
			}
			return entry;
		});
		const pending = stale.install(item.id, item.lock.version, item.archive);
		await reached.open;
		const closing = stale.close();
		const current = await f.open([item]);
		const installed = await current.install(item.id, item.lock.version, item.archive);
		held.release();
		await expect(pending).rejects.toEqual(refusal);
		await closing;
		expect(readdirSync(f.root)).toEqual([finalName(item)]);
		await expect(verify(installed.bundle)).resolves.toBe(
			path.join(installed.bundle.directory, "index.mjs"),
		);
		await expect(current.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
	});

	it("installs on retry after a transient failure", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		vi.spyOn(artifacts, "verifyBundle").mockRejectedValueOnce(new Error("DYTEST transient"));
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(readdirSync(f.root)).toEqual([]);
		const installed = await installer.install(item.id, item.lock.version, item.archive);
		expect(readdirSync(f.root)).toEqual([finalName(item)]);
		expect(installed.bundle.directory).toBe(path.join(f.root, finalName(item)));
	});
});
