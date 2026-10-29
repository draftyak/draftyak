import type { SendPolicyInput } from "@draftyak/extensions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type DeadlineClock,
	POLICY_TIMEOUT_MS,
	settleWithin,
} from "../../src/extensions/policy.ts";
import { MODULE_TIMEOUT_MS } from "../../src/extensions/registry.ts";
import {
	busyFor,
	type Fixture,
	fixture,
	flush,
	manualClock,
	OTHER_ULID,
	resetTrace,
	trace,
	ULID,
} from "./helpers.ts";

let f: Fixture;
beforeEach(() => {
	resetTrace();
	f = fixture();
});
afterEach(() => f.remove());

const input = (): SendPolicyInput =>
	({
		phase: "claim",
		snapshot: { v: 1, draft: { body: "DYTEST-SNAPSHOT" } } as never,
		flags: [],
		userId: ULID,
		accountId: OTHER_ULID,
	}) as SendPolicyInput;
const policy = (id: string, body: string): string =>
	`registry.sendPolicy({ id: ${JSON.stringify(id)}, async evaluate(input) { ${body} } });`;
const modules = (...bodies: string[]) =>
	f.config(
		bodies.map((body, index) =>
			f.module(`m${index}`, policy(`p${index}`, body), { provides: ["sendPolicy"] }),
		),
	);

describe("send policies", () => {
	it("AND-s every policy: require takes the most approvals and every role, deny wins", async () => {
		modules(
			'return { kind: "require", approvals: 2, roles: ["finance"] };',
			'return { kind: "require", approvals: 3, roles: ["legal", "finance"] };',
			'return { kind: "require", approvals: 1 };',
		);
		const host = await f.start();
		expect(await host.evaluateSendPolicy(input())).toEqual({
			kind: "require",
			approvals: 3,
			roles: ["finance", "legal"],
		});
		host.close();
		modules(
			'return { kind: "require", approvals: 5 };',
			'return { kind: "deny", reason: "DYTEST-REASON" };',
		);
		const next = await f.start();
		const decision = await next.evaluateSendPolicy(input());
		expect(decision).toEqual({ kind: "deny", policies: ["m1/p1"] });
		expect(JSON.stringify(decision)).not.toContain("DYTEST-REASON");
		expect(Object.isFrozen(decision)).toBe(true);
	});

	it.each([
		["a synchronous throw", 'evaluate() { throw new Error("PRIVATE_CANARY"); }'],
		["a rejection", 'async evaluate() { throw new Error("PRIVATE_CANARY"); }'],
		["no result", "async evaluate() {}"],
		["an allow result", 'async evaluate() { return { kind: "allow" }; }'],
		["a skip result", 'async evaluate() { return { kind: "skip" }; }'],
		["zero approvals", 'async evaluate() { return { kind: "require", approvals: 0 }; }'],
		["fractional approvals", 'async evaluate() { return { kind: "require", approvals: 1.5 }; }'],
		["approvals as text", 'async evaluate() { return { kind: "require", approvals: "2" }; }'],
		["unsafe approvals", 'async evaluate() { return { kind: "require", approvals: 2 ** 53 }; }'],
		[
			"an extra field",
			'async evaluate() { return { kind: "require", approvals: 2, skipApproval: true }; }',
		],
		[
			"a role outside the grammar",
			'async evaluate() { return { kind: "require", approvals: 1, roles: ["Owner"] }; }',
		],
		[
			"a repeated role",
			'async evaluate() { return { kind: "require", approvals: 1, roles: ["a", "a"] }; }',
		],
		[
			"roles that are not an array",
			'async evaluate() { return { kind: "require", approvals: 1, roles: "owner" }; }',
		],
		[
			"an accessor",
			'async evaluate() { return { kind: "require", get approvals() { trace.push("getter"); return 1; } }; }',
		],
		["a proxy", 'async evaluate() { return new Proxy({ kind: "require", approvals: 1 }, {}); }'],
		[
			"an inherited kind",
			'async evaluate() { return Object.assign(Object.create({ kind: "require" }), { approvals: 1 }); }',
		],
	])("denies %s", async (_, method) => {
		f.config([
			f.module("m0", `registry.sendPolicy({ id: "p0", ${method} });`, { provides: ["sendPolicy"] }),
		]);
		const host = await f.start();
		expect(await host.evaluateSendPolicy(input())).toEqual({ kind: "deny", policies: ["m0/p0"] });
		expect(trace()).not.toContain("getter");
	});

	it("denies a policy still running after two seconds", async () => {
		const clock = manualClock();
		modules('return { kind: "require", approvals: 1 };', "return new Promise(() => {});");
		const host = await f.start({ clock });
		const pending = host.evaluateSendPolicy(input());
		await flush();
		expect(clock.waits.slice(-2)).toEqual([POLICY_TIMEOUT_MS, POLICY_TIMEOUT_MS]);
		expect(clock.waits.filter((ms) => ms === MODULE_TIMEOUT_MS)).toHaveLength(4);
		clock.fire();
		expect(await pending).toEqual({ kind: "deny", policies: ["m1/p1"] });
	});

	it.each([
		["one millisecond inside the bound", POLICY_TIMEOUT_MS - 1, "require"],
		["to the bound", POLICY_TIMEOUT_MS, "deny"],
		["past the bound", POLICY_TIMEOUT_MS + 1, "deny"],
		["while the clock goes backwards", -1, "deny"],
	])(
		"judges a result a busy event loop delays %s by the host's monotonic clock",
		async (_, ms, kind) => {
			const clock = manualClock();
			modules(`${busyFor(ms)} return { kind: "require", approvals: 2 };`);
			const host = await f.start({ clock });
			expect(await host.evaluateSendPolicy(input())).toEqual(
				kind === "require"
					? { kind: "require", approvals: 2, roles: [] }
					: { kind: "deny", policies: ["m0/p0"] },
			);
			expect(clock.waits.at(-1)).toBe(POLICY_TIMEOUT_MS);
		},
	);

	it("gives every policy its own frozen copy of the input", async () => {
		modules(
			`trace.push(Object.isFrozen(input), Object.isFrozen(input.snapshot.draft));
			try { input.snapshot.draft.body = "changed"; } catch (error) { trace.push(error.constructor.name); }
			try { input.flags.push({}); } catch (error) { trace.push(error.constructor.name); }
			return { kind: "require", approvals: 1 };`,
			`trace.push(input.snapshot.draft.body);
			return { kind: "require", approvals: 1 };`,
		);
		const host = await f.start();
		const core = input();
		expect(await host.evaluateSendPolicy(core)).toEqual({
			kind: "require",
			approvals: 1,
			roles: [],
		});
		expect(trace()).toEqual(expect.arrayContaining([true, true, "TypeError", "DYTEST-SNAPSHOT"]));
		expect(trace().filter((item) => item === "TypeError")).toHaveLength(2);
		expect(core).toEqual(input());
		expect(Object.isFrozen(core)).toBe(false);
	});

	it("refuses an unknown phase from core", async () => {
		const host = await f.start();
		await expect(host.evaluateSendPolicy({ ...input(), phase: "send" as never })).rejects.toThrow(
			TypeError,
		);
	});
});

describe("workspace access", () => {
	const workspace = (body: string): string =>
		`registry.workspace({ id: "w", async workspacesFor() { return []; }, async canAccess(userId, accountId) { ${body} } });`;

	it("allows only an exact true for the asked user and account", async () => {
		f.config([
			f.module("alpha", workspace("trace.push(userId, accountId); return true;"), {
				provides: ["workspace"],
			}),
		]);
		const host = await f.start();
		expect(await host.canAccessWorkspace(ULID, OTHER_ULID)).toBe(true);
		expect(trace()).toEqual(expect.arrayContaining([ULID, OTHER_ULID]));
	});

	it.each([
		["a truthy value", "return 1;"],
		["a truthy string", 'return "true";'],
		["a boxed true", "return new Boolean(true);"],
		["a rejection", 'throw new Error("PRIVATE_CANARY");'],
		["false", "return false;"],
	])("refuses %s", async (_, body) => {
		f.config([f.module("alpha", workspace(body), { provides: ["workspace"] })]);
		const host = await f.start();
		expect(await host.canAccessWorkspace(ULID, OTHER_ULID)).toBe(false);
	});

	it("refuses a provider still running after two seconds", async () => {
		const clock = manualClock();
		f.config([
			f.module("alpha", workspace("return new Promise(() => {});"), { provides: ["workspace"] }),
		]);
		const host = await f.start({ clock });
		const pending = host.canAccessWorkspace(ULID, OTHER_ULID);
		await flush();
		expect(clock.waits.at(-1)).toBe(POLICY_TIMEOUT_MS);
		clock.fire();
		expect(await pending).toBe(false);
	});

	it.each([
		["one millisecond inside the bound", POLICY_TIMEOUT_MS - 1, true],
		["to the bound", POLICY_TIMEOUT_MS, false],
		["past the bound", POLICY_TIMEOUT_MS + 1, false],
		["while the clock goes backwards", -1, false],
	])(
		"judges an answer a busy event loop delays %s by the host's monotonic clock",
		async (_, ms, allowed) => {
			const clock = manualClock();
			f.config([
				f.module("alpha", workspace(`${busyFor(ms)} return true;`), { provides: ["workspace"] }),
			]);
			const host = await f.start({ clock });
			expect(await host.canAccessWorkspace(ULID, OTHER_ULID)).toBe(allowed);
			expect(clock.waits.at(-1)).toBe(POLICY_TIMEOUT_MS);
		},
	);
});

describe("the deadline fence", () => {
	/** A timer that ends only on abort, and monotonic readings handed out in order. */
	const readings = (...values: unknown[]): DeadlineClock => ({
		after: (_ms, signal) =>
			new Promise<void>((_resolve, reject) =>
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
			),
		monotonicMs: () => {
			const value = values.shift();
			if (value instanceof Error) throw value;
			return value as number;
		},
	});

	it.each([
		["one millisecond inside the bound", [0, POLICY_TIMEOUT_MS - 1], true, true],
		["at the bound", [0, POLICY_TIMEOUT_MS], true, false],
		["past the bound", [0, POLICY_TIMEOUT_MS + 1], true, false],
		["after the clock went backwards", [5, 4], true, false],
		["with a non-finite end reading", [0, Number.NaN], true, false],
		["with an infinite end reading", [0, Number.POSITIVE_INFINITY], true, false],
		["with an end reading that is not a number", [0, "1"], true, false],
		["with an end reading that throws", [0, new Error("PRIVATE_CANARY")], true, false],
		["with an infinite start reading", [Number.NEGATIVE_INFINITY, 0], false, false],
		["with a start reading that is not a number", ["0", 1], false, false],
		["with a start reading that throws", [new Error("PRIVATE_CANARY")], false, false],
	])("counts a value settling %s only inside the bound", async (_, values, runs, counts) => {
		let ran = false;
		const settled = await settleWithin(
			() => {
				ran = true;
				return "DYTEST-VALUE";
			},
			POLICY_TIMEOUT_MS,
			readings(...values),
		);
		expect(settled).toEqual(counts ? { value: "DYTEST-VALUE" } : undefined);
		expect(ran).toBe(runs);
	});
});
