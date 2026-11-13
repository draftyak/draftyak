import type { IncomingMessage } from "node:http";
import { types } from "node:util";

export interface NativeHttpResponse {
	readonly status: 200 | 400 | 403 | 404 | 503;
	readonly body: Uint8Array;
}

export interface NativeHttpOperation {
	readonly method: string;
	readonly path: string;
	readonly body: Uint8Array | undefined;
}

/** The original context publishes synchronously inside its admitted operation. */
export type NativeHttpDispatch = (
	request: NativeHttpOperation,
	publish: (response: NativeHttpResponse) => void,
	deadline: number,
) => Promise<void>;

export class NativeHttpRequestError extends Error {
	readonly code = "INVALID_REQUEST";
	constructor() {
		super("INVALID_REQUEST");
	}
}

const SETTINGS_BYTES = 4096;
const ACCOUNT_BYTES = 1_048_576;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const backingBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const copyBytes = Uint8Array.prototype.set;

/** Leaves events and all other namespaces to their existing handlers. */
export function isNativeHttpPath(path: string | undefined): path is string {
	return (
		typeof path === "string" &&
		(path === "/api/v1/accounts" ||
			path.startsWith("/api/v1/accounts?") ||
			path.startsWith("/api/v1/accounts/") ||
			path === "/api/v1/settings" ||
			path.startsWith("/api/v1/settings?") ||
			path.startsWith("/api/v1/settings/"))
	);
}

/** Called only after the existing attachment validates the original HTTP headers. */
export async function readNativeHttpOperation(
	request: IncomingMessage,
): Promise<NativeHttpOperation> {
	const method = request.method;
	const path = request.url;
	if (typeof method !== "string" || !isNativeHttpPath(path) || request.aborted || request.destroyed)
		throw new NativeHttpRequestError();
	const put = method === "PUT" && path === "/api/v1/settings";
	const length = request.headers["content-length"];
	let expected = 0;
	if (put) {
		if (
			typeof length !== "string" ||
			!/^[1-9][0-9]{0,3}$/.test(length) ||
			Number(length) > SETTINGS_BYTES ||
			!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")
		)
			throw new NativeHttpRequestError();
		expected = Number(length);
	} else if (length !== undefined) {
		// Supplying even zero bytes differs from an absent operation body.
		throw new NativeHttpRequestError();
	}

	const body = await new Promise<Uint8Array>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;
		const cleanup = (): void => {
			request.off("data", data);
			request.off("end", end);
			request.off("aborted", fail);
			request.off("error", fail);
			request.off("close", fail);
		};
		const fail = (): void => {
			if (settled) return;
			settled = true;
			request.pause();
			cleanup();
			chunks.length = 0;
			reject(new NativeHttpRequestError());
		};
		const data = (chunk: unknown): void => {
			if (!Buffer.isBuffer(chunk) || chunk.byteLength > expected - total) {
				fail();
				return;
			}
			total += chunk.byteLength;
			chunks.push(chunk);
		};
		const end = (): void => {
			if (settled) return;
			if (!request.complete || total !== expected) {
				fail();
				return;
			}
			settled = true;
			cleanup();
			resolve(Buffer.concat(chunks, total));
			chunks.length = 0;
		};
		request.on("data", data);
		request.once("end", end);
		request.once("aborted", fail);
		request.once("error", fail);
		request.once("close", fail);
	});
	return Object.freeze({ method, path, body: put ? body : undefined });
}

/** Bounds the genuine router result before the attachment copies it for framing. */
export function nativeHttpResponseBytes(
	request: NativeHttpOperation,
	result: NativeHttpResponse,
): Buffer {
	if (result === null || typeof result !== "object" || types.isProxy(result))
		throw new Error("UNAVAILABLE");
	const status = Object.getOwnPropertyDescriptor(result, "status")?.value;
	const body = Object.getOwnPropertyDescriptor(result, "body")?.value;
	if (
		![200, 400, 403, 404, 503].includes(status) ||
		types.isProxy(body) ||
		!types.isUint8Array(body)
	)
		throw new Error("UNAVAILABLE");
	const buffer = backingBuffer?.call(body);
	const size = byteLength?.call(body);
	const limit = request.path.startsWith("/api/v1/accounts") ? ACCOUNT_BYTES : SETTINGS_BYTES;
	if (
		types.isSharedArrayBuffer(buffer) ||
		resizable?.call(buffer) === true ||
		typeof size !== "number" ||
		size > limit
	)
		throw new Error("UNAVAILABLE");
	const captured = Buffer.alloc(size);
	copyBytes.call(captured, body);
	return captured;
}
