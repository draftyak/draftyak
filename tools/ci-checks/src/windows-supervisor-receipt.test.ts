import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkWindowsSupervisorReceipts,
	WindowsSupervisorReceiptError,
	windowsSupervisorCases,
} from "./windows-supervisor-receipt.ts";

type Event = { seq: number; type: string; [key: string]: unknown };
type Status = { code: number | null; signal: string | null };
type Child = {
	id: number;
	kind: string;
	branch: string;
	errors: number;
	pid?: number;
	exit?: Status;
	close?: Status;
};
type Request = {
	id: number;
	child: number;
	pid: number;
	role: string;
	write: string;
	reply: string;
	value?: number;
};
type Receipt = {
	scope: string;
	events: Event[];
	faults: string[];
	children: Child[];
	requests: Request[];
	tasklist: { id: number; callbacks: number; value?: number; error?: string }[];
	launches: {
		reader: number;
		tasklist: number;
		unmatched: number;
		unmatchedAfterClose: number;
		afterClose: number;
	};
	fallbackCount: number;
	closeBoundary: boolean;
	restored: boolean;
};
type Binding = { source: string; route: string; admissionRef: string; case: string };
type Wire = {
	scope: string;
	case: string;
	requestBinding: Binding;
	receipt: Receipt;
	measurement?: string;
	samples?: number[];
	postCloseUnreadable?: boolean;
	[key: string]: unknown;
};
type Input = { id: string; json: string; expected: Binding; hubPid: number; targetPid: number };
type Assertion = {
	fullName: string;
	title: string;
	status: string;
	duration?: number;
	failureMessages: string[];
};
type Report = {
	success: boolean;
	numTotalTestSuites: number;
	numPassedTestSuites: number;
	numFailedTestSuites: number;
	numPendingTestSuites: number;
	numTotalTests: number;
	numPassedTests: number;
	numFailedTests: number;
	numPendingTests: number;
	numTodoTests: number;
	numRuntimeErrorTestSuites?: number;
	testResults: { name: string; status: string; message: string; assertionResults: Assertion[] }[];
	[key: string]: unknown;
};
type Fixture = { captures: Input[]; reports: { A: string; B: string }; directory: string };
const source = "a".repeat(40);
const directory = path.resolve("synthetic-source");
function at<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) throw new Error("fixture index");
	return item;
}
function base(): Receipt {
	return {
		scope: "capture-only",
		events: [],
		faults: [],
		children: [],
		requests: [],
		tasklist: [],
		launches: { reader: 1, tasklist: 0, unmatched: 0, unmatchedAfterClose: 0, afterClose: 0 },
		fallbackCount: 0,
		closeBoundary: true,
		restored: true,
	};
}
function push(receipt: Receipt, type: string, fields: Record<string, unknown> = {}): void {
	receipt.events.push({ seq: receipt.events.length + 1, type, ...fields });
}
function started(receipt: Receipt, kind: string, pid: number, code = 0): number {
	const id = receipt.children.length + 1;
	receipt.children.push({
		id,
		kind,
		pid,
		branch: "started",
		errors: 0,
		exit: { code, signal: null },
		close: { code, signal: null },
	});
	push(receipt, "child-returned", { child: id, kind, pid });
	push(receipt, "spawn", { child: id, kind, pid });
	return id;
}
function end(receipt: Receipt, id: number, kind: string): void {
	push(receipt, "exit", { child: id, kind });
	push(receipt, "close", { child: id, kind });
}
function primary(): Receipt {
	const receipt = base();
	push(receipt, "launch-attempt", { kind: "reader" });
	const child = started(receipt, "reader", 501, 1);
	for (const [index, pid] of [101, 201].entries()) {
		const id = index + 1,
			role = index === 0 ? "self-check" : "target";
		const value = index === 0 ? 4096 : 536_870_913;
		receipt.requests.push({ id, child, pid, role, value, write: "backpressure", reply: "value" });
		push(receipt, "reader-request", { id, child, pid, state: role });
		push(receipt, "reader-reply", { id, child, pid, state: "value", value });
	}
	push(receipt, "close-boundary");
	end(receipt, child, "reader");
	return receipt;
}
function fallback(branch: "sync-throw" | "no-pid" | "started"): Receipt {
	const receipt = base();
	receipt.launches.tasklist = 2;
	receipt.fallbackCount = 1;
	push(receipt, "launch-attempt", { kind: "reader" });
	if (branch === "sync-throw") push(receipt, "spawn-throw", { kind: "reader", error: "EACCES" });
	else if (branch === "no-pid") {
		receipt.children.push({
			id: 1,
			kind: "reader",
			branch: "no-pid",
			errors: 1,
			close: { code: 1, signal: null },
		});
		push(receipt, "child-returned", { child: 1, kind: "reader" });
		push(receipt, "child-error", { child: 1, kind: "reader", error: "EPERM" });
		push(receipt, "close", { child: 1, kind: "reader" });
	} else {
		const child = started(receipt, "reader", 501, 1);
		receipt.requests.push({
			id: 1,
			child,
			pid: 101,
			role: "self-check",
			write: "accepted",
			reply: "unreadable",
		});
		push(receipt, "reader-request", { id: 1, child, pid: 101, state: "self-check" });
		push(receipt, "reader-reply", { id: 1, child, pid: 101, state: "unreadable" });
		end(receipt, child, "reader");
	}
	push(receipt, "fallback");
	for (let index = 0; index < 2; index++) {
		push(receipt, "launch-attempt", { kind: "tasklist" });
		const child = started(receipt, "tasklist", 601 + index);
		receipt.tasklist.push({ id: index + 1, callbacks: 1, value: 4096 + index });
		push(receipt, "tasklist-reply", { id: index + 1, pid: 101, value: 4096 + index });
		end(receipt, child, "tasklist");
	}
	push(receipt, "close-boundary");
	return receipt;
}
function report(group: "A" | "B"): Report {
	const entries = windowsSupervisorCases.filter((entry) => entry.case === group);
	const assertions: Assertion[] = entries.map((entry) => ({
		fullName: [entry.suite, entry.title].filter(Boolean).join(" "),
		title: entry.title,
		status: "passed",
		duration: 10,
		failureMessages: [],
	}));
	if (group === "A")
		for (let index = 0; index < 6; index++)
			assertions.push({
				fullName: `unselected ${index}`,
				title: `unselected ${index}`,
				status: "pending",
				failureMessages: [],
			});
	return {
		success: true,
		numTotalTestSuites: 2,
		numPassedTestSuites: 2,
		numFailedTestSuites: 0,
		numPendingTestSuites: 0,
		numTotalTests: assertions.length,
		numPassedTests: entries.length,
		numFailedTests: 0,
		numPendingTests: assertions.length - entries.length,
		numTodoTests: 0,
		testResults: [
			{
				name: path.join(directory, entries[0]?.file ?? "").replaceAll("\\", "/"),
				status: "passed",
				message: "",
				assertionResults: assertions,
			},
		],
	};
}
function fixture(branch: "sync-throw" | "no-pid" | "started" = "sync-throw"): Fixture {
	const captures = windowsSupervisorCases.map((entry, index): Input => {
		const expected = {
			source,
			route: "supervisor-windows-policy",
			admissionRef: `synthetic-${index}`,
			case: entry.case,
		};
		const wire: Wire =
			entry.case === "A"
				? {
						scope: "capture-only",
						case: "A",
						measurement: entry.measurement,
						requestBinding: { ...expected },
						receipt: primary(),
					}
				: {
						scope: "capture-only",
						case: "B",
						requestBinding: { ...expected },
						receipt: fallback(branch),
						samples: [4096, 4097],
						postCloseUnreadable: true,
					};
		return {
			id: entry.id,
			json: JSON.stringify(wire),
			expected,
			hubPid: 101,
			targetPid: entry.case === "A" ? 201 : 101,
		};
	});
	return {
		captures,
		reports: { A: JSON.stringify(report("A"), null, 2), B: JSON.stringify(report("B"), null, 2) },
		directory,
	};
}
function change(fixture: Fixture, index: number, mutate: (wire: Wire) => void): void {
	const input = at(fixture.captures, index);
	const wire = JSON.parse(input.json) as Wire;
	mutate(wire);
	input.json = JSON.stringify(wire);
}
function changeReport(fixture: Fixture, group: "A" | "B", mutate: (report: Report) => void): void {
	const value = JSON.parse(fixture.reports[group]) as Report;
	mutate(value);
	fixture.reports[group] = JSON.stringify(value, null, 2);
}
function run(fixture: Fixture): ReturnType<typeof checkWindowsSupervisorReceipts> {
	return checkWindowsSupervisorReceipts(fixture.captures, fixture.reports, fixture.directory);
}
function refuses(fixture: Fixture): void {
	expect(() => run(fixture)).toThrow(WindowsSupervisorReceiptError);
}
function resequence(wire: Wire): void {
	wire.receipt.events.forEach((event, index) => {
		event.seq = index + 1;
	});
}

describe("reported Windows supervisor consistency", () => {
	it.each(["sync-throw", "no-pid", "started"] as const)(
		"accepts the actual %s fallback IO shape with two primary cases",
		(branch) => {
			const data = fixture(branch);
			expect(run(data)).toEqual({
				scope: "reported-consistency",
				source,
				cases: ["A.growing", "A.untouched", "B.natural"],
				reportedPassed: 3,
				reportedFiltered: 6,
			});
		},
	);
	it("preserves primary nonzero reader exit and write(false) backpressure", () => {
		expect(run(fixture()).reportedPassed).toBe(3);
	});
	it("accepts failed-write fallback without inventing a reader reply", () => {
		const data = fixture("started");
		change(data, 2, (wire) => {
			const request = at(wire.receipt.requests, 0);
			request.write = "threw";
			request.reply = "pending";
			wire.receipt.events = wire.receipt.events.filter((event) => event.type !== "reader-reply");
			wire.receipt.events.splice(4, 0, { seq: 0, type: "write-throw", child: 1, error: "EPERM" });
			resequence(wire);
		});
		expect(run(data).reportedPassed).toBe(3);
	});
	it("accepts LF or CRLF capture transport and pretty framework JSON", () => {
		const data = fixture();
		at(data.captures, 0).json += "\n";
		at(data.captures, 1).json += "\r\n";
		expect(run(data).reportedPassed).toBe(3);
	});
	it("accepts unrelated report data without inventing a private reporter schema", () => {
		const data = fixture();
		changeReport(data, "A", (value) => {
			value.toolMetadata = { value: 1 };
		});
		expect(run(data).reportedPassed).toBe(3);
	});
	it("returns detached frozen reported data without a native result flag", () => {
		const data = fixture(),
			result = run(data);
		at(data.captures, 0).expected.source = "b".repeat(40);
		expect(result.source).toBe(source);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.cases)).toBe(true);
		expect(result).not.toHaveProperty("nativePassed");
	});
	it.each(["failed", "skipped", "pending"])(
		"a valid finally capture cannot rescue a %s framework case",
		(state) => {
			const data = fixture();
			changeReport(data, "A", (value) => {
				at(at(value.testResults, 0).assertionResults, 0).status = state;
			});
			refuses(data);
		},
	);
	it.each([
		"wrong title",
		"wrong file",
		"duplicate case",
		"wrong count",
		"runtime error",
		"failure body",
		"empty duration",
		"late duration",
	])("refuses the reported %s", (fault) => {
		const data = fixture();
		changeReport(data, "B", (value) => {
			const suite = at(value.testResults, 0),
				assertion = at(suite.assertionResults, 0);
			if (fault === "wrong title") assertion.title = "different";
			if (fault === "wrong file") suite.name += ".other";
			if (fault === "duplicate case") suite.assertionResults.push({ ...assertion });
			if (fault === "wrong count") value.numPendingTests = 1;
			if (fault === "runtime error") value.numRuntimeErrorTestSuites = 1;
			if (fault === "failure body") assertion.failureMessages.push("synthetic");
			if (fault === "empty duration") assertion.duration = 0;
			if (fault === "late duration") assertion.duration = 60_001;
		});
		refuses(data);
	});
	it("requires all three registry cases exactly once", () => {
		for (const mode of ["missing", "extra", "duplicate"]) {
			const data = fixture();
			if (mode === "missing") data.captures.pop();
			if (mode === "extra") data.captures.push({ ...at(data.captures, 0) });
			if (mode === "duplicate") at(data.captures, 1).id = "A.growing";
			refuses(data);
		}
	});
	it.each(["measurement", "source", "route", "reference", "case", "grant field"])(
		"refuses a mismatched %s",
		(fault) => {
			const data = fixture();
			change(data, 0, (wire) => {
				if (fault === "measurement") wire.measurement = "untouched";
				if (fault === "source") wire.requestBinding.source = "b".repeat(40);
				if (fault === "route") wire.requestBinding.route = "different";
				if (fault === "reference") wire.requestBinding.admissionRef = "different";
				if (fault === "case") wire.requestBinding.case = "B";
				if (fault === "grant field") wire.nativePassed = true;
			});
			refuses(data);
		},
	);
	it.each(["duplicate", "escaped duplicate", "pretty", "trailing", "truncated"])(
		"refuses %s capture JSON",
		(fault) => {
			const data = fixture(),
				input = at(data.captures, 0);
			if (fault === "duplicate")
				input.json = input.json.replace(
					'"scope":"capture-only"',
					'"scope":"capture-only","scope":"capture-only"',
				);
			if (fault === "escaped duplicate")
				input.json = input.json.replace(
					'"scope":"capture-only"',
					'"scope":"capture-only","\\u0073cope":"capture-only"',
				);
			if (fault === "pretty") input.json = JSON.stringify(JSON.parse(input.json), null, 2);
			if (fault === "trailing") input.json += " ";
			if (fault === "truncated") input.json = input.json.slice(0, -1);
			refuses(data);
		},
	);
	it("counts capture UTF8 bytes at65536 rather than JavaScript characters or4096", () => {
		const data = fixture(),
			input = at(data.captures, 0),
			wire = JSON.parse(input.json) as Wire;
		wire.padding = "";
		const base = JSON.stringify(wire);
		wire.padding = "x".repeat(65_536 - Buffer.byteLength(base));
		input.json = JSON.stringify(wire);
		expect(Buffer.byteLength(input.json)).toBe(65_536);
		try {
			run(data);
			throw new Error("expected shape refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(WindowsSupervisorReceiptError);
			expect((error as WindowsSupervisorReceiptError).reason).toBe("shape");
		}
		wire.padding += "x";
		input.json = JSON.stringify(wire);
		try {
			run(data);
			throw new Error("expected wire refusal");
		} catch (error) {
			expect((error as WindowsSupervisorReceiptError).reason).toBe("wire");
		}
		wire.padding = "é".repeat(33_000);
		input.json = JSON.stringify(wire);
		expect(input.json.length).toBeLessThan(65_536);
		try {
			run(data);
			throw new Error("expected UTF8 refusal");
		} catch (error) {
			expect((error as WindowsSupervisorReceiptError).reason).toBe("wire");
		}
	});
	it("refuses caller accessors and proxies without invoking hooks", () => {
		let observed = 0;
		const data = fixture();
		Object.defineProperty(at(data.captures, 0).expected, "source", {
			get() {
				observed++;
				return source;
			},
		});
		refuses(data);
		const other = fixture();
		at(other.captures, 0).expected = new Proxy(at(other.captures, 0).expected, {
			ownKeys() {
				observed++;
				throw new Error("hook");
			},
		});
		refuses(other);
		const reports = new Proxy(fixture().reports, {
			ownKeys() {
				observed++;
				throw new Error("hook");
			},
		});
		expect(() => checkWindowsSupervisorReceipts(fixture().captures, reports, directory)).toThrow(
			WindowsSupervisorReceiptError,
		);
		expect(observed).toBe(0);
	});
	it("returns the fixed refusal for a revoked captures-array proxy", () => {
		const data = fixture();
		const revoked = Proxy.revocable(data.captures, {});
		revoked.revoke();
		expect(() =>
			checkWindowsSupervisorReceipts(revoked.proxy, data.reports, data.directory),
		).toThrow(WindowsSupervisorReceiptError);
	});
	it.each([
		"limit",
		"unsafe value",
		"missing self-check",
		"wrong target",
		"wrong reply",
		"FIFO",
		"sequence",
		"after boundary",
		"unfinished",
		"working set",
	])("refuses primary %s", (fault) => {
		const data = fixture();
		change(data, 0, (wire) => {
			const receipt = wire.receipt,
				target = at(receipt.requests, 1);
			if (fault === "limit" || fault === "unsafe value") {
				target.value = fault === "limit" ? 536_870_912 : Number.MAX_SAFE_INTEGER + 1;
				const reply = receipt.events.find(
					(event) => event.type === "reader-reply" && event.id === 2,
				);
				if (reply) reply.value = target.value;
			}
			if (fault === "missing self-check") at(receipt.requests, 0).role = "target";
			if (fault === "wrong target") {
				target.pid = 202;
				for (const event of receipt.events) if (event.id === 2) event.pid = 202;
			}
			if (fault === "wrong reply") {
				const reply = receipt.events.find(
					(event) => event.type === "reader-reply" && event.id === 2,
				);
				if (reply) reply.value = 536_870_914;
			}
			if (fault === "FIFO") {
				const reply = receipt.events.splice(4, 1);
				receipt.events.splice(5, 0, ...reply);
				resequence(wire);
			}
			if (fault === "sequence") at(receipt.events, 1).seq = 1;
			if (fault === "after boundary") {
				const boundary = receipt.events.splice(7, 1);
				receipt.events.splice(6, 0, ...boundary);
				resequence(wire);
			}
			if (fault === "unfinished") delete at(receipt.children, 0).close;
			if (fault === "working set") {
				receipt.children[0] = { ...at(receipt.children, 0), kind: "tasklist" };
				for (const event of receipt.events) if (event.kind) event.kind = "tasklist";
			}
		});
		refuses(data);
	});
	it.each([
		"sample",
		"callback value",
		"callback count",
		"late callback",
		"missing self-check",
		"primary success",
		"unreadable value",
		"wrong worker",
		"after close",
		"unmatched after close",
		"unsettled tool",
		"invented PID",
		"invented exit",
		"pending reader",
	])("refuses fallback %s", (fault) => {
		const data = fixture(
			fault === "invented PID" || fault === "invented exit" ? "no-pid" : "started",
		);
		change(data, 2, (wire) => {
			const receipt = wire.receipt;
			if (fault === "sample" && wire.samples) wire.samples[0] = 1;
			if (fault === "callback value") {
				const event = receipt.events.find((event) => event.type === "tasklist-reply");
				if (event) event.value = 1;
			}
			if (fault === "callback count") at(receipt.tasklist, 0).callbacks = 2;
			if (fault === "late callback") {
				const index = receipt.events.findIndex(
					(event) => event.type === "tasklist-reply" && event.id === 2,
				);
				const removed = receipt.events.splice(index, 1);
				receipt.events.push(...removed);
				resequence(wire);
			}
			if (fault === "missing self-check") {
				receipt.requests = [];
				receipt.events = receipt.events.filter(
					(event) => event.type !== "reader-request" && event.type !== "reader-reply",
				);
				resequence(wire);
			}
			if (fault === "primary success") {
				const request = at(receipt.requests, 0);
				request.reply = "value";
				request.value = 1;
			}
			if (fault === "unreadable value") {
				const event = receipt.events.find((event) => event.type === "reader-reply");
				if (event) event.value = 1;
			}
			if (fault === "wrong worker") {
				const event = receipt.events.find((event) => event.type === "tasklist-reply");
				if (event) event.pid = 102;
			}
			if (fault === "after close") receipt.launches.afterClose = 1;
			if (fault === "unmatched after close") receipt.launches.unmatchedAfterClose = 1;
			if (fault === "unsettled tool") delete at(receipt.children, receipt.children.length - 1).exit;
			if (fault === "invented PID") at(receipt.children, 0).pid = 501;
			if (fault === "invented exit") at(receipt.children, 0).exit = { code: 0, signal: null };
			if (fault === "pending reader") at(receipt.children, 0).branch = "unconfirmed";
		});
		refuses(data);
	});
	it("refuses fallback reader requests and replies after the matched child close", () => {
		const data = fixture("started");
		change(data, 2, (wire) => {
			const io = wire.receipt.events.filter(
				(event) => event.type === "reader-request" || event.type === "reader-reply",
			);
			wire.receipt.events = wire.receipt.events.filter((event) => !io.includes(event));
			const close = wire.receipt.events.findIndex(
				(event) => event.type === "close" && event.child === 1,
			);
			wire.receipt.events.splice(close + 1, 0, ...io);
			resequence(wire);
		});
		refuses(data);
	});
	it("refuses a fallback reply after its matched child close", () => {
		const data = fixture("started");
		change(data, 2, (wire) => {
			const reply = wire.receipt.events.filter((event) => event.type === "reader-reply");
			wire.receipt.events = wire.receipt.events.filter((event) => !reply.includes(event));
			const close = wire.receipt.events.findIndex(
				(event) => event.type === "close" && event.child === 1,
			);
			wire.receipt.events.splice(close + 1, 0, ...reply);
			resequence(wire);
		});
		refuses(data);
	});
	it("refuses primary reader IO after its matched child closed", () => {
		const data = fixture();
		change(data, 0, (wire) => {
			const terminal = wire.receipt.events.filter(
				(event) => event.child === 1 && (event.type === "exit" || event.type === "close"),
			);
			wire.receipt.events = wire.receipt.events.filter((event) => !terminal.includes(event));
			const firstRequest = wire.receipt.events.findIndex(
				(event) => event.type === "reader-request",
			);
			wire.receipt.events.splice(firstRequest, 0, ...terminal);
			resequence(wire);
		});
		refuses(data);
	});
	it("accepts an unreadable reply after timeout fallback and before capture close", () => {
		const data = fixture("started");
		change(data, 2, (wire) => {
			const late = wire.receipt.events.filter(
				(event) =>
					event.type === "reader-reply" ||
					(event.child === 1 && (event.type === "exit" || event.type === "close")),
			);
			wire.receipt.events = wire.receipt.events.filter((event) => !late.includes(event));
			const boundary = wire.receipt.events.findIndex((event) => event.type === "close-boundary");
			wire.receipt.events.splice(boundary, 0, ...late);
			resequence(wire);
		});
		expect(run(data).reportedPassed).toBe(3);
	});
	it("refuses a self-check reply before its corresponding request", () => {
		const data = fixture("started");
		change(data, 2, (wire) => {
			const index = wire.receipt.events.findIndex((event) => event.type === "reader-reply");
			const reply = wire.receipt.events.splice(index, 1);
			wire.receipt.events.splice(index - 1, 0, ...reply);
			resequence(wire);
		});
		refuses(data);
	});
	it("accepts a pending unreadable reply during drain after the global close marker", () => {
		const data = fixture("started");
		change(data, 2, (wire) => {
			const late = wire.receipt.events.filter(
				(event) => event.type === "reader-reply" || (event.child === 1 && event.type === "close"),
			);
			wire.receipt.events = wire.receipt.events.filter((event) => !late.includes(event));
			wire.receipt.events.push(...late);
			resequence(wire);
		});
		expect(run(data).reportedPassed).toBe(3);
	});
	it("refuses a new matched launch after the close marker even with a zero counter", () => {
		const data = fixture();
		change(data, 0, (wire) => {
			const launch = wire.receipt.events.splice(0, 1);
			wire.receipt.events.push(...launch);
			resequence(wire);
		});
		refuses(data);
	});
	it("preserves an omitted optional spawn PID", () => {
		const data = fixture();
		change(data, 0, (wire) => {
			const spawn = wire.receipt.events.find((event) => event.type === "spawn");
			if (spawn) delete spawn.pid;
		});
		expect(run(data).reportedPassed).toBe(3);
	});
	it("joins a present spawn PID to the matched returned child", () => {
		const data = fixture();
		change(data, 0, (wire) => {
			const event = wire.receipt.events.find((event) => event.type === "spawn");
			if (event) event.pid = 999;
		});
		refuses(data);
	});
	it("rejects absent optional data changed to null", () => {
		const data = fixture("no-pid");
		change(data, 2, (wire) => {
			Object.assign(at(wire.receipt.children, 0), { pid: null });
		});
		refuses(data);
	});
	it("enforces event and child cardinality bounds before accepting a trace", () => {
		const data = fixture();
		change(data, 0, (wire) => {
			while (wire.receipt.events.length <= 256) push(wire.receipt, "fallback");
		});
		refuses(data);
		const children = fixture();
		change(children, 0, (wire) => {
			while (wire.receipt.children.length <= 8)
				wire.receipt.children.push({ ...at(wire.receipt.children, 0) });
		});
		refuses(children);
	});
});
