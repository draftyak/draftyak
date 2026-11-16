import { randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HUB_NAMESPACES } from "../../src/kernel/namespaces.ts";
import { openNativeStorage } from "../../src/native-storage.ts";
import { HubStore } from "../../src/store/store.ts";
import { nativeBinding } from "./helpers.ts";

const PREFIX = "draftyak-owner-settings-schema-";
const CLEANUP = "Owner settings schema fixture cleanup failed";
const EARLIER_NAMESPACES = [
	"audit",
	"core",
	"devices",
	"jobs",
	"events",
	"revisions",
	"credentials",
	"tickets",
	"accounts",
	"pluginregistry",
] as const;

interface Fixture {
	readonly directory: string;
	readonly parent: string;
	identity?: { readonly dev: bigint; readonly ino: bigint };
	key: MasterKey | undefined;
	readonly stores: Map<HubStore, "owned" | "indeterminate">;
}

const fixtures = new Set<Fixture>();

function fixture(): Fixture {
	const parent = realpathSync.native(path.resolve(os.tmpdir()));
	const f: Fixture = {
		parent,
		directory: mkdtempSync(path.join(parent, PREFIX)),
		key: undefined,
		stores: new Map(),
	};
	fixtures.add(f);
	const physical = lstatSync(f.directory, { bigint: true });
	if (!physical.isDirectory() || physical.isSymbolicLink()) throw new Error(CLEANUP);
	f.identity = { dev: physical.dev, ino: physical.ino };
	const bytes = randomBytes(32);
	try {
		f.key = new MasterKey(bytes);
	} finally {
		bytes.fill(0);
	}
	return f;
}

function options(f: Fixture) {
	if (!f.key) throw new Error("Owner settings schema fixture key unavailable");
	return { filename: path.join(f.directory, "hub.db"), nativeBinding, masterKey: f.key };
}

function closeStore(f: Fixture, store: HubStore): void {
	if (f.stores.get(store) !== "owned") throw new Error(CLEANUP);
	f.stores.set(store, "indeterminate");
	store.close();
	f.stores.delete(store);
}

function bare(f: Fixture, migrations?: Readonly<Record<string, string>>, create = false): HubStore {
	const store = new HubStore({
		...options(f),
		...(migrations === undefined ? {} : { migrations }),
		...(create ? { create: true } : {}),
	});
	f.stores.set(store, "owned");
	return store;
}

async function native(f: Fixture, create = false): Promise<HubStore> {
	const store = await openNativeStorage({ ...options(f), ...(create ? { create: true } : {}) });
	f.stores.set(store, "owned");
	return store;
}

afterEach(() => {
	let failed = false;
	for (const f of fixtures) {
		for (const [store, state] of f.stores) {
			if (state !== "owned") {
				failed = true;
				continue;
			}
			try {
				closeStore(f, store);
			} catch {
				failed = true;
			}
		}
		try {
			f.key?.destroy();
			f.key = undefined;
		} catch {
			failed = true;
		}
		if (f.stores.size !== 0 || f.key !== undefined) continue;
		try {
			const resolved = realpathSync.native(f.directory);
			const physical = lstatSync(f.directory, { bigint: true });
			if (
				!path.isAbsolute(f.directory) ||
				resolved !== f.directory ||
				path.dirname(resolved) !== f.parent ||
				!path.basename(resolved).startsWith(PREFIX) ||
				!physical.isDirectory() ||
				physical.isSymbolicLink() ||
				physical.dev !== f.identity?.dev ||
				physical.ino !== f.identity?.ino
			)
				throw new Error(CLEANUP);
			rmSync(resolved, { recursive: true, force: false });
			fixtures.delete(f);
		} catch {
			failed = true;
		}
	}
	if (failed) throw new Error(CLEANUP);
});

function expectOwnerSettings(store: HubStore): void {
	expect(
		store.read((db) => db.all("SELECT name FROM main._migrations_ownersettings ORDER BY name")),
	).toEqual([{ name: "0001_owner_settings" }]);
	expect(
		store.read((db) => db.get("SELECT type FROM main.sqlite_schema WHERE name = 'owner_settings'")),
	).toEqual({ type: "table" });
	expect(store.read((db) => db.get("SELECT count(*) AS n FROM main.owner_settings"))).toEqual({ n: 0 });
}

function earlierLedgers(store: HubStore) {
	return store.read((db) =>
		EARLIER_NAMESPACES.map((namespace) => ({
			namespace,
			rows: db.all(`SELECT name, timestamp FROM main._migrations_${namespace} ORDER BY name`),
		})),
	);
}

it("reopens native-created owner settings with a bare HubStore", async () => {
	const f = fixture();
	closeStore(f, await native(f, true));
	const reopened = bare(f);
	expectOwnerSettings(reopened);
});

it("upgrades the earlier native prefix and bare-reopens owner settings without rewriting its ledgers", async () => {
	const f = fixture();
	const migrations = Object.fromEntries(
		EARLIER_NAMESPACES.map((namespace) => [namespace, HUB_NAMESPACES[namespace]]),
	);
	const earlier = bare(f, migrations, true);
	for (const namespace of EARLIER_NAMESPACES) await earlier.migrate(namespace);
	const before = earlierLedgers(earlier);
	for (const ledger of before) expect(ledger.rows.length).toBeGreaterThan(0);
	expect(
		earlier.read((db) => db.get("SELECT name FROM main.sqlite_schema WHERE name = 'owner_settings'")),
	).toBeUndefined();
	closeStore(f, earlier);
	closeStore(f, await native(f));
	const reopened = bare(f);
	expectOwnerSettings(reopened);
	expect(earlierLedgers(reopened)).toEqual(before);
});
