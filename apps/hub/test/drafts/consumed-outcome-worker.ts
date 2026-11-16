import { types } from "node:util";
import {
	isMainThread,
	type MessagePort,
	parentPort,
	threadId,
	workerData,
} from "node:worker_threads";
import type { AuditChain } from "../../src/audit/chain.ts";
import type {
	ConsumedDraftDisposition,
	DraftRevisionError,
	NativeDraftRevisions,
} from "../../src/drafts/revisions.ts";
import type { MasterKey } from "../../src/kernel/master-key.ts";
import type { HubStore } from "../../src/store/store.ts";

export interface OutcomeWorkerInput {
	readonly seed: Uint8Array;
	readonly filename: string;
	readonly nativeBinding: string;
	readonly migrations: Readonly<Record<string, string>>;
	readonly at: number;
	readonly request: ConsumedDraftDisposition;
	readonly gate: SharedArrayBuffer;
	readonly mode: "race" | "hold";
}

export type OutcomeWorkerMessage =
	| {
			readonly type: "ready";
			readonly threadId: number;
			readonly state: string;
			readonly rev: number;
			readonly lockId: string | null;
	  }
	| {
			readonly type: "held";
			readonly threadId: number;
			readonly state: string;
			readonly lockId: null;
	  }
	| {
			readonly type: "committed";
			readonly threadId: number;
			readonly state: string;
			readonly lockId: null;
	  }
	| {
			readonly type: "refused";
			readonly threadId: number;
			readonly code: "DRAFT_REVISION_UNAVAILABLE";
	  }
	| { readonly type: "rolled-back"; readonly threadId: number }
	| {
			readonly type: "fault";
			readonly threadId: number;
			readonly stage: "opening" | "barrier" | "writing" | "closing";
			readonly code: string;
	  };

type Stage = "opening" | "barrier" | "writing" | "closing";
const rollback = Object.freeze(Object.create(null)) as object;
const waitLimitMs = 15_000;
const technicalCodes = new Set([
	"DRAFT_REVISION_UNAVAILABLE",
	"INPUT_INVALID",
	"READY_STATE_MISMATCH",
	"RESULT_STATE_MISMATCH",
	"BARRIER_ABORTED",
	"BARRIER_TIMEOUT",
	"BARRIER_VALUE_INVALID",
	"SQLITE_BUSY",
	"SQLITE_LOCKED",
	"SQLITE_CANTOPEN",
	"SQLITE_CORRUPT",
	"SQLITE_NOTADB",
	"SQLITE_IOERR",
	"SQLITE_READONLY",
	"SQLITE_FULL",
	"SQLITE_CONSTRAINT",
	"SQLITE_CONSTRAINT_FOREIGNKEY",
	"ENOENT",
	"EACCES",
	"EPERM",
	"ERR_DLOPEN_FAILED",
	"ERR_MODULE_NOT_FOUND",
	"ERR_UNKNOWN_FILE_EXTENSION",
	"ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
	"ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
]);

class WorkerFault extends Error {
	readonly code: string;
	constructor(code: string) {
		super("Synthetic outcome worker unavailable");
		this.code = code;
	}
}

function codeOf(error: unknown): string {
	if (error === null || typeof error !== "object" || types.isProxy(error)) return "UNCLASSIFIED";
	const descriptor = Object.getOwnPropertyDescriptor(error, "code");
	return descriptor &&
		"value" in descriptor &&
		typeof descriptor.value === "string" &&
		technicalCodes.has(descriptor.value)
		? descriptor.value
		: "UNCLASSIFIED";
}

function revisionRefusal(
	error: unknown,
	errorClass: typeof DraftRevisionError | undefined,
): boolean {
	if (
		error === null ||
		typeof error !== "object" ||
		types.isProxy(error) ||
		errorClass === undefined ||
		!(error instanceof errorClass)
	)
		return false;
	const descriptor = Object.getOwnPropertyDescriptor(error, "code");
	return (
		descriptor !== undefined &&
		"value" in descriptor &&
		descriptor.value === "DRAFT_REVISION_UNAVAILABLE"
	);
}

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value))
		throw new WorkerFault("INPUT_INVALID");
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		Reflect.ownKeys(descriptors).some(
			(key) => typeof key !== "string" || !("value" in (descriptors[key] as PropertyDescriptor)),
		)
	)
		throw new WorkerFault("INPUT_INVALID");
	return value as Record<string, unknown>;
}

function inputOf(value: unknown): OutcomeWorkerInput {
	const data = record(value);
	const keys = ["seed", "filename", "nativeBinding", "migrations", "at", "request", "gate", "mode"];
	if (
		Object.keys(data).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(data, key)) ||
		!types.isUint8Array(data.seed) ||
		data.seed.byteLength !== 32 ||
		data.seed.buffer instanceof SharedArrayBuffer ||
		typeof data.filename !== "string" ||
		!data.filename ||
		typeof data.nativeBinding !== "string" ||
		!data.nativeBinding ||
		!Number.isSafeInteger(data.at) ||
		(data.at as number) < 0 ||
		!(data.gate instanceof SharedArrayBuffer) ||
		data.gate.byteLength !== 8 ||
		(data.mode !== "race" && data.mode !== "hold")
	)
		throw new WorkerFault("INPUT_INVALID");
	const migrations = record(data.migrations);
	if (
		Object.keys(migrations).length === 0 ||
		Object.values(migrations).some((value) => typeof value !== "string" || !value)
	)
		throw new WorkerFault("INPUT_INVALID");
	record(data.request);
	return data as unknown as OutcomeWorkerInput;
}

function decision(gate: Int32Array, index: 0 | 1): number {
	const deadline = performance.now() + waitLimitMs;
	for (;;) {
		const value = Atomics.load(gate, index);
		if (value === -1) throw new WorkerFault("BARRIER_ABORTED");
		if (value !== 0) {
			if (value === 1 || (index === 1 && value === 2)) return value;
			throw new WorkerFault("BARRIER_VALUE_INVALID");
		}
		const remaining = deadline - performance.now();
		if (remaining <= 0) throw new WorkerFault("BARRIER_TIMEOUT");
		Atomics.wait(gate, index, 0, remaining);
	}
}

async function runWorker(value: unknown, port: MessagePort): Promise<void> {
	let stage: Stage = "opening";
	let key: MasterKey | undefined;
	let audit: AuditChain | undefined;
	let store: HubStore | undefined;
	let revisions: NativeDraftRevisions | undefined;
	let revisionError: typeof DraftRevisionError | undefined;
	let inputSeed: Uint8Array | undefined;
	let terminal: OutcomeWorkerMessage | undefined;
	try {
		const input = inputOf(value);
		inputSeed = input.seed;
		const draftModule = await import("../../src/drafts/revisions.ts");
		const auditModule = await import("../../src/audit/chain.ts");
		const keyModule = await import("../../src/kernel/master-key.ts");
		const storeModule = await import("../../src/store/store.ts");
		revisionError = draftModule.DraftRevisionError;
		const seed = Uint8Array.from(input.seed);
		try {
			key = new keyModule.MasterKey(seed);
		} finally {
			seed.fill(0);
			input.seed.fill(0);
		}
		const auditKey = key.derive("audit");
		try {
			audit = new auditModule.AuditChain(auditKey);
		} finally {
			auditKey.fill(0);
		}
		store = new storeModule.HubStore({
			filename: input.filename,
			nativeBinding: input.nativeBinding,
			masterKey: key,
			migrations: input.migrations,
		});
		revisions = new draftModule.NativeDraftRevisions(store, audit, key, {
			wallMs: () => input.at,
			monotonicMs: () => performance.now(),
		});
		const service = revisions;
		const binding = {
			draftId: input.request.draftId,
			accountId: input.request.accountId,
			conversationId: input.request.conversationId,
			channel: input.request.channel,
		};
		const current = service.current(binding);
		if (
			current.draft.state !== "open" ||
			current.draft.rev !== input.request.expectedRev ||
			current.lockId !== input.request.lockId
		)
			throw new WorkerFault("READY_STATE_MISMATCH");
		port.postMessage({
			type: "ready",
			threadId,
			state: current.draft.state,
			rev: current.draft.rev,
			lockId: current.lockId,
		} satisfies OutcomeWorkerMessage);
		const gate = new Int32Array(input.gate);
		stage = "barrier";
		decision(gate, 0);
		if (Atomics.load(gate, 0) !== 1) throw new WorkerFault("BARRIER_ABORTED");
		stage = "writing";
		const settled = store.write((tx) => {
			const result = service.settleConsumedInTransaction(tx, input.request);
			if (
				result.lockId !== null ||
				result.draft.rev !== input.request.expectedRev ||
				result.draft.state !== (input.request.outcome === "sent" ? "sent" : "open")
			)
				throw new WorkerFault("RESULT_STATE_MISMATCH");
			if (input.mode === "hold") {
				port.postMessage({
					type: "held",
					threadId,
					state: result.draft.state,
					lockId: null,
				} satisfies OutcomeWorkerMessage);
				if (decision(gate, 1) === 2) throw rollback;
			}
			return result;
		});
		terminal = { type: "committed", threadId, state: settled.draft.state, lockId: null };
	} catch (error) {
		terminal =
			error === rollback
				? { type: "rolled-back", threadId }
				: stage === "writing" && revisionRefusal(error, revisionError)
					? { type: "refused", threadId, code: "DRAFT_REVISION_UNAVAILABLE" }
					: { type: "fault", threadId, stage, code: codeOf(error) };
	} finally {
		let failed = false;
		try {
			inputSeed?.fill(0);
		} catch {
			failed = true;
		}
		for (const close of [
			() => revisions?.destroy(),
			() => store?.close(),
			() => audit?.destroy(),
			() => key?.destroy(),
		]) {
			try {
				close();
			} catch {
				failed = true;
			}
		}
		if (failed) terminal = { type: "fault", threadId, stage: "closing", code: "CLEANUP_FAILED" };
		if (!terminal) terminal = { type: "fault", threadId, stage: "closing", code: "UNCLASSIFIED" };
		if (terminal.type === "fault") process.exitCode = 1;
		try {
			port.postMessage(terminal);
		} finally {
			port.close();
		}
	}
}

if (!isMainThread && parentPort !== null) {
	const port = parentPort;
	void runWorker(workerData, port).catch(() => {
		process.exitCode = 1;
		port.close();
	});
}
