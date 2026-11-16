import { isProxy } from "node:util/types";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import {
	captureNativeKvRequest,
	type NativeKvJson,
	type NativeKvRequest,
} from "./native-kv-request.ts";

export type NativeKvMemoryErrorCode =
	| "CHANNEL_KV_MEMORY_CLOSED"
	| "CHANNEL_KV_MEMORY_INVALID"
	| "CHANNEL_KV_MEMORY_LIMIT";

export class NativeKvMemoryError extends Error {
	override readonly name = "NativeKvMemoryError";
	readonly code: NativeKvMemoryErrorCode;

	constructor(code: NativeKvMemoryErrorCode) {
		super(code);
		this.code = code;
	}
}

export interface NativeKvMemory {
	get(partition: object, key: unknown): NativeKvJson;
	set(partition: object, key: unknown, value: unknown): void;
	delete(partition: object, key: unknown): void;
	close(): void;
}

const MAX_VALUE_BYTES = 65_536;
const MAX_STORED_KEYS = 1024;
const invalid = (): NativeKvMemoryError => new NativeKvMemoryError("CHANNEL_KV_MEMORY_INVALID");

function capture(method: NativeKvRequest["method"], raw: unknown): NativeKvRequest {
	try {
		return captureNativeKvRequest(method, raw);
	} catch {
		throw invalid();
	}
}

/**
 * Bounded RAM DATA only. The original receiver selects partition identities;
 * possession of one does not establish a Session, account or permission.
 */
export function createNativeKvMemory(): NativeKvMemory {
	const partitions = new Map<object, Map<string, string>>();
	let storedKeys = 0;
	let closed = false;
	const enter = (partition: object): void => {
		if (closed) throw new NativeKvMemoryError("CHANNEL_KV_MEMORY_CLOSED");
		if (partition === null || typeof partition !== "object" || isProxy(partition)) throw invalid();
	};
	return Object.freeze({
		get(partition: object, key: unknown): NativeKvJson {
			enter(partition);
			const request = capture("host/kv.get", { key });
			const text = partitions.get(partition)?.get(request.params.key);
			if (text === undefined) return null;
			try {
				// Each observation owns a fresh deeply frozen copy of the stored JSON.
				const result = capture("host/kv.set", {
					key: request.params.key,
					value: parseStrict(text),
				});
				if (result.method !== "host/kv.set") throw invalid();
				return result.params.value;
			} catch {
				throw invalid();
			}
		},
		set(partition: object, key: unknown, value: unknown): void {
			enter(partition);
			const request = capture("host/kv.set", { key, value });
			if (request.method !== "host/kv.set") throw invalid();
			let text: string;
			try {
				text = canonicalize(request.params.value);
			} catch {
				throw invalid();
			}
			if (Buffer.byteLength(text) > MAX_VALUE_BYTES)
				throw new NativeKvMemoryError("CHANNEL_KV_MEMORY_LIMIT");
			const values = partitions.get(partition);
			const replacement = values?.has(request.params.key) === true;
			if (!replacement && storedKeys >= MAX_STORED_KEYS)
				throw new NativeKvMemoryError("CHANNEL_KV_MEMORY_LIMIT");
			// Validation and complete snapshot construction precede every retained mutation.
			if (values) values.set(request.params.key, text);
			else partitions.set(partition, new Map([[request.params.key, text]]));
			if (!replacement) storedKeys++;
		},
		delete(partition: object, key: unknown): void {
			enter(partition);
			const request = capture("host/kv.delete", { key });
			const values = partitions.get(partition);
			if (!values?.delete(request.params.key)) return;
			storedKeys--;
			if (values.size === 0) partitions.delete(partition);
		},
		close(): void {
			if (closed) return;
			closed = true;
			for (const values of partitions.values()) values.clear();
			partitions.clear();
			storedKeys = 0;
		},
	});
}
