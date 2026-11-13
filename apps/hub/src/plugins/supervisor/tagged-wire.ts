import { Buffer } from "node:buffer";
import { isProxy } from "node:util/types";
import {
	HOST_FRAME_TAG,
	HOST_MAX_FRAME_BYTES,
	type HostCancel,
	HostMessage,
	type HostRequest,
	PluginBootstrap,
} from "@draftyak/protocol/host-channel";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";

export class PluginWireError extends Error {
	readonly code = "PLUGIN_WIRE_INVALID";
	constructor() {
		super("Invalid plugin process frame");
		this.name = "PluginWireError";
	}
}

export type PluginWireFrame =
	| { readonly kind: "host"; readonly message: HostRequest | HostCancel }
	| { readonly kind: "untagged"; readonly value: unknown };

export interface PluginWireRead {
	/** Bytes consumed from this input, including LF when a frame is returned. */
	readonly consumed: number;
	readonly frame?: PluginWireFrame;
}

export interface PluginWireDecoder {
	/** Returns at most one frame. Feed the unconsumed suffix again, preserving its order. */
	push(bytes: Uint8Array): PluginWireRead;
	end(): void;
}

function invalid(): never {
	throw new PluginWireError();
}

const tagByte = HOST_FRAME_TAG.charCodeAt(0);
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteKind = Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag)?.get;
const byteBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const bufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;

// Read native slots, never a caller's iterator, constructor, species or shadowed accessors.
function ordinaryBytes(raw: Uint8Array): Uint8Array {
	if (
		isProxy(raw) ||
		!byteKind ||
		!byteBuffer ||
		!byteOffset ||
		!byteLength ||
		!bufferLength ||
		!bufferResizable ||
		Reflect.apply(byteKind, raw, []) !== "Uint8Array"
	)
		invalid();
	const backing = Reflect.apply(byteBuffer, raw, []) as ArrayBuffer;
	// This getter rejects SharedArrayBuffer; resizable buffers are refused separately.
	Reflect.apply(bufferLength, backing, []);
	if (Reflect.apply(bufferResizable, backing, [])) invalid();
	const offset = Reflect.apply(byteOffset, raw, []) as number;
	const length = Reflect.apply(byteLength, raw, []) as number;
	// A detached buffer throws here instead of masquerading as an ordinary empty input.
	return new Uint8Array(backing, offset, length);
}

function retain(bytes: Uint8Array): Buffer {
	const view = ordinaryBytes(bytes);
	if (view.byteLength > HOST_MAX_FRAME_BYTES) invalid();
	const retained = Buffer.allocUnsafe(view.byteLength);
	for (let at = 0; at < view.byteLength; at++) retained[at] = view[at] as number;
	return retained;
}

function internalMessage(value: unknown): boolean {
	if (value === null || typeof value !== "object" || !Object.hasOwn(value, "cmd")) return false;
	const command = (value as Record<string, unknown>).cmd;
	return typeof command === "string" && command.startsWith("NODE_");
}

function childFrame(line: Buffer): PluginWireFrame {
	const tagged = line[0] === tagByte;
	if (line.length - (tagged ? 1 : 0) > HOST_MAX_FRAME_BYTES) invalid();
	const value = parseStrict(tagged ? line.subarray(1) : line);
	if (internalMessage(value)) invalid();
	if (!tagged) return Object.freeze({ kind: "untagged", value });
	const message = HostMessage.parse(value);
	if (!("method" in message)) invalid();
	if (message.method === "host/cancel") return Object.freeze({ kind: "host", message });
	if (!("id" in message)) invalid();
	return Object.freeze({ kind: "host", message });
}

export function createPluginWireDecoder(): PluginWireDecoder {
	let storage: Buffer | undefined;
	let used = 0;
	let ended = false;
	let failed = false;
	return Object.freeze({
		push(input: Uint8Array): PluginWireRead {
			if (ended || failed) invalid();
			try {
				const bytes = ordinaryBytes(input);
				if (bytes.byteLength === 0) return Object.freeze({ consumed: 0 });
				const tagged = (used ? storage?.[0] : bytes[0]) === tagByte;
				const maximum = HOST_MAX_FRAME_BYTES + (tagged ? 1 : 0);
				for (let at = 0; at < bytes.byteLength; at++) {
					const byte = bytes[at] as number;
					if (byte === 10) {
						if (!storage || used === 0) invalid();
						const frame = childFrame(storage.subarray(0, used));
						used = 0;
						return Object.freeze({ consumed: at + 1, frame });
					}
					if (used >= maximum) invalid();
					storage ??= Buffer.allocUnsafe(HOST_MAX_FRAME_BYTES + 1);
					storage[used++] = byte;
				}
				return Object.freeze({ consumed: bytes.byteLength });
			} catch {
				failed = true;
				used = 0;
				storage = undefined;
				invalid();
			}
		},
		end(): void {
			if (failed) invalid();
			if (ended) return;
			if (used !== 0) {
				failed = true;
				used = 0;
				storage = undefined;
				invalid();
			}
			ended = true;
			storage = undefined;
		},
	});
}

function parentFrame(value: unknown): Buffer {
	const json = canonicalize(value);
	if (Buffer.byteLength(json) > HOST_MAX_FRAME_BYTES) invalid();
	return Buffer.from(`${HOST_FRAME_TAG}${json}\n`, "utf8");
}

/** Accept full UTF-8 JSON DATA, not an object whose getters could run during serialization. */
export function encodePluginHostFrame(json: Uint8Array): Buffer {
	try {
		const value = parseStrict(retain(json));
		if (internalMessage(value)) invalid();
		const message = HostMessage.parse(value);
		if ("method" in message) {
			if (message.method !== "host/stream.chunk" && message.method !== "host/ws.message") invalid();
		} else if (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) invalid();
		return parentFrame(message);
	} catch {
		invalid();
	}
}

/** Validate bootstrap DATA only; the caller owns its first-frame position and actual authority. */
export function encodePluginBootstrapFrame(json: Uint8Array): Buffer {
	try {
		return parentFrame(PluginBootstrap.parse(parseStrict(retain(json))));
	} catch {
		invalid();
	}
}
