import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as artifacts from "../../src/artifacts/index.ts";
import {
	BUNDLED_PLUGIN_IDS,
	openPluginInstaller,
	PluginInstallError,
} from "../../src/plugins/installer/index.ts";
import {
	bundle,
	EXECUTED,
	finalName,
	fixture,
	manifest,
	removeFixtures,
} from "./installer-fixtures.ts";

const refusal = new PluginInstallError();
const globals = globalThis as Record<symbol, unknown>;

afterEach(async () => {
	vi.restoreAllMocks();
	await removeFixtures();
	delete globals[EXECUTED];
});

/** Native state excluding access times, which reads may change. */
function snapshot(root: string): unknown[] {
	const rows: unknown[] = [];
	const visit = (name: string): void => {
		const stat = lstatSync(name, { bigint: true });
		rows.push([
			path.relative(root, name),
			stat.dev,
			stat.ino,
			stat.mode,
			stat.nlink,
			stat.size,
			stat.mtimeNs,
			stat.ctimeNs,
			stat.isFile() ? readFileSync(name) : null,
		]);
		if (stat.isDirectory() && !stat.isSymbolicLink())
			for (const child of readdirSync(name).sort()) visit(path.join(name, child));
	};
	visit(root);
	return rows;
}

describe("read-only pinned plugin inspection", () => {
	it("reopens all five exact native pins after the installing factory closed, without writes or execution", async () => {
		const f = fixture();
		const packages = BUNDLED_PLUGIN_IDS.map((id) => bundle(id));
		const first = await f.open(packages);
		const installed = [];
		for (const item of packages)
			installed.push(await first.install(item.id, item.lock.version, item.archive));
		await first.close();
		const next = await f.open(packages);
		const before = snapshot(f.root);
		for (const [index, item] of packages.entries()) {
			const facts = await next.inspect(item.id, item.lock.version, item.archive);
			expect(facts).toEqual(installed[index]);
			expect(Object.keys(facts).sort()).toEqual(["bundle", "digests", "manifest"]);
			expect(Object.isFrozen(facts)).toBe(true);
			expect(Object.isFrozen(facts.bundle.inventory.files)).toBe(true);
			expect(Object.isFrozen(facts.manifest)).toBe(true);
			expect(Object.isFrozen(facts.digests)).toBe(true);
			await expect(next.install(item.id, item.lock.version, item.archive)).rejects.toEqual(refusal);
		}
		expect(snapshot(f.root)).toEqual(before);
		expect(globals[EXECUTED]).toBeUndefined();
	});

	it("refuses an absent target without creating a staging folder", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const before = snapshot(f.root);
		await expect(installer.inspect(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(snapshot(f.root)).toEqual(before);
	});

	it("uses only its captured native catalog and original archive, never a caller's record", async () => {
		const f = fixture();
		const item = bundle();
		const other = bundle(item.id, { extras: [{ name: "package/other.mjs", body: "export {};" }] });
		const options = f.options([item]);
		const installer = await openPluginInstaller(options);
		f.installers.push(installer);
		const installed = await installer.install(item.id, item.lock.version, item.archive);
		const repacked = Buffer.from(item.archive);
		repacked[9] = (repacked[9] ?? 0) ^ 1;
		const repackedLock = {
			...item.lock,
			integrity: `sha512-${createHash("sha512").update(repacked).digest("base64")}`,
		};
		expect(artifacts.preparePinnedPackage(repacked, repackedLock).inventory.files).toEqual(
			installed.bundle.inventory.files,
		);
		options.bundles[0] = { id: other.id, package: other.lock };
		const before = snapshot(f.root);
		for (const [id, version, archive] of [
			["channel-hello", item.lock.version, item.archive],
			[item.id, "2.0.0", item.archive],
			[item.id, item.lock.version, other.archive],
			[item.id, item.lock.version, repacked],
			[item.id, item.lock.version, installed],
			[installed, item.lock.version, item.archive],
		] as const)
			await expect(installer.inspect(id as never, version, archive as never)).rejects.toEqual(
				refusal,
			);
		expect(await installer.inspect(item.id, item.lock.version, item.archive)).toEqual(installed);
		const different = await f.open([other]);
		await expect(different.inspect(other.id, other.lock.version, other.archive)).rejects.toEqual(
			refusal,
		);
		expect(snapshot(f.root)).toEqual(before);
	});

	it("reapplies declaration policy even when every existing byte matches a native archive pin", async () => {
		const f = fixture();
		const declared = { ...manifest(), egress: { profile: "slack-v1" } };
		const item = bundle("channel-gmail", { manifest: declared });
		const prepared = artifacts.preparePinnedPackage(item.archive, item.lock);
		const target = path.join(f.root, finalName(item));
		const directories = new Set([target]);
		mkdirSync(target, { mode: 0o700 });
		for (const [relative, bytes] of prepared.files) {
			const filename = path.join(target, relative);
			mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
			for (
				let parent = path.dirname(filename);
				parent.startsWith(target);
				parent = path.dirname(parent)
			)
				directories.add(parent);
			writeFileSync(filename, bytes, { mode: 0o400 });
		}
		if (process.platform !== "win32")
			for (const directory of [...directories].reverse()) chmodSync(directory, 0o500);
		// Byte verification is a positive control: it does not admit this declaration.
		await expect(
			artifacts.verifyBundle({ directory: target, inventory: prepared.inventory }),
		).resolves.toBe(path.join(target, item.lock.entry));
		const installer = await f.open([item]);
		const before = snapshot(f.root);
		await expect(installer.inspect(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(snapshot(f.root)).toEqual(before);
	});

	for (const alteration of ["rewritten", "extra", "missing", "writable", "hard-linked"] as const)
		it(`refuses a ${alteration} file and leaves that tree untouched`, async () => {
			const f = fixture();
			const item = bundle();
			const installer = await f.open([item]);
			const installed = await installer.install(item.id, item.lock.version, item.archive);
			const target = installed.bundle.directory;
			const file = path.join(target, "index.mjs");
			if (alteration === "rewritten") {
				const content = readFileSync(file);
				const index = content.length - 2;
				content[index] = (content[index] ?? 0) ^ 1;
				chmodSync(file, 0o600);
				writeFileSync(file, content);
				chmodSync(file, 0o400);
			} else if (alteration === "extra") {
				chmodSync(target, 0o700);
				const extra = path.join(target, "extra.mjs");
				writeFileSync(extra, "export {};", { mode: 0o400 });
				if (process.platform !== "win32") chmodSync(target, 0o500);
			} else if (alteration === "missing") {
				chmodSync(target, 0o700);
				chmodSync(file, 0o600);
				unlinkSync(file);
				if (process.platform !== "win32") chmodSync(target, 0o500);
			} else if (alteration === "writable") chmodSync(file, 0o600);
			else linkSync(file, path.join(f.dir, "outside-link.mjs"));
			const before = snapshot(f.root);
			await expect(installer.inspect(item.id, item.lock.version, item.archive)).rejects.toEqual(
				refusal,
			);
			expect(snapshot(f.root)).toEqual(before);
		});

	it("refuses an existing target replaced by a directory link", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const installed = await installer.install(item.id, item.lock.version, item.archive);
		const sealedMode = lstatSync(installed.bundle.directory).mode;
		// A sibling rename keeps the sealed directory's parent unchanged on POSIX.
		const moved = path.join(f.root, "moved-tree");
		renameSync(installed.bundle.directory, moved);
		expect(lstatSync(moved).mode).toBe(sealedMode);
		symlinkSync(
			moved,
			installed.bundle.directory,
			process.platform === "win32" ? "junction" : "dir",
		);
		const before = snapshot(f.root);
		await expect(installer.inspect(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(lstatSync(installed.bundle.directory).isSymbolicLink()).toBe(true);
		expect(existsSync(path.join(moved, "index.mjs"))).toBe(true);
		expect(snapshot(f.root)).toEqual(before);
	});

	it("refuses an unsealed POSIX directory without changing it", {
		tags: ["requires:posix"],
	}, async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const installed = await installer.install(item.id, item.lock.version, item.archive);
		chmodSync(path.join(installed.bundle.directory, "lib"), 0o700);
		const before = snapshot(f.root);
		await expect(installer.inspect(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(snapshot(f.root)).toEqual(before);
	});

	it("refuses a replacement private root even when a new factory installs the same valid pin there", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		await installer.install(item.id, item.lock.version, item.archive);
		renameSync(f.root, path.join(f.dir, "previous-root"));
		mkdirSync(f.root, { mode: 0o700 });
		const next = await f.open([item]);
		await next.install(item.id, item.lock.version, item.archive);
		const before = snapshot(f.root);
		await expect(installer.inspect(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		await expect(next.inspect(item.id, item.lock.version, item.archive)).resolves.toMatchObject({
			bundle: { directory: path.join(f.root, finalName(item)) },
		});
		expect(snapshot(f.root)).toEqual(before);
	});

	it("refuses a file changed after its hash check", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		const installed = await installer.install(item.id, item.lock.version, item.archive);
		const verify = artifacts.verifyBundle;
		vi.spyOn(artifacts, "verifyBundle").mockImplementation(async (input) => {
			const result = await verify(input);
			const file = path.join(installed.bundle.directory, "index.mjs");
			chmodSync(file, 0o600);
			writeFileSync(file, "export const changed = true;\n");
			chmodSync(file, 0o400);
			return result;
		});
		await expect(installer.inspect(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(readFileSync(path.join(installed.bundle.directory, "index.mjs"), "utf8")).toContain(
			"changed",
		);
	});

	it("close waits for inspection and refuses its result and all later operations", async () => {
		const f = fixture();
		const item = bundle();
		const installer = await f.open([item]);
		await installer.install(item.id, item.lock.version, item.archive);
		const before = snapshot(f.root);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const verify = artifacts.verifyBundle;
		vi.spyOn(artifacts, "verifyBundle").mockImplementation(async (input) => {
			entered.resolve();
			await release.promise;
			return verify(input);
		});
		const pending = installer.inspect(item.id, item.lock.version, item.archive);
		const refused = expect(pending).rejects.toEqual(refusal);
		await entered.promise;
		let closed = false;
		const closing = installer.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		release.resolve();
		await refused;
		await closing;
		expect(closed).toBe(true);
		await expect(installer.inspect(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			refusal,
		);
		expect(snapshot(f.root)).toEqual(before);
	});
});
