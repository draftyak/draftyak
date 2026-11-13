import { Buffer } from "node:buffer";
import { once } from "node:events";
import { type IncomingHttpHeaders, IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isNativeHttpPath,
	type NativeHttpOperation,
	NativeHttpRequestError,
	type NativeHttpResponse,
	nativeHttpResponseBytes,
	readNativeHttpOperation,
} from "../../src/api/native-http.ts";

// Framing and byte DATA only: these fixtures open no listener and issue no peer or grant.
const readEvents = ["data", "end", "aborted", "error", "close"] as const;
interface RequestFixture {
	readonly request: IncomingMessage;
	readonly socket: Socket;
	readonly originalListeners: readonly number[];
}
const fixtures: RequestFixture[] = [];

function incoming(
	method = "GET",
	path = "/api/v1/settings",
	headers: IncomingHttpHeaders = {},
): RequestFixture {
	const socket = new Socket();
	const request = new IncomingMessage(socket);
	request.method = method;
	request.url = path;
	request.headers = headers;
	const fixture = {
		request,
		socket,
		originalListeners: readEvents.map((event) => request.listenerCount(event)),
	};
	fixtures.push(fixture);
	return fixture;
}

function expectReadRetired(fixture: RequestFixture): void {
	expect(readEvents.map((event) => fixture.request.listenerCount(event))).toEqual(
		fixture.originalListeners,
	);
}

function finish(request: IncomingMessage, chunks: readonly Buffer[] = [], complete = true): void {
	for (const chunk of chunks) request.push(chunk);
	request.complete = complete;
	request.push(null);
}

function operation(path = "/api/v1/settings"): NativeHttpOperation {
	return { method: "GET", path, body: undefined };
}

function response(
	body: Uint8Array,
	status: NativeHttpResponse["status"] = 200,
): NativeHttpResponse {
	return { status, body };
}

afterEach(async () => {
	const closed: Promise<unknown>[] = [];
	for (const { request, socket } of fixtures.splice(0)) {
		if (!request.closed) closed.push(once(request, "close"));
		if (!socket.closed) closed.push(once(socket, "close"));
		request.destroy();
		socket.destroy();
	}
	await Promise.all(closed);
});

describe("native HTTP operation DATA", () => {
	it("captures only the accounts/settings namespace and preserves exact method and target bytes", async () => {
		for (const path of [
			undefined,
			"/device/v1/events",
			"/api/v1/account",
			"/api/v1/accounts-extra",
		]) {
			expect(isNativeHttpPath(path)).toBe(false);
		}
		for (const [method, path] of [
			["GET", "/api/v1/accounts?afterId=01ARZ3NDEKTSV4RRFFQ69G5FAV"],
			["get", "/api/v1/accounts/%2f?afterId=%2F"],
			["PATCH", "/api/v1/settings?zone=UTC"],
		]) {
			const fixture = incoming(method, path);
			const pending = readNativeHttpOperation(fixture.request);
			finish(fixture.request);
			const captured = await pending;
			expect(captured).toEqual({ method, path, body: undefined });
			expect(Object.isFrozen(captured)).toBe(true);
			expectReadRetired(fixture);
		}
	});

	it("distinguishes an absent GET body from Content-Length: 0 and from received body bytes", async () => {
		const absent = incoming();
		const accepted = readNativeHttpOperation(absent.request);
		finish(absent.request);
		expect((await accepted).body).toBeUndefined();
		expectReadRetired(absent);

		const explicitEmpty = incoming("GET", "/api/v1/settings", { "content-length": "0" });
		await expect(readNativeHttpOperation(explicitEmpty.request)).rejects.toBeInstanceOf(
			NativeHttpRequestError,
		);
		expectReadRetired(explicitEmpty);

		const supplied = incoming("GET", "/api/v1/accounts");
		const refused = expect(readNativeHttpOperation(supplied.request)).rejects.toMatchObject({
			code: "INVALID_REQUEST",
		});
		supplied.request.push(Buffer.from("x"));
		await refused;
		expect(supplied.request.isPaused()).toBe(true);
		expectReadRetired(supplied);
	});

	it.each([1, 4096])("owns an exact %i-byte PUT body after complete framing", async (size) => {
		const fixture = incoming("PUT", "/api/v1/settings", {
			"content-length": String(size),
			"content-type": "Application/JSON; charset=UTF-8",
		});
		const payload = Buffer.alloc(size, 0x30);
		const expected = Buffer.from(payload);
		const pending = readNativeHttpOperation(fixture.request);
		finish(fixture.request, [payload.subarray(0, 1), payload.subarray(1)]);
		const captured = await pending;
		expect(captured.method).toBe("PUT");
		expect(captured.path).toBe("/api/v1/settings");
		expect(captured.body).toEqual(expected);
		payload.fill(0);
		expect(captured.body).toEqual(expected);
		expectReadRetired(fixture);
	});

	it("refuses malformed or over-limit declared lengths before attaching body readers", async () => {
		for (const length of [undefined, "0", "01", "+1", "-1", " 1", "1.0", "1e3", "4097", 1]) {
			const fixture = incoming("PUT", "/api/v1/settings", {
				"content-length": length as string,
				"content-type": "application/json",
			});
			await expect(readNativeHttpOperation(fixture.request)).rejects.toMatchObject({
				code: "INVALID_REQUEST",
			});
			expectReadRetired(fixture);
		}
		for (const contentType of [undefined, "text/plain", "application/json; charset=latin1"]) {
			const fixture = incoming("PUT", "/api/v1/settings", {
				"content-length": "1",
				"content-type": contentType,
			});
			await expect(readNativeHttpOperation(fixture.request)).rejects.toMatchObject({
				code: "INVALID_REQUEST",
			});
			expectReadRetired(fixture);
		}
	});

	it("rejects a streaming overflow without waiting for EOF or copying an aggregate body", async () => {
		const fixture = incoming("PUT", "/api/v1/settings", {
			"content-length": "4096",
			"content-type": "application/json",
		});
		const concat = vi.spyOn(Buffer, "concat");
		try {
			const refused = expect(readNativeHttpOperation(fixture.request)).rejects.toMatchObject({
				code: "INVALID_REQUEST",
			});
			fixture.request.push(Buffer.alloc(4096));
			fixture.request.push(Buffer.from("x"));
			await refused;
			expect(fixture.request.readableEnded).toBe(false);
			expect(fixture.request.isPaused()).toBe(true);
			expect(concat).not.toHaveBeenCalled();
			expectReadRetired(fixture);
		} finally {
			concat.mockRestore();
		}
	});

	it.each([
		["short body", 1, true],
		["incomplete parser message", 2, false],
	] as const)("refuses %s and retires its listeners", async (_, size, complete) => {
		const fixture = incoming("PUT", "/api/v1/settings", {
			"content-length": "2",
			"content-type": "application/json",
		});
		const refused = expect(readNativeHttpOperation(fixture.request)).rejects.toMatchObject({
			code: "INVALID_REQUEST",
		});
		finish(fixture.request, [Buffer.alloc(size)], complete);
		await refused;
		expectReadRetired(fixture);
	});

	it.each(["aborted", "error", "close"] as const)(
		"retires a partial body on %s without requiring end",
		async (event) => {
			const fixture = incoming("PUT", "/api/v1/settings", {
				"content-length": "2",
				"content-type": "application/json",
			});
			const refused = expect(readNativeHttpOperation(fixture.request)).rejects.toMatchObject({
				code: "INVALID_REQUEST",
			});
			const firstChunk = once(fixture.request, "data");
			fixture.request.push(Buffer.from("x"));
			await firstChunk;
			fixture.request.emit(
				event,
				event === "error" ? new Error("fixture stream failure") : undefined,
			);
			await refused;
			expect(fixture.request.isPaused()).toBe(true);
			expectReadRetired(fixture);
		},
	);

	it("refuses an already-aborted or destroyed message without leaving a pending read", async () => {
		const aborted = incoming();
		aborted.request.aborted = true;
		expect(aborted.request.destroyed).toBe(false);
		await expect(readNativeHttpOperation(aborted.request)).rejects.toMatchObject({
			code: "INVALID_REQUEST",
		});
		expectReadRetired(aborted);

		const destroyed = incoming();
		destroyed.request.destroy();
		await expect(readNativeHttpOperation(destroyed.request)).rejects.toMatchObject({
			code: "INVALID_REQUEST",
		});
		expectReadRetired(destroyed);
	});
});

describe("native HTTP response DATA", () => {
	it.each([
		["/api/v1/settings", 4096],
		["/api/v1/accounts", 1_048_576],
	] as const)("enforces the %s cap and owns the returned copy", (path, limit) => {
		const bytes = new Uint8Array(limit).fill(0x61);
		const copied = nativeHttpResponseBytes(operation(path), response(bytes));
		expect(copied.byteLength).toBe(limit);
		expect(copied[0]).toBe(0x61);
		expect(copied[limit - 1]).toBe(0x61);
		bytes.fill(0);
		expect(copied[0]).toBe(0x61);
		expect(copied[limit - 1]).toBe(0x61);
		expect(() =>
			nativeHttpResponseBytes(operation(path), response(new Uint8Array(limit + 1))),
		).toThrow("UNAVAILABLE");
	});

	it("accepts only the fixed response status set", () => {
		for (const status of [200, 400, 403, 404, 503] as const) {
			expect(
				nativeHttpResponseBytes(operation(), response(new Uint8Array([0x61]), status)),
			).toEqual(Buffer.from("a"));
		}
		for (const status of [201, 204, 401, 405, 413, "200", Number.NaN]) {
			expect(() =>
				nativeHttpResponseBytes(operation(), {
					status,
					body: new Uint8Array(),
				} as NativeHttpResponse),
			).toThrow("UNAVAILABLE");
		}
	});

	it("rejects proxy, accessor, shared and resizable response inputs without invoking accessors", () => {
		let traps = 0;
		const proxied = new Proxy(response(new Uint8Array([1])), {
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("unexpected descriptor trap");
			},
		});
		const accessor = Object.defineProperty({ body: new Uint8Array([1]) }, "status", {
			get() {
				traps++;
				throw new Error("unexpected status getter");
			},
		});
		const proxyBody = new Proxy(new Uint8Array([1]), {
			get() {
				traps++;
				throw new Error("unexpected byte getter");
			},
		});
		const resizableBuffer = Reflect.construct(ArrayBuffer, [
			1,
			{ maxByteLength: 2 },
		]) as ArrayBuffer;
		const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
		expect(resizable?.call(resizableBuffer)).toBe(true);
		for (const value of [
			proxied,
			accessor,
			{ status: 200, body: proxyBody },
			{ status: 200, body: new Uint8Array(new SharedArrayBuffer(1)) },
			{ status: 200, body: new Uint8Array(resizableBuffer) },
			{ status: 200, body: { byteLength: 1 } },
		]) {
			expect(() => nativeHttpResponseBytes(operation(), value as NativeHttpResponse)).toThrow(
				"UNAVAILABLE",
			);
		}
		expect(traps).toBe(0);
	});

	it("copies typed-array slots without consulting shadowed size, buffer or iteration getters", () => {
		const bytes = new Uint8Array([0x61, 0x62]);
		let getters = 0;
		for (const key of ["byteLength", "buffer", "length", Symbol.iterator]) {
			Object.defineProperty(bytes, key, {
				get() {
					getters++;
					throw new Error("unexpected shadowed typed-array getter");
				},
			});
		}
		expect(nativeHttpResponseBytes(operation(), response(bytes))).toEqual(Buffer.from("ab"));
		expect(getters).toBe(0);
	});

	it("rejects actual oversized slots before allocation despite an apparently small getter", () => {
		const bytes = new Uint8Array(4097);
		let getters = 0;
		Object.defineProperty(bytes, "byteLength", {
			get() {
				getters++;
				return 0;
			},
		});
		const allocate = vi.spyOn(Buffer, "alloc");
		try {
			expect(() => nativeHttpResponseBytes(operation(), response(bytes))).toThrow("UNAVAILABLE");
			expect(getters).toBe(0);
			expect(allocate).not.toHaveBeenCalled();
		} finally {
			allocate.mockRestore();
		}
	});
});
