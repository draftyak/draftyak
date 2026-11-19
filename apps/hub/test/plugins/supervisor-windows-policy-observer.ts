import path from "node:path";
import { isProxy } from "node:util/types";
import { parseReaderLine, parseTasklistCsv } from "../../src/plugins/supervisor/memory.ts";

type Call = (this: unknown, ...args: unknown[]) => unknown;
type Data = string | number | boolean | null | readonly Data[] | { readonly [key: string]: Data };
type Tuple = readonly [string, readonly string[], Readonly<Record<string, Data>>];

export interface WindowsSamplerBindings {
	readonly reader: Tuple;
	readonly tasklist: Tuple;
	readonly hubPid: number;
	readonly targetPid: number;
}

// Kept literal so an observation can match the unmodified production launch.
const READER_SCRIPT =
	"$ErrorActionPreference='Stop';while($true){$l=[Console]::In.ReadLine();if($null -eq $l){break};$v='x';try{$v=[string](Get-Process -Id ([int]$l)).PrivateMemorySize64}catch{$v='x'};[Console]::Out.WriteLine($v);[Console]::Out.Flush()}";

/** Data bindings only: this does not inspect a host, launch anything or authorize a run. */
export function windowsSamplerBindings(
	systemRoot: string,
	hubPid: number,
	targetPid: number,
): WindowsSamplerBindings {
	if (
		typeof systemRoot !== "string" ||
		systemRoot.length > 512 ||
		systemRoot.includes("\0") ||
		!path.win32.isAbsolute(systemRoot) ||
		!validPid(hubPid) ||
		!validPid(targetPid)
	)
		throw new TypeError("OBSERVER_BINDINGS_INVALID");
	return freezeData({
		reader: [
			path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READER_SCRIPT],
			{
				env: { SystemRoot: systemRoot },
				stdio: ["pipe", "pipe", "ignore"],
				windowsHide: true,
				shell: false,
			},
		],
		tasklist: [
			path.win32.join(systemRoot, "System32", "tasklist.exe"),
			["/fi", `PID eq ${targetPid}`, "/fo", "csv", "/nh"],
			{
				env: { SystemRoot: systemRoot },
				timeout: 2_000,
				maxBuffer: 65_536,
				shell: false,
				windowsHide: true,
			},
		],
		hubPid,
		targetPid,
	}) as unknown as WindowsSamplerBindings;
}

const LIMITS = Object.freeze({
	events: 256,
	children: 8,
	requests: 64,
	calls: 32,
	bytes: 65_536,
	line: 4096,
});
type ErrorCode = "EACCES" | "EPERM" | "ENOENT" | "ENOSYS" | "ETIMEDOUT" | "OTHER";
type Fault =
	| "OBSERVATION_ERROR"
	| "OBSERVATION_LIMIT"
	| "CHILD_UNOBSERVABLE"
	| "STREAM_UNOBSERVABLE"
	| "READER_REQUEST_INVALID"
	| "READER_REPLY_INVALID"
	| "READER_REPLY_UNEXPECTED"
	| "CALLBACK_INVALID"
	| "CALLBACK_REPEATED"
	| "NEW_LAUNCH_AFTER_CLOSE"
	| "RESTORE_CONFLICT"
	| "UNSETTLED_CHILD";

export interface ObservationEvent {
	readonly seq: number;
	readonly type: string;
	readonly kind?: "reader" | "tasklist";
	readonly id?: number;
	readonly child?: number;
	readonly pid?: number;
	readonly value?: number;
	readonly state?: string;
	readonly error?: ErrorCode;
}

interface Status {
	readonly code: number | null;
	readonly signal: "SIGTERM" | "SIGKILL" | "SIGINT" | "OTHER" | null;
}

export interface ObservedChild {
	readonly id: number;
	readonly kind: "reader" | "tasklist";
	readonly pid: number | undefined;
	readonly branch: "no-pid" | "started" | "unconfirmed";
	readonly errors: number;
	readonly exit: Status | undefined;
	readonly close: Status | undefined;
}

export interface ReaderRequest {
	readonly id: number;
	readonly child: number;
	readonly pid: number;
	readonly role: "self-check" | "target";
	readonly write: "pending" | "accepted" | "backpressure" | "threw";
	readonly reply: "pending" | "value" | "unreadable" | "malformed";
	readonly value?: number;
}

export interface TasklistReply {
	readonly id: number;
	readonly callbacks: number;
	readonly value: number | undefined;
	readonly error: ErrorCode | undefined;
}

export interface WindowsSamplerReceipt {
	readonly scope: "capture-only";
	readonly events: readonly ObservationEvent[];
	readonly faults: readonly Fault[];
	readonly children: readonly ObservedChild[];
	readonly requests: readonly ReaderRequest[];
	readonly tasklist: readonly TasklistReply[];
	readonly launches: Readonly<{
		reader: number;
		tasklist: number;
		unmatched: number;
		unmatchedAfterClose: number;
		afterClose: number;
	}>;
	readonly fallbackCount: number;
	readonly closeBoundary: boolean;
	readonly restored: boolean;
}

export interface WindowsSamplerObserver {
	/** Connect only to the actual sampler callback or supervisor fallback event. */
	fallback(): void;
	/** Mark immediately BEFORE calling the real owner's close. This does not close it. */
	closeBoundary(): void;
	snapshot(): WindowsSamplerReceipt;
	unsettled(): readonly number[];
	/**
	 * Ends capture and restores taps. Retained wrappers and callbacks still delegate, but no longer
	 * change the receipt. A child returned after restoration remains unobserved, not adopted.
	 * This never signals or waits for a process, and is not a cleanup-completion assertion.
	 */
	restore(): WindowsSamplerReceipt;
}

const FALLBACK_INVALID = "WINDOWS_FALLBACK_OBSERVATION_INVALID";
const PRIMARY_INVALID = "WINDOWS_PRIMARY_OBSERVATION_INVALID";

/** Records a reaction before the caller awaits the same promise; observation cannot replace it. */
export function tapOriginalPromise<T>(
	promise: Promise<T>,
	onValue: (value: T) => void,
	onError: (error: unknown) => void,
): Promise<T> {
	const failed = (error: unknown): void => {
		try {
			onError(error);
		} catch {
			// An observation callback cannot alter the original operation or reject a derived promise.
		}
	};
	void promise.then((value) => {
		try {
			onValue(value);
		} catch (error) {
			failed(error);
		}
	}, failed);
	return promise;
}

function positiveBytes(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function observationCheck(condition: boolean, code: string): asserts condition {
	if (!condition) throw new TypeError(code);
}

function closedObservation(receipt: WindowsSamplerReceipt, code: string): void {
	observationCheck(
		receipt.scope === "capture-only" &&
			receipt.closeBoundary &&
			receipt.restored &&
			receipt.faults.length === 0 &&
			receipt.launches.afterClose === 0 &&
			receipt.events.length <= LIMITS.events &&
			receipt.children.length <= LIMITS.children &&
			receipt.requests.length <= LIMITS.requests &&
			receipt.tasklist.length <= LIMITS.calls,
		code,
	);
	observationCheck(
		receipt.events.every((event, index) => event.seq === index + 1) &&
			receipt.children.every((child, index) => child.id === index + 1),
		code,
	);
	observationCheck(
		receipt.events.filter((event) => event.type === "close-boundary").length === 1,
		code,
	);
	for (const child of receipt.children) {
		observationCheck(child.close !== undefined && child.branch !== "unconfirmed", code);
		observationCheck(
			child.branch === "started"
				? validPid(child.pid) && child.exit !== undefined
				: child.pid === undefined && child.errors > 0 && child.exit === undefined,
			code,
		);
		for (const type of ["child-returned", "close"])
			observationCheck(
				receipt.events.filter(
					(event) => event.type === type && event.child === child.id && event.kind === child.kind,
				).length === 1,
				code,
			);
		for (const type of ["spawn", "exit", "child-error"])
			observationCheck(
				receipt.events.filter(
					(event) => event.type === type && event.child === child.id && event.kind === child.kind,
				).length === (type === "child-error" ? child.errors : child.branch === "started" ? 1 : 0),
				code,
			);
		observationCheck(
			receipt.events.find((event) => event.type === "child-returned" && event.child === child.id)
				?.pid === child.pid,
			code,
		);
	}
}

/**
 * Checks captured sampler-component observations only. This does not authenticate a receipt,
 * establish policy causation or language mode, grant an operation, or prove process cleanup.
 */
export function assertWindowsPolicyFallbackReceipt(
	receipt: WindowsSamplerReceipt,
	targetPid: number,
	samples: readonly [number | undefined, number | undefined],
	postCloseValue: number | undefined,
): void {
	const code = FALLBACK_INVALID;
	closedObservation(receipt, code);
	observationCheck(validPid(targetPid) && postCloseValue === undefined, code);
	observationCheck(
		samples.length === 2 &&
			samples.every(positiveBytes) &&
			receipt.launches.unmatchedAfterClose === 0 &&
			receipt.launches.reader === 1 &&
			receipt.launches.tasklist === 2 &&
			receipt.fallbackCount === 1 &&
			receipt.tasklist.length === 2 &&
			receipt.requests.length <= 1,
		code,
	);
	const readers = receipt.children.filter((child) => child.kind === "reader");
	const tools = receipt.children.filter((child) => child.kind === "tasklist");
	const throws = receipt.events.filter(
		(event) => event.type === "spawn-throw" && event.kind === "reader",
	);
	observationCheck(
		tools.length === 2 &&
			readers.length <= 1 &&
			(readers.length === 0 ? throws.length === 1 : throws.length === 0),
		code,
	);
	observationCheck(
		(readers[0]?.branch !== "started" || receipt.requests.length === 1) &&
			receipt.events.filter((event) => event.type === "reader-request").length ===
				receipt.requests.length,
		code,
	);
	for (const child of tools)
		observationCheck(
			child.branch === "started" &&
				child.errors === 0 &&
				child.exit?.code === 0 &&
				child.exit.signal === null &&
				child.close?.code === 0 &&
				child.close.signal === null,
			code,
		);
	for (const request of receipt.requests)
		observationCheck(
			request.id === 1 &&
				request.child === readers[0]?.id &&
				request.pid === targetPid &&
				request.role === "self-check" &&
				request.write !== "pending" &&
				request.reply !== "value" &&
				request.reply !== "malformed" &&
				request.value === undefined,
			code,
		);
	const fallback = receipt.events.filter((event) => event.type === "fallback");
	const launches = receipt.events.filter((event) => event.type === "launch-attempt");
	const callbacks = receipt.events.filter((event) => event.type === "tasklist-reply");
	const boundary = receipt.events.find((event) => event.type === "close-boundary");
	for (const request of receipt.requests) {
		const sent = receipt.events.find(
			(event) => event.type === "reader-request" && event.id === request.id,
		);
		observationCheck(
			sent?.child === request.child &&
				sent.pid === targetPid &&
				sent.state === "self-check" &&
				sent.seq < (fallback[0]?.seq ?? 0),
			code,
		);
	}
	observationCheck(
		fallback.length === 1 &&
			launches.length === 3 &&
			callbacks.length === 2 &&
			launches[0]?.kind === "reader" &&
			launches[1]?.kind === "tasklist" &&
			launches[2]?.kind === "tasklist" &&
			(launches[0]?.seq ?? Infinity) < (fallback[0]?.seq ?? 0) &&
			(fallback[0]?.seq ?? Infinity) < (launches[1]?.seq ?? 0) &&
			(callbacks[0]?.seq ?? Infinity) < (launches[2]?.seq ?? 0) &&
			(callbacks[1]?.seq ?? Infinity) < (boundary?.seq ?? 0),
		code,
	);
	for (const [index, reply] of receipt.tasklist.entries()) {
		const event = callbacks[index];
		observationCheck(
			reply.id === index + 1 &&
				reply.callbacks === 1 &&
				reply.error === undefined &&
				positiveBytes(reply.value) &&
				reply.value === samples[index] &&
				event?.id === reply.id &&
				event.pid === targetPid &&
				event.value === reply.value &&
				event.error === undefined &&
				event.seq > (launches[index + 1]?.seq ?? Infinity),
			code,
		);
	}
}

/** Numeric private-byte observations; the existing supervisor assertions establish its outcome. */
export function assertWindowsPolicyPrimaryReceipt(
	receipt: WindowsSamplerReceipt,
	hubPid: number,
	targetPid: number,
	limitBytes: number,
): void {
	const code = PRIMARY_INVALID;
	closedObservation(receipt, code);
	observationCheck(validPid(hubPid) && validPid(targetPid) && positiveBytes(limitBytes), code);
	const child = receipt.children[0];
	observationCheck(
		receipt.launches.reader === 1 &&
			receipt.launches.tasklist === 0 &&
			receipt.fallbackCount === 0 &&
			receipt.tasklist.length === 0 &&
			receipt.children.length === 1 &&
			child?.kind === "reader" &&
			child.branch === "started" &&
			child.errors === 0 &&
			receipt.requests.length >= 2 &&
			receipt.events.filter((event) => event.type === "launch-attempt").length === 1 &&
			receipt.events.filter((event) => event.type === "reader-request").length ===
				receipt.requests.length &&
			receipt.events.filter((event) => event.type === "reader-reply").length ===
				receipt.requests.length &&
			!receipt.events.some((event) => event.type === "spawn-throw" || event.type === "fallback"),
		code,
	);
	let previousReply = 0;
	for (const [index, request] of receipt.requests.entries()) {
		const sent = receipt.events.filter(
			(event) => event.type === "reader-request" && event.id === request.id,
		);
		const replies = receipt.events.filter(
			(event) => event.type === "reader-reply" && event.id === request.id,
		);
		const reply = replies[0];
		observationCheck(
			request.id === index + 1 &&
				request.child === child.id &&
				request.pid === (index === 0 ? hubPid : targetPid) &&
				request.role === (index === 0 ? "self-check" : "target") &&
				(request.write === "accepted" || request.write === "backpressure") &&
				request.reply === "value" &&
				positiveBytes(request.value) &&
				sent.length === 1 &&
				replies.length === 1 &&
				sent[0]?.child === child.id &&
				sent[0].pid === request.pid &&
				sent[0].seq > previousReply &&
				reply?.child === child.id &&
				reply.pid === request.pid &&
				reply.value === request.value &&
				reply.state === "value" &&
				reply.seq > sent[0].seq,
			code,
		);
		previousReply = reply.seq;
	}
	observationCheck(
		receipt.requests.slice(1).some((request) => (request.value ?? 0) > limitBytes) &&
			previousReply < (receipt.events.find((event) => event.type === "close-boundary")?.seq ?? 0),
		code,
	);
}

interface Hook {
	readonly object: object;
	readonly key: string;
	readonly before: PropertyDescriptor | undefined;
	readonly wrapper: Call;
}
interface ChildState {
	readonly id: number;
	readonly handle: object;
	readonly kind: "reader" | "tasklist";
	readonly pid: number | undefined;
	spawned: boolean;
	errors: number;
	exit: Status | undefined;
	close: Status | undefined;
	buffer: string;
	bytes: number;
	pending: MutableRequest[];
}
type MutableRequest = { -readonly [Key in keyof ReaderRequest]: ReaderRequest[Key] };
type MutableReply = { -readonly [Key in keyof TasklistReply]: TasklistReply[Key] };

function validPid(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function object(value: unknown): value is object {
	return typeof value === "object" && value !== null && !isProxy(value);
}

function ownData(value: object, key: string): PropertyDescriptor | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor !== undefined && "value" in descriptor ? descriptor : undefined;
}

// Reflection never reaches a proxy or invokes an accessor. Only small inert data trees match.
function dataFields(value: unknown): Record<string, PropertyDescriptor> | undefined {
	if (!object(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
		return undefined;
	const fields = Object.getOwnPropertyDescriptors(value);
	if (Reflect.ownKeys(fields).length > 32) return undefined;
	for (const key of Reflect.ownKeys(fields)) {
		if (typeof key !== "string" || !("value" in (fields[key] as PropertyDescriptor)))
			return undefined;
	}
	return fields;
}

function sameData(actual: unknown, expected: unknown, depth = 0): boolean {
	if (actual === expected) return true;
	if (depth > 6 || typeof actual !== typeof expected) return false;
	const left = dataFields(actual);
	const right = dataFields(expected);
	if (
		left === undefined ||
		right === undefined ||
		Array.isArray(actual) !== Array.isArray(expected)
	)
		return false;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every(
		(key) => Object.hasOwn(right, key) && sameData(left[key]?.value, right[key]?.value, depth + 1),
	);
}

function copyData(value: unknown, depth = 0, budget = { left: 256 }): Data {
	if (--budget.left < 0) throw new TypeError("OBSERVER_BINDINGS_INVALID");
	if (typeof value === "string" && value.length <= LIMITS.bytes) return value;
	if (
		value === null ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isSafeInteger(value))
	)
		return value;
	const fields = depth <= 6 ? dataFields(value) : undefined;
	if (fields === undefined) throw new TypeError("OBSERVER_BINDINGS_INVALID");
	if (Array.isArray(value)) {
		const length = fields.length?.value;
		if (
			!Number.isInteger(length) ||
			length < 0 ||
			length > 32 ||
			Object.keys(fields).length !== length + 1
		)
			throw new TypeError("OBSERVER_BINDINGS_INVALID");
		return Object.freeze(
			Array.from({ length }, (_, index) =>
				copyData(fields[String(index)]?.value, depth + 1, budget),
			),
		);
	}
	const result: Record<string, Data> = Object.create(null);
	for (const key of Object.keys(fields))
		result[key] = copyData(fields[key]?.value, depth + 1, budget);
	return Object.freeze(result);
}

function freezeData<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freezeData(child);
		Object.freeze(value);
	}
	return value;
}

function method(value: object, key: string): Call | undefined {
	let current: object | null = value;
	for (let depth = 0; current !== null && depth < 8; depth++) {
		if (isProxy(current)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (descriptor !== undefined)
			return "value" in descriptor &&
				typeof descriptor.value === "function" &&
				!isProxy(descriptor.value)
				? (descriptor.value as Call)
				: undefined;
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function errorCode(value: unknown): ErrorCode {
	if (!object(value)) return "OTHER";
	const code = ownData(value, "code")?.value;
	return code === "EACCES" ||
		code === "EPERM" ||
		code === "ENOENT" ||
		code === "ENOSYS" ||
		code === "ETIMEDOUT"
		? code
		: "OTHER";
}

function status(args: unknown[]): Status {
	return {
		code: typeof args[0] === "number" && Number.isSafeInteger(args[0]) ? args[0] : null,
		signal:
			args[1] === null || args[1] === undefined
				? null
				: args[1] === "SIGTERM" || args[1] === "SIGKILL" || args[1] === "SIGINT"
					? args[1]
					: "OTHER",
	};
}

/**
 * Captures calls made through the supplied object. A receipt is data, not native evidence or
 * policy authority. Only objects actually returned by matched delegate calls enter private state.
 */
export function createWindowsSamplerObserver(
	delegate: object,
	bindings: WindowsSamplerBindings,
): WindowsSamplerObserver {
	const expected = copyData(bindings) as unknown as WindowsSamplerBindings;
	if (
		!validPid(expected.hubPid) ||
		!validPid(expected.targetPid) ||
		!Array.isArray(expected.reader) ||
		!Array.isArray(expected.tasklist) ||
		expected.reader.length !== 3 ||
		expected.tasklist.length !== 3
	)
		throw new TypeError("OBSERVER_BINDINGS_INVALID");
	if (!object(delegate)) throw new TypeError("OBSERVER_DELEGATE_INVALID");
	const realSpawn = method(delegate, "spawn");
	const realExec = method(delegate, "execFile");
	if (realSpawn === undefined || realExec === undefined)
		throw new TypeError("OBSERVER_DELEGATE_INVALID");
	const hooks: Hook[] = [];
	const children = new Map<object, ChildState>();
	const events: ObservationEvent[] = [];
	const faults = new Set<Fault>();
	const requests: MutableRequest[] = [];
	const replies: MutableReply[] = [];
	const launches = { reader: 0, tasklist: 0, unmatched: 0, unmatchedAfterClose: 0, afterClose: 0 };
	let closed = false;
	let restored = false;
	let fallbackCount = 0;
	const refuse = (code: Fault): void => {
		faults.add(code);
	};
	const capture = (body: () => void): void => {
		if (restored) return;
		try {
			body();
		} catch {
			refuse("OBSERVATION_ERROR");
		}
	};
	const bump = (value: number): number => {
		if (value >= LIMITS.events) {
			refuse("OBSERVATION_LIMIT");
			return LIMITS.events + 1;
		}
		return value + 1;
	};
	const record = (type: string, fields: Omit<ObservationEvent, "seq" | "type"> = {}): void => {
		if (events.length >= LIMITS.events) {
			refuse("OBSERVATION_LIMIT");
			return;
		}
		events.push(Object.freeze({ seq: events.length + 1, type, ...fields }));
	};
	const hook = (value: object, key: string, wrap: (original: Call) => Call): boolean => {
		const original = method(value, key);
		if (original === undefined) return false;
		const before = Object.getOwnPropertyDescriptor(value, key);
		if (
			before !== undefined &&
			(!("value" in before) || (!before.configurable && !before.writable))
		)
			return false;
		const wrapper = wrap(original);
		Object.defineProperty(
			value,
			key,
			before === undefined
				? { value: wrapper, configurable: true, writable: true, enumerable: false }
				: { ...before, value: wrapper },
		);
		hooks.push({ object: value, key, before, wrapper });
		return true;
	};
	const matches = (args: unknown[], tuple: Tuple, callback: boolean): boolean => {
		try {
			return (
				args.length === (callback ? 4 : 3) &&
				args[0] === tuple[0] &&
				(!callback || (typeof args[3] === "function" && !isProxy(args[3]))) &&
				sameData(args.slice(0, 3), tuple)
			);
		} catch {
			return false;
		}
	};
	const launched = (kind: "reader" | "tasklist" | "unmatched"): void => {
		const telemetry = (value: number): number => Math.min(value + 1, LIMITS.events + 1);
		launches[kind] = kind === "unmatched" ? telemetry(launches[kind]) : bump(launches[kind]);
		if (closed && kind === "unmatched")
			launches.unmatchedAfterClose = telemetry(launches.unmatchedAfterClose);
		if (closed && kind !== "unmatched") {
			launches.afterClose = bump(launches.afterClose);
			refuse("NEW_LAUNCH_AFTER_CLOSE");
		}
		if (kind !== "unmatched") record("launch-attempt", { kind });
	};
	const data = (child: ChildState, chunk: unknown): void => {
		if (typeof chunk !== "string") {
			refuse("READER_REPLY_INVALID");
			return;
		}
		child.bytes = Math.min(LIMITS.bytes + 1, child.bytes + chunk.length);
		if (child.bytes > LIMITS.bytes || child.buffer.length + chunk.length > LIMITS.bytes) {
			refuse("OBSERVATION_LIMIT");
			child.buffer = "";
			return;
		}
		child.buffer += chunk;
		for (;;) {
			const end = child.buffer.indexOf("\n");
			if (end < 0) break;
			const line = child.buffer.slice(0, end).replace(/\r$/, "");
			child.buffer = child.buffer.slice(end + 1);
			const request = child.pending.shift();
			if (request === undefined) {
				refuse("READER_REPLY_UNEXPECTED");
				continue;
			}
			const value = parseReaderLine(line);
			request.reply = line === "x" ? "unreadable" : value === undefined ? "malformed" : "value";
			if (value !== undefined) request.value = value;
			if (request.reply === "malformed") refuse("READER_REPLY_INVALID");
			record("reader-reply", {
				id: request.id,
				child: child.id,
				pid: request.pid,
				value,
				state: request.reply,
			});
		}
		if (child.buffer.length > LIMITS.line) {
			refuse("OBSERVATION_LIMIT");
			child.buffer = "";
		}
	};
	const track = (returned: unknown, kind: "reader" | "tasklist"): void => {
		if (!object(returned) || children.has(returned)) {
			refuse("CHILD_UNOBSERVABLE");
			return;
		}
		if (children.size >= LIMITS.children) {
			refuse("OBSERVATION_LIMIT");
			return;
		}
		const pidField = Object.getOwnPropertyDescriptor(returned, "pid");
		if (pidField !== undefined && !("value" in pidField)) {
			refuse("CHILD_UNOBSERVABLE");
			return;
		}
		const pid = pidField?.value;
		if (pid !== undefined && !validPid(pid)) {
			refuse("CHILD_UNOBSERVABLE");
			return;
		}
		const state: ChildState = {
			id: children.size + 1,
			handle: returned,
			kind,
			pid,
			spawned: false,
			errors: 0,
			exit: undefined,
			close: undefined,
			buffer: "",
			bytes: 0,
			pending: [],
		};
		children.set(returned, state);
		record("child-returned", { child: state.id, kind, pid });
		if (
			!hook(
				returned,
				"emit",
				(original) =>
					function (this: unknown, ...args: unknown[]) {
						if (this !== returned) return Reflect.apply(original, this, args);
						capture(() => {
							if (args[0] === "spawn") {
								state.spawned = true;
								record("spawn", { child: state.id, kind, pid });
							} else if (args[0] === "error") {
								state.errors = bump(state.errors);
								record("child-error", { child: state.id, kind, error: errorCode(args[1]) });
							} else if (args[0] === "exit") {
								state.exit = status(args.slice(1));
								record("exit", { child: state.id, kind });
							} else if (args[0] === "close") {
								state.close = status(args.slice(1));
								record("close", { child: state.id, kind });
							}
						});
						return Reflect.apply(original, this, args);
					},
			)
		)
			refuse("CHILD_UNOBSERVABLE");
		if (kind !== "reader") return;
		const input = ownData(returned, "stdin")?.value;
		const output = ownData(returned, "stdout")?.value;
		if (!object(input) || !object(output)) {
			if (pid !== undefined) refuse("STREAM_UNOBSERVABLE");
			return;
		}
		if (
			!hook(
				input,
				"write",
				(original) =>
					function (this: unknown, ...args: unknown[]) {
						if (this !== input) return Reflect.apply(original, this, args);
						let request: MutableRequest | undefined;
						capture(() => {
							const text = args[0];
							if (typeof text !== "string" || !/^[0-9]{1,16}\n$/.test(text)) {
								refuse("READER_REQUEST_INVALID");
								return;
							}
							const number = Number(text.slice(0, -1));
							const first = requests.every((entry) => entry.child !== state.id);
							if (!validPid(number) || number !== (first ? expected.hubPid : expected.targetPid)) {
								refuse("READER_REQUEST_INVALID");
								return;
							}
							if (requests.length >= LIMITS.requests) {
								refuse("OBSERVATION_LIMIT");
								return;
							}
							request = {
								id: requests.length + 1,
								child: state.id,
								pid: number,
								role: first ? "self-check" : "target",
								write: "pending",
								reply: "pending",
							};
							requests.push(request);
							state.pending.push(request);
							record("reader-request", {
								child: state.id,
								id: request.id,
								pid: number,
								state: request.role,
							});
						});
						try {
							const result = Reflect.apply(original, this, args);
							capture(() => {
								if (request !== undefined)
									request.write = result === false ? "backpressure" : "accepted";
							});
							return result;
						} catch (error) {
							capture(() => {
								if (request !== undefined) {
									request.write = "threw";
									state.pending = state.pending.filter((entry) => entry !== request);
								}
								record("write-throw", { child: state.id, error: errorCode(error) });
							});
							throw error;
						}
					},
			)
		)
			refuse("STREAM_UNOBSERVABLE");
		if (
			!hook(
				output,
				"emit",
				(original) =>
					function (this: unknown, ...args: unknown[]) {
						if (this !== output) return Reflect.apply(original, this, args);
						capture(() => {
							if (args[0] === "data") data(state, args[1]);
						});
						return Reflect.apply(original, this, args);
					},
			)
		)
			refuse("STREAM_UNOBSERVABLE");
	};
	const snapshot = (): WindowsSamplerReceipt =>
		freezeData({
			scope: "capture-only" as const,
			events: [...events],
			faults: [...faults],
			children: [...children.values()].map((child) => ({
				id: child.id,
				kind: child.kind,
				pid: child.pid,
				branch: child.spawned
					? ("started" as const)
					: child.pid === undefined
						? ("no-pid" as const)
						: ("unconfirmed" as const),
				errors: child.errors,
				exit: child.exit,
				close: child.close,
			})),
			requests: requests.map((request) => ({ ...request })),
			tasklist: replies.map((reply) => ({ ...reply })),
			launches: { ...launches },
			fallbackCount,
			closeBoundary: closed,
			restored,
		});
	const unsettled = (): readonly number[] =>
		Object.freeze(
			[...children.values()]
				.filter((child) =>
					child.pid === undefined
						? child.errors === 0 || child.close === undefined
						: child.exit === undefined || child.close === undefined,
				)
				.map((child) => child.id),
		);
	const restore = (): WindowsSamplerReceipt => {
		if (!restored) {
			if (unsettled().length > 0) refuse("UNSETTLED_CHILD");
			for (const entry of hooks.toReversed())
				capture(() => {
					if (ownData(entry.object, entry.key)?.value !== entry.wrapper) {
						refuse("RESTORE_CONFLICT");
						return;
					}
					if (entry.before === undefined) {
						if (!Reflect.deleteProperty(entry.object, entry.key)) refuse("RESTORE_CONFLICT");
					} else Object.defineProperty(entry.object, entry.key, entry.before);
				});
			restored = true;
		}
		return snapshot();
	};
	try {
		if (
			!hook(
				delegate,
				"spawn",
				() =>
					function (this: unknown, ...args: unknown[]) {
						if (restored) return Reflect.apply(realSpawn, this, args);
						const matched = matches(args, expected.reader, false);
						capture(() => launched(matched ? "reader" : "unmatched"));
						try {
							const child = Reflect.apply(realSpawn, this, args);
							if (matched && !restored) capture(() => track(child, "reader"));
							return child;
						} catch (error) {
							if (matched)
								capture(() => record("spawn-throw", { kind: "reader", error: errorCode(error) }));
							throw error;
						}
					},
			) ||
			!hook(
				delegate,
				"execFile",
				() =>
					function (this: unknown, ...args: unknown[]) {
						if (restored) return Reflect.apply(realExec, this, args);
						const matched = matches(args, expected.tasklist, true);
						capture(() => launched(matched ? "tasklist" : "unmatched"));
						if (!matched) return Reflect.apply(realExec, this, args);
						let call: MutableReply | undefined;
						capture(() => {
							if (replies.length >= LIMITS.calls) refuse("OBSERVATION_LIMIT");
							else {
								call = { id: replies.length + 1, callbacks: 0, value: undefined, error: undefined };
								replies.push(call);
							}
						});
						const callback = args[3] as Call;
						const forwarded = [...args];
						let callbackThrown: unknown;
						let callbackDidThrow = false;
						forwarded[3] = function (this: unknown, ...reply: unknown[]) {
							capture(() => {
								if (call === undefined) return;
								call.callbacks = bump(call.callbacks);
								if (call.callbacks > 1) refuse("CALLBACK_REPEATED");
								call.error = reply[0] ? errorCode(reply[0]) : undefined;
								if (!reply[0] && typeof reply[1] === "string" && reply[1].length <= LIMITS.bytes)
									call.value = parseTasklistCsv(reply[1], expected.targetPid);
								else {
									call.value = undefined;
									if (!reply[0]) refuse("CALLBACK_INVALID");
								}
								record("tasklist-reply", {
									id: call.id,
									pid: expected.targetPid,
									value: call.value,
									error: call.error,
								});
							});
							try {
								return Reflect.apply(callback, this, reply);
							} catch (error) {
								callbackThrown = error;
								callbackDidThrow = true;
								capture(() => record("callback-throw", { id: call?.id, error: errorCode(error) }));
								throw error;
							}
						};
						try {
							const child = Reflect.apply(realExec, this, forwarded);
							if (!restored) capture(() => track(child, "tasklist"));
							return child;
						} catch (error) {
							if (!callbackDidThrow || error !== callbackThrown)
								capture(() => record("spawn-throw", { kind: "tasklist", error: errorCode(error) }));
							throw error;
						}
					},
			)
		)
			throw new TypeError("OBSERVER_INSTALL_REFUSED");
	} catch (error) {
		restore();
		throw error;
	}
	return Object.freeze({
		fallback(): void {
			capture(() => {
				fallbackCount = bump(fallbackCount);
				record("fallback");
			});
		},
		closeBoundary(): void {
			capture(() => {
				if (!closed) {
					closed = true;
					record("close-boundary");
				}
			});
		},
		snapshot,
		unsettled,
		restore,
	});
}
