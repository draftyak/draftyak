import { describe, expect, it, vi } from "vitest";
import {
	type AccountConnectSelectionData,
	captureAccountConnectSelection,
} from "../../src/identity/account-connect-selection-values.ts";
import { WorkError } from "../../src/jobs/values.ts";

const idFields = [
	"pluginInstanceId",
	"ownerUserId",
	"registryId",
	"versionId",
	"operationId",
] as const;
const fields = [...idFields, "ownerEpoch", "selectedGeneration"] as const;

function selection(): AccountConnectSelectionData {
	return {
		pluginInstanceId: "00000000000000000000000001",
		ownerUserId: "00000000000000000000000002",
		ownerEpoch: 0,
		registryId: "00000000000000000000000003",
		versionId: "00000000000000000000000004",
		selectedGeneration: 1,
		operationId: "00000000000000000000000005",
	};
}

function refused(raw: unknown): void {
	let failure: unknown;
	try {
		captureAccountConnectSelection(raw);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(WorkError);
	if (!(failure instanceof WorkError)) throw Error("Expected fixed input refusal");
	expect(failure.code).toBe("input");
	expect(failure.message).toBe("Durable work input refused");
	expect(Object.hasOwn(failure, "cause")).toBe(false);
}

describe("Account connect selection DATA", () => {
	it("captures each distinct scalar in an owned frozen record", () => {
		const raw = { ...selection() };
		const before = { ...raw };
		const captured = captureAccountConnectSelection(raw);
		expect(captured).toEqual(before);
		expect(captured).not.toBe(raw);
		expect(Object.keys(captured)).toEqual([
			"pluginInstanceId",
			"ownerUserId",
			"ownerEpoch",
			"registryId",
			"versionId",
			"selectedGeneration",
			"operationId",
		]);
		expect(Object.isFrozen(captured)).toBe(true);
		for (const key of idFields) raw[key] = "7ZZZZZZZZZZZZZZZZZZZZZZZZZ";
		raw.ownerEpoch = 12;
		raw.selectedGeneration = 34;
		expect(captured).toEqual(before);
		expect(Reflect.set(captured, "ownerEpoch", 1)).toBe(false);
		expect(captured.ownerEpoch).toBe(0);
	});

	it("accepts exact null-prototype and frozen records independent of key order", () => {
		const raw = Object.fromEntries(Object.entries(selection()).reverse());
		const nullPrototype = Object.assign(Object.create(null), raw);
		expect(captureAccountConnectSelection(nullPrototype)).toEqual(selection());
		expect(captureAccountConnectSelection(Object.freeze(raw))).toEqual(selection());
	});

	it.each(idFields)("validates the actual ULID grammar of %s without coercion", (field) => {
		for (const valid of ["00000000000000000000000000", "7ZZZZZZZZZZZZZZZZZZZZZZZZZ"]) {
			const raw = { ...selection(), [field]: valid };
			expect(captureAccountConnectSelection(raw)[field]).toBe(valid);
		}
		for (const invalid of [
			"",
			"0000000000000000000000000",
			"000000000000000000000000000",
			"8ZZZZZZZZZZZZZZZZZZZZZZZZZ",
			"0IIIIIIIIIIIIIIIIIIIIIIIII",
			"0zzzzzzzzzzzzzzzzzzzzzzzzz",
			"00000000000000000000000001\n",
			null,
			1,
		]) {
			refused({ ...selection(), [field]: invalid });
		}
	});

	it.each([
		{ field: "ownerEpoch", minimum: 0 },
		{ field: "selectedGeneration", minimum: 1 },
	] as const)("bounds $field to its exact safe integer range", ({ field, minimum }) => {
		for (const valid of [minimum, Number.MAX_SAFE_INTEGER]) {
			expect(captureAccountConnectSelection({ ...selection(), [field]: valid })[field]).toBe(valid);
		}
		for (const invalid of [
			minimum - 1,
			0.5,
			Number.MAX_SAFE_INTEGER + 1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			"1",
			1n,
			null,
			undefined,
		]) {
			refused({ ...selection(), [field]: invalid });
		}
	});

	it("requires every field as an own value, including both numeric fields", () => {
		for (const field of fields) {
			const missing: Record<string, unknown> = { ...selection() };
			delete missing[field];
			refused(missing);
			refused({ ...selection(), [field]: undefined });
		}
	});

	it("refuses extra string and symbol fields instead of silently dropping them", () => {
		refused({ ...selection(), checked: true });
		refused({ ...selection(), [Symbol("selection")]: true });
		const hidden = { ...selection() };
		Object.defineProperty(hidden, "unexpected", { value: 1 });
		refused(hidden);
	});

	it("refuses inherited values and records with a custom prototype", () => {
		refused(Object.create(selection()));
		const inheritedOwner: Record<string, unknown> = { ...selection() };
		delete inheritedOwner.ownerUserId;
		Object.setPrototypeOf(inheritedOwner, { ownerUserId: selection().ownerUserId });
		refused(inheritedOwner);
		refused(Object.assign(Object.create({ checked: true }), selection()));
	});

	it("refuses nonenumerable required fields", () => {
		for (const field of fields) {
			const raw = { ...selection() };
			Object.defineProperty(raw, field, { enumerable: false });
			refused(raw);
		}
	});

	it("rejects required accessors without invoking any getter", () => {
		const get = vi.fn(() => "00000000000000000000000001");
		for (const field of fields) {
			const raw = { ...selection() };
			Object.defineProperty(raw, field, { enumerable: true, get });
			refused(raw);
		}
		expect(get).not.toHaveBeenCalled();
	});

	it("rejects proxies before their property, prototype or key traps run", () => {
		const trap = vi.fn(() => {
			throw Error("Caller hook ran");
		});
		refused(new Proxy(selection(), { get: trap, getPrototypeOf: trap, ownKeys: trap }));
		const revoked = Proxy.revocable(selection(), {});
		revoked.revoke();
		refused(revoked.proxy);
		expect(trap).not.toHaveBeenCalled();
	});

	it("never coerces objects supplied in scalar positions", () => {
		const hook = vi.fn(() => "00000000000000000000000001");
		const object = { toString: hook, valueOf: hook, [Symbol.toPrimitive]: hook };
		for (const field of fields) refused({ ...selection(), [field]: object });
		expect(hook).not.toHaveBeenCalled();
	});

	it("refuses nonrecord roots", () => {
		for (const raw of [
			undefined,
			null,
			true,
			1,
			"",
			[],
			() => selection(),
			new Map(),
			new Date(0),
		]) {
			refused(raw);
		}
	});
});
