import { expect, it, vi } from "vitest";
import { assertDestinations, createRecorder, readResult } from "../src/index.ts";
import { record } from "../src/schema.ts";
import { hub, parsedZero, required, target, zero } from "./fixtures.ts";

const aliases = ["hub\n", `${"h".repeat(64)}\n`, "hub\r\n", "hub\u2028", "hub\u2029", "hub\nother"];
const steps = () => ({ policy: vi.fn(() => false), resolve: vi.fn(), connect: vi.fn() });

it.each(aliases)("refuses whole-string observer/caller metadata %j at writer", (token) => {
	for (const descriptor of [
		{ ...hub, id: token },
		{ ...hub, caller: { ...hub.caller, instanceId: token } },
	]) {
		expect(() => createRecorder({ profile: "test", observers: [descriptor] })).toThrow(
			"INVALID_RESULT",
		);
	}
});
it.each(aliases)(
	"refuses whole-string observer/caller metadata %j in consumer requirements",
	(token) => {
		for (const descriptor of [
			{ ...hub, id: token },
			{ ...hub, caller: { ...hub.caller, instanceId: token } },
		]) {
			expect(() => readResult(zero(), { ...required, observers: [descriptor] })).toThrow(
				"INVALID_RESULT",
			);
		}
	},
);
it.each(aliases)("refuses whole-string observer/caller metadata %j in encoded reports", (token) => {
	for (const descriptor of [
		{ ...hub, id: token },
		{ ...hub, caller: { ...hub.caller, instanceId: token } },
	]) {
		expect(() =>
			readResult(
				JSON.stringify({
					...parsedZero(),
					observers: [{ ...descriptor, state: "complete", attempts: 0, canary: "unobserved" }],
				}),
				required,
			),
		).toThrow("INVALID_RESULT");
	}
});

const hostAliases = [
	"upstream.example\n",
	"upstream.example\r\n",
	"upstream.example\u2028",
	"upstream.example\u2029",
	"upstream.example\nother",
];
it.each(hostAliases)("refuses a noncanonical destination %j before dispatch", async (host) => {
	const recorder = createRecorder({ profile: "test", observers: [hub] });
	const observer = recorder.observer(hub.id);
	const actions = steps();
	await expect(observer.observe({ ...target, host }, actions)).rejects.toThrow("INVALID_RESULT");
	expect(actions.policy).not.toHaveBeenCalled();
	expect(() => readResult(recorder.finish(), required)).toThrow("OBSERVATION_FAILED");
});
it.each(hostAliases)("refuses a noncanonical destination %j in encoded reports", (host) => {
	const report = {
		...parsedZero(),
		observers: [{ ...hub, state: "complete", attempts: 1, canary: "unobserved" }],
		attempts: [
			{
				observerId: hub.id,
				sequence: 0,
				destination: { ...target, host },
				stage: "policy",
				outcome: "refused",
			},
		],
	};
	expect(() => readResult(JSON.stringify(report), required)).toThrow("INVALID_RESULT");
});

it("keeps exact token and DNS-label/host length boundaries valid", async () => {
	const descriptor = {
		id: "x".repeat(64),
		caller: { kind: "hub" as const, instanceId: "y".repeat(64) },
	};
	const recorder = createRecorder({ profile: "test", observers: [descriptor] });
	const observer = recorder.observer(descriptor.id);
	const host = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
	expect(host).toHaveLength(253);
	await expect(observer.observe({ ...target, host }, steps())).resolves.toMatchObject({
		outcome: "refused",
	});
	observer.complete();
	expect(
		readResult(recorder.finish(), { ...required, observers: [descriptor] }).attempts[0]?.destination
			.host,
	).toBe(host);
});

it.each(["observe", "scanCanary"] as const)(
	"poisons an unsealed session on %s after completion without dispatch",
	async (operation) => {
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		await observer.scanCanary(new Uint8Array([7]), []);
		observer.complete();
		const actions = steps();
		const iterator = vi.fn(() => [][Symbol.iterator]());
		const chunks = { [Symbol.iterator]: iterator };
		await expect(
			operation === "observe"
				? observer.observe(target, actions)
				: observer.scanCanary(new Uint8Array([7]), chunks),
		).rejects.toThrow("LIFECYCLE");
		expect(actions.policy).not.toHaveBeenCalled();
		expect(iterator).not.toHaveBeenCalled();
		expect(() => readResult(recorder.finish(), { ...required, canary: true })).toThrow(
			"OBSERVATION_FAILED",
		);
	},
);

it("refuses metadata proxies before any trap can run across writer and reader inputs", async () => {
	let traps = 0;
	const wrap = <T extends object>(value: T): T =>
		new Proxy(value, {
			get: (object, key, receiver) => {
				traps++;
				return Reflect.get(object, key, receiver);
			},
			getPrototypeOf: (object) => {
				traps++;
				return Reflect.getPrototypeOf(object);
			},
			ownKeys: (object) => {
				traps++;
				return Reflect.ownKeys(object);
			},
			getOwnPropertyDescriptor: (object, key) => {
				traps++;
				return Reflect.getOwnPropertyDescriptor(object, key);
			},
		});
	for (const options of [
		wrap({ profile: "test", observers: [hub] }),
		{ profile: "test", observers: wrap([hub]) },
		{ profile: "test", observers: [wrap(hub)] },
		{ profile: "test", observers: [{ ...hub, caller: wrap(hub.caller) }] },
	]) {
		expect(() => createRecorder(options)).toThrow("INVALID_RESULT");
	}
	for (const requirements of [
		wrap(required),
		{ ...required, observers: wrap([hub]) },
		{ ...required, observers: [wrap(hub)] },
		{ ...required, observers: [{ ...hub, caller: wrap(hub.caller) }] },
	]) {
		expect(() => readResult(zero(), requirements)).toThrow("INVALID_RESULT");
	}
	const recorder = createRecorder({ profile: "test", observers: [hub] });
	const observer = recorder.observer(hub.id);
	const actions = steps();
	await expect(observer.observe(wrap(target), actions)).rejects.toThrow("INVALID_RESULT");
	expect(actions.policy).not.toHaveBeenCalled();
	expect(() => assertDestinations(zero(), required, wrap([target]))).toThrow("INVALID_RESULT");
	expect(() => assertDestinations(zero(), required, [wrap(target)])).toThrow("INVALID_RESULT");
	expect(traps).toBe(0);
});

it("snapshots checked own values and refuses roster/allowlist accessors without reading them", () => {
	const original = { host: "before.example", port: 443, transport: "tcp" };
	const copied = record(original, ["host", "port", "transport"]);
	original.host = "after.example";
	expect(copied.host).toBe("before.example");
	expect(copied).not.toBe(original);
	expect(Object.isFrozen(copied)).toBe(true);
	let reads = 0;
	const observers = [hub];
	Object.defineProperty(observers, "0", {
		enumerable: true,
		get: () => {
			reads++;
			return hub;
		},
	});
	expect(() => createRecorder({ profile: "test", observers })).toThrow("INVALID_RESULT");
	expect(() => readResult(zero(), { ...required, observers })).toThrow("INVALID_RESULT");
	const allowed = [target];
	Object.defineProperty(allowed, "0", {
		enumerable: true,
		get: () => {
			reads++;
			return target;
		},
	});
	expect(() => assertDestinations(zero(), required, allowed)).toThrow("INVALID_RESULT");
	expect(reads).toBe(0);
});
