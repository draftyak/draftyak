import type { DataClass } from "@draftyak/protocol/data-class";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureNativeBackupTarget,
	NativeBackupTargetError,
	nativeBackupTargetRefusals,
} from "../../src/extensions/registry.ts";
import { createNativeBackupTargetFixture } from "./native-backup-target-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createNativeBackupTargetFixture>>;
const fixtures: Fixture[] = [];
async function fixture(refuses: readonly DataClass[] = []): Promise<Fixture> {
	const result = await createNativeBackupTargetFixture(refuses);
	fixtures.push(result);
	return result;
}
afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((entry) => entry.close()));
});

function unavailable(operation: () => unknown): void {
	let caught: unknown;
	try {
		operation();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(NativeBackupTargetError);
	expect(caught).toMatchObject({
		name: "NativeBackupTargetError",
		code: "BACKUP_TARGET_UNAVAILABLE",
		message: "Backup target unavailable",
	});
	expect(Object.hasOwn(caught as object, "cause")).toBe(false);
}

function copy(value: object): object {
	return Object.create(
		Object.getPrototypeOf(value),
		Object.getOwnPropertyDescriptors(value),
	) as object;
}

describe("native backup target provenance", () => {
	it("captures a genuinely registered target without invoking its provider", async () => {
		const f = await fixture();
		expect(f.host.providers("backup").map((provider) => provider.id)).toEqual([f.targetId]);
		const target = captureNativeBackupTarget(f.host, f.targetId);
		expect(nativeBackupTargetRefusals(target, f.host)).toEqual([]);
		expect(f.calls).toEqual([]);
	});

	it("keeps registered identity and refusal DATA despite original provider mutation", async () => {
		const f = await fixture(["slack.content", "slack.metadata"]);
		const target = captureNativeBackupTarget(f.host, f.targetId);
		const original = f.provider.refuses;
		expect(Reflect.set(original, "0", "slack.metadata")).toBe(true);
		expect(Reflect.set(original, "length", 0)).toBe(true);
		expect(Reflect.set(f.provider, "refuses", [])).toBe(true);
		expect(Reflect.set(f.provider, "id", "replacement-target")).toBe(true);
		const afterMutation = captureNativeBackupTarget(f.host, f.targetId);
		for (const captured of [target, afterMutation]) {
			const refuses = nativeBackupTargetRefusals(captured, f.host);
			expect(refuses).toEqual(["slack.content", "slack.metadata"]);
			expect(Object.isFrozen(refuses)).toBe(true);
			expect(Reflect.set(refuses, "0", "slack.metadata")).toBe(false);
			expect(Reflect.set(refuses, "length", 0)).toBe(false);
			expect(nativeBackupTargetRefusals(captured, f.host)).toEqual([
				"slack.content",
				"slack.metadata",
			]);
		}
		unavailable(() => captureNativeBackupTarget(f.host, "replacement-target"));
	});

	it("does not reread original provider accessors after registration", async () => {
		const f = await fixture(["slack.content"]);
		let hooks = 0;
		const read = (): never => {
			hooks++;
			throw new Error("Unexpected provider accessor");
		};
		Object.defineProperty(f.provider, "id", { get: read });
		Object.defineProperty(f.provider, "refuses", { get: read });
		const target = captureNativeBackupTarget(f.host, f.targetId);
		expect(nativeBackupTargetRefusals(target, f.host)).toEqual(["slack.content"]);
		expect(hooks).toBe(0);
	});

	it("refuses host copies and inherited host methods", async () => {
		const f = await fixture();
		for (const host of [Object.assign({}, f.host), copy(f.host), Object.create(f.host)])
			unavailable(() => captureNativeBackupTarget(host, f.targetId));
		expect(
			nativeBackupTargetRefusals(captureNativeBackupTarget(f.host, f.targetId), f.host),
		).toEqual([]);
	});

	it("refuses unbranded and proxy hosts without running their hooks", async () => {
		const f = await fixture();
		let hooks = 0;
		const read = (): never => {
			hooks++;
			throw new Error("Unexpected host hook");
		};
		const forged = Object.defineProperty({}, "providers", { get: read });
		const providerHost = { providers: read };
		const proxy = new Proxy(f.host, {
			get: read,
			getPrototypeOf: read,
			ownKeys: read,
			getOwnPropertyDescriptor: read,
		});
		for (const host of [null, undefined, false, 0, "host", forged, providerHost, proxy])
			unavailable(() => captureNativeBackupTarget(host, f.targetId));
		expect(hooks).toBe(0);
		expect(f.calls).toEqual([]);
	});

	it("refuses unknown or malformed identifiers without coercion", async () => {
		const f = await fixture();
		let coercions = 0;
		const id = {
			toString() {
				coercions++;
				return f.targetId;
			},
			[Symbol.toPrimitive]() {
				coercions++;
				return f.targetId;
			},
		};
		for (const value of ["missing-target", "", "fixture-target\n", null, undefined, 1, id])
			unavailable(() => captureNativeBackupTarget(f.host, value));
		expect(coercions).toBe(0);
	});

	it("does not accept raw registrations, copied tokens or token prototypes", async () => {
		const f = await fixture();
		const target = captureNativeBackupTarget(f.host, f.targetId);
		for (const value of [
			null,
			{},
			f.provider,
			f.host.providers("backup")[0],
			Object.assign({}, target),
			copy(target),
			Object.create(target),
		])
			unavailable(() => nativeBackupTargetRefusals(value, f.host));
		expect(nativeBackupTargetRefusals(target, f.host)).toEqual([]);
	});

	it("refuses a target proxy without inspecting or invoking it", async () => {
		const f = await fixture();
		const target = captureNativeBackupTarget(f.host, f.targetId);
		let hooks = 0;
		const read = (): never => {
			hooks++;
			throw new Error("Unexpected target hook");
		};
		const proxy = new Proxy(target, {
			get: read,
			getPrototypeOf: read,
			ownKeys: read,
			getOwnPropertyDescriptor: read,
		});
		unavailable(() => nativeBackupTargetRefusals(proxy, f.host));
		expect(hooks).toBe(0);
		expect(f.calls).toEqual([]);
	});

	it("requires the genuine expected host even with a genuine token", async () => {
		const f = await fixture();
		const target = captureNativeBackupTarget(f.host, f.targetId);
		let hooks = 0;
		const proxy = new Proxy(f.host, {
			get() {
				hooks++;
				throw new Error("Unexpected expected-host hook");
			},
		});
		for (const host of [null, {}, copy(f.host), Object.create(f.host), proxy])
			unavailable(() => nativeBackupTargetRefusals(target, host));
		expect(hooks).toBe(0);
	});

	it("binds each token to its original real host despite equal provider identifiers", async () => {
		const first = await fixture(["slack.content"]);
		const second = await first.openSecondHost();
		fixtures.push(second);
		expect(second.host).not.toBe(first.host);
		expect(second.targetId).toBe(first.targetId);
		const firstTarget = captureNativeBackupTarget(first.host, first.targetId);
		const secondTarget = captureNativeBackupTarget(second.host, second.targetId);
		expect(nativeBackupTargetRefusals(firstTarget, first.host)).toEqual(["slack.content"]);
		expect(nativeBackupTargetRefusals(secondTarget, second.host)).toEqual(["slack.content"]);
		unavailable(() => nativeBackupTargetRefusals(firstTarget, second.host));
		unavailable(() => nativeBackupTargetRefusals(secondTarget, first.host));
	});

	it("retires captured targets and refuses new capture after their genuine host closes", async () => {
		const f = await fixture(["slack.metadata"]);
		const target = captureNativeBackupTarget(f.host, f.targetId);
		expect(nativeBackupTargetRefusals(target, f.host)).toEqual(["slack.metadata"]);
		f.host.close();
		expect(f.host.providers("backup")).toEqual([]);
		unavailable(() => nativeBackupTargetRefusals(target, f.host));
		unavailable(() => captureNativeBackupTarget(f.host, f.targetId));
	});
});
