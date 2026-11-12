const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const nativeByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const nativeByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const nativeTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const isView = ArrayBuffer.isView;
const ByteArray = Uint8Array;
const setBytes = Uint8Array.prototype.set;

/** Read the native view extent without invoking caller-owned properties. */
export function byteViewLength(value: unknown): number | undefined {
	try {
		if (!isView(value) || nativeTag?.call(value) !== "Uint8Array") return undefined;
		return nativeByteLength?.call(value);
	} catch {
		return undefined;
	}
}

/** Bound the received view before allocating a stable parsing copy. */
export function copyByteView(value: unknown, limit: number): Uint8Array | undefined {
	try {
		const length = byteViewLength(value);
		if (length === undefined || length > limit) return undefined;
		const view = new ByteArray(nativeBuffer?.call(value), nativeByteOffset?.call(value), length);
		const copy = new ByteArray(length);
		setBytes.call(copy, view);
		return copy;
	} catch {
		return undefined;
	}
}
