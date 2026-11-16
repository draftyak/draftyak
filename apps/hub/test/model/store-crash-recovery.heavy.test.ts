import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	type BigIntStats,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore } from "../../src/store/store.ts";

type Mode = "in-transaction" | "after-commit";
type End = { code: number | null; signal: NodeJS.Signals | null };
const READY = Buffer.from("STORE_CRASH_READY\n");
const PAYLOAD_BYTES = 4 * 1024 * 1024;
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const require = createRequire(import.meta.url);
const header = (
	process.report.getReport() as unknown as { header: { glibcVersionRuntime?: string } }
).header;
const platform =
	process.platform === "linux" && !header.glibcVersionRuntime ? "linuxmusl" : process.platform;
const nativeBinding = path.join(
	path.dirname(require.resolve("better-sqlite3-multiple-ciphers/package.json")),
	"prebuilds",
	`${platform}-${process.arch}.node`,
);
const driver = fileURLToPath(new URL("./fixtures/store-crash-child.mjs", import.meta.url));
const auditMigrations = fileURLToPath(
	new URL("../../src/store/migrations/audit/", import.meta.url),
);
const bodies = new Set<Promise<void>>();
const children = new Set<ChildOwner>();
const stores = new Set<StoreOwner>();
interface DirectoryOwner {
	attempted: boolean;
	directory?: string;
	identity?: BigIntStats;
}
const directories = new Set<DirectoryOwner>();
let retiring = false;

interface ChildOwner {
	child: ChildProcessWithoutNullStreams;
	ready: Promise<void>;
	joined: Promise<void>;
	assertStage: () => void;
	assertCrashed: () => void;
	kill: { attemptedWhileLive: boolean; accepted: boolean; exit?: End; close?: End };
	retirement?: Promise<void>;
}

function launch(input: unknown): ChildOwner {
	if (retiring) throw new Error("Test body is retiring");
	const serialized = JSON.stringify(input);
	if (typeof serialized !== "string") throw new Error("Missing crash child input");
	const child = spawn(process.execPath, [driver], {
		shell: false,
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let readyResolve!: () => void;
	let readyReject!: (error: Error) => void;
	let joinedResolve!: () => void;
	let joinedReject!: (error: Error) => void;
	const ready = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	const joined = new Promise<void>((resolve, reject) => {
		joinedResolve = resolve;
		joinedReject = reject;
	});
	void ready.catch(() => {});
	void joined.catch(() => {});
	let spawned = false;
	let spawnError = false;
	let exit: End | undefined;
	let closed: End | undefined;
	let stdinClosed = false;
	const pipes = [
		{ eof: false, closed: false, bytes: Buffer.alloc(0) },
		{ eof: false, closed: false, bytes: Buffer.alloc(0) },
	];
	let protocolError: Error | undefined;
	const owner: ChildOwner = {
		child,
		ready,
		joined,
		kill: { attemptedWhileLive: false, accepted: false },
		assertStage: () => {
			if (
				protocolError ||
				!spawned ||
				!pipes[0]?.bytes.equals(READY) ||
				pipes[1]?.bytes.length !== 0
			)
				throw new Error("Crash child stage protocol was not confirmed");
		},
		assertCrashed: () => {
			if (
				!owner.kill.attemptedWhileLive ||
				!owner.kill.accepted ||
				!exit ||
				!closed ||
				(exit.code === 0 && exit.signal === null)
			)
				throw new Error("The original child was not confirmed forcibly terminated");
		},
	};
	children.add(owner);
	const fail = (): void => {
		protocolError ??= new Error("Owned crash child failed before the expected stage");
		readyReject(protocolError);
	};
	const finish = (): void => {
		if (!closed || !stdinClosed || !pipes.every((pipe) => pipe.closed)) return;
		if (spawned && (!exit || !pipes.every((pipe) => pipe.eof))) return;
		if (!spawned && (!spawnError || child.pid !== undefined)) return;
		if (spawned && (exit?.code !== closed.code || exit?.signal !== closed.signal)) {
			joinedReject(new Error("Original crash child exit and close disagree"));
			return;
		}
		children.delete(owner);
		joinedResolve();
	};
	child.on("spawn", () => {
		spawned = true;
	});
	child.on("error", () => {
		spawnError = true;
		fail();
		finish();
	});
	child.on("exit", (code, signal) => {
		exit = { code, signal };
		owner.kill.exit = exit;
		finish();
	});
	child.on("close", (code, signal) => {
		closed = { code, signal };
		owner.kill.close = closed;
		if (!pipes[0]?.bytes.equals(READY)) fail();
		finish();
	});
	child.stdin.on("error", fail);
	child.stdin.on("close", () => {
		stdinClosed = true;
		finish();
	});
	for (const [index, stream] of [child.stdout, child.stderr].entries()) {
		const pipe = pipes[index];
		if (!pipe) throw new Error("Missing owned child stream");
		stream.on("data", (chunk: Buffer) => {
			if (pipe.bytes.length + chunk.length > 16 * 1024) {
				fail();
				return;
			}
			pipe.bytes = Buffer.concat([pipe.bytes, chunk]);
			if (index === 0 && pipe.bytes.equals(READY)) readyResolve();
			else if (index === 1 || pipe.bytes.length >= READY.length) fail();
		});
		stream.on("error", fail);
		stream.on("end", () => {
			pipe.eof = true;
			finish();
		});
		stream.on("close", () => {
			pipe.closed = true;
			finish();
		});
	}
	try {
		child.stdin.end(serialized);
	} catch {
		fail();
	}
	return owner;
}

function terminate(owner: ChildOwner): Promise<void> {
	if (owner.retirement) return owner.retirement;
	owner.retirement = (async () => {
		let killError: unknown;
		try {
			if (owner.child.exitCode === null && owner.child.signalCode === null) {
				owner.kill.attemptedWhileLive = true;
				owner.kill.accepted = owner.child.kill("SIGKILL");
			}
		} catch (error) {
			killError = error;
		}
		await owner.joined;
		if (killError !== undefined) throw killError;
	})();
	return owner.retirement;
}

interface StoreOwner {
	store: HubStore;
	closeAttempted: boolean;
}
function ownStore(store: HubStore): StoreOwner {
	const owner = { store, closeAttempted: false };
	stores.add(owner);
	return owner;
}
function closeStore(owner: StoreOwner): void {
	if (owner.closeAttempted) throw new Error("Store close cannot be retried");
	owner.closeAttempted = true;
	owner.store.close();
	stores.delete(owner);
}

function snapshot(store: HubStore, audit: AuditChain) {
	return store.read((reader) => {
		audit.verify(reader);
		return {
			rows: reader
				.all<{ id: string; payload: Uint8Array }>("SELECT id,payload FROM crash_rows ORDER BY id")
				.map((row) => ({ id: row.id, bytes: row.payload.byteLength, sha256: digest(row.payload) })),
			events: reader.all<Record<string, unknown>>(
				"SELECT seq,id,at,action,actor_kind,actor_id,refs,previous,mac FROM audit_events ORDER BY seq",
			),
			head: reader.get<{
				singleton: number;
				audit_seq: number;
				audit_head: string;
				audit_tag: string;
			}>("SELECT singleton,audit_seq,audit_head,audit_tag FROM audit_meta WHERE singleton=1"),
		};
	});
}

async function exercise(mode: Mode): Promise<void> {
	const directoryOwner: DirectoryOwner = { attempted: false };
	directories.add(directoryOwner);
	let tempRoot: string | undefined;
	let directory: string | undefined;
	let identity: BigIntStats | undefined;
	let seed: Buffer | undefined;
	let key: MasterKey | undefined;
	let audit: AuditChain | undefined;
	let current: StoreOwner | undefined;
	let child: ChildOwner | undefined;
	let failure: unknown;
	let canRemove = true;
	const retainCleanupFailure = (error: unknown): void => {
		canRemove = false;
		failure =
			failure === undefined
				? error
				: new AggregateError([failure, error], "Crash test and retirement failed");
	};
	try {
		tempRoot = realpathSync(os.tmpdir());
		directoryOwner.attempted = true;
		directory = mkdtempSync(path.join(tempRoot, "draftyak-store-crash-"));
		directoryOwner.directory = directory;
		identity = lstatSync(directory, { bigint: true });
		directoryOwner.identity = identity;
		if (!identity.isDirectory() || identity.isSymbolicLink())
			throw new Error("Invalid crash fixture directory");
		const filename = path.join(directory, "crash.db");
		seed = randomBytes(32);
		key = new MasterKey(seed);
		const derived = key.derive("audit");
		try {
			audit = new AuditChain(derived);
		} finally {
			derived.fill(0);
		}
		const crashMigrations = path.join(directory, "crash");
		mkdirSync(crashMigrations);
		writeFileSync(
			path.join(crashMigrations, "0001_rows.sql"),
			"CREATE TABLE crash_rows(id TEXT PRIMARY KEY NOT NULL,payload BLOB NOT NULL) STRICT;\n",
			{ flag: "wx", mode: 0o600 },
		);
		const migrations = { audit: auditMigrations, crash: crashMigrations };
		const created = new HubStore({
			filename,
			nativeBinding,
			masterKey: key,
			create: true,
			migrations,
		});
		current = ownStore(created);
		await created.migrate("audit");
		await created.migrate("crash");
		created.write((tx) => {
			tx.run("INSERT INTO crash_rows(id,payload) VALUES(?,?)", [
				"baseline",
				Buffer.from("baseline"),
			]);
			audit?.append(tx, {
				id: String(100).padStart(26, "0"),
				at: 1000,
				action: "test.baseline",
				actor: { kind: "hub", id: null },
				refs: {},
			});
		});
		const baseline = snapshot(created, audit);
		expect(baseline.rows).toHaveLength(1);
		expect(baseline.events).toHaveLength(1);
		expect(baseline.head?.audit_seq).toBe(1);
		closeStore(current);
		current = undefined;
		if (retiring) throw new Error("Test body is retiring");
		child = launch({
			schema: 1,
			filename,
			nativeBinding,
			migrations,
			mode,
			seed: seed.toString("hex"),
		});
		await child.ready;
		// Uncommitted spills and committed records both exercise a real on-disk WAL.
		expect(lstatSync(`${filename}-wal`).size).toBeGreaterThan(32);
		await terminate(child);
		child.assertStage();
		child.assertCrashed();
		const reopened = new HubStore({ filename, nativeBinding, masterKey: key, migrations });
		current = ownStore(reopened);
		const actual = snapshot(reopened, audit);
		if (mode === "in-transaction") {
			expect(actual).toEqual(baseline);
		} else {
			expect(actual.rows).toEqual([
				baseline.rows[0],
				...[0x61, 0x62].map((byte, index) => ({
					id: `crash-row-${index + 1}`,
					bytes: PAYLOAD_BYTES,
					sha256: digest(Buffer.alloc(PAYLOAD_BYTES, byte)),
				})),
			]);
			expect(actual.events.slice(0, baseline.events.length)).toEqual(baseline.events);
			expect(actual.events).toHaveLength(baseline.events.length + 2);
			for (const [index, event] of actual.events.slice(1).entries()) {
				expect(event).toMatchObject({
					seq: index + 2,
					id: String(101 + index).padStart(26, "0"),
					at: 1001 + index,
					action: "test.crash",
					actor_kind: "hub",
					actor_id: null,
					refs: "{}",
				});
				expect(event.previous).toBe(
					index === 0 ? baseline.head?.audit_head : actual.events[index]?.mac,
				);
			}
			expect(actual.head).toMatchObject({
				singleton: 1,
				audit_seq: 3,
				audit_head: actual.events[2]?.mac,
			});
		}
	} catch (error) {
		failure = error;
	} finally {
		try {
			if (child) await terminate(child);
			if (current) {
				if (current.closeAttempted)
					retainCleanupFailure(new Error("Unqualified store close remains owned"));
				else closeStore(current);
			}
		} catch (error) {
			retainCleanupFailure(error);
		}
		try {
			audit?.destroy();
		} catch (error) {
			retainCleanupFailure(error);
		}
		try {
			key?.destroy();
		} catch (error) {
			retainCleanupFailure(error);
		}
		seed?.fill(0);
		if (canRemove && directory !== undefined && identity !== undefined && tempRoot !== undefined) {
			try {
				const resolved = realpathSync(directory);
				const finalIdentity = lstatSync(resolved, { bigint: true });
				if (
					path.dirname(resolved) !== tempRoot ||
					!path.basename(resolved).startsWith("draftyak-store-crash-") ||
					finalIdentity.isSymbolicLink() ||
					finalIdentity.dev !== identity.dev ||
					finalIdentity.ino !== identity.ino
				) {
					retainCleanupFailure(new Error("Unexpected crash fixture directory"));
				} else {
					rmSync(resolved, { recursive: true, force: false });
					expect(existsSync(resolved)).toBe(false);
					directories.delete(directoryOwner);
				}
			} catch (error) {
				retainCleanupFailure(error);
			}
		} else if (!directoryOwner.attempted) {
			directories.delete(directoryOwner);
		}
	}
	if (failure !== undefined) throw failure;
}

beforeEach(() => {
	if (children.size || bodies.size || stores.size || directories.size)
		throw new Error("Previous crash-test owners have not retired");
	retiring = false;
});
afterEach(async () => {
	retiring = true;
	try {
		await Promise.all([...children].map(terminate));
	} finally {
		while (bodies.size) await Promise.allSettled([...bodies]);
	}
	expect(children.size).toBe(0);
	expect(stores.size).toBe(0);
	expect(directories.size).toBe(0);
});

// Process crashes exercise recovery; they do not prove a machine's power-loss flush behavior.
it.each(["in-transaction", "after-commit"] as const)(
	"recovers data and authenticated audit state after a %s process crash",
	(mode) => {
		const original = Promise.resolve().then(() => exercise(mode));
		bodies.add(original);
		void original.then(
			() => bodies.delete(original),
			() => bodies.delete(original),
		);
		return original;
	},
);
