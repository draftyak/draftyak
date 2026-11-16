import { randomBytes } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Root = Pick<
	typeof import("../../../src/index.ts"),
	"openNativeStorage" | "HubStore" | "MasterKey" | "AuditChain"
>;
type Store = InstanceType<Root["HubStore"]>;
type BuiltCopy = {
	readonly root: Root;
	readonly directory: string;
	readonly parent: string;
	readonly binding: string;
	readonly gmailAsset: string;
	readonly gmailBytes: Buffer;
	readonly gmailMode: number;
};
type Fixture = {
	readonly root: Root;
	readonly filename: string;
	readonly masterKey: InstanceType<Root["MasterKey"]>;
	readonly audit: InstanceType<Root["AuditChain"]>;
	readonly options: {
		filename: string;
		masterKey: InstanceType<Root["MasterKey"]>;
		nativeBinding: string;
	};
	readonly stores: Set<Store>;
	readonly built: BuiltCopy;
};

const hub = path.resolve(import.meta.dirname, "../../..");
const sourceAsset = path.join(
	hub,
	"src/channels/gmail/connection/credential-migrations/0001_credentials.sql",
);
const namespaces = [
	"audit",
	"core",
	"devices",
	"jobs",
	"events",
	"revisions",
	"credentials",
	"tickets",
	"accounts",
	"gmailcredentials",
] as const;
const sqlAssets = [
	"store/migrations/audit/0001_chain.sql",
	"store/migrations/core/0001_identity.sql",
	"devices-migrations/0001_devices.sql",
	"jobs-migrations/0001_jobs.sql",
	"events-migrations/0001_events.sql",
	"drafts/migrations/0001_native_revisions.sql",
	"drafts/migrations/0002_immutable_revisions.sql",
	"credentials/migrations/0001_credentials.sql",
	"credentials/migrations/0002_sealed_credentials.sql",
	"outbox/migrations/0001_send_attempts.sql",
	"accounts/migrations/0001_accounts.sql",
	"credential-migrations/0001_credentials.sql",
] as const;
let built: BuiltCopy | undefined;
let copyLocation: { directory: string; parent: string } | undefined;
let retainCopy = false;

function physicalDirectory(directory: string): void {
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory)
		throw new Error("Gmail default-storage physical directory refused");
}

function removeOwnedDirectory(directory: string, parent: string, prefix: string): void {
	physicalDirectory(parent);
	physicalDirectory(directory);
	if (path.dirname(directory) !== parent || !path.basename(directory).startsWith(prefix))
		throw new Error("Owned Gmail default-storage cleanup target refused");
	rmSync(directory, { recursive: true, force: false });
}

function copyBuiltFile(relative: string, destination: string): Buffer {
	const original = path.join(hub, "dist", relative);
	let directory = path.dirname(original);
	while (directory !== hub) {
		physicalDirectory(directory);
		directory = path.dirname(directory);
	}
	const stat = lstatSync(original);
	if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(original) !== original)
		throw new Error("Gmail default-storage built file refused");
	const bytes = readFileSync(original);
	mkdirSync(path.dirname(destination), { recursive: true });
	writeFileSync(destination, bytes, { flag: "wx", mode: stat.mode & 0o777 });
	expect(readFileSync(destination)).toEqual(bytes);
	return bytes;
}

async function fixture(run: (value: Fixture) => Promise<void>): Promise<void> {
	if (!built) throw new Error("Owned built Gmail root is unavailable");
	const copy = built;
	const root = copy.root;
	physicalDirectory(copy.directory);
	const directory = mkdtempSync(path.join(copy.directory, "case-"));
	physicalDirectory(directory);
	const stores = new Set<Store>();
	const originalClose = root.HubStore.prototype.close;
	let masterKey: InstanceType<Root["MasterKey"]> | undefined;
	let audit: InstanceType<Root["AuditChain"]> | undefined;
	let workFailed = false;
	let workError: unknown;
	const cleanupErrors: unknown[] = [];
	try {
		const bytes = randomBytes(32);
		try {
			masterKey = new root.MasterKey(bytes);
		} finally {
			bytes.fill(0);
		}
		const auditBytes = masterKey.derive("audit");
		try {
			audit = new root.AuditChain(auditBytes);
		} finally {
			auditBytes.fill(0);
		}
		const filename = path.join(directory, "default-gmail.db");
		await run({
			root,
			filename,
			masterKey,
			audit,
			options: { filename, masterKey, nativeBinding: copy.binding },
			stores,
			built: copy,
		});
	} catch (error) {
		workFailed = true;
		workError = error;
	} finally {
		let closeFailed = false;
		for (const store of stores) {
			try {
				Reflect.apply(originalClose, store, []);
			} catch (error) {
				cleanupErrors.push(error);
				// Retry the genuine native close before considering owned scratch removal.
				try {
					Reflect.apply(originalClose, store, []);
				} catch (retryError) {
					closeFailed = true;
					cleanupErrors.push(retryError);
				}
			}
		}
		if (closeFailed) {
			retainCopy = true;
		}
		try {
			audit?.destroy();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			masterKey?.destroy();
		} catch (error) {
			cleanupErrors.push(error);
		}
		if (!closeFailed) {
			try {
				removeOwnedDirectory(directory, copy.directory, "case-");
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
	}
	const errors = workFailed ? [workError, ...cleanupErrors] : cleanupErrors;
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1)
		throw new AggregateError(errors, "Gmail default-storage work or cleanup failed");
}

function inspect(f: Fixture, store: Store) {
	return store.read((sql) => {
		const tables = sql.all<{ name: string; rowid: number; sql: string }>(
			"SELECT name,rowid,sql FROM main.sqlite_schema WHERE type='table' ORDER BY rowid",
		);
		const gmail = tables.find((row) => row.name === "gmail_credentials");
		expect(
			gmail,
			"Default native factory must migrate the delivered Gmail credential table",
		).toBeDefined();
		expect(tables.some((row) => row.name === "_migrations_gmailcredentials")).toBe(true);
		expect(gmail?.sql).toMatch(/REFERENCES\s+credentials\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i);
		const ordinal = (name: string) => {
			const row = tables.find((value) => value.name === name);
			expect(row, `Missing default schema table ${name}`).toBeDefined();
			return row?.rowid ?? -1;
		};
		expect(ordinal("audit_events")).toBeLessThan(ordinal("hub_meta"));
		expect(ordinal("hub_meta")).toBeLessThan(ordinal("credentials"));
		expect(ordinal("credentials")).toBeLessThan(ordinal("gmail_credentials"));
		const migrations = namespaces.map((namespace) => {
			const count = sql.get<{ n: number }>(
				`SELECT count(*) AS n FROM main._migrations_${namespace}`,
			)?.n;
			expect(count).toBe(namespace === "credentials" || namespace === "revisions" ? 2 : 1);
			return [namespace, count] as const;
		});
		expect(migrations).toHaveLength(10);
		expect(migrations.reduce((sum, [, n]) => sum + (n ?? 0), 0)).toBe(12);
		expect(sql.get("SELECT count(*) AS n FROM gmail_credentials")).toEqual({ n: 0 });
		expect(sql.get("SELECT count(*) AS n FROM credentials")).toEqual({ n: 0 });
		expect(sql.get("SELECT count(*) AS n FROM accounts")).toEqual({ n: 0 });
		expect(sql.get("SELECT count(*) AS n FROM users")).toEqual({ n: 0 });
		expect(sql.get("SELECT count(*) AS n FROM approval_pins")).toEqual({ n: 0 });
		expect(
			sql.get("SELECT singleton,identity_wrapped,statement_wrapped,identity_cert FROM hub_meta"),
		).toEqual({
			singleton: 1,
			identity_wrapped: null,
			statement_wrapped: null,
			identity_cert: null,
		});
		expect(
			sql.get("SELECT singleton,epoch,bootstrap_done,owner_user_id FROM device_authority"),
		).toEqual({ singleton: 1, epoch: 0, bootstrap_done: 0, owner_user_id: null });
		const genesis = sql.get<{ audit_seq: number; audit_head: string; audit_tag: string }>(
			"SELECT audit_seq,audit_head,audit_tag FROM audit_meta",
		);
		expect(genesis?.audit_tag).toMatch(/^[0-9a-f]{64}$/);
		f.audit.verify(sql);
		return { tables, migrations, genesis };
	});
}

describe("Gmail schema through the built default native storage factory", {
	concurrent: false,
}, () => {
	beforeAll(async () => {
		// A current real Hub build is required. All test APIs come from one byte-identical owned copy.
		physicalDirectory(hub);
		const parent = path.join(hub, "node_modules");
		physicalDirectory(parent);
		const directory = mkdtempSync(path.join(parent, ".gmail-default-storage-"));
		copyLocation = { directory, parent };
		physicalDirectory(directory);
		const dist = path.join(directory, "dist");
		physicalDirectory(path.join(hub, "dist"));
		const modules = readdirSync(path.join(hub, "dist"), { withFileTypes: true }).filter((entry) =>
			entry.name.endsWith(".mjs"),
		);
		expect(modules.some((entry) => entry.name === "index.mjs")).toBe(true);
		for (const entry of modules) {
			if (
				!entry.isFile() ||
				entry.isSymbolicLink() ||
				!/^[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/.test(entry.name) ||
				/siwc|dynamic[-_]agent/i.test(entry.name)
			)
				throw new Error("Gmail default-storage built module name refused");
			copyBuiltFile(entry.name, path.join(dist, entry.name));
		}
		for (const relative of sqlAssets) copyBuiltFile(relative, path.join(dist, relative));
		const gmailAsset = path.join(dist, "credential-migrations/0001_credentials.sql");
		const gmailBytes = readFileSync(gmailAsset);
		expect(gmailBytes).toEqual(readFileSync(sourceAsset));
		const require = createRequire(import.meta.url);
		const binding = realpathSync(
			path.join(
				path.dirname(require.resolve("better-sqlite3-multiple-ciphers/package.json")),
				"prebuilds",
				`${process.platform}-${process.arch}.node`,
			),
		);
		const root = (await import(pathToFileURL(path.join(dist, "index.mjs")).href)) as Root;
		built = {
			root,
			directory,
			parent,
			binding,
			gmailAsset,
			gmailBytes,
			gmailMode: lstatSync(gmailAsset).mode & 0o777,
		};
	});

	afterAll(() => {
		if (retainCopy)
			throw new Error("Owned Gmail default-storage copy retained after incomplete native close");
		if (copyLocation)
			removeOwnedDirectory(copyLocation.directory, copyLocation.parent, ".gmail-default-storage-");
	});

	it("creates the default Gmail schema and preserves encrypted state and audit on genuine reopen", async () => {
		await fixture(async (f) => {
			let store = await f.root.openNativeStorage({ ...f.options, create: true });
			f.stores.add(store);
			const initial = inspect(f, store);
			expect({ seq: initial.genesis?.audit_seq, head: initial.genesis?.audit_head }).toEqual({
				seq: 0,
				head: "",
			});
			// These are deliberately unresolvable row data, never owner identity or a grant.
			let foreignKeyError: unknown;
			try {
				store.write((sql) =>
					sql.run(
						"INSERT INTO gmail_credentials(account_id,user_id,credential_ref) VALUES(?,?,?)",
						[
							"00000000000000000000000001",
							"00000000000000000000000002",
							"00000000000000000000000003",
						],
					),
				);
			} catch (error) {
				foreignKeyError = error;
			}
			expect(foreignKeyError).toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
			expect(inspect(f, store)).toEqual(initial);
			store.write((sql) =>
				f.audit.append(sql, {
					id: "00000000000000000000000001",
					at: 1_000_000,
					action: "hub.init",
					actor: { kind: "hub", id: null },
					refs: {},
				}),
			);
			const populated = inspect(f, store);
			expect(populated.genesis?.audit_seq).toBe(1);
			store.checkpoint();
			store.close();
			expect(readFileSync(f.filename).subarray(0, 16).toString()).not.toBe("SQLite format 3\0");
			store = await f.root.openNativeStorage(f.options);
			f.stores.add(store);
			expect(inspect(f, store)).toEqual(populated);
		});
	});

	it("refuses a missing owned built Gmail SQL asset and genuinely closes the failed factory store", async () => {
		await fixture(async (f) => {
			const { gmailAsset, gmailBytes, gmailMode } = f.built;
			const originalClose = f.root.HubStore.prototype.close;
			const failed: Store[] = [];
			let returned: Store | undefined,
				failure: unknown,
				originalCloseReturned = 0;
			let removed = false;
			try {
				f.root.HubStore.prototype.close = function (this: Store) {
					f.stores.add(this);
					failed.push(this);
					const result = Reflect.apply(originalClose, this, []);
					originalCloseReturned++;
					return result;
				};
				unlinkSync(gmailAsset);
				removed = true;
				try {
					returned = await f.root.openNativeStorage({ ...f.options, create: true });
					f.stores.add(returned);
				} catch (error) {
					failure = error;
				}
			} finally {
				try {
					// A pre-registration factory may unexpectedly succeed: close it before any assertion.
					if (returned) Reflect.apply(originalClose, returned, []);
				} finally {
					try {
						if (removed) writeFileSync(gmailAsset, gmailBytes, { flag: "wx", mode: gmailMode });
					} finally {
						f.root.HubStore.prototype.close = originalClose;
					}
				}
			}
			// All observations/assertions happen after exact asset and prototype restoration.
			expect(readFileSync(gmailAsset)).toEqual(gmailBytes);
			expect(f.root.HubStore.prototype.close).toBe(originalClose);
			expect(
				failure,
				"Default factory must refuse its missing delivered Gmail migration",
			).toMatchObject({ code: "ENOENT", path: gmailAsset });
			expect(failed).toHaveLength(1);
			expect(originalCloseReturned).toBe(1);
			expect(() => failed[0]?.read(() => undefined)).toThrow(/Database is unavailable/);
			const repaired = await f.root.openNativeStorage(f.options);
			f.stores.add(repaired);
			const snapshot = inspect(f, repaired);
			expect({ seq: snapshot.genesis?.audit_seq, head: snapshot.genesis?.audit_head }).toEqual({
				seq: 0,
				head: "",
			});
		});
	});
});
