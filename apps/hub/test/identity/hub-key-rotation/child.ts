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
			if (store || !request.key || !request.filename || !request.dir)
				throw new Error("Invalid fixture init");
			try {
				key = new MasterKey(request.key);
			} finally {
				request.key.fill(0);
			}
			const auditKey = key.derive("audit");
			audit = new AuditChain(auditKey);
			auditKey.fill(0);
			store = new HubStore({
				filename: request.filename,
				nativeBinding,
				masterKey: key,
				migrations: rotationMigrations(request.dir),
			});
			identity = await openRotatedIdentity(store, key, audit);
			rotation = new HubKeyRotation(store, key, audit, { clock });
			reply(request.id, { pid: process.pid, hid: identity.hid });
		} else if (request.command === "prepare") {
			if (!rotation || !identity) throw new Error("Fixture is not initialized");
			prepared = await rotation.prepareSuccessor(identity);
			reply(request.id, null);
		} else if (request.command === "commit") {
			reply(request.id, commit(request));
		} else if (request.command === "hold-commit") {
			commit(request, () => hold(request.id));
		} else if (request.command === "hold-clock") {
			holdClock = request.id;
			commit(request);
		} else throw new Error("Unknown fixture command");
	} catch (error) {
		process.send?.({
			id: request.id,
			ok: false,
			code: error instanceof Error ? error.message : "fixture",
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
