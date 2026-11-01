import { AuditChain } from "../../../src/audit/chain.ts";
import type { HubIdentity } from "../../../src/identity/hub-key.ts";
import {
	HubKeyRotation,
	openRotatedIdentity,
	type PreparedSuccessor,
} from "../../../src/identity/hub-key-rotation/rotation.ts";
import { MasterKey } from "../../../src/kernel/master-key.ts";
import { HubStore } from "../../../src/store/store.ts";
import { nativeBinding } from "../../store/helpers.ts";
import { rotationMigrations } from "./fixture.ts";

interface Request {
	readonly id: number;
	readonly command: string;
	readonly dir?: string;
	readonly filename?: string;
	readonly key?: Uint8Array;
	readonly epoch?: number;
}

let store: HubStore | undefined;
let key: MasterKey | undefined;
let audit: AuditChain | undefined;
let identity: HubIdentity | undefined;
let rotation: HubKeyRotation | undefined;
let prepared: PreparedSuccessor | undefined;
let holdClock: number | undefined;
type Phase =
	| "idle"
	| "init-input"
	| "master-key"
	| "audit-key"
	| "store-open"
	| "identity-open"
	| "rotation-open"
	| "prepare"
	| "commit";
let phase: Phase = "idle";
const SQLITE_CODES = new Set([
	"SQLITE_BUSY",
	"SQLITE_BUSY_RECOVERY",
	"SQLITE_BUSY_SNAPSHOT",
	"SQLITE_BUSY_TIMEOUT",
	"SQLITE_LOCKED",
	"SQLITE_LOCKED_SHAREDCACHE",
	"SQLITE_LOCKED_VTAB",
	"SQLITE_IOERR",
	"SQLITE_CANTOPEN",
	"SQLITE_NOTADB",
	"SQLITE_CORRUPT",
]);

function reply(id: number, value: unknown): void {
	process.send?.({ id, ok: true, value });
}
// The parent kills this owned process after it receives the staged marker.
function hold(id: number): never {
	reply(id, { staged: true });
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
	throw new Error("Held rotation timed out");
}
const clock = {
	wallMs: (): number => {
		if (holdClock !== undefined) hold(holdClock);
		return Date.now();
	},
};
function commit(request: Request, then?: () => void): unknown {
	const current = rotation;
	const handle = prepared;
	if (!store || !current || !handle) throw new Error("Fixture has no prepared rotation");
	prepared = undefined;
	const record = store.write((tx) => {
		const result = current.commit(tx, handle, {
			epoch: request.epoch ?? 1,
			actor: { kind: "cli", id: null },
		});
		then?.();
		return result;
	});
	return { seq: record.seq, newKey: record.newKey };
}

process.on("message", async (request: Request) => {
	try {
		if (request.command === "init") {
			phase = "init-input";
			if (store || !request.key || !request.filename || !request.dir)
				throw new Error("Invalid fixture init");
			try {
				phase = "master-key";
				key = new MasterKey(request.key);
			} finally {
				request.key.fill(0);
			}
			phase = "audit-key";
			const auditKey = key.derive("audit");
			audit = new AuditChain(auditKey);
			auditKey.fill(0);
			phase = "store-open";
			store = new HubStore({
				filename: request.filename,
				nativeBinding,
				masterKey: key,
				migrations: rotationMigrations(request.dir),
			});
			phase = "identity-open";
			identity = await openRotatedIdentity(store, key, audit);
			phase = "rotation-open";
			rotation = new HubKeyRotation(store, key, audit, { clock });
			reply(request.id, { pid: process.pid, hid: identity.hid });
		} else if (request.command === "prepare") {
			phase = "prepare";
			if (!rotation || !identity) throw new Error("Fixture is not initialized");
			prepared = await rotation.prepareSuccessor(identity);
			reply(request.id, null);
		} else if (request.command === "commit") {
			phase = "commit";
			reply(request.id, commit(request));
		} else if (request.command === "hold-commit") {
			phase = "commit";
			commit(request, () => hold(request.id));
		} else if (request.command === "hold-clock") {
			phase = "commit";
			holdClock = request.id;
			commit(request);
		} else throw new Error("Unknown fixture command");
	} catch (error) {
		const sqliteCode =
			error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
		const message = error instanceof Error ? error.message : undefined;
		const code =
			typeof sqliteCode === "string" && SQLITE_CODES.has(sqliteCode)
				? sqliteCode
				: message === "Hub identity rotation unavailable" ||
						message === "Hub identity chain unavailable"
					? message
					: "fixture";
		process.send?.({
			id: request.id,
			ok: false,
			code,
			phase,
		});
	}
});

process.on("disconnect", () => {
	identity?.lock();
	rotation?.lock();
	audit?.destroy();
	store?.close();
	key?.destroy();
});
