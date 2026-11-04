import path from "node:path";
import { isProxy } from "node:util/types";

const WIRE_BYTES = 65_536;
const REPORT_BYTES = 1024 * 1024;
const LIMIT_BYTES = 536_870_912;
const route = "supervisor-windows-policy";
type Reason = "wire" | "shape" | "binding" | "trace" | "report" | "selection";

/** Captured and reported DATA consistency only; never policy or process authority. */
export class WindowsSupervisorReceiptError extends Error {
	readonly code = "WINDOWS_SUPERVISOR_RECEIPT_INVALID";
	readonly reason: Reason;
	constructor(reason: Reason) {
		super("Windows supervisor receipt is inconsistent");
		this.name = "WindowsSupervisorReceiptError";
		this.reason = reason;
	}
}
const refuse = (reason: Reason): never => {
	throw new WindowsSupervisorReceiptError(reason);
};
function check(value: unknown, reason: Reason): asserts value {
	if (!value) refuse(reason);
}
type Row = Record<string, unknown>;
function object(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
	exact = true,
): Row {
	check(value !== null && typeof value === "object" && !isProxy(value), "shape");
	check([Object.prototype, null].includes(Object.getPrototypeOf(value)), "shape");
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Reflect.ownKeys(descriptors);
	check(
		keys.every(
			(key) => typeof key === "string" && (!exact || [...required, ...optional].includes(key)),
		),
		"shape",
	);
	const copy: Row = Object.create(null);
	for (const key of keys) {
		const descriptor = descriptors[key as string];
		check(descriptor && Object.hasOwn(descriptor, "value"), "shape");
		copy[key as string] = descriptor.value;
	}
	check(
		required.every((key) => Object.hasOwn(copy, key)),
		"shape",
	);
	return copy;
}
function array(value: unknown, maximum: number): unknown[] {
	check(!isProxy(value) && Array.isArray(value), "shape");
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
	check(typeof length === "number" && Number.isSafeInteger(length) && length <= maximum, "shape");
	check(Reflect.ownKeys(value).length === length + 1, "shape");
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		check(descriptor && Object.hasOwn(descriptor, "value"), "shape");
		result.push(descriptor.value);
	}
	return result;
}
function integer(value: unknown, minimum = 0): number {
	check(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum, "shape");
	return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
	check(typeof value === "string" && values.includes(value as T), "shape");
	return value as T;
}
function optionalInteger(row: Row, name: string, minimum = 0): number | undefined {
	return Object.hasOwn(row, name) ? integer(row[name], minimum) : undefined;
}
function parseJson(value: unknown, maximum: number, canonical: boolean): unknown {
	check(typeof value === "string", "wire");
	let text = value;
	if (canonical) {
		if (text.endsWith("\r\n")) text = text.slice(0, -2);
		else if (text.endsWith("\n")) text = text.slice(0, -1);
	}
	check(Buffer.byteLength(text, "utf8") <= maximum, "wire");
	try {
		const parsed: unknown = JSON.parse(text);
		// Capture producers use JSON.stringify. This also rejects escaped duplicate keys.
		if (canonical && JSON.stringify(parsed) !== text) refuse("wire");
		return parsed;
	} catch {
		return refuse("wire");
	}
}
interface Binding {
	readonly source: string;
	readonly route: typeof route;
	readonly admissionRef: string;
	readonly case: "A" | "B";
}
function binding(value: unknown): Binding {
	const row = object(value, ["source", "route", "admissionRef", "case"]);
	check(typeof row.source === "string" && /^[0-9a-f]{40}$/.test(row.source), "binding");
	check(row.route === route, "binding");
	check(
		typeof row.admissionRef === "string" &&
			/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.admissionRef),
		"binding",
	);
	return {
		source: row.source,
		route,
		admissionRef: row.admissionRef,
		case: choice(row.case, ["A", "B"]),
	};
}
const errors = ["EACCES", "EPERM", "ENOENT", "ENOSYS", "ETIMEDOUT", "OTHER"] as const;
const signals = ["SIGTERM", "SIGKILL", "SIGINT", "OTHER"] as const;
interface Status {
	readonly code: number | null;
	readonly signal: string | null;
}
function status(value: unknown): Status {
	const row = object(value, ["code", "signal"]);
	check(
		row.code === null || (typeof row.code === "number" && Number.isSafeInteger(row.code)),
		"shape",
	);
	return {
		code: row.code as number | null,
		signal: row.signal === null ? null : choice(row.signal, signals),
	};
}
interface Child {
	readonly id: number;
	readonly kind: "reader" | "tasklist";
	readonly branch: "started" | "no-pid" | "unconfirmed";
	readonly errors: number;
	readonly pid: number | undefined;
	readonly exit: Status | undefined;
	readonly close: Status | undefined;
}
interface Request {
	readonly id: number;
	readonly child: number;
	readonly pid: number;
	readonly role: "self-check" | "target";
	readonly write: "pending" | "accepted" | "backpressure" | "threw";
	readonly reply: "pending" | "value" | "unreadable" | "malformed";
	readonly value: number | undefined;
}
interface ToolReply {
	readonly id: number;
	readonly callbacks: number;
	readonly value: number | undefined;
	readonly error: string | undefined;
}
const eventFields: Readonly<Record<string, readonly [readonly string[], readonly string[]]>> = {
	"launch-attempt": [["kind"], []],
	"reader-request": [["child", "id", "pid", "state"], []],
	"reader-reply": [["child", "id", "pid", "state"], ["value"]],
	"write-throw": [["child", "error"], []],
	"child-returned": [["child", "kind"], ["pid"]],
	spawn: [["child", "kind"], ["pid"]],
	"child-error": [["child", "kind", "error"], []],
	exit: [["child", "kind"], []],
	close: [["child", "kind"], []],
	"spawn-throw": [["kind", "error"], []],
	"tasklist-reply": [
		["id", "pid"],
		["value", "error"],
	],
	"callback-throw": [["error"], ["id"]],
	fallback: [[], []],
	"close-boundary": [[], []],
};
interface Event {
	readonly seq: number;
	readonly type: string;
	readonly kind: "reader" | "tasklist" | undefined;
	readonly child: number | undefined;
	readonly id: number | undefined;
	readonly pid: number | undefined;
	readonly value: number | undefined;
	readonly state: string | undefined;
	readonly error: string | undefined;
}
function event(value: unknown): Event {
	const initial = object(
		value,
		["seq", "type"],
		["kind", "child", "id", "pid", "value", "state", "error"],
	);
	check(typeof initial.type === "string" && Object.hasOwn(eventFields, initial.type), "shape");
	const fields = eventFields[initial.type];
	check(fields, "shape");
	const row = object(value, ["seq", "type", ...fields[0]], fields[1]);
	let state: string | undefined;
	if (row.type === "reader-request") state = choice(row.state, ["self-check", "target"]);
	if (row.type === "reader-reply") state = choice(row.state, ["value", "unreadable", "malformed"]);
	return {
		seq: integer(row.seq, 1),
		type: initial.type,
		kind: Object.hasOwn(row, "kind")
			? choice<"reader" | "tasklist">(row.kind, ["reader", "tasklist"])
			: undefined,
		child: optionalInteger(row, "child", 1),
		id: optionalInteger(row, "id", 1),
		pid: optionalInteger(row, "pid", 1),
		value: optionalInteger(row, "value"),
		state,
		error: Object.hasOwn(row, "error") ? choice(row.error, errors) : undefined,
	};
}
interface Receipt {
	readonly events: readonly Event[];
	readonly children: readonly Child[];
	readonly requests: readonly Request[];
	readonly tasklist: readonly ToolReply[];
	readonly launches: Readonly<{
		reader: number;
		tasklist: number;
		unmatched: number;
		unmatchedAfterClose: number;
		afterClose: number;
	}>;
	readonly fallbackCount: number;
}
function receipt(value: unknown): Receipt {
	const row = object(value, [
		"scope",
		"events",
		"faults",
		"children",
		"requests",
		"tasklist",
		"launches",
		"fallbackCount",
		"closeBoundary",
		"restored",
	]);
	check(
		row.scope === "capture-only" && row.closeBoundary === true && row.restored === true,
		"trace",
	);
	check(array(row.faults, 0).length === 0, "trace");
	const launches = object(row.launches, [
		"reader",
		"tasklist",
		"unmatched",
		"unmatchedAfterClose",
		"afterClose",
	]);
	const children = array(row.children, 8).map((item): Child => {
		const child = object(item, ["id", "kind", "branch", "errors", "close"], ["pid", "exit"]);
		return {
			id: integer(child.id, 1),
			kind: choice(child.kind, ["reader", "tasklist"]),
			branch: choice(child.branch, ["started", "no-pid", "unconfirmed"]),
			errors: integer(child.errors),
			pid: optionalInteger(child, "pid", 1),
			close: status(child.close),
			exit: Object.hasOwn(child, "exit") ? status(child.exit) : undefined,
		};
	});
	const requests = array(row.requests, 64).map((item): Request => {
		const request = object(item, ["id", "child", "pid", "role", "write", "reply"], ["value"]);
		return {
			id: integer(request.id, 1),
			child: integer(request.child, 1),
			pid: integer(request.pid, 1),
			role: choice(request.role, ["self-check", "target"]),
			write: choice(request.write, ["pending", "accepted", "backpressure", "threw"]),
			reply: choice(request.reply, ["pending", "value", "unreadable", "malformed"]),
			value: optionalInteger(request, "value"),
		};
	});
	const tasklist = array(row.tasklist, 32).map((item): ToolReply => {
		const reply = object(item, ["id", "callbacks"], ["value", "error"]);
		return {
			id: integer(reply.id, 1),
			callbacks: integer(reply.callbacks),
			value: optionalInteger(reply, "value"),
			error: Object.hasOwn(reply, "error") ? choice(reply.error, errors) : undefined,
		};
	});
	const result: Receipt = {
		events: array(row.events, 256).map(event),
		children,
		requests,
		tasklist,
		launches: {
			reader: integer(launches.reader),
			tasklist: integer(launches.tasklist),
			unmatched: integer(launches.unmatched),
			unmatchedAfterClose: integer(launches.unmatchedAfterClose),
			afterClose: integer(launches.afterClose),
		},
		fallbackCount: integer(row.fallbackCount),
	};
	closed(result);
	return result;
}
const events = (value: Receipt, type: string, child?: number): readonly Event[] =>
	value.events.filter(
		(item) => item.type === type && (child === undefined || item.child === child),
	);
function one(value: readonly Event[]): Event {
	check(value.length === 1 && value[0], "trace");
	return value[0];
}
function closed(value: Receipt): void {
	check(value.launches.afterClose === 0, "trace");
	check(
		value.events.every((item, index) => item.seq === index + 1),
		"trace",
	);
	check(
		value.children.every((child, index) => child.id === index + 1),
		"trace",
	);
	const boundary = one(events(value, "close-boundary"));
	check(
		value.events.every(
			(item) =>
				(item.type !== "launch-attempt" && item.type !== "reader-request") ||
				item.seq < boundary.seq,
		),
		"trace",
	);
	for (const item of value.events) {
		if (item.child !== undefined) {
			const child = value.children[item.child - 1];
			check(child && (item.kind === undefined || item.kind === child.kind), "trace");
		}
	}
	for (const child of value.children) {
		check(child.close && child.branch !== "unconfirmed", "trace");
		check(
			child.branch === "started"
				? child.pid !== undefined && child.exit !== undefined
				: child.pid === undefined && child.errors > 0 && child.exit === undefined,
			"trace",
		);
		const returned = one(events(value, "child-returned", child.id));
		const close = one(events(value, "close", child.id));
		check(
			returned.kind === child.kind && close.kind === child.kind && returned.pid === child.pid,
			"trace",
		);
		// Global teardown can precede drain; only the matched child close ends its reader IO.
		check(
			value.events.every(
				(item) =>
					item.child !== child.id ||
					(item.type !== "reader-request" && item.type !== "reader-reply") ||
					(returned.seq < item.seq && item.seq < close.seq),
			),
			"trace",
		);
		for (const type of ["spawn", "exit", "child-error"]) {
			const matching = events(value, type, child.id);
			check(
				matching.every((item) => item.kind === child.kind),
				"trace",
			);
			check(
				matching.length ===
					(type === "child-error" ? child.errors : child.branch === "started" ? 1 : 0),
				"trace",
			);
		}
		if (child.branch === "started") {
			const spawn = one(events(value, "spawn", child.id));
			const exit = one(events(value, "exit", child.id));
			check(
				(spawn.pid === undefined || spawn.pid === child.pid) &&
					returned.seq < spawn.seq &&
					spawn.seq < exit.seq &&
					exit.seq < close.seq,
				"trace",
			);
		}
	}
}
function primary(value: Receipt, hubPid: number, targetPid: number): void {
	const child = value.children[0];
	check(
		hubPid !== targetPid &&
			value.launches.reader === 1 &&
			value.launches.tasklist === 0 &&
			value.fallbackCount === 0 &&
			value.tasklist.length === 0 &&
			value.children.length === 1 &&
			child?.kind === "reader" &&
			child.branch === "started" &&
			child.errors === 0 &&
			value.requests.length >= 2 &&
			events(value, "launch-attempt").length === 1 &&
			events(value, "reader-request").length === value.requests.length &&
			events(value, "reader-reply").length === value.requests.length &&
			!value.events.some((item) => item.type === "spawn-throw" || item.type === "fallback"),
		"trace",
	);
	check(events(value, "launch-attempt")[0]?.kind === "reader", "trace");
	let previous = 0;
	for (const [index, request] of value.requests.entries()) {
		const sent = one(
			value.events.filter((item) => item.type === "reader-request" && item.id === request.id),
		);
		const reply = one(
			value.events.filter((item) => item.type === "reader-reply" && item.id === request.id),
		);
		check(
			request.id === index + 1 &&
				request.child === child.id &&
				request.pid === (index === 0 ? hubPid : targetPid) &&
				request.role === (index === 0 ? "self-check" : "target") &&
				(request.write === "accepted" || request.write === "backpressure") &&
				request.reply === "value" &&
				request.value !== undefined &&
				request.value > 0 &&
				sent.child === child.id &&
				sent.pid === request.pid &&
				sent.state === request.role &&
				sent.seq > previous &&
				reply.child === child.id &&
				reply.pid === request.pid &&
				reply.value === request.value &&
				reply.state === "value" &&
				reply.seq > sent.seq,
			"trace",
		);
		previous = reply.seq;
	}
	check(
		value.requests.slice(1).some((request) => (request.value ?? 0) > LIMIT_BYTES) &&
			previous < one(events(value, "close-boundary")).seq,
		"trace",
	);
}
function fallback(value: Receipt, targetPid: number, samples: readonly number[]): void {
	check(
		samples.length === 2 &&
			samples.every((sample) => sample > 0) &&
			value.launches.unmatchedAfterClose === 0 &&
			value.launches.reader === 1 &&
			value.launches.tasklist === 2 &&
			value.fallbackCount === 1 &&
			value.tasklist.length === 2 &&
			value.requests.length <= 1,
		"trace",
	);
	const readers = value.children.filter((child) => child.kind === "reader");
	const tools = value.children.filter((child) => child.kind === "tasklist");
	const throws = value.events.filter(
		(item) => item.type === "spawn-throw" && item.kind === "reader",
	);
	check(
		tools.length === 2 &&
			readers.length <= 1 &&
			(readers.length === 0 ? throws.length === 1 : throws.length === 0) &&
			(readers[0]?.branch !== "started" || value.requests.length === 1) &&
			events(value, "reader-request").length === value.requests.length,
		"trace",
	);
	for (const child of tools)
		check(
			child.branch === "started" &&
				child.errors === 0 &&
				child.exit?.code === 0 &&
				child.exit.signal === null &&
				child.close?.code === 0 &&
				child.close.signal === null,
			"trace",
		);
	const fall = one(events(value, "fallback"));
	for (const request of value.requests) {
		const sent = one(
			value.events.filter((item) => item.type === "reader-request" && item.id === request.id),
		);
		check(
			request.id === 1 &&
				request.child === readers[0]?.id &&
				request.pid === targetPid &&
				request.role === "self-check" &&
				request.write !== "pending" &&
				request.reply !== "value" &&
				request.reply !== "malformed" &&
				request.value === undefined &&
				sent.child === request.child &&
				sent.pid === targetPid &&
				sent.state === "self-check" &&
				sent.seq < fall.seq,
			"trace",
		);
	}
	const readerReplies = events(value, "reader-reply");
	check(
		readerReplies.length ===
			value.requests.filter((request) => request.reply === "unreadable").length,
		"trace",
	);
	for (const reply of readerReplies) {
		const request = value.requests.find((entry) => entry.id === reply.id);
		const sent = value.events.find(
			(entry) => entry.type === "reader-request" && entry.id === reply.id,
		);
		check(
			request &&
				sent &&
				reply.state === "unreadable" &&
				reply.value === undefined &&
				reply.child === request.child &&
				reply.pid === request.pid &&
				request.reply === "unreadable" &&
				reply.seq > sent.seq,
			"trace",
		);
	}
	const launches = events(value, "launch-attempt");
	const callbacks = events(value, "tasklist-reply");
	const boundary = one(events(value, "close-boundary"));
	check(
		launches.length === 3 &&
			callbacks.length === 2 &&
			launches[0]?.kind === "reader" &&
			launches[1]?.kind === "tasklist" &&
			launches[2]?.kind === "tasklist" &&
			launches[0].seq < fall.seq &&
			fall.seq < launches[1].seq &&
			(callbacks[0]?.seq ?? Infinity) < launches[2].seq &&
			(callbacks[1]?.seq ?? Infinity) < boundary.seq,
		"trace",
	);
	for (const [index, reply] of value.tasklist.entries()) {
		const callback = callbacks[index];
		check(
			reply.id === index + 1 &&
				reply.callbacks === 1 &&
				reply.error === undefined &&
				reply.value !== undefined &&
				reply.value > 0 &&
				reply.value === samples[index] &&
				callback?.id === reply.id &&
				callback.pid === targetPid &&
				callback.value === reply.value &&
				callback.error === undefined &&
				callback.seq > (launches[index + 1]?.seq ?? Infinity),
			"trace",
		);
	}
}

export type WindowsSupervisorCaseId = "A.growing" | "A.untouched" | "B.natural";
interface WindowsSupervisorCaseDefinition {
	readonly id: WindowsSupervisorCaseId;
	readonly case: "A" | "B";
	readonly measurement: "growing" | "untouched" | undefined;
	readonly file: string;
	readonly suite: string;
	readonly title: string;
}
export const windowsSupervisorCases: readonly WindowsSupervisorCaseDefinition[] = Object.freeze([
	Object.freeze({
		id: "A.growing",
		case: "A",
		measurement: "growing",
		file: "apps/hub/test/plugins/supervisor.heavy.test.ts",
		suite: "memory watchdog with the real sampler",
		title: "kills a growing plugin above 512 MiB within two ticks",
	}),
	Object.freeze({
		id: "A.untouched",
		case: "A",
		measurement: "untouched",
		file: "apps/hub/test/plugins/supervisor.heavy.test.ts",
		suite: "memory watchdog with the real sampler",
		title: "counts committed but untouched memory on Windows",
	}),
	Object.freeze({
		id: "B.natural",
		case: "B",
		measurement: undefined,
		file: "apps/hub/test/plugins/supervisor-windows-policy.native.ts",
		suite: "",
		title: "observes natural Windows sampler fallback with the unmodified reader",
	}),
] as const);
export interface WindowsSupervisorCaptureInput {
	readonly id: WindowsSupervisorCaseId;
	readonly json: string;
	readonly expected: Readonly<{
		source: string;
		route: typeof route;
		admissionRef: string;
		case: "A" | "B";
	}>;
	readonly hubPid: number;
	readonly targetPid: number;
}
export interface WindowsSupervisorReports {
	readonly A: string;
	readonly B: string;
}
export interface WindowsSupervisorReportedConsistency {
	readonly scope: "reported-consistency";
	readonly source: string;
	readonly cases: readonly WindowsSupervisorCaseId[];
	readonly reportedPassed: 3;
	readonly reportedFiltered: 6;
}
function framework(value: unknown, directory: string, group: "A" | "B"): void {
	const parsed = parseJson(value, REPORT_BYTES, false);
	// The fields below are the delivered public native-supervisor report schema.
	const row = object(
		parsed,
		[
			"success",
			"numTotalTestSuites",
			"numPassedTestSuites",
			"numFailedTestSuites",
			"numPendingTestSuites",
			"numTotalTests",
			"numPassedTests",
			"numFailedTests",
			"numPendingTests",
			"numTodoTests",
			"testResults",
		],
		["numRuntimeErrorTestSuites"],
		false,
	);
	const suites = array(row.testResults, 1);
	check(suites.length === 1, "report");
	const suite = suites[0];
	check(suite !== null && typeof suite === "object" && !isProxy(suite), "report");
	const data = suite as Row;
	const assertions = array(data.assertionResults, group === "A" ? 8 : 1);
	const targets = windowsSupervisorCases.filter((item) => item.case === group);
	check(
		assertions.length === (group === "A" ? 8 : 1) &&
			row.success === true &&
			integer(row.numTotalTestSuites, 1) === row.numPassedTestSuites &&
			row.numFailedTestSuites === 0 &&
			row.numPendingTestSuites === 0 &&
			row.numTotalTests === assertions.length &&
			row.numPassedTests === targets.length &&
			row.numFailedTests === 0 &&
			row.numPendingTests === assertions.length - targets.length &&
			row.numTodoTests === 0 &&
			(row.numRuntimeErrorTestSuites === undefined || row.numRuntimeErrorTestSuites === 0) &&
			data.name === path.join(directory, targets[0]?.file ?? "").replaceAll("\\", "/") &&
			data.status === "passed" &&
			data.message === "",
		"report",
	);
	const names = new Set<string>();
	const passed = new Set<string>();
	for (const item of assertions) {
		check(item !== null && typeof item === "object" && !isProxy(item), "report");
		const test = item as Row;
		check(
			typeof test.fullName === "string" &&
				test.fullName.length > 0 &&
				!names.has(test.fullName) &&
				array(test.failureMessages, 0).length === 0,
			"report",
		);
		names.add(test.fullName);
		const target = targets.find(
			(entry) => [entry.suite, entry.title].filter(Boolean).join(" ") === test.fullName,
		);
		if (target) {
			check(
				test.title === target.title &&
					test.status === "passed" &&
					typeof test.duration === "number" &&
					Number.isFinite(test.duration) &&
					test.duration > 0 &&
					test.duration <= 60_000,
				"report",
			);
			passed.add(target.id);
		} else check(test.status === "pending" || test.status === "skipped", "report");
	}
	check(passed.size === targets.length, "report");
}

/** Validates reported/captured consistency; the launcher retains all native and policy gates. */
export function checkWindowsSupervisorReceipts(
	captures: unknown,
	reports: unknown,
	directory: string,
): WindowsSupervisorReportedConsistency {
	check(typeof directory === "string" && path.isAbsolute(directory), "report");
	const report = object(reports, ["A", "B"]);
	framework(report.A, directory, "A");
	framework(report.B, directory, "B");
	const rows = array(captures, 3);
	check(rows.length === 3, "selection");
	const seen = new Set<WindowsSupervisorCaseId>();
	let source: string | undefined;
	for (const item of rows) {
		const input = object(item, ["id", "json", "expected", "hubPid", "targetPid"]);
		const definition = windowsSupervisorCases.find((entry) => entry.id === input.id);
		check(definition && !seen.has(definition.id), "selection");
		seen.add(definition.id);
		const expected = binding(input.expected);
		check(
			expected.case === definition.case && (source === undefined || source === expected.source),
			"binding",
		);
		source = expected.source;
		const hubPid = integer(input.hubPid, 1),
			targetPid = integer(input.targetPid, 1);
		const capture = object(
			parseJson(input.json, WIRE_BYTES, true),
			definition.case === "A"
				? ["scope", "case", "measurement", "requestBinding", "receipt"]
				: ["scope", "case", "requestBinding", "receipt", "samples", "postCloseUnreadable"],
		);
		check(capture.scope === "capture-only" && capture.case === definition.case, "binding");
		const actual = binding(capture.requestBinding);
		check(
			actual.source === expected.source &&
				actual.route === expected.route &&
				actual.admissionRef === expected.admissionRef &&
				actual.case === expected.case,
			"binding",
		);
		const observation = receipt(capture.receipt);
		if (definition.case === "A") {
			check(capture.measurement === definition.measurement, "selection");
			primary(observation, hubPid, targetPid);
		} else {
			check(hubPid === targetPid && capture.postCloseUnreadable === true, "trace");
			fallback(
				observation,
				targetPid,
				array(capture.samples, 2).map((sample) => integer(sample, 1)),
			);
		}
	}
	check(source !== undefined && seen.size === 3, "selection");
	return Object.freeze({
		scope: "reported-consistency",
		source,
		cases: Object.freeze(windowsSupervisorCases.map((item) => item.id)),
		reportedPassed: 3,
		reportedFiltered: 6,
	});
}
