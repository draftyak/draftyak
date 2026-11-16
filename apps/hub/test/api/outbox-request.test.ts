import { describe, expect, it } from "vitest";
import {
	NativeOutboxRequestError,
	parseNativeOutboxRequest,
} from "../../src/api/outbox-request.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BASE = "/api/v1/outbox";
const PATH = `${BASE}/${ID}`;

function invalid(method: unknown, path: unknown, body: unknown = undefined): void {
	let caught: unknown;
	try {
		parseNativeOutboxRequest(method, path, body);
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(NativeOutboxRequestError);
	expect(caught).toMatchObject({
		name: "NativeOutboxRequestError",
		message: "INVALID_REQUEST",
		code: "INVALID_REQUEST",
	});
	expect(Object.hasOwn(caught as object, "cause")).toBe(false);
}

describe("native outbox request parsing", () => {
	it.each(["00000000000000000000000000", ID, `7${"Z".repeat(25)}`])(
		"returns only the exact canonical ULID: %s",
		(id) => {
			expect(parseNativeOutboxRequest("GET", `${BASE}/${id}`)).toBe(id);
			expect(parseNativeOutboxRequest("GET", `${BASE}/${id}`, undefined)).toBe(id);
		},
	);

	it.each([
		"",
		ID.slice(1),
		`${ID}0`,
		ID.toLowerCase(),
		`8${ID.slice(1)}`,
		`${ID.slice(0, 25)}I`,
		`${ID.slice(0, 25)}L`,
		`${ID.slice(0, 25)}O`,
		`${ID.slice(0, 25)}U`,
		`${ID.slice(0, 25)}\n`,
		`${ID.slice(0, 25)}\u2028`,
	])("refuses an invalid or noncanonical identifier: %s", (id) => {
		invalid("GET", `${BASE}/${id}`);
	});

	it.each([
		BASE,
		`${PATH}/`,
		`${PATH}/other`,
		`${BASE}//${ID}`,
		`${PATH}?`,
		`${PATH}?afterId=${ID}`,
		`${PATH}#`,
		`${PATH}#fragment`,
		`${BASE}/%30${ID.slice(1)}`,
		`${BASE}%2F${ID}`,
		`${BASE}/.%2F${ID}`,
		`${BASE}/../${ID}`,
		`${BASE}/./${ID}`,
		`${BASE}\\${ID}`,
		`${PATH}\n`,
		`${PATH}\r`,
		`${PATH}\u2028`,
		`${PATH}\u0000`,
	])("refuses owned URL variants without normalization: %s", (path) => {
		invalid("GET", path);
	});

	it.each(["POST", "PUT", "HEAD", "OPTIONS", "get", " GET", "GET ", "", 0, null])(
		"refuses a non-GET method on the owned route: %s",
		(method) => {
			invalid(method, PATH);
		},
	);

	it.each([
		new Uint8Array(0),
		new Uint8Array([0]),
		new ArrayBuffer(0),
		"",
		"{}",
		null,
		false,
		0,
		{},
	])("refuses every supplied body value, including empty bodies: %s", (body) => {
		invalid("GET", PATH, body);
	});

	it("refuses a body with accessors without observing any body property", () => {
		let reads = 0;
		const body = Object.create(null, {
			byteLength: {
				get: () => {
					reads++;
					throw new Error("body getter");
				},
			},
			toString: {
				get: () => {
					reads++;
					throw new Error("body conversion");
				},
			},
		});
		invalid("GET", PATH, body);
		expect(reads).toBe(0);
	});

	it("refuses method and path objects without coercing or invoking traps", () => {
		let reads = 0;
		const object = new Proxy(Object.create(null), {
			get() {
				reads++;
				throw new Error("get trap");
			},
			ownKeys() {
				reads++;
				throw new Error("ownKeys trap");
			},
			getPrototypeOf() {
				reads++;
				throw new Error("prototype trap");
			},
		});
		invalid(object, PATH);
		invalid("GET", object);
		invalid("GET", new String(PATH));
		invalid(new String("GET"), PATH);
		expect(reads).toBe(0);
	});

	it("does not interpret an object as a request envelope", () => {
		let reads = 0;
		const request = Object.create(null, {
			method: {
				get: () => {
					reads++;
					return "GET";
				},
			},
			path: {
				get: () => {
					reads++;
					return PATH;
				},
			},
			body: {
				get: () => {
					reads++;
					throw new Error("body getter");
				},
			},
		});
		invalid(request, undefined);
		invalid("GET", request);
		expect(reads).toBe(0);
	});

	it("delegates unrelated paths without inspecting method or body", () => {
		let reads = 0;
		const value = new Proxy(Object.create(null), {
			get() {
				reads++;
				throw new Error("get trap");
			},
			ownKeys() {
				reads++;
				throw new Error("ownKeys trap");
			},
			getPrototypeOf() {
				reads++;
				throw new Error("prototype trap");
			},
		});
		for (const path of [
			"/api/v1/settings",
			`/api/v1/outboxes/${ID}`,
			`/api/v1/outbox-archive/${ID}`,
			`/api/v1/outbox.other/${ID}`,
			`https://localhost${PATH}`,
			`/%61pi/v1/outbox/${ID}`,
		])
			expect(parseNativeOutboxRequest(value, path, value)).toBeUndefined();
		expect(reads).toBe(0);
	});

	it("handles revoked proxies without invoking them", () => {
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		invalid("GET", proxy);
		invalid(proxy, PATH);
		invalid("GET", PATH, proxy);
		expect(parseNativeOutboxRequest(proxy, "/unrelated", proxy)).toBeUndefined();
	});

	it("keeps refusal messages fixed and does not attach the rejected input", () => {
		const marker = "private-input-marker";
		try {
			parseNativeOutboxRequest("GET", `${BASE}/${marker}`);
			throw new Error("expected refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(NativeOutboxRequestError);
			expect((error as NativeOutboxRequestError).message).toBe("INVALID_REQUEST");
			expect(Object.values(error as object)).not.toContain(marker);
		}
	});
});
