import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "@draftyak/protocol/jcs";
import { expect } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import {
	type CredentialActor,
	type CredentialBinding,
	type CredentialValue,
	CredentialVault,
} from "../../src/credentials/vault.ts";
import type { TimerClock } from "../../src/kernel/clock.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";
import { migrations, nativeBinding } from "../store/helpers.ts";

export const credentialMigrations: string = path.resolve(
	import.meta.dirname,
	"../../src/credentials/migrations",
);
interface Tracked {
	readonly dir: string;
	readonly stores: HubStore[];
	readonly vaults: CredentialVault[];
	readonly key: MasterKey;
	readonly audit: AuditChain;
}
const tracked: Tracked[] = [];
/** Closes every fixture of the test and checks that its folder is gone. */
export function cleanupFixtures(): void {
	for (const fixture of tracked.splice(0)) {
		for (const vault of fixture.vaults) vault.destroy();
		for (const store of fixture.stores) store.close();
		fixture.audit.destroy();
		fixture.key.destroy();
		rmSync(fixture.dir, { recursive: true, force: true });
		expect(existsSync(fixture.dir)).toBe(false);
	}
}
export const canary = (): string => `DYTEST-${randomBytes(20).toString("hex")}`;
export const gmail = (ownerId: string = newId()): CredentialBinding => ({
	ownerKind: "account",
	ownerId,
	kind: "gmail-oauth",
});
export const slack = (ownerId: string = newId()): CredentialBinding => ({
	ownerKind: "account",
	ownerId,
	kind: "slack-token",
});
export const slackApp = (ownerId: string = newId()): CredentialBinding => ({
	ownerKind: "account",
	ownerId,
	kind: "slack-app-token",
});
export const provider = (ownerId: string = newId()): CredentialBinding => ({
	ownerKind: "provider",
	ownerId,
	kind: "provider-key",
});
export const token = (expiresAt = 0): CredentialValue => ({
	kind: "gmail-oauth",
	accessToken: canary(),
	refreshToken: canary(),
	expiresAt,
});
export const keyValue = (): CredentialValue => ({ kind: "provider-key", key: canary() });
export const slackValue = (expiresAt: number | null = null): CredentialValue => ({
	kind: "slack-token",
	accessToken: canary(),
	expiresAt,
});
export const appValue = (): CredentialValue => ({ kind: "slack-app-token", accessToken: canary() });
/** Every secret string a value holds. */
export const secrets = (value: CredentialValue): string[] =>
	value.kind === "provider-key"
		? [value.key]
		: value.kind === "gmail-oauth"
			? [value.accessToken, value.refreshToken]
			: [value.accessToken];
export interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
}
export const deferred = <T>(): Deferred<T> => {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};

export interface FakeClock {
	readonly clock: TimerClock;
	readonly state: { wall: number; mono: number };
	readonly waits: Set<{ due: number; resolve: () => void }>;
	readonly advance: (ms: number) => void;
	/** Ends every pending wait without moving either clock. */
	readonly fire: () => void;
}
/** A wall and monotonic clock that moves only when a test advances it. */
export function fakeClock(wall = 1_800_000_000_000): FakeClock {
	const state = { wall, mono: 1_000 };
	const waits = new Set<{ due: number; resolve: () => void }>();
	const clock: TimerClock = {
		wallMs: () => state.wall,
		monotonicMs: () => state.mono,
		after: (ms, signal) =>
			new Promise<void>((resolve, reject) => {
				if (signal?.aborted) return reject(signal.reason);
				const wait = {
					due: state.mono + ms,
					resolve: () => {
						waits.delete(wait);
						resolve();
					},
				};
				waits.add(wait);
				signal?.addEventListener(
					"abort",
					() => {
						waits.delete(wait);
						reject(signal.reason);
					},
					{ once: true },
				);
			}),
	};
	const advance = (ms: number): void => {
		state.wall += ms;
		state.mono += ms;
		for (const wait of [...waits]) if (wait.due <= state.mono) wait.resolve();
	};
	const fire = (): void => {
		for (const wait of [...waits]) wait.resolve();
	};
	return { clock, state, waits, advance, fire };
}

// The documented format, written out independently: version 1, nonce, tag, AES-256-GCM
// ciphertext, under the "secrets" subkey and the labelled canonical binding.
const context = (reference: string, owner: CredentialBinding, generation: number): Buffer =>
	Buffer.from(
		`draftyak/v1/credential-value\n${canonicalize({
			reference,
			ownerKind: owner.ownerKind,
			ownerId: owner.ownerId,
			kind: owner.kind,
			generation,
		})}`,
	);
export function sealWith(
	key: MasterKey,
	reference: string,
	owner: CredentialBinding,
	generation: number,
	value: unknown,
): Buffer {
	const secret = key.derive("secrets");
	try {
		const nonce = randomBytes(12),
			cipher = createCipheriv("aes-256-gcm", secret, nonce);
		cipher.setAAD(context(reference, owner, generation));
		const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
		return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), body]);
	} finally {
		secret.fill(0);
	}
}
export function unsealWith(
	key: MasterKey,
	sealed: Uint8Array,
	reference: string,
	owner: CredentialBinding,
	generation: number,
): unknown {
	const secret = key.derive("secrets"),
		bytes = Buffer.from(sealed);
	try {
		expect(bytes[0]).toBe(1);
		const decipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(1, 13));
		decipher.setAAD(context(reference, owner, generation));
		decipher.setAuthTag(bytes.subarray(13, 29));
		return JSON.parse(
			Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString("utf8"),
		);
	} finally {
		secret.fill(0);
	}
}

/** The value a refreshing row keeps, opened independently for the row's generation. */
export function keptValue(f: VaultFixture, reference: string, owner: CredentialBinding): unknown {
	const row = f.row(reference);
	expect(row?.status).toBe("refreshing");
	expect(row?.value).toBeInstanceOf(Uint8Array);
	return unsealWith(f.key, row?.value as Uint8Array, reference, owner, row?.generation as number);
}

export interface StoredRow {
	readonly owner_kind: string;
	readonly owner_id: string;
	readonly kind: string;
	readonly data_class: string;
	readonly generation: number;
	readonly status: string;
	readonly value: Uint8Array | null;
}
/** True when any column of any table, or the database, -wal or -shm file, holds a needle. */
export function holdsAny(store: HubStore, filename: string, needles: readonly string[]): boolean {
	const found = (bytes: Buffer): boolean =>
		needles.some((needle) => bytes.includes(Buffer.from(needle)));
	for (const suffix of ["", "-wal", "-shm"])
		if (existsSync(filename + suffix) && found(readFileSync(filename + suffix))) return true;
	return store.read((db) => {
		const tables = db.all<{ name: string }>(
			"SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name",
		);
		for (const { name } of tables)
			for (const row of db.all<Record<string, unknown>>(`SELECT * FROM main."${name}"`))
				for (const value of Object.values(row)) {
					if (typeof value === "string" && found(Buffer.from(value))) return true;
					if (value instanceof Uint8Array && found(Buffer.from(value))) return true;
				}
		return false;
	});
}

export interface AuditRow {
	readonly action: string;
	readonly actor_kind: string;
	readonly actor_id: string | null;
	readonly refs: string;
}
export interface VaultFixture {
	readonly dir: string;
	readonly filename: string;
	readonly fault: string;
	readonly legacy: string;
	readonly key: MasterKey;
	readonly audit: AuditChain;
	readonly store: HubStore;
	readonly vault: CredentialVault;
	open(on?: HubStore, clock?: TimerClock): CredentialVault;
	create(owner: CredentialBinding, value: CredentialValue, actor?: CredentialActor): string;
	reopen(): HubStore;
	row(reference: string, on?: HubStore): StoredRow | undefined;
	actions(on?: HubStore): AuditRow[];
	raw(work: (tx: SqlTransaction) => void, on?: HubStore): void;
}
/** With legacy, the credentials namespace starts with 0001 only, in a folder the test extends. */
export async function vaultFixture(
	options: { readonly clock?: TimerClock; readonly legacy?: boolean } = {},
): Promise<VaultFixture> {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-credentials-"));
	const filename = path.join(dir, "hub.db"),
		fault = path.join(dir, "fault"),
		legacy = path.join(dir, "legacy");
	mkdirSync(fault);
	if (options.legacy) {
		mkdirSync(legacy);
		copyFileSync(
			path.join(credentialMigrations, "0001_credentials.sql"),
			path.join(legacy, "0001_credentials.sql"),
		);
	}
	const key = new MasterKey(randomBytes(32));
	const auditKey = key.derive("audit"),
		audit = new AuditChain(auditKey);
	auditKey.fill(0);
	const storeOptions = {
		filename,
		nativeBinding,
		masterKey: key,
		migrations: {
			audit: path.join(migrations, "audit"),
			credentials: options.legacy ? legacy : credentialMigrations,
			fault,
		},
	};
	let store = new HubStore({ ...storeOptions, create: true });
	const entry: Tracked = { dir, stores: [store], vaults: [], key, audit };
	tracked.push(entry);
	await store.migrate("audit");
	await store.migrate("credentials");
	const open = (on: HubStore = store, clock = options.clock): CredentialVault => {
		const vault = new CredentialVault(on, audit, key, clock);
		entry.vaults.push(vault);
		return vault;
	};
	const vault = options.legacy ? undefined : open();
	const create = (
		owner: CredentialBinding,
		value: CredentialValue,
		actor?: CredentialActor,
	): string => {
		if (!vault) throw new Error("no vault");
		return store.write((tx) => vault.createInTransaction(tx, owner, value, actor));
	};
	const reopen = (): HubStore => {
		store.close();
		store = new HubStore(storeOptions);
		entry.stores.push(store);
		return store;
	};
	const row = (reference: string, on: HubStore = store): StoredRow | undefined =>
		on.read((db) =>
			db.get<StoredRow>(
				"SELECT owner_kind,owner_id,kind,data_class,generation,status,value FROM main.credentials WHERE id=?",
				[reference],
			),
		);
	const actions = (on: HubStore = store): AuditRow[] =>
		on.read((db) =>
			db.all<AuditRow>(
				"SELECT action,actor_kind,actor_id,refs FROM main.audit_events ORDER BY seq",
			),
		);
	const raw = (work: (tx: SqlTransaction) => void, on: HubStore = store): void =>
		on.write((tx) => work(tx));
	return {
		dir,
		filename,
		fault,
		legacy,
		key,
		audit,
		get store() {
			return store;
		},
		vault: vault as CredentialVault,
		open,
		create,
		reopen,
		row,
		actions,
		raw,
	};
}
