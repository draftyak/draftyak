import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { egressDigest, manifestDigest, sendTemplateDigest } from "@draftyak/protocol/digests";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, expect, it } from "vitest";
import { AuditChain } from "../../../src/audit/chain.ts";
import { advanceEpochForRestore } from "../../../src/identity/devices.ts";
import type { WorkScope } from "../../../src/jobs/database.ts";
import { newId } from "../../../src/kernel/ids.ts";
import { openPluginRegistry, PluginRegistryError } from "../../../src/plugins/registry/index.ts";
import { openEncrypted } from "../../../src/store/open.ts";
import { nativeBinding } from "../../store/helpers.ts";
import { bundle, fixture, removeFixtures } from "./helpers.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup(bootstrapped = true, bundles = [bundle()]) {
	const f = await fixture(bootstrapped, bundles);
	fixtures.push(f);
	return f;
}
afterEach(async () => {
	for (const f of fixtures.splice(0)) await f.close();
	await removeFixtures();
});
const failure = (code: string) => expect.objectContaining({ name: "PluginRegistryError", code });
function counts(f: Awaited<ReturnType<typeof fixture>>) {
	return f.native.store.read((sql) => ({
		versions: sql.get<{ n: number }>("SELECT count(*) AS n FROM plugin_versions")?.n,
		states: sql.get<{ n: number }>("SELECT count(*) AS n FROM plugin_generations")?.n,
		audit: sql.get<{ n: number }>("SELECT count(*) AS n FROM audit_events")?.n,
		events: sql.get<{ n: number }>("SELECT count(*) AS n FROM events")?.n,
	}));
}

it("records only real pinned installer output, with inert state and exact digests, across reopen", async () => {
	const f = await setup(),
		registry = await f.open(),
		item = f.bundles[0];
	if (!item) throw new Error("DYTEST missing package");
	const record = await registry.stageBundled(item.id, item.lock.version, item.archive, 0);
	expect(record).toMatchObject({
		pluginId: item.id,
		version: item.lock.version,
		generation: 1,
		state: "staged",
		ownerUserId: f.native.ownerUserId,
	});
	expect(record.installed.bundle.inventory).toMatchObject(item.lock);
	expect(record.installed.digests).toEqual({
		manifest: manifestDigest(item.manifest),
		egress: egressDigest(item.manifest.egress),
		send: sendTemplateDigest(item.manifest.send),
	});
	expect(Object.isFrozen(record.installed.manifest)).toBe(true);
	expect(Object.keys(record)).not.toContain("reviewed");
	expect(existsSync(record.installed.bundle.directory)).toBe(true);
	expect((await f.reopen()).get(item.id)).toEqual(record);
	expect(counts(f).versions).toBe(1);
	f.native.store.read((sql) => f.native.audit.verify(sql));
	const events = f.database.write((scope) =>
		f.events.page(scope, { userId: record.ownerUserId, afterSeq: 0 }),
	);
	expect(events.events.at(-1)).toMatchObject({
		kind: "plugins.changed",
		dataClass: "hub.state",
		accountId: null,
		ids: [record.id],
	});
});

it("refuses unbootstrapped or cross-store owner state before filesystem staging", async () => {
	const f = await setup(false);
	await expect(f.open()).rejects.toMatchObject(failure("unavailable"));
	expect(readdirSync(f.files.root)).toEqual([]);
	const good = await setup(),
		other = await setup();
	await expect(
		openPluginRegistry({
			store: good.native.store,
			database: good.database,
			devices: other.native.registry,
			audit: good.native.audit,
			events: good.events,
			installer: good.files.options(good.bundles),
		}),
	).rejects.toMatchObject(failure("unavailable"));
	expect(readdirSync(good.files.root)).toEqual([]);
});

it("keeps admin install and upgrade unavailable without any writes", async () => {
	const f = await setup(),
		registry = await f.open(),
		before = counts(f);
	expect(() => registry.install()).toThrow(PluginRegistryError);
	expect(() => registry.upgrade()).toThrow(PluginRegistryError);
	expect(counts(f)).toEqual(before);
	expect(readdirSync(f.files.root)).toEqual([]);
});

it("uses monotone CAS generations for bounded version records and tightenings", async () => {
	const first = bundle(),
		second = bundle("channel-gmail", { version: "1.0.1" });
	const f = await setup(true, [first, second]),
		registry = await f.open();
	const staged = await registry.stageBundled(first.id, first.lock.version, first.archive, 0);
	const disabled = f.database.write((scope) =>
		registry.disable(scope, first.id, staged.generation),
	);
	expect(disabled.generation).toBe(2);
	const before = counts(f);
	await expect(
		registry.stageBundled(second.id, second.lock.version, second.archive, 1),
	).rejects.toMatchObject(failure("conflict"));
	expect(counts(f)).toEqual(before);
	expect(readdirSync(f.files.root)).toHaveLength(1);
	const next = await registry.stageBundled(second.id, second.lock.version, second.archive, 2);
	expect(next).toMatchObject({ id: staged.id, generation: 3, version: "1.0.1", state: "staged" });
	expect(next.versionId).not.toBe(staged.versionId);
	const quarantined = f.database.write((scope) => registry.quarantine(scope, first.id, 3));
	expect(quarantined).toMatchObject({ generation: 4, state: "quarantined" });
	expect(() => f.database.write((scope) => registry.disable(scope, first.id, 4))).toThrow(
		PluginRegistryError,
	);
	expect(counts(f).versions).toBe(2);
});

it("poisons caught failures so version/state, audit and invalidation roll back together", async () => {
	const f = await setup(),
		registry = await f.open(),
		item = f.bundles[0];
	if (!item) throw new Error("DYTEST missing package");
	await registry.stageBundled(item.id, item.lock.version, item.archive, 0);
	const before = counts(f);
	f.clock.failed = true;
	expect(() =>
		f.database.write((scope) => {
			try {
				registry.disable(scope, item.id, 1);
			} catch {
				/* Outer consumers may catch the refusal. */
			}
		}),
	).toThrow();
	expect(counts(f)).toEqual(before);
	expect(registry.get(item.id)).toMatchObject({ generation: 1, state: "staged" });
});

it("reinspects its genuine installed tree and original archive for a live-process retry after rollback", async () => {
	const f = await setup(),
		registry = await f.open(),
		item = f.bundles[0];
	if (!item) throw new Error("DYTEST missing package");
	const before = counts(f);
	f.clock.failed = true;
	await expect(registry.stageBundled(item.id, item.lock.version, item.archive, 0)).rejects.toThrow(
		PluginRegistryError,
	);
	expect(counts(f)).toEqual(before);
	expect(readdirSync(f.files.root)).toHaveLength(1);
	f.clock.failed = false;
	await expect(
		registry.stageBundled(item.id, item.lock.version, new Uint8Array([1]), 0),
	).rejects.toThrow(PluginRegistryError);
	expect(await registry.stageBundled(item.id, item.lock.version, item.archive, 0)).toMatchObject({
		generation: 1,
	});
	expect(counts(f).versions).toBe(1);
});

it("recovers a late failed install after close/reopen only through native pin/archive reinspection", async () => {
	const f = await setup(),
		registry = await f.open(),
		item = f.bundles[0];
	if (!item) throw new Error("DYTEST missing package");
	const before = counts(f);
	f.clock.failed = true;
	await expect(
		registry.stageBundled(item.id, item.lock.version, item.archive, 0),
	).rejects.toThrow();
	const targets = readdirSync(f.files.root);
	const reopened = await f.reopen();
	const record = await reopened.stageBundled(item.id, item.lock.version, item.archive, 0);
	expect(record).toMatchObject({ generation: 1, state: "staged" });
	expect(record.installed.bundle.inventory).toMatchObject(item.lock);
	expect(counts(f)).toEqual({
		versions: 1,
		states: 1,
		audit: (before.audit ?? 0) + 1,
		events: (before.events ?? 0) + 1,
	});
	expect(readdirSync(f.files.root)).toEqual(targets);
});

it.each(["changed bytes", "extra file", "wrong archive"] as const)(
	"refuses restart recovery with %s without changing the existing tree or database",
	async (mode) => {
		const f = await setup(),
			registry = await f.open(),
			item = f.bundles[0];
		if (!item) throw new Error("DYTEST missing package");
		f.clock.failed = true;
		await expect(
			registry.stageBundled(item.id, item.lock.version, item.archive, 0),
		).rejects.toThrow(PluginRegistryError);
		const targets = readdirSync(f.files.root),
			directory = path.join(f.files.root, targets[0] as string),
			entry = path.join(directory, item.lock.entry);
		if (mode === "changed bytes") {
			chmodSync(entry, 0o600);
			writeFileSync(entry, "DYTEST changed bytes");
			chmodSync(entry, 0o400);
		}
		if (mode === "extra file") {
			chmodSync(directory, 0o700);
			writeFileSync(path.join(directory, "unlisted.txt"), "DYTEST unlisted");
			if (process.platform !== "win32") chmodSync(directory, 0o500);
		}
		const bytes = readFileSync(entry),
			identity = lstatSync(directory, { bigint: true });
		const reopened = await f.reopen(),
			before = counts(f),
			archive =
				mode === "wrong archive"
					? bundle(item.id, {
							extras: [{ name: "package/changed.txt", body: "DYTEST different pin" }],
						}).archive
					: item.archive;
		await expect(reopened.stageBundled(item.id, item.lock.version, archive, 0)).rejects.toThrow(
			PluginRegistryError,
		);
		expect(counts(f)).toEqual(before);
		expect(readdirSync(f.files.root)).toEqual(targets);
		expect(lstatSync(directory, { bigint: true }).ino).toBe(identity.ino);
		expect(readFileSync(entry)).toEqual(bytes);
		if (mode === "extra file")
			expect(readFileSync(path.join(directory, "unlisted.txt"), "utf8")).toBe("DYTEST unlisted");
	},
);

it("refuses foreign, expired and forged scopes without granting native write authority", async () => {
	const f = await setup(),
		other = await setup(),
		registry = await f.open();
	const before = counts(f);
	let expired: WorkScope | undefined;
	f.database.write((scope) => {
		expired = scope;
	});
	expect(() => registry.getInTransaction(expired as WorkScope, "channel-gmail")).toThrow();
	expect(() => registry.getInTransaction({ sql: {} } as WorkScope, "channel-gmail")).toThrow();
	expect(() =>
		other.database.write((scope) => registry.disable(scope, "channel-gmail", 1)),
	).toThrow();
	expect(counts(f)).toEqual(before);
});

it("rechecks native owner/epoch between inspection refusal and filesystem installation", async () => {
	const f = await setup(),
		registry = await f.open(),
		item = f.bundles[0];
	if (!item) throw new Error("DYTEST missing package");
	const pending = registry.stageBundled(item.id, item.lock.version, item.archive, 0);
	const rejected = expect(pending).rejects.toMatchObject(failure("unavailable"));
	f.native.store.write((sql) => advanceEpochForRestore(f.native.registry, sql));
	const before = counts(f);
	await rejected;
	expect(counts(f)).toEqual(before);
	expect(readdirSync(f.files.root)).toEqual([]);
});

it("rechecks native owner/epoch after the asynchronous install and commits no stale record", async () => {
	const f = await setup(),
		registry = await f.open(),
		item = f.bundles[0];
	if (!item) throw new Error("DYTEST missing package");
	const pending = registry.stageBundled(item.id, item.lock.version, item.archive, 0);
	const rejected = expect(pending).rejects.toMatchObject(failure("unavailable"));
	await turn();
	expect(readdirSync(f.files.root)).toHaveLength(1);
	f.native.store.write((sql) => advanceEpochForRestore(f.native.registry, sql));
	const before = counts(f);
	await rejected;
	expect(counts(f)).toEqual(before);
	expect(readdirSync(f.files.root)).toHaveLength(1);
});

it("rechecks the generation before falling back from inspection to filesystem installation", async () => {
	const first = bundle(),
		second = bundle("channel-gmail", { version: "1.0.1" }),
		f = await setup(true, [first, second]),
		registry = await f.open();
	await registry.stageBundled(first.id, first.lock.version, first.archive, 0);
	const pending = registry.stageBundled(second.id, second.lock.version, second.archive, 1),
		rejected = expect(pending).rejects.toMatchObject(failure("conflict"));
	f.database.write((scope) => registry.disable(scope, first.id, 1));
	const before = counts(f);
	await rejected;
	expect(counts(f)).toEqual(before);
	expect(readdirSync(f.files.root)).toHaveLength(1);
	expect(registry.get(first.id)).toMatchObject({ generation: 2, state: "disabled" });
});

it("keeps the first installer reservation when concurrent rejected calls finish", async () => {
	const f = await setup(),
		registry = await f.open(),
		item = f.bundles[0];
	if (!item) throw new Error("DYTEST missing package");
	const first = registry.stageBundled(item.id, item.lock.version, item.archive, 0);
	await expect(
		registry.stageBundled(item.id, item.lock.version, item.archive, 0),
	).rejects.toMatchObject(failure("conflict"));
	await expect(
		registry.stageBundled(item.id, item.lock.version, item.archive, 0),
	).rejects.toMatchObject(failure("conflict"));
	expect(await first).toMatchObject({ generation: 1 });
	expect(counts(f).versions).toBe(1);
});

it("allows only one concurrent CAS winner and retries the other genuine staged version", async () => {
	const a = bundle(),
		b = bundle("channel-gmail", { version: "1.0.1" });
	const f = await setup(true, [a, b]),
		left = await f.open(),
		right = await f.open();
	const outcomes = await Promise.allSettled([
		left.stageBundled(a.id, a.lock.version, a.archive, 0),
		right.stageBundled(b.id, b.lock.version, b.archive, 0),
	]);
	expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
	expect(counts(f).versions).toBe(1);
	const firstWon = outcomes[0]?.status === "fulfilled",
		retry = firstWon ? right : left,
		item = firstWon ? b : a;
	expect(await retry.stageBundled(item.id, item.lock.version, item.archive, 1)).toMatchObject({
		generation: 2,
	});
	expect(counts(f).versions).toBe(2);
});

it("poisons its own scope when a caught audit failure precedes invalidation", async () => {
	const f = await setup(),
		registry = await f.open(),
		item = f.bundles[0];
	if (!item) throw new Error("DYTEST missing package");
	await registry.stageBundled(item.id, item.lock.version, item.archive, 0);
	const key = f.native.key.derive("audit"),
		lockedAudit = new AuditChain(key);
	key.fill(0);
	lockedAudit.destroy();
	const refused = await openPluginRegistry({
		store: f.native.store,
		database: f.database,
		devices: f.native.registry,
		audit: lockedAudit,
		events: f.events,
		installer: f.files.options(f.bundles),
	});
	const before = counts(f);
	try {
		expect(() =>
			f.database.write((scope) => {
				try {
					refused.disable(scope, item.id, 1);
				} catch {
					/* Consumer catches the audit failure. */
				}
			}),
		).toThrow();
		expect(counts(f)).toEqual(before);
		expect(registry.get(item.id)).toMatchObject({ generation: 1, state: "staged" });
	} finally {
		await refused.close();
	}
});

it("reinspects its genuine installed tree and refuses a changed file on retry", async () => {
	const f = await setup(),
		registry = await f.open(),
		item = f.bundles[0];
	if (!item) throw new Error("DYTEST missing package");
	const before = counts(f);
	f.clock.failed = true;
	await expect(
		registry.stageBundled(item.id, item.lock.version, item.archive, 0),
	).rejects.toThrow();
	const target = path.join(f.files.root, readdirSync(f.files.root)[0] as string, item.lock.entry);
	chmodSync(target, 0o600);
	writeFileSync(target, "DYTEST changed file");
	f.clock.failed = false;
	await expect(registry.stageBundled(item.id, item.lock.version, item.archive, 0)).rejects.toThrow(
		PluginRegistryError,
	);
	expect(counts(f)).toEqual(before);
});

it.each(["writable file", "replacement root"] as const)(
	"refuses a live-process retry after a %s even with the same package bytes",
	async (mode) => {
		const f = await setup(),
			registry = await f.open(),
			item = f.bundles[0];
		if (!item) throw new Error("DYTEST missing package");
		f.clock.failed = true;
		await expect(
			registry.stageBundled(item.id, item.lock.version, item.archive, 0),
		).rejects.toThrow(PluginRegistryError);
		const before = counts(f);
		if (mode === "writable file") {
			chmodSync(
				path.join(f.files.root, readdirSync(f.files.root)[0] as string, item.lock.entry),
				0o600,
			);
		} else {
			const saved = path.join(f.files.dir, "original-root");
			expect(path.dirname(realpathSync(f.files.root))).toBe(realpathSync(f.files.dir));
			expect(path.dirname(saved)).toBe(realpathSync(f.files.dir));
			renameSync(f.files.root, saved);
			mkdirSync(f.files.root, { mode: 0o700 });
			const fresh = await f.files.open(f.bundles);
			await fresh.install(item.id, item.lock.version, item.archive);
		}
		f.clock.failed = false;
		await expect(
			registry.stageBundled(item.id, item.lock.version, item.archive, 0),
		).rejects.toThrow(PluginRegistryError);
		expect(counts(f)).toEqual(before);
	},
);

it("refuses a locked owner and a foreign work database before filesystem side effects", async () => {
	const f = await setup(),
		registry = await f.open(),
		item = f.bundles[0],
		other = await setup();
	if (!item) throw new Error("DYTEST missing package");
	f.native.registry.lock();
	await expect(registry.stageBundled(item.id, item.lock.version, item.archive, 0)).rejects.toThrow(
		PluginRegistryError,
	);
	expect(readdirSync(f.files.root)).toEqual([]);
	const misplaced = await openPluginRegistry({
		store: other.native.store,
		database: f.database,
		devices: other.native.registry,
		audit: other.native.audit,
		events: other.events,
		installer: other.files.options(other.bundles),
	});
	try {
		await expect(
			misplaced.stageBundled(item.id, item.lock.version, item.archive, 0),
		).rejects.toThrow(PluginRegistryError);
	} finally {
		await misplaced.close();
	}
	expect(readdirSync(other.files.root)).toEqual([]);
});

it("refuses corrupt bounded rows and current owner/epoch changes", async () => {
	const f = await setup(),
		registry = await f.open(),
		item = f.bundles[0];
	if (!item) throw new Error("DYTEST missing package");
	await registry.stageBundled(item.id, item.lock.version, item.archive, 0);
	f.native.store.write((sql) => sql.run("UPDATE plugin_generations SET epoch=epoch+1"));
	expect(() => registry.get(item.id)).toThrow(PluginRegistryError);
	f.native.store.write((sql) => {
		sql.run("UPDATE plugin_generations SET epoch=epoch-1");
		sql.run("UPDATE plugin_generations SET id=?", ["!".repeat(26)]);
	});
	expect(() => registry.get(item.id)).toThrow(PluginRegistryError);
});

it("keeps oversized or invalid persisted descriptors behind native read bounds", async () => {
	const f = await setup(),
		registry = await f.open(),
		item = f.bundles[0];
	if (!item) throw new Error("DYTEST missing package");
	await registry.stageBundled(item.id, item.lock.version, item.archive, 0);
	const raw = openEncrypted({ filename: f.native.filename, nativeBinding }, f.native.key);
	try {
		raw.exec("DROP TRIGGER plugin_versions_no_update; PRAGMA ignore_check_constraints=ON;");
		raw.prepare("UPDATE plugin_versions SET descriptor=?").run("x".repeat(524_289));
		expect(() => registry.get(item.id)).toThrow(PluginRegistryError);
		raw.prepare("UPDATE plugin_versions SET descriptor=?").run("{}");
		expect(() => registry.get(item.id)).toThrow(PluginRegistryError);
	} finally {
		raw.close();
	}
});

it.each(["native pin", "declared digest"] as const)(
	"refuses a persisted %s mismatch",
	async (mode) => {
		const f = await setup(),
			registry = await f.open(),
			item = f.bundles[0];
		if (!item) throw new Error("DYTEST missing package");
		const installed = (await registry.stageBundled(item.id, item.lock.version, item.archive, 0))
			.installed;
		const edited = JSON.parse(canonicalize(installed)) as {
			bundle: { inventory: { integrity: string } };
			digests: { egress: string };
		};
		if (mode === "native pin")
			edited.bundle.inventory.integrity = `sha512-${Buffer.alloc(64, 3).toString("base64")}`;
		else edited.digests.egress = Buffer.alloc(32, 3).toString("hex");
		const raw = openEncrypted({ filename: f.native.filename, nativeBinding }, f.native.key);
		try {
			raw.exec("DROP TRIGGER plugin_versions_no_update");
			raw.prepare("UPDATE plugin_versions SET descriptor=?").run(canonicalize(edited));
			expect(() => registry.get(item.id)).toThrow(PluginRegistryError);
		} finally {
			raw.close();
		}
	},
);

it("ends pending staging on close without committing an installed record", async () => {
	const f = await setup(),
		registry = await f.open(),
		item = f.bundles[0];
	if (!item) throw new Error("DYTEST missing package");
	const before = counts(f),
		pending = registry.stageBundled(item.id, item.lock.version, item.archive, 0);
	const rejected = expect(pending).rejects.toThrow(PluginRegistryError);
	await registry.close();
	await rejected;
	expect(counts(f)).toEqual(before);
	expect(() => registry.get(item.id)).toThrow(PluginRegistryError);
});

it("rejects caller-provided installed DTOs, pins and out-of-catalog archives", async () => {
	const f = await setup(),
		registry = await f.open(),
		item = f.bundles[0];
	if (!item) throw new Error("DYTEST missing package");
	await expect(registry.stageBundled(item.id, "8.0.0", item.archive, 0)).rejects.toMatchObject(
		failure("input"),
	);
	await expect(
		registry.stageBundled(
			item.id,
			item.lock.version,
			{ bundle: {}, reviewed: true } as unknown as Uint8Array,
			0,
		),
	).rejects.toMatchObject(failure("install"));
	await expect(
		registry.stageBundled(item.id, item.lock.version, new Uint8Array([1, 2, 3]), 0),
	).rejects.toMatchObject(failure("install"));
	expect(counts(f).versions).toBe(0);
	expect(newId()).toHaveLength(26);
});

it("keeps its captured native catalog and root when startup input objects change", async () => {
	const f = await setup(),
		item = f.bundles[0];
	if (!item) throw new Error("DYTEST missing package");
	const changed = bundle(item.id, {
			extras: [{ name: "package/changed.txt", body: "DYTEST changed pin" }],
		}),
		config = f.files.options(f.bundles),
		registry = await openPluginRegistry({
			store: f.native.store,
			database: f.database,
			devices: f.native.registry,
			audit: f.native.audit,
			events: f.events,
			installer: config,
		});
	try {
		config.bundles.splice(0, 1, { id: changed.id, package: changed.lock });
		config.directory = path.join(f.files.root, "changed");
		const before = counts(f);
		await expect(
			registry.stageBundled(item.id, item.lock.version, changed.archive, 0),
		).rejects.toThrow(PluginRegistryError);
		expect(counts(f)).toEqual(before);
		expect(readdirSync(f.files.root)).toEqual([]);
		const recorded = await registry.stageBundled(item.id, item.lock.version, item.archive, 0);
		expect(recorded.installed.bundle.inventory.integrity).toBe(item.lock.integrity);
		expect(path.dirname(recorded.installed.bundle.directory)).toBe(f.files.root);
	} finally {
		await registry.close();
	}
});
