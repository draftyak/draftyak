import { isProxy } from "node:util/types";
import { HOST_MAX_FRAME_BYTES, parseHostParams } from "@draftyak/protocol/host-channel";
import { canonicalize, JCS_MAX_DEPTH } from "@draftyak/protocol/jcs";
import { denseArray, inertRecord, ownData } from "../../../extensions/values.ts";

export type NativeKvJson =
	| null
	| boolean
	| number
	| string
	| readonly NativeKvJson[]
	| { readonly [key: string]: NativeKvJson };

export type NativeKvRequest =
	| Readonly<{ method: "host/kv.get"; params: Readonly<{ key: string }> }>
	| Readonly<{
			method: "host/kv.set";
			params: Readonly<{ key: string; value: NativeKvJson }>;
	  }>
	| Readonly<{ method: "host/kv.delete"; params: Readonly<{ key: string }> }>;

export class NativeKvRequestError extends Error {
	override readonly name = "NativeKvRequestError";
	readonly code = "CHANNEL_KV_REQUEST_INVALID";

	constructor() {
		super("CHANNEL_KV_REQUEST_INVALID");
	}
}

const refused = (): NativeKvRequestError => new NativeKvRequestError();

interface CopyBudget {
	bytes: number;
	readonly active: Set<object>;
}

function addBytes(budget: CopyBudget, bytes: number): void {
	budget.bytes += bytes;
	if (budget.bytes > HOST_MAX_FRAME_BYTES) throw refused();
}

function stringBytes(value: string, budget: CopyBudget): void {
	// UTF-16 length is a lower bound on its quoted UTF-8 representation.
	if (value.length > HOST_MAX_FRAME_BYTES - budget.bytes) throw refused();
	addBytes(budget, Buffer.byteLength(canonicalize(value)));
}

/** Counts the expanded JSON form while copying only own, inert DATA. */
function copyJson(value: unknown, depth: number, budget: CopyBudget): NativeKvJson {
	if (value === null) {
		addBytes(budget, 4);
		return null;
	}
	if (typeof value === "string") {
		stringBytes(value, budget);
		return value;
	}
	if (typeof value === "boolean" || typeof value === "number") {
		// The public canonicalizer also rejects nonfinite numbers.
		addBytes(budget, Buffer.byteLength(canonicalize(value)));
		return value;
	}
	if (typeof value !== "object" || isProxy(value)) throw refused();
	if (depth >= JCS_MAX_DEPTH || budget.active.has(value)) throw refused();
	budget.active.add(value);
	try {
		addBytes(budget, 2);
		const remaining = HOST_MAX_FRAME_BYTES - budget.bytes;
		if (Array.isArray(value)) {
			// Even a one-byte scalar needs a comma between adjacent entries.
			const items = denseArray(value, Math.floor((remaining + 1) / 2), "unavailable");
			const result: NativeKvJson[] = [];
			for (let index = 0; index < items.length; index++) {
				if (index !== 0) addBytes(budget, 1);
				result.push(copyJson(items[index], depth + 1, budget));
			}
			return result;
		}
		// Empty member name, colon, one-byte value and separator need at least five bytes.
		const entries = ownData(value, Math.floor((remaining + 1) / 5), "unavailable");
		const result = Object.create(null) as Record<string, NativeKvJson>;
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (!entry) throw refused();
			const [key, item] = entry;
			if (index !== 0) addBytes(budget, 1);
			stringBytes(key, budget);
			addBytes(budget, 1);
			// A null prototype keeps names such as __proto__ ordinary JSON members.
			result[key] = copyJson(item, depth + 1, budget);
		}
		return result;
	} finally {
		// Shared subgraphs are copied per occurrence; only actual ancestor cycles refuse.
		budget.active.delete(value);
	}
}

function freezeJson(value: NativeKvJson): NativeKvJson {
	if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) freezeJson(item);
		Object.freeze(value);
	}
	return value;
}

/** Captures public KV request DATA, without selecting a namespace or granting access. */
export function captureNativeKvRequest(method: unknown, raw: unknown): NativeKvRequest {
	try {
		if (method !== "host/kv.get" && method !== "host/kv.set" && method !== "host/kv.delete")
			throw refused();
		const source = inertRecord(
			raw,
			method === "host/kv.set" ? ["key", "value"] : ["key"],
			[],
			"unavailable",
		);
		if (typeof source.key !== "string" || source.key.length > 128) throw refused();
		parseHostParams("host/kv.get", { key: source.key });
		const snapshot = copyJson(source, 0, { bytes: 0, active: new Set() });
		// The existing public parser applies jsonCopy's exact aggregate frame/depth checks.
		if (method === "host/kv.set") {
			const params = parseHostParams(method, snapshot);
			return Object.freeze({
				method,
				params: Object.freeze({ key: params.key, value: freezeJson(params.value as NativeKvJson) }),
			});
		}
		const params = parseHostParams(method, snapshot);
		return Object.freeze({ method, params: Object.freeze({ key: params.key }) });
	} catch {
		throw refused();
	}
}
