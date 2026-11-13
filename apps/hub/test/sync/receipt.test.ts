import type { Provenance } from "@draftyak/protocol/entities/common";
import { describe, expect, it } from "vitest";
import {
	firstMetadataReceipt,
	type MetadataDigestRow,
	messageMetadataDigest,
	readMetadataReceipt,
} from "../../src/sync/receipt.ts";

const SOURCE = "00000000000000000000000003";
const OTHER_SOURCE = "00000000000000000000000004";
const SAFE_ERROR = "Metadata receipt unavailable";
const LEGACY_PREIMAGE =
	'{"messageId":"00000000000000000000000001","providerId":"DYTEST-provider","threadId":"DYTEST-thread","conversationId":"00000000000000000000000002","internalDate":123,"labelJson":"[]","sizeBytes":7}';
const LEGACY_HASH = "1f64b65be6e80760ba9a55170276aee8a86cee490e4c52fd77a8927225e14384";

function legacyRow(): MetadataDigestRow {
	return {
		...(JSON.parse(LEGACY_PREIMAGE) as Omit<MetadataDigestRow, "ingressSourceId" | "receivedAt">),
		ingressSourceId: null,
		receivedAt: null,
	};
}

function fixedFailure(work: () => unknown): void {
	let caught: unknown;
	try {
		work();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(Error);
	expect((caught as Error).message).toBe(SAFE_ERROR);
}

const invalidRows: readonly (readonly [string, unknown])[] = [
	["missing time", { ingressSourceId: SOURCE, receivedAt: null }],
	["missing source", { ingressSourceId: null, receivedAt: 0 }],
	["short source", { ingressSourceId: "short", receivedAt: 0 }],
	["noncanonical source", { ingressSourceId: "80000000000000000000000000", receivedAt: 0 }],
	["negative time", { ingressSourceId: SOURCE, receivedAt: -1 }],
	["fractional time", { ingressSourceId: SOURCE, receivedAt: 0.5 }],
	["unsafe time", { ingressSourceId: SOURCE, receivedAt: Number.MAX_SAFE_INTEGER + 1 }],
	["NaN time", { ingressSourceId: SOURCE, receivedAt: Number.NaN }],
	["infinite time", { ingressSourceId: SOURCE, receivedAt: Number.POSITIVE_INFINITY }],
	["string time", { ingressSourceId: SOURCE, receivedAt: "0" }],
];

describe("metadata receipt DATA", () => {
	it("keeps an unknown legacy receipt null", () => {
		expect(readMetadataReceipt({ ingressSourceId: null, receivedAt: null }, SOURCE)).toBeNull();
	});

	it.each([0, Number.MAX_SAFE_INTEGER])(
		"reads safe time %s as frozen detached DATA",
		(receivedAt) => {
			const row = { ingressSourceId: SOURCE, receivedAt };
			const receipt = readMetadataReceipt(row, SOURCE);
			expect(receipt).toEqual({ via: "plugin", sourceId: SOURCE, receivedAt });
			expect(Object.isFrozen(receipt)).toBe(true);
			row.ingressSourceId = OTHER_SOURCE;
			row.receivedAt = 12;
			expect(receipt).toEqual({ via: "plugin", sourceId: SOURCE, receivedAt });
		},
	);

	it.each(invalidRows)("refuses %s with the fixed error", (_label, row) => {
		fixedFailure(() =>
			readMetadataReceipt(row as Parameters<typeof readMetadataReceipt>[0], SOURCE),
		);
	});

	it("requires the current expected plugin rather than any valid source ID", () => {
		fixedFailure(() =>
			readMetadataReceipt({ ingressSourceId: OTHER_SOURCE, receivedAt: 1 }, SOURCE),
		);
		fixedFailure(() => readMetadataReceipt({ ingressSourceId: null, receivedAt: null }, "bad"));
	});

	it("does not evaluate receipt accessors or proxy traps", () => {
		let reads = 0;
		const accessor = {
			get ingressSourceId(): string {
				reads++;
				return SOURCE;
			},
			receivedAt: 0,
		};
		fixedFailure(() => readMetadataReceipt(accessor, SOURCE));
		const proxy = new Proxy(
			{ ingressSourceId: SOURCE, receivedAt: 0 },
			{
				getOwnPropertyDescriptor() {
					reads++;
					throw new Error("DYTEST trap");
				},
			},
		);
		fixedFailure(() => readMetadataReceipt(proxy, SOURCE));
		expect(reads).toBe(0);
	});

	it("refuses revoked receipt and digest rows with the same fixed safe error", () => {
		const readProxy = Proxy.revocable({ ingressSourceId: SOURCE, receivedAt: 0 }, {});
		readProxy.revoke();
		fixedFailure(() => readMetadataReceipt(readProxy.proxy, SOURCE));
		const digestProxy = Proxy.revocable(legacyRow(), {});
		digestProxy.revoke();
		fixedFailure(() => messageMetadataDigest(digestProxy.proxy));
	});
});

describe("first metadata receipt", () => {
	it.each([0, Number.MAX_SAFE_INTEGER])(
		"samples only the new native clock value %s",
		(nativeTime) => {
			const providerDate = legacyRow().internalDate;
			let samples = 0;
			const receipt = firstMetadataReceipt(undefined, SOURCE, () => {
				samples++;
				return nativeTime;
			});
			expect(receipt).toEqual({ via: "plugin", sourceId: SOURCE, receivedAt: nativeTime });
			expect(receipt?.receivedAt).not.toBe(providerDate);
			expect(samples).toBe(1);
			expect(Object.isFrozen(receipt)).toBe(true);
		},
	);

	it("preserves known and legacy receipts without sampling the clock", () => {
		let samples = 0;
		const clock = (): number => {
			samples++;
			throw new Error("DYTEST clock must not run");
		};
		const previous: Provenance = { via: "plugin", sourceId: SOURCE, receivedAt: 42 };
		const receipt = firstMetadataReceipt(previous, SOURCE, clock);
		expect(receipt).toEqual(previous);
		expect(receipt).not.toBe(previous);
		expect(Object.isFrozen(receipt)).toBe(true);
		previous.sourceId = OTHER_SOURCE;
		previous.receivedAt = 43;
		expect(receipt).toEqual({ via: "plugin", sourceId: SOURCE, receivedAt: 42 });
		expect(firstMetadataReceipt(null, SOURCE, clock)).toBeNull();
		expect(samples).toBe(0);
	});

	it.each([
		{ via: "device", sourceId: SOURCE, receivedAt: 1 },
		{ via: "plugin", sourceId: OTHER_SOURCE, receivedAt: 1 },
		{ via: "plugin", sourceId: "bad", receivedAt: 1 },
		{ via: "plugin", sourceId: SOURCE, receivedAt: -1 },
		{ via: "plugin", sourceId: SOURCE, receivedAt: 1, extra: true },
	])("refuses invalid existing receipt %# without a new clock sample", (previous) => {
		let samples = 0;
		fixedFailure(() =>
			firstMetadataReceipt(previous as Provenance, SOURCE, () => {
				samples++;
				return 2;
			}),
		);
		expect(samples).toBe(0);
	});

	it("replaces clock exceptions with the fixed safe error", () => {
		fixedFailure(() =>
			firstMetadataReceipt(undefined, SOURCE, () => {
				throw new Error("DYTEST private clock detail");
			}),
		);
	});

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"refuses native time %s without clamping or fallback",
		(time) => {
			fixedFailure(() => firstMetadataReceipt(undefined, SOURCE, () => time));
		},
	);

	it("rejects an invalid plugin before sampling a new clock", () => {
		let samples = 0;
		fixedFailure(() =>
			firstMetadataReceipt(undefined, "bad", () => {
				samples++;
				return 0;
			}),
		);
		expect(samples).toBe(0);
	});
});

describe("message metadata digest compatibility", () => {
	it("matches the exact old literal seven-field JSON preimage hash for legacy rows", () => {
		expect(messageMetadataDigest(legacyRow())).toBe(LEGACY_HASH);
	});

	it("retains incoming legacy field order rather than rebuilding canonical order", () => {
		const oldPreimage =
			'{"providerId":"DYTEST-provider","messageId":"00000000000000000000000001","labelJson":"[]","threadId":"DYTEST-thread","sizeBytes":7,"conversationId":"00000000000000000000000002","internalDate":123}';
		const reordered: MetadataDigestRow = {
			...(JSON.parse(oldPreimage) as Omit<MetadataDigestRow, "ingressSourceId" | "receivedAt">),
			ingressSourceId: null,
			receivedAt: null,
		};
		expect(messageMetadataDigest(reordered)).toBe(
			"d880842d3d2641d6cf22fb8a245fac9ceab780f78086cd39d7e57cba76aff7ff",
		);
		expect(messageMetadataDigest(reordered)).not.toBe(LEGACY_HASH);
	});

	it("includes each known receipt source and time while keeping retries stable", () => {
		const known: MetadataDigestRow = { ...legacyRow(), ingressSourceId: SOURCE, receivedAt: 42 };
		const initial = messageMetadataDigest(known);
		expect(initial).not.toBe(LEGACY_HASH);
		expect(messageMetadataDigest({ ...known })).toBe(initial);
		expect(messageMetadataDigest({ ...known, ingressSourceId: OTHER_SOURCE })).not.toBe(initial);
		expect(messageMetadataDigest({ ...known, receivedAt: 43 })).not.toBe(initial);
	});

	it("refuses unexpected enumerable digest fields", () => {
		fixedFailure(() =>
			messageMetadataDigest({ ...legacyRow(), unexpected: "DYTEST" } as MetadataDigestRow),
		);
	});

	it.each(invalidRows)("refuses malformed digest receipt %s", (_label, row) => {
		fixedFailure(() => messageMetadataDigest({ ...legacyRow(), ...(row as object) }));
	});
});
