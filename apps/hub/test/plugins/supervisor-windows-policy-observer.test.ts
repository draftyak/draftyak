import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExclude } from "vitest/config";
import { vitestConfig } from "../../../../vitest.shared.ts";
import {
	createWindowsPolicyConfig,
	validateWindowsPolicyRequest,
	WINDOWS_POLICY_ENTRY,
	WINDOWS_POLICY_MODE,
	WINDOWS_POLICY_ROUTE,
} from "../../vitest.windows-policy.config.ts";
import {
	assertWindowsPolicyFallbackReceipt,
	assertWindowsPolicyPrimaryReceipt,
	createWindowsSamplerObserver,
	tapOriginalPromise,
	type WindowsSamplerBindings,
	type WindowsSamplerObserver,
	type WindowsSamplerReceipt,
	windowsSamplerBindings,
} from "./supervisor-windows-policy-observer.ts";

type Call = (this: unknown, ...args: unknown[]) => unknown;
const bindings = windowsSamplerBindings("C:\\Windows", 100, 200);
const observers: WindowsSamplerObserver[] = [];

class Input extends EventEmitter {
	readonly calls: { receiver: unknown; args: unknown[] }[] = [];
	result: unknown = false;
	action: (() => void) | undefined;
	write(...args: unknown[]): unknown {
		this.calls.push({ receiver: this, args });
		this.action?.();
		return this.result;
	}
}

class Child extends EventEmitter {
	readonly stdin = new Input();
	readonly stdout = new EventEmitter();
	readonly pid: number | undefined;
	constructor(pid: number | undefined = 300) {
		super();
		this.pid = pid;
		this.on("error", () => {});
	}
	finish(): void {
		if (this.pid === undefined)
			this.emit("error", Object.assign(new Error("unused"), { code: "EACCES" }));
		else {
			this.emit("spawn");
			this.emit("exit", 0, null);
		}
		this.emit("close", this.pid === undefined ? -1 : 0, null);
	}
}

class IO {
	readonly calls: { kind: string; receiver: unknown; args: unknown[] }[] = [];
	child: unknown = new Child();
	throwing: unknown;
	spawn(...args: unknown[]): unknown {
		this.calls.push({ kind: "spawn", receiver: this, args });
		if (this.throwing !== undefined) throw this.throwing;
		return this.child;
	}
	execFile(...args: unknown[]): unknown {
		this.calls.push({ kind: "execFile", receiver: this, args });
		if (this.throwing !== undefined) throw this.throwing;
		return this.child;
	}
}

function observe(io = new IO(), expected = bindings) {
	const observer = createWindowsSamplerObserver(io, expected);
	observers.push(observer);
	return { io, observer };
}

function reader(io: IO): Child {
	const child = io.child as Child;
	expect(io.spawn(...bindings.reader)).toBe(child);
	return child;
}

function reply(io: IO): Call {
	return io.calls.at(-1)?.args[3] as Call;
}

function csv(pid = 200, memory = "1,234 K"): string {
	return `"node.exe","${pid}","Console","1","${memory}"\r\n`;
}

afterEach(() => {
	for (const observer of observers.splice(0)) observer.restore();
});

describe("terminal restoration capture", () => {
	it("does not tap a child returned after its synchronous callback restores the observer", () => {
		const io = new IO();
		const child = io.child as Child;
		const receiver = {};
		const returned = Symbol("callback return");
		const nativeArgs = [null, csv(), "stderr"];
		let callbackResult: unknown;
		io.execFile = function (...args: unknown[]) {
			this.calls.push({ kind: "execFile", receiver: this, args });
			callbackResult = Reflect.apply(args[3] as Call, receiver, nativeArgs);
			return child;
		};
		const delegateBefore = Object.getOwnPropertyDescriptor(io, "execFile");
		const emitBefore = Object.getOwnPropertyDescriptor(child, "emit");
		const { observer } = observe(io);
		let first: ReturnType<WindowsSamplerObserver["snapshot"]> | undefined;
		let callbackReceiver: unknown;
		let callbackArgs: unknown[] = [];
		const callback = function (this: unknown, ...args: unknown[]) {
			callbackReceiver = this;
			callbackArgs = args;
			first = observer.restore();
			return returned;
		};
		expect(io.execFile(...bindings.tasklist, callback)).toBe(child);
		expect(callbackResult).toBe(returned);
		expect(callbackReceiver).toBe(receiver);
		expect(callbackArgs).toEqual(nativeArgs);
		expect(first?.restored).toBe(true);
		expect(Object.getOwnPropertyDescriptor(child, "emit")).toEqual(emitBefore);
		expect(Object.getOwnPropertyDescriptor(io, "execFile")).toEqual(delegateBefore);
		expect(observer.snapshot()).toEqual(first);
		expect(observer.restore()).toEqual(first);
		expect(observer.snapshot().children).toEqual([]);
	});

	it("makes a retained matched spawn wrapper transparent after restoration", () => {
		const { io, observer } = observe();
		const child = io.child as Child;
		const spawn = io.spawn;
		const emitBefore = Object.getOwnPropertyDescriptor(child, "emit");
		const inputBefore = Object.getOwnPropertyDescriptor(child.stdin, "write");
		const outputBefore = Object.getOwnPropertyDescriptor(child.stdout, "emit");
		const before = observer.restore();
		expect(Reflect.apply(spawn, io, [...bindings.reader])).toBe(child);
		expect(io.calls[0]?.receiver).toBe(io);
		expect(io.calls[0]?.args[1]).toBe(bindings.reader[1]);
		expect(io.calls[0]?.args[2]).toBe(bindings.reader[2]);
		expect(Object.getOwnPropertyDescriptor(child, "emit")).toEqual(emitBefore);
		expect(Object.getOwnPropertyDescriptor(child.stdin, "write")).toEqual(inputBefore);
		expect(Object.getOwnPropertyDescriptor(child.stdout, "emit")).toEqual(outputBefore);
		expect(observer.restore()).toEqual(before);
	});

	it("makes a retained exec wrapper preserve callback identity and exceptions after restoration", () => {
		const { io, observer } = observe();
		const execute = io.execFile;
		const child = io.child as Child;
		const emitBefore = Object.getOwnPropertyDescriptor(child, "emit");
		const marker = new Error("original callback error");
		const callback = () => {
			throw marker;
		};
		const before = observer.restore();
		expect(Reflect.apply(execute, io, [...bindings.tasklist, callback])).toBe(child);
		expect(io.calls[0]?.args[3]).toBe(callback);
		expect(() => reply(io)(null, csv(), "")).toThrow(marker);
		expect(Object.getOwnPropertyDescriptor(child, "emit")).toEqual(emitBefore);
		expect(observer.restore()).toEqual(before);
	});

	it("forwards already-installed late callbacks without changing the terminal receipt", () => {
		const { io, observer } = observe();
		const receiver = {};
		const result = Symbol("callback return");
		const marker = new Error("late original throw");
		const calls: { receiver: unknown; args: unknown[] }[] = [];
		let throwing = false;
		io.execFile(...bindings.tasklist, function (this: unknown, ...args: unknown[]) {
			calls.push({ receiver: this, args });
			if (throwing) throw marker;
			return result;
		});
		const callback = reply(io);
		(io.child as Child).finish();
		const before = observer.restore();
		const args = [null, csv(), "stderr", result];
		expect(Reflect.apply(callback, receiver, args)).toBe(result);
		throwing = true;
		expect(() => Reflect.apply(callback, receiver, args)).toThrow(marker);
		expect(calls).toEqual([
			{ receiver, args },
			{ receiver, args },
		]);
		expect(observer.snapshot()).toEqual(before);
		expect(observer.restore()).toEqual(before);
	});
});

describe("Windows sampler capture bindings", () => {
	it("constructs only the unmodified Windows command data without querying a runtime", () => {
		expect(bindings.reader[0]).toBe(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		);
		expect(bindings.reader[1].slice(0, 4)).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
		]);
		expect(bindings.reader[1][4]).toContain("[Console]::In.ReadLine()");
		expect(bindings.reader[2]).toEqual({
			env: { SystemRoot: "C:\\Windows" },
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
			shell: false,
		});
		expect(bindings.tasklist).toEqual([
			"C:\\Windows\\System32\\tasklist.exe",
			["/fi", "PID eq 200", "/fo", "csv", "/nh"],
			{
				env: { SystemRoot: "C:\\Windows" },
				timeout: 2_000,
				maxBuffer: 65_536,
				shell: false,
				windowsHide: true,
			},
		]);
		expect(Object.isFrozen(bindings.reader[2].env)).toBe(true);
		expect(() => windowsSamplerBindings("relative", 100, 200)).toThrow("OBSERVER_BINDINGS_INVALID");
		expect(() => windowsSamplerBindings("C:\\Windows", 0, 200)).toThrow(
			"OBSERVER_BINDINGS_INVALID",
		);
	});

	it("delegates unrelated calls before observing their argument trees", () => {
		const { io, observer } = observe();
		let traps = 0;
		const hostile = new Proxy(
			{},
			{
				get() {
					traps++;
					throw new Error("get");
				},
				ownKeys() {
					traps++;
					throw new Error("keys");
				},
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error("descriptor");
				},
				getPrototypeOf() {
					traps++;
					throw new Error("prototype");
				},
			},
		);
		expect(io.spawn("unrelated", hostile, hostile)).toBe(io.child);
		expect(traps).toBe(0);
		expect(io.calls[0]?.args[0]).toBe("unrelated");
		expect(io.calls[0]?.args[1]).toBe(hostile);
		expect(io.calls[0]?.args[2]).toBe(hostile);
		expect(observer.snapshot().children).toEqual([]);
		expect(observer.snapshot().launches.unmatched).toBe(1);
	});

	it("preserves a borrowed delegate receiver, sentinel return and original thrown object", () => {
		const { io, observer } = observe();
		const sentinel = Symbol("return");
		const foreign = { calls: [] as IO["calls"], child: sentinel, throwing: undefined as unknown };
		expect(Reflect.apply(io.spawn, foreign, ["unrelated"])).toBe(sentinel);
		expect(foreign.calls[0]?.receiver).toBe(foreign);
		const marker = new Error("original unmatched throw");
		foreign.throwing = marker;
		expect(() => Reflect.apply(io.execFile, foreign, ["unrelated"])).toThrow(marker);
		expect(observer.snapshot().children).toEqual([]);
	});

	it("refuses proxy and accessor matches without invoking any traps or getters", () => {
		const { io, observer } = observe();
		let reads = 0;
		const proxy = new Proxy([...bindings.reader[1]], {
			get() {
				reads++;
				throw new Error("get");
			},
			ownKeys() {
				reads++;
				throw new Error("keys");
			},
			getOwnPropertyDescriptor() {
				reads++;
				throw new Error("descriptor");
			},
		});
		const options = Object.defineProperty({}, "env", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("getter");
			},
		});
		expect(io.spawn(bindings.reader[0], proxy, bindings.reader[2])).toBe(io.child);
		expect(io.spawn(bindings.reader[0], bindings.reader[1], options)).toBe(io.child);
		expect(reads).toBe(0);
		expect(observer.snapshot().children).toEqual([]);
		expect(observer.snapshot().launches.unmatched).toBe(2);
	});

	it("does not inspect poisoned options after the reader script already differs", () => {
		const { io, observer } = observe();
		let traps = 0;
		const options = new Proxy(
			{},
			{
				ownKeys() {
					traps++;
					throw new Error("keys");
				},
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error("descriptor");
				},
				getPrototypeOf() {
					traps++;
					throw new Error("prototype");
				},
			},
		);
		const args = [...bindings.reader[1]];
		args[4] = "different";
		expect(io.spawn(bindings.reader[0], args, options)).toBe(io.child);
		expect(traps).toBe(0);
		expect(observer.snapshot().children).toEqual([]);
	});

	it("requires exact options and rejects altered launch flags without owning the child", () => {
		const { io, observer } = observe();
		expect(io.spawn(bindings.reader[0], [...bindings.reader[1], "extra"], bindings.reader[2])).toBe(
			io.child,
		);
		expect(
			io.spawn(bindings.reader[0], bindings.reader[1], { ...bindings.reader[2], shell: true }),
		).toBe(io.child);
		expect(observer.snapshot().children).toEqual([]);
		expect(observer.snapshot().launches.reader).toBe(0);
	});

	it("rejects inaccessible delegate and binding methods without reading accessors", () => {
		let reads = 0;
		const delegate = Object.defineProperty({ execFile() {} }, "spawn", {
			get() {
				reads++;
				throw new Error("getter");
			},
		});
		expect(() => createWindowsSamplerObserver(delegate, bindings)).toThrow(
			"OBSERVER_DELEGATE_INVALID",
		);
		const input = Object.defineProperty({}, "reader", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("getter");
			},
		});
		expect(() => createWindowsSamplerObserver(new IO(), input as WindowsSamplerBindings)).toThrow(
			"OBSERVER_BINDINGS_INVALID",
		);
		expect(reads).toBe(0);
	});
});

describe("transparent owned reader capture", () => {
	it("preserves delegate receiver, argument identity, returned child and false backpressure", () => {
		const { io, observer } = observe();
		const child = reader(io);
		expect(io.calls[0]?.receiver).toBe(io);
		expect(io.calls[0]?.args[1]).toBe(bindings.reader[1]);
		expect(io.calls[0]?.args[2]).toBe(bindings.reader[2]);
		const callback = () => "untouched";
		expect(child.stdin.write("100\n", "latin1", callback)).toBe(false);
		expect(child.stdin.calls[0]).toEqual({
			receiver: child.stdin,
			args: ["100\n", "latin1", callback],
		});
		child.stdout.emit("data", "123\n");
		expect(observer.snapshot().requests).toEqual([
			{
				id: 1,
				child: 1,
				pid: 100,
				role: "self-check",
				write: "backpressure",
				reply: "value",
				value: 123,
			},
		]);
		expect(observer.snapshot().faults).toEqual([]);
		child.finish();
	});

	it("observes fragmented FIFO replies without consuming data or changing listener behavior", () => {
		const { io, observer } = observe();
		const child = reader(io);
		expect(child.stdout.listenerCount("data")).toBe(0);
		const seen: unknown[] = [];
		child.stdout.on("data", (...args) => seen.push(args));
		child.stdin.write("100\n");
		child.stdin.write("200\n");
		child.stdin.write("200\n");
		expect(child.stdout.emit("data", "12")).toBe(true);
		expect(child.stdout.emit("data", "3\r\nx\n4")).toBe(true);
		expect(child.stdout.emit("data", "56\n")).toBe(true);
		expect(seen).toEqual([["12"], ["3\r\nx\n4"], ["56\n"]]);
		expect(
			observer
				.snapshot()
				.requests.map(({ pid, role, reply, value }) => ({ pid, role, reply, value })),
		).toEqual([
			{ pid: 100, role: "self-check", reply: "value", value: 123 },
			{ pid: 200, role: "target", reply: "unreadable", value: undefined },
			{ pid: 200, role: "target", reply: "value", value: 456 },
		]);
		expect(child.stdout.listenerCount("data")).toBe(1);
		child.finish();
	});

	it("keeps immutable snapshots detached from later replies and exposes no handles", () => {
		const { io, observer } = observe();
		const child = reader(io);
		child.stdin.write("100\n");
		const before = observer.snapshot();
		child.stdout.emit("data", "99\n");
		expect(before.requests[0]?.reply).toBe("pending");
		expect(observer.snapshot().requests[0]?.value).toBe(99);
		expect(Object.isFrozen(before.requests[0])).toBe(true);
		expect(Object.keys(before.children[0] ?? {})).not.toContain("handle");
		expect(Object.keys(before)).not.toContain("policy");
		expect(before.scope).toBe("capture-only");
		child.finish();
	});

	it("does not credit borrowed stream methods to the retained handle", () => {
		const { io, observer } = observe();
		const child = reader(io);
		const otherInput = new Input();
		expect(Reflect.apply(child.stdin.write, otherInput, ["100\n"])).toBe(false);
		expect(otherInput.calls).toHaveLength(1);
		expect(Reflect.apply(child.stdout.emit, new EventEmitter(), ["data", "123\n"])).toBe(false);
		expect(Reflect.apply(child.emit, new EventEmitter(), ["exit", 0, null])).toBe(false);
		expect(observer.snapshot().requests).toEqual([]);
		expect(observer.snapshot().children[0]?.exit).toBeUndefined();
		child.finish();
	});

	it("preserves an original write exception and never pairs its abandoned request", () => {
		const { io, observer } = observe();
		const child = reader(io);
		const marker = new Error("original write failure");
		child.stdin.action = () => {
			throw marker;
		};
		expect(() => child.stdin.write("100\n")).toThrow(marker);
		child.stdout.emit("data", "123\n");
		expect(observer.snapshot().requests[0]?.write).toBe("threw");
		expect(observer.snapshot().requests[0]?.reply).toBe("pending");
		expect(observer.snapshot().faults).toContain("READER_REPLY_UNEXPECTED");
		child.finish();
	});

	it("preserves an original event listener exception and unhandled error behavior", () => {
		const { io, observer } = observe();
		const child = reader(io);
		const marker = new Error("original listener");
		child.stdout.on("data", () => {
			throw marker;
		});
		child.stdin.write("100\n");
		expect(() => child.stdout.emit("data", "7\n")).toThrow(marker);
		expect(observer.snapshot().requests[0]?.value).toBe(7);
		child.removeAllListeners("error");
		expect(() => child.emit("error", marker)).toThrow(marker);
		expect(observer.snapshot().children[0]?.errors).toBe(1);
		child.emit("spawn");
		child.emit("exit", 0, null);
		child.emit("close", 0, null);
	});

	it("records malformed, unexpected and wrong-target data as refusals without changing delivery", () => {
		const { io, observer } = observe();
		const child = reader(io);
		child.stdin.write("200\n");
		child.stdout.emit("data", "7\n");
		child.stdin.write("100\n");
		child.stdout.emit("data", "not-digits\n");
		expect(observer.snapshot().faults).toEqual(
			expect.arrayContaining([
				"READER_REQUEST_INVALID",
				"READER_REPLY_UNEXPECTED",
				"READER_REPLY_INVALID",
			]),
		);
		expect(child.stdin.calls).toHaveLength(2);
		expect(observer.snapshot().requests[0]?.reply).toBe("malformed");
		child.finish();
	});

	it("bounds capture without closing streams, dropping writes or throwing into production", () => {
		const { io, observer } = observe();
		const child = reader(io);
		child.stdin.write("100\n");
		for (let i = 0; i < 80; i++) expect(child.stdin.write("200\n")).toBe(false);
		const chunk = "9".repeat(65_537);
		let delivered: unknown;
		child.stdout.on("data", (data) => {
			delivered = data;
		});
		expect(() => child.stdout.emit("data", chunk)).not.toThrow();
		expect(delivered).toBe(chunk);
		expect(child.stdin.calls).toHaveLength(81);
		expect(observer.snapshot().requests).toHaveLength(64);
		expect(observer.snapshot().faults).toContain("OBSERVATION_LIMIT");
		expect(observer.snapshot().events.length).toBeLessThanOrEqual(256);
		child.finish();
	});
});

describe("real callback shape, simulated IO only", () => {
	it("forwards callback receiver/all arguments/return and parses only the matching target", () => {
		const { io, observer } = observe();
		const receiver = {};
		const extra = {};
		let actual: unknown[] = [];
		let actualThis: unknown;
		const callback = function (this: unknown, ...args: unknown[]) {
			actual = args;
			actualThis = this;
			return extra;
		};
		expect(io.execFile(...bindings.tasklist, callback)).toBe(io.child);
		const args = [null, csv(), "real stderr argument", extra];
		expect(Reflect.apply(reply(io), receiver, args)).toBe(extra);
		expect(actualThis).toBe(receiver);
		expect(actual).toEqual(args);
		expect(actual[3]).toBe(extra);
		expect(observer.snapshot().tasklist).toEqual([
			{ id: 1, callbacks: 1, value: 1_263_616, error: undefined },
		]);
		(io.child as Child).finish();
	});

	it("preserves callback throws and does not turn errors or malformed CSV into values", () => {
		const { io, observer } = observe();
		const marker = new Error("callback marker");
		io.execFile(...bindings.tasklist, () => {
			throw marker;
		});
		expect(() => reply(io)(null, csv(201), "")).toThrow(marker);
		expect(observer.snapshot().tasklist[0]?.value).toBeUndefined();
		const error = Object.defineProperty({}, "code", {
			get() {
				throw new Error("must not run");
			},
		});
		expect(() => reply(io)(error, csv(), "")).toThrow(marker);
		expect(observer.snapshot().tasklist[0]?.error).toBe("OTHER");
		expect(observer.snapshot().tasklist[0]?.value).toBeUndefined();
		expect(observer.snapshot().faults).toContain("CALLBACK_REPEATED");
		(io.child as Child).finish();
	});

	it("rejects non-string callback data without invoking coercion hooks", () => {
		const { io, observer } = observe();
		let coerced = 0;
		const stdout = {
			toString() {
				coerced++;
				throw new Error("coercion");
			},
		};
		let seen: unknown;
		io.execFile(...bindings.tasklist, (_error: unknown, value: unknown) => {
			seen = value;
		});
		reply(io)(null, stdout, "");
		expect(seen).toBe(stdout);
		expect(coerced).toBe(0);
		expect(observer.snapshot().faults).toContain("CALLBACK_INVALID");
		(io.child as Child).finish();
	});

	it("leaves a different tasklist target and its callback entirely untouched and unowned", () => {
		const { io, observer } = observe();
		const callback = () => 17;
		io.execFile(
			bindings.tasklist[0],
			["/fi", "PID eq 201", "/fo", "csv", "/nh"],
			bindings.tasklist[2],
			callback,
		);
		expect(io.calls[0]?.args[3]).toBe(callback);
		expect(observer.snapshot().children).toEqual([]);
		expect(observer.snapshot().tasklist).toEqual([]);
	});
});

describe("three lifecycle branches and restoration", () => {
	it("records a synchronous throw with no invented child or lifecycle", () => {
		const { io, observer } = observe();
		const marker = Object.assign(new Error("private message never recorded"), { code: "EACCES" });
		io.throwing = marker;
		expect(() => io.spawn(...bindings.reader)).toThrow(marker);
		expect(observer.snapshot().children).toEqual([]);
		expect(observer.unsettled()).toEqual([]);
		expect(observer.snapshot().events.at(-1)).toMatchObject({
			type: "spawn-throw",
			error: "EACCES",
		});
		expect(JSON.stringify(observer.snapshot())).not.toContain(marker.message);
	});

	it("requires error and close but never invents exit for a returned no-PID child", () => {
		const { io, observer } = observe();
		io.child = new Child(undefined);
		// Explicit assignment avoids the fixture constructor's default argument.
		Object.defineProperty(io.child, "pid", { value: undefined, configurable: true });
		const child = reader(io);
		expect(observer.unsettled()).toEqual([1]);
		child.emit("error", Object.assign(new Error("unused"), { code: "EACCES" }));
		expect(observer.unsettled()).toEqual([1]);
		child.emit("close", -1, null);
		expect(observer.unsettled()).toEqual([]);
		expect(observer.snapshot().children[0]).toMatchObject({
			branch: "no-pid",
			pid: undefined,
			errors: 1,
			exit: undefined,
			close: { code: -1, signal: null },
		});
	});

	it("distinguishes started exit from close and reports pending handles without signaling them", () => {
		const { io, observer } = observe();
		const child = reader(io);
		let kills = 0;
		Object.defineProperty(child, "kill", {
			value() {
				kills++;
				throw new Error("not permitted");
			},
		});
		child.emit("spawn");
		child.emit("exit", null, "SIGTERM");
		expect(observer.unsettled()).toEqual([1]);
		expect(observer.snapshot().children[0]?.branch).toBe("started");
		expect(observer.restore().faults).toContain("UNSETTLED_CHILD");
		expect(kills).toBe(0);
	});

	it("marks before owner close, distinguishes late callbacks from new launches and counts fallback", () => {
		const { io, observer } = observe();
		io.execFile(...bindings.tasklist, () => "callback");
		const callback = reply(io);
		observer.fallback();
		observer.closeBoundary();
		expect(callback(null, csv(), "")).toBe("callback");
		(io.child as Child).finish();
		expect(observer.snapshot().launches.afterClose).toBe(0);
		expect(observer.snapshot().fallbackCount).toBe(1);
		io.child = new Child(301);
		io.spawn(...bindings.reader);
		expect(observer.snapshot().launches.afterClose).toBe(1);
		expect(observer.snapshot().faults).toContain("NEW_LAUNCH_AFTER_CLOSE");
		(io.child as Child).finish();
	});

	it("leaves unrelated calls after close unowned without a sampler launch refusal", () => {
		const { io, observer } = observe();
		observer.closeBoundary();
		const callback = () => 42;
		expect(io.spawn("other-tool", [], {})).toBe(io.child);
		expect(
			io.execFile(
				bindings.tasklist[0],
				["/fi", "PID eq 201", "/fo", "csv", "/nh"],
				bindings.tasklist[2],
				callback,
			),
		).toBe(io.child);
		expect(io.calls[1]?.args[3]).toBe(callback);
		expect(observer.snapshot().launches).toEqual({
			reader: 0,
			tasklist: 0,
			unmatched: 2,
			unmatchedAfterClose: 2,
			afterClose: 0,
		});
		expect(observer.snapshot().children).toEqual([]);
		expect(observer.snapshot().faults).not.toContain("NEW_LAUNCH_AFTER_CLOSE");
	});

	it("bounds more than 256 unrelated launches after close without poisoning sampler capture", () => {
		const { io, observer } = observe();
		const returned = Symbol("unrelated return");
		const argv = ["unchanged"];
		const options = { unchanged: true };
		io.child = returned;
		observer.closeBoundary();
		for (let index = 0; index < 300; index++)
			expect(io.spawn("unrelated-tool", argv, options)).toBe(returned);
		expect(io.calls).toHaveLength(300);
		for (const call of io.calls) {
			expect(call.receiver).toBe(io);
			expect(call.args[0]).toBe("unrelated-tool");
			expect(call.args[1]).toBe(argv);
			expect(call.args[2]).toBe(options);
		}
		const receipt = observer.snapshot();
		expect(receipt.children).toEqual([]);
		expect(receipt.launches).toEqual({
			reader: 0,
			tasklist: 0,
			unmatched: 257,
			unmatchedAfterClose: 257,
			afterClose: 0,
		});
		expect(receipt.faults).toEqual([]);
		expect(receipt.events.map((event) => event.type)).toEqual(["close-boundary"]);
	});

	it("restores exact own descriptors and removes only its inherited-method shadows", () => {
		const io = new IO();
		const child = io.child as Child;
		Object.defineProperty(io, "spawn", {
			value: io.spawn,
			enumerable: true,
			configurable: false,
			writable: true,
		});
		Object.defineProperty(child.stdin, "write", {
			value: child.stdin.write,
			enumerable: true,
			configurable: true,
			writable: true,
		});
		const spawnBefore = Object.getOwnPropertyDescriptor(io, "spawn");
		const writeBefore = Object.getOwnPropertyDescriptor(child.stdin, "write");
		const { observer } = observe(io);
		reader(io).finish();
		observer.restore();
		expect(Object.getOwnPropertyDescriptor(io, "spawn")).toEqual(spawnBefore);
		expect(Object.getOwnPropertyDescriptor(child.stdin, "write")).toEqual(writeBefore);
		expect(Object.hasOwn(io, "execFile")).toBe(false);
		expect(Object.hasOwn(child, "emit")).toBe(false);
		expect(Object.hasOwn(child.stdout, "emit")).toBe(false);
		expect(observer.restore().faults).toEqual([]);
	});

	it("does not overwrite another replacement when restoring and rejects unobservable objects", () => {
		const { io, observer } = observe();
		const foreign = () => "foreign";
		io.child = new Proxy(
			{},
			{
				get() {
					throw new Error("trap");
				},
				getOwnPropertyDescriptor() {
					throw new Error("trap");
				},
			},
		);
		expect(io.spawn(...bindings.reader)).toBe(io.child);
		Object.defineProperty(io, "spawn", { value: foreign, configurable: true, writable: true });
		expect(observer.restore().faults).toEqual(
			expect.arrayContaining(["CHILD_UNOBSERVABLE", "RESTORE_CONFLICT"]),
		);
		expect(io.spawn()).toBe("foreign");
		expect(observer.snapshot().children).toEqual([]);
	});

	it("rolls back a partial install without calling any delegate", () => {
		const io = new IO();
		const before = Object.getOwnPropertyDescriptor(io, "spawn");
		Object.defineProperty(io, "execFile", {
			value: io.execFile,
			configurable: false,
			writable: false,
		});
		expect(() => createWindowsSamplerObserver(io, bindings)).toThrow("OBSERVER_INSTALL_REFUSED");
		expect(Object.getOwnPropertyDescriptor(io, "spawn")).toEqual(before);
		expect(io.calls).toEqual([]);
	});

	it("contains an internal tap-install failure without changing the returned object", () => {
		const { io, observer } = observe();
		io.child = Object.preventExtensions(new Child());
		expect(() => io.spawn(...bindings.reader)).not.toThrow();
		expect(io.calls).toHaveLength(1);
		expect(observer.snapshot().faults).toContain("OBSERVATION_ERROR");
		expect(observer.unsettled()).toEqual([1]);
	});
});

const configBinding = () => ({
	source: "a".repeat(40),
	route: WINDOWS_POLICY_ROUTE,
	admissionRef: "synthetic-consistency-only",
	case: "B" as const,
});

describe("explicit Windows profile configuration, data only", () => {
	it("rejects an ordinary or invented mode before reading either binding", () => {
		let reads = 0;
		const inputs = {
			platform: "win32",
			get request() {
				reads++;
				throw new Error("request evaluated");
			},
			get expected() {
				reads++;
				throw new Error("expected evaluated");
			},
		};
		for (const mode of ["test", "live", "device", "windows-policy", ""])
			expect(() => validateWindowsPolicyRequest(mode, inputs)).toThrow(
				"WINDOWS_POLICY_MODE_REQUIRED",
			);
		expect(reads).toBe(0);
	});

	it("rejects a non-Windows explicit request before reading bindings", () => {
		let reads = 0;
		const inputs = {
			platform: "linux",
			get request() {
				reads++;
				throw new Error("request evaluated");
			},
			get expected() {
				reads++;
				throw new Error("expected evaluated");
			},
		};
		expect(() => validateWindowsPolicyRequest(WINDOWS_POLICY_MODE, inputs)).toThrow(
			"WINDOWS_POLICY_PLATFORM_REQUIRED",
		);
		expect(reads).toBe(0);
	});

	it("refuses absent inputs and malformed JSON instead of an empty native selection", () => {
		const valid = configBinding();
		expect(() =>
			validateWindowsPolicyRequest("heavy", {
				platform: "win32",
				request: undefined,
				expected: valid,
			}),
		).toThrow("WINDOWS_POLICY_REQUEST_REQUIRED");
		expect(() =>
			validateWindowsPolicyRequest("heavy", {
				platform: "win32",
				request: valid,
				expected: undefined,
			}),
		).toThrow("WINDOWS_POLICY_EXPECTED_REQUIRED");
		for (const malformed of ["{", "null", "[]", " ".repeat(4097)])
			expect(() =>
				validateWindowsPolicyRequest("heavy", {
					platform: "win32",
					request: malformed,
					expected: valid,
				}),
			).toThrow("WINDOWS_POLICY_BINDING_INVALID");
	});

	it("refuses accessors, proxies and extra grant-shaped fields without evaluating them", () => {
		let reads = 0;
		const accessor = Object.defineProperty(configBinding(), "source", {
			get() {
				reads++;
				throw new Error("source evaluated");
			},
		});
		const proxy = new Proxy(
			{},
			{
				get() {
					reads++;
					throw new Error("get trap");
				},
				ownKeys() {
					reads++;
					throw new Error("keys trap");
				},
				getOwnPropertyDescriptor() {
					reads++;
					throw new Error("descriptor trap");
				},
				getPrototypeOf() {
					reads++;
					throw new Error("prototype trap");
				},
			},
		);
		for (const request of [accessor, proxy, { ...configBinding(), nativePass: true }])
			expect(() =>
				validateWindowsPolicyRequest("heavy", {
					platform: "win32",
					request,
					expected: configBinding(),
				}),
			).toThrow("WINDOWS_POLICY_BINDING_INVALID");
		expect(reads).toBe(0);
	});

	it("distinguishes route, case, source and reference mismatch without treating a DTO as authority", () => {
		const expected = configBinding();
		for (const [request, code] of [
			[{ ...expected, route: "another-route" }, "ROUTE_MISMATCH"],
			[{ ...expected, case: "A" }, "CASE_MISMATCH"],
			[{ ...expected, source: "b".repeat(40) }, "SOURCE_MISMATCH"],
			[{ ...expected, admissionRef: "another-context" }, "REFERENCE_MISMATCH"],
		] as const)
			expect(() =>
				validateWindowsPolicyRequest("heavy", { platform: "win32", request, expected }),
			).toThrow(`WINDOWS_POLICY_${code}`);
	});

	it("returns detached frozen consistency data for object or JSON inputs and distinguishes A from B", () => {
		const request = configBinding();
		const expected = configBinding();
		const result = validateWindowsPolicyRequest("heavy", { platform: "win32", request, expected });
		expect(result).toEqual(expected);
		expect(result).not.toBe(request);
		expect(result).not.toBe(expected);
		expect(Object.isFrozen(result)).toBe(true);
		request.source = "b".repeat(40);
		expect(result.source).toBe("a".repeat(40));
		expect(
			validateWindowsPolicyRequest("heavy", {
				platform: "win32",
				request: JSON.stringify(expected),
				expected: JSON.stringify(expected),
			}),
		).toEqual(result);
		const a = { ...expected, case: "A" as const };
		expect(
			validateWindowsPolicyRequest("heavy", { platform: "win32", request: a, expected: a }, "A"),
		).toEqual(a);
		expect(() =>
			validateWindowsPolicyRequest("heavy", { platform: "win32", request: a, expected: a }),
		).toThrow("WINDOWS_POLICY_CASE_MISMATCH");
	});

	it("selects exactly one explicit entry with no zero-test pass or eager capability detector", () => {
		const config = createWindowsPolicyConfig(
			{ command: "serve", mode: "heavy" },
			{
				platform: "win32",
				request: configBinding(),
				expected: configBinding(),
			},
		);
		expect(config.envDir).toBe(false);
		expect(config.test?.include).toEqual(["test/plugins/supervisor-windows-policy.native.ts"]);
		expect(config.test?.include).toEqual([WINDOWS_POLICY_ENTRY]);
		expect(config.test?.passWithNoTests).toBe(false);
		expect(config.test?.exclude).toEqual([
			...defaultExclude,
			"**/*siwc*/**",
			"**/*siwc*",
			"**/*dynamic-agent*",
			"**/*dynamic_agent*",
		]);
		expect(config.test?.fsModuleCachePath).toBe(
			path.join(process.cwd(), "node_modules", ".vitest-cache"),
		);
		expect(config.test?.execArgv).toEqual([
			"--require",
			fileURLToPath(new URL("../helpers/loopback-preload.cjs", import.meta.url)),
		]);
		expect(config.test?.tags).toBeUndefined();
	});

	it("leaves the actual native entry outside every default tier's consumed glob", () => {
		for (const mode of ["test", "heavy", "live", "device"]) {
			const config = vitestConfig({ command: "serve", mode });
			expect(
				config.test?.include?.some((pattern) => path.matchesGlob(WINDOWS_POLICY_ENTRY, pattern)),
			).toBe(false);
		}
	});
});

describe("original Promise observation, microtasks only", () => {
	it("records a pending result before its caller resumes without replacing the Promise", async () => {
		const pending = Promise.withResolvers<object>();
		const value = {};
		const order: string[] = [];
		const returned = tapOriginalPromise(
			pending.promise,
			(actual) => {
				expect(actual).toBe(value);
				order.push("observation");
			},
			() => {
				throw new Error("unexpected rejection");
			},
		);
		expect(returned).toBe(pending.promise);
		const caller = (async () => {
			expect(await returned).toBe(value);
			order.push("caller");
		})();
		pending.resolve(value);
		await caller;
		expect(order).toEqual(["observation", "caller"]);
	});

	it("records an already-resolved result before an awaiting caller resumes", async () => {
		const original = Promise.resolve(42);
		const order: string[] = [];
		expect(
			tapOriginalPromise(
				original,
				() => {
					order.push("observation");
				},
				() => {},
			),
		).toBe(original);
		expect(await original).toBe(42);
		order.push("caller");
		expect(order).toEqual(["observation", "caller"]);
	});

	it("preserves original rejection identity when the observation error handler also throws", async () => {
		const originalError = {};
		const observerError = {};
		const original = Promise.reject(originalError);
		let observed: unknown;
		const returned = tapOriginalPromise(
			original,
			() => {
				throw new Error("unexpected fulfillment");
			},
			(error) => {
				observed = error;
				throw observerError;
			},
		);
		expect(returned).toBe(original);
		await expect(returned).rejects.toBe(originalError);
		await Promise.resolve();
		expect(observed).toBe(originalError);
	});

	it("contains observer failures while preserving the original fulfilled object", async () => {
		const value = {};
		const observerError = {};
		const original = Promise.resolve(value);
		const errors: unknown[] = [];
		const returned = tapOriginalPromise(
			original,
			() => {
				throw observerError;
			},
			(error) => {
				errors.push(error);
				throw new Error("observation handler failed");
			},
		);
		expect(returned).toBe(original);
		expect(await returned).toBe(value);
		await Promise.resolve();
		expect(errors).toEqual([observerError]);
	});
});

type MutableData<T> = T extends readonly (infer Item)[]
	? MutableData<Item>[]
	: T extends object
		? { -readonly [Key in keyof T]: MutableData<T[Key]> }
		: T;

function editedReceipt(
	receipt: WindowsSamplerReceipt,
	edit: (copy: MutableData<WindowsSamplerReceipt>) => void,
): WindowsSamplerReceipt {
	const copy = structuredClone(receipt) as MutableData<WindowsSamplerReceipt>;
	edit(copy);
	return copy;
}

function purePrimaryReceipt(
	values: readonly number[],
	checked: string = "64",
): WindowsSamplerReceipt {
	const { io, observer } = observe();
	const child = reader(io);
	child.emit("spawn");
	child.stdin.write("100\n");
	child.stdout.emit("data", `${checked}\n`);
	for (const value of values) {
		child.stdin.write("200\n");
		child.stdout.emit("data", `${String(value)}\n`);
	}
	observer.closeBoundary();
	child.emit("exit", 0, null);
	child.emit("close", 0, null);
	return observer.restore();
}

function pureFallbackReceipt(
	branch: "sync-throw" | "no-pid" | "started" = "no-pid",
	afterClose?: (io: IO) => void,
) {
	const expected = windowsSamplerBindings("C:\\Windows", 200, 200);
	const { io, observer } = observe(new IO(), expected);
	if (branch === "sync-throw") {
		const error = Object.assign(new Error("synthetic reader refusal"), { code: "EACCES" });
		io.throwing = error;
		expect(() => io.spawn(...expected.reader)).toThrow(error);
		io.throwing = undefined;
	} else {
		const child = new Child();
		if (branch === "no-pid") Object.defineProperty(child, "pid", { value: undefined });
		io.child = child;
		io.spawn(...expected.reader);
		if (branch === "started") {
			child.emit("spawn");
			child.stdin.write("200\n");
			child.emit("exit", 1, null);
		} else child.emit("error", Object.assign(new Error("synthetic refusal"), { code: "EACCES" }));
		child.emit("close", branch === "started" ? 1 : -1, null);
	}
	observer.fallback();
	const samples: [number, number] = [1234 * 1024, 2345 * 1024];
	for (let index = 0; index < 2; index++) {
		const child = new Child(401 + index);
		io.child = child;
		io.execFile(...expected.tasklist, () => undefined);
		child.emit("spawn");
		child.emit("exit", 0, null);
		child.emit("close", 0, null);
		reply(io)(null, csv(200, index === 0 ? "1,234 K" : "2,345 K"), "");
	}
	observer.closeBoundary();
	afterClose?.(io);
	return { receipt: observer.restore(), samples };
}

describe("primary measurement consistency, synthetic capture only", () => {
	it("requires a positive hub check then an over-limit owned-target reading while preserving write(false)", () => {
		const receipt = purePrimaryReceipt([999, 1001]);
		expect(receipt.requests.map((request) => request.write)).toEqual([
			"backpressure",
			"backpressure",
			"backpressure",
		]);
		expect(() => assertWindowsPolicyPrimaryReceipt(receipt, 100, 200, 1000)).not.toThrow();
	});

	it("refuses the exact limit without an over-limit measurement", () => {
		expect(() =>
			assertWindowsPolicyPrimaryReceipt(purePrimaryReceipt([999, 1000]), 100, 200, 1000),
		).toThrow("WINDOWS_PRIMARY_OBSERVATION_INVALID");
	});

	it("refuses an unreadable self-check, a wrong target and incomplete reader settlement", () => {
		expect(() =>
			assertWindowsPolicyPrimaryReceipt(purePrimaryReceipt([1001], "x"), 100, 200, 1000),
		).toThrow("WINDOWS_PRIMARY_OBSERVATION_INVALID");
		const receipt = purePrimaryReceipt([1001]);
		expect(() => assertWindowsPolicyPrimaryReceipt(receipt, 100, 201, 1000)).toThrow(
			"WINDOWS_PRIMARY_OBSERVATION_INVALID",
		);
		const unfinished = editedReceipt(receipt, (copy) => {
			if (copy.children[0]) copy.children[0].close = undefined;
		});
		expect(() => assertWindowsPolicyPrimaryReceipt(unfinished, 100, 200, 1000)).toThrow(
			"WINDOWS_PRIMARY_OBSERVATION_INVALID",
		);
	});
});

describe("fallback measurement consistency, synthetic capture only", () => {
	it("refuses an otherwise complete fallback observation with an unmatched post-close command", () => {
		const { receipt, samples } = pureFallbackReceipt("no-pid", (io) => {
			const unowned = new Child(901);
			const argv: unknown[] = [];
			const options = {};
			io.child = unowned;
			expect(io.spawn("unrelated-tool", argv, options)).toBe(unowned);
			const call = io.calls.at(-1);
			expect(call?.receiver).toBe(io);
			expect(call?.args[1]).toBe(argv);
			expect(call?.args[2]).toBe(options);
		});
		expect(receipt.faults).toEqual([]);
		expect(receipt.launches.afterClose).toBe(0);
		expect(receipt.launches.unmatchedAfterClose).toBe(1);
		expect(receipt.children).toHaveLength(3);
		expect(receipt.children.some((child) => child.pid === 901)).toBe(false);
		expect(() => assertWindowsPolicyFallbackReceipt(receipt, 200, samples, undefined)).toThrow(
			"WINDOWS_FALLBACK_OBSERVATION_INVALID",
		);
	});

	it.each(["sync-throw", "no-pid", "started"] as const)(
		"accepts only complete %s capture data, without asserting policy cause",
		(branch) => {
			const { receipt, samples } = pureFallbackReceipt(branch);
			expect(() =>
				assertWindowsPolicyFallbackReceipt(receipt, 200, samples, undefined),
			).not.toThrow();
			expect(receipt.scope).toBe("capture-only");
		},
	);

	it("requires observed working-set values for the same PID and an unreadable post-close result", () => {
		const { receipt, samples } = pureFallbackReceipt();
		expect(() =>
			assertWindowsPolicyFallbackReceipt(receipt, 200, [samples[0] + 1, samples[1]], undefined),
		).toThrow("WINDOWS_FALLBACK_OBSERVATION_INVALID");
		expect(() => assertWindowsPolicyFallbackReceipt(receipt, 201, samples, undefined)).toThrow(
			"WINDOWS_FALLBACK_OBSERVATION_INVALID",
		);
		expect(() => assertWindowsPolicyFallbackReceipt(receipt, 200, samples, 1)).toThrow(
			"WINDOWS_FALLBACK_OBSERVATION_INVALID",
		);
	});

	it("refuses a started reader with its self-check observation entirely missing", () => {
		const { receipt, samples } = pureFallbackReceipt("started");
		const changed = editedReceipt(receipt, (copy) => {
			copy.requests = [];
			copy.events = copy.events.filter((event) => event.type !== "reader-request");
			copy.events.forEach((event, index) => {
				event.seq = index + 1;
			});
		});
		expect(changed.faults).toEqual([]);
		expect(changed.children.find((child) => child.kind === "reader")?.branch).toBe("started");
		expect(() => assertWindowsPolicyFallbackReceipt(changed, 200, samples, undefined)).toThrow(
			"WINDOWS_FALLBACK_OBSERVATION_INVALID",
		);
	});

	it.each([0, 2])("requires each fallback callback exactly once, not %s times", (callbacks) => {
		const { receipt, samples } = pureFallbackReceipt();
		const changed = editedReceipt(receipt, (copy) => {
			if (copy.tasklist[1]) copy.tasklist[1].callbacks = callbacks;
		});
		expect(() => assertWindowsPolicyFallbackReceipt(changed, 200, samples, undefined)).toThrow(
			"WINDOWS_FALLBACK_OBSERVATION_INVALID",
		);
	});

	it("refuses a restart, new sampler work after close or an unfinished tool without relying on a fault label", () => {
		const { receipt, samples } = pureFallbackReceipt();
		for (const changed of [
			editedReceipt(receipt, (copy) => {
				copy.launches.reader = 2;
			}),
			editedReceipt(receipt, (copy) => {
				copy.launches.afterClose = 1;
			}),
			editedReceipt(receipt, (copy) => {
				const tool = copy.children.find((child) => child.kind === "tasklist");
				if (tool) tool.close = undefined;
			}),
		]) {
			expect(changed.faults).toEqual([]);
			expect(() => assertWindowsPolicyFallbackReceipt(changed, 200, samples, undefined)).toThrow(
				"WINDOWS_FALLBACK_OBSERVATION_INVALID",
			);
		}
	});

	it("never invents exit for a denied child with no PID", () => {
		const { receipt, samples } = pureFallbackReceipt();
		const changed = editedReceipt(receipt, (copy) => {
			const reader = copy.children.find((child) => child.kind === "reader");
			if (reader) reader.exit = { code: 0, signal: null };
		});
		expect(() => assertWindowsPolicyFallbackReceipt(changed, 200, samples, undefined)).toThrow(
			"WINDOWS_FALLBACK_OBSERVATION_INVALID",
		);
	});

	it("refuses a confirmed primary reading or target request in a fallback-only observation", () => {
		const { receipt, samples } = pureFallbackReceipt("started");
		for (const role of ["self-check", "target"] as const) {
			const changed = editedReceipt(receipt, (copy) => {
				copy.requests.push({
					id: 1,
					child: 1,
					pid: 200,
					role,
					write: "backpressure",
					reply: role === "self-check" ? "value" : "pending",
					value: role === "self-check" ? 64 : undefined,
				});
			});
			expect(() => assertWindowsPolicyFallbackReceipt(changed, 200, samples, undefined)).toThrow(
				"WINDOWS_FALLBACK_OBSERVATION_INVALID",
			);
		}
	});

	it("requires both callbacks before close even when their values and counts are otherwise complete", () => {
		const { receipt, samples } = pureFallbackReceipt();
		const changed = editedReceipt(receipt, (copy) => {
			const index = copy.events.findLastIndex((event) => event.type === "tasklist-reply");
			const [late] = copy.events.splice(index, 1);
			if (!late) throw new Error("Synthetic reply missing");
			copy.events.push(late);
			copy.events.forEach((event, position) => {
				event.seq = position + 1;
			});
		});
		expect(changed.tasklist).toEqual(receipt.tasklist);
		expect(changed.faults).toEqual([]);
		expect(() => assertWindowsPolicyFallbackReceipt(changed, 200, samples, undefined)).toThrow(
			"WINDOWS_FALLBACK_OBSERVATION_INVALID",
		);
	});
});
