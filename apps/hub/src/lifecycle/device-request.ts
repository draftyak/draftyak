import { checkRouteRequestBytes, PairingWindowRequest } from "@draftyak/protocol/device-api";
import { parseStrict } from "@draftyak/protocol/jcs";
import { MAX_CLAIM_BYTES, MAX_REVEAL_BYTES } from "@draftyak/protocol/pairing";

export type DeviceRequestFrame =
	| Readonly<{
			route: "pairing-window";
			received: Uint8Array;
			body: PairingWindowRequest;
	  }>
	| Readonly<{
			route: "pairing-claim";
			received: Uint8Array;
	  }>
	| Readonly<{
			route: "pairing-reveal";
			received: Uint8Array;
	  }>;

export type DeviceRequestRefusalReason = "unsupported" | "too-large" | "invalid";
export type DeviceRequestResult =
	| Readonly<{ ok: true; frame: DeviceRequestFrame }>
	| Readonly<{ ok: false; reason: DeviceRequestRefusalReason }>;

const Bytes = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(Bytes.prototype);
const nativeLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const nativeOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const nativeTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const isView = ArrayBuffer.isView;
const setBytes = Bytes.prototype.set;
const fillBytes = Bytes.prototype.fill;

const refuse = (reason: DeviceRequestRefusalReason): DeviceRequestResult =>
	Object.freeze({ ok: false, reason });

/**
 * Recognizes only received pairing DATA, never a peer or an authorization decision.
 * On success the caller owns frame.received and must wipe it when the receiver is done, including on error.
 * The owned copy is an ordinary Uint8Array; Buffer input does not require Buffer output.
 * Open DATA contains ordinary immutable strings: release those references; no string erasure is claimed.
 * No body, PIN, code or byte value may be logged or retained beyond the receiver's use.
 */
export function decodeDeviceRequest(
	method: string,
	path: string,
	received: Uint8Array,
): DeviceRequestResult {
	if (method !== "POST") return refuse("unsupported");
	let route: DeviceRequestFrame["route"];
	let limit: number;
	if (path === "/device/v1/pairing/windows") {
		route = "pairing-window";
		limit = 1024;
	} else if (path === "/pair/v1/claim") {
		route = "pairing-claim";
		limit = MAX_CLAIM_BYTES;
	} else if (path === "/pair/v1/reveal") {
		route = "pairing-reveal";
		limit = MAX_REVEAL_BYTES;
	} else return refuse("unsupported");

	let owned: Uint8Array | undefined;
	let returned = false;
	try {
		// Intrinsic reads avoid caller extent, iterator, index and slice hooks.
		if (!isView(received) || nativeTag?.call(received) !== "Uint8Array") return refuse("invalid");
		const length: unknown = nativeLength?.call(received);
		if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0)
			return refuse("invalid");
		if (length > limit) return refuse("too-large");
		// Apply the received-byte cap before allocating or decoding a parsing copy.
		const view = new Bytes(nativeBuffer?.call(received), nativeOffset?.call(received), length);
		owned = new Bytes(length);
		setBytes.call(owned, view);
		let frame: DeviceRequestFrame;
		if (route === "pairing-window") {
			if (!checkRouteRequestBytes("pairing-window", owned)) return refuse("invalid");
			const body = PairingWindowRequest.parse(parseStrict(owned));
			frame = Object.freeze({ route, received: owned, body: Object.freeze(body) });
		} else if (route === "pairing-claim") {
			// The original cryptographic receiver, not this parser, validates these opaque bytes.
			frame = Object.freeze({ route, received: owned });
		} else {
			// The original cryptographic receiver, not this parser, validates claim/reveal bytes.
			frame = Object.freeze({ route, received: owned });
		}
		const result: DeviceRequestResult = Object.freeze({ ok: true, frame });
		returned = true;
		return result;
	} catch {
		return refuse("invalid");
	} finally {
		if (!returned && owned !== undefined) fillBytes.call(owned, 0);
	}
}
