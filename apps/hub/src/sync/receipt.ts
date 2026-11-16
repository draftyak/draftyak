import { createHash } from "node:crypto";
import { types } from "node:util";
import { type Provenance as M1Provenance, Provenance } from "@draftyak/protocol/entities/common";

export interface MetadataDigestRow {
	readonly messageId: string;
	readonly providerId: string;
	readonly threadId: string;
	readonly conversationId: string;
	readonly internalDate: number;
	readonly labelJson: string;
	readonly sizeBytes: number | null;
	readonly ingressSourceId: string | null;
	readonly receivedAt: number | null;
}

type ReceiptRow = Pick<MetadataDigestRow, "ingressSourceId" | "receivedAt">;

function unavailable(): never {
	throw new Error("Metadata receipt unavailable");
}

function dataField(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) {
		return unavailable();
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return unavailable();
	const field = Object.getOwnPropertyDescriptor(value, key);
	if (field === undefined || !field.enumerable || !("value" in field)) return unavailable();
	return field.value;
}

function pluginReceipt(value: unknown, expectedPluginId?: string): Readonly<M1Provenance> {
	try {
		const via = dataField(value, "via");
		const sourceId = dataField(value, "sourceId");
		const receivedAt = dataField(value, "receivedAt");
		const keys = Reflect.ownKeys(value as object);
		if (
			keys.length !== 3 ||
			keys.some((key) => !["via", "sourceId", "receivedAt"].includes(String(key)))
		) {
			return unavailable();
		}
		const parsed = Provenance.parse({ via, sourceId, receivedAt });
		if (
			parsed.via !== "plugin" ||
			(expectedPluginId !== undefined && parsed.sourceId !== expectedPluginId)
		) {
			return unavailable();
		}
		return Object.freeze({
			via: "plugin",
			sourceId: parsed.sourceId,
			receivedAt: parsed.receivedAt,
		});
	} catch {
		return unavailable();
	}
}

function checkedPluginId(pluginId: string): string {
	return pluginReceipt({ via: "plugin", sourceId: pluginId, receivedAt: 0 }).sourceId;
}

function pairedReceipt(row: ReceiptRow, expectedPluginId?: string): Readonly<M1Provenance> | null {
	const sourceId = dataField(row, "ingressSourceId");
	const receivedAt = dataField(row, "receivedAt");
	if (sourceId === null && receivedAt === null) return null;
	if (sourceId === null || receivedAt === null) return unavailable();
	return pluginReceipt({ via: "plugin", sourceId, receivedAt }, expectedPluginId);
}

/** Asserted receipt DATA only; this establishes no native or provider authority. */
export function readMetadataReceipt(
	row: ReceiptRow,
	expectedPluginId: string,
): Readonly<M1Provenance> | null {
	return pairedReceipt(row, checkedPluginId(expectedPluginId));
}

export function firstMetadataReceipt(
	previous: Readonly<M1Provenance> | null | undefined,
	pluginId: string,
	clock: () => number,
): Readonly<M1Provenance> | null {
	const expected = checkedPluginId(pluginId);
	if (previous === null) return null;
	if (previous !== undefined) return pluginReceipt(previous, expected);
	try {
		return pluginReceipt({ via: "plugin", sourceId: expected, receivedAt: clock() }, expected);
	} catch {
		return unavailable();
	}
}

function stringValue(value: unknown): string {
	if (typeof value !== "string") return unavailable();
	return value;
}

function integerValue(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return unavailable();
	return value;
}

export function messageMetadataDigest(message: MetadataDigestRow): string {
	// Reject non-DATA containers before enumeration, including revoked proxies.
	dataField(message, "ingressSourceId");
	const expectedKeys = [
		"messageId",
		"providerId",
		"threadId",
		"conversationId",
		"internalDate",
		"labelJson",
		"sizeBytes",
		"ingressSourceId",
		"receivedAt",
	];
	const keys = Object.keys(message);
	if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
		return unavailable();
	}
	const captured: Record<string, unknown> = Object.create(null);
	// Retain the incoming row's enumerable field order, not a reconstructed order.
	for (const key of keys) {
		const value = dataField(message, key);
		if (key === "internalDate") captured[key] = integerValue(value);
		else if (key === "sizeBytes" || key === "receivedAt") {
			captured[key] = value === null ? null : integerValue(value);
		} else if (key === "ingressSourceId") {
			captured[key] = value === null ? null : stringValue(value);
		} else captured[key] = stringValue(value);
	}
	const snapshot = captured as unknown as MetadataDigestRow;
	pairedReceipt(snapshot);
	const { ingressSourceId, receivedAt, ...legacy } = snapshot;
	try {
		return createHash("sha256")
			.update(JSON.stringify(ingressSourceId === null && receivedAt === null ? legacy : snapshot))
			.digest("hex");
	} catch {
		return unavailable();
	}
}
