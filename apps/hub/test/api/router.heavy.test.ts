import { randomBytes } from "node:crypto";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, expect, it } from "vitest";
import type { NativeApiErrorCode, NativeApiResponse } from "../../src/api/router.ts";
import type { NativeDevicePeer } from "../../src/authz/native-peer.ts";
import type { HubSession } from "../../src/lifecycle/session.ts";
import type { NativeFixture, TestDevice } from "../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { SessionFixture } from "../lifecycle/session-helpers.ts";

requireLoopbackNetworkGuard();
const [
	{ createNativeApiRouter, NATIVE_API_ROUTE_DESCRIPTORS },
	{ cliConfirmPinScope, revokePinScope },
	{ decodePairingPayload, makePairingClaim, pairingEkm },
	{ nativePairingWindows },
	native,
	{ closeSessionTransport, sessionFixture, sessionTransport },
] = await Promise.all([
	import("../../src/api/router.ts"),
	import("../../src/authz/scopes.ts"),
	import("@draftyak/protocol/pairing"),
	import("../../src/lifecycle/session.ts"),
	import("../authz/native-fixture.ts"),
	import("../lifecycle/session-helpers.ts"),
]);

const ROUTE = "/api/v1/settings";
const SCHEMA = "draftyak.entities.OwnerSettings";
const SETTINGS = {
	zone: "America/Chicago",
	workingHours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
};
const OTHER = {
	zone: "Europe/Paris",
	workingHours: { days: ["tue", "thu"], start: "12:30", end: "15:00" },
};
const encode = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
const decoder = new TextDecoder("utf-8", { fatal: true });
const fixtures: SessionFixture[] = [];
const transports: NativeFixture[] = [];

interface Context {
	readonly session: HubSession;
	readonly native: NativeFixture;
	readonly router: ReturnType<typeof createNativeApiRouter>;
}

async function open(): Promise<Context> {
	const fixture = sessionFixture("draftyak-settings-router-");
	fixtures.push(fixture);
	const key = fixture.key();
	const session = await fixture.open({ masterKey: key });
	const transport = await sessionTransport(session, key, fixture.folder);
	transports.push(transport);
	return { session, native: transport, router: createNativeApiRouter(session) };
}

async function owner(context: Context): Promise<TestDevice> {
	// This is the only bootstrap admission; later devices use the original session window.
	const administrator = await native.bootstrap(context.native);
	expect(administrator.socket.getProtocol()).toBe("TLSv1.3");
	return administrator;
}

async function admitDevice(
	context: Context,
	administrator: TestDevice,
	client: TestDevice,
): Promise<string> {
	const windows = await nativePairingWindows(context.session);
	const opened = await windows.open(administrator.peer, { role: "device", pin: native.PIN });
	const payload = decodePairingPayload(opened.pairingCode, Date.now());
	const nd = randomBytes(16);
	let ekm: Uint8Array | undefined, claim: Buffer | undefined, reveal: Buffer | undefined;
	try {
		ekm = pairingEkm(client.socket, payload.pid);
		claim = Buffer.from(
			JSON.stringify(
				makePairingClaim(
					payload,
					{
						name: "DYTEST router device",
						transportSpkiSha256: client.transportSpkiSha256,
						signingKey: client.signingKey,
					},
					ekm,
					nd,
				),
			),
		);
		reveal = Buffer.from(JSON.stringify({ pid: payload.pid, nd: nd.toString("base64url") }));
		const claimed = windows.claim(client.peer, claim);
		const recorded = windows.reveal(client.peer, reveal);
		expect(claimed.deviceId).toBe(recorded.deviceId);
		expect(claimed.epoch).toBe(recorded.epoch);
		client.id = recorded.deviceId;
		return recorded.deviceId;
	} finally {
		nd.fill(0);
		ekm?.fill(0);
		claim?.fill(0);
		reveal?.fill(0);
	}
}

function responseText(response: NativeApiResponse): string {
	expect(Object.isFrozen(response)).toBe(true);
	expect(Object.keys(response).sort()).toEqual(["body", "status"]);
	expect(response.body).toBeInstanceOf(Uint8Array);
	expect(response.body.byteLength).toBeLessThanOrEqual(4096);
	const text = decoder.decode(response.body);
	expect(Buffer.from(text, "utf8")).toEqual(Buffer.from(response.body));
	return text;
}

function ok(response: NativeApiResponse, expected: unknown): void {
	expect(response.status).toBe(200);
	const text = responseText(response);
	expect(text).toBe(canonicalize(expected));
	expect(JSON.parse(text)).toEqual(expected);
}

function refused(
	response: NativeApiResponse,
	status: 400 | 403 | 404 | 503,
	code: NativeApiErrorCode,
): void {
	expect(response.status).toBe(status);
	expect(responseText(response)).toBe(`{"code":"${code}"}`);
}

afterEach(async () => {
	let failed = false;
	for (const transport of transports.splice(0)) {
		try {
			await closeSessionTransport(transport);
		} catch {
			failed = true;
		}
	}
	for (const fixture of fixtures.splice(0)) {
		try {
			await fixture.remove();
		} catch {
			failed = true;
		}
	}
	if (failed) throw new Error("DYTEST router fixture cleanup incomplete");
});

it("describes exactly the shared handlers that dispatch invokes", async () => {
	expect(NATIVE_API_ROUTE_DESCRIPTORS).toEqual([
		{
			operationId: "getOwnerSettings",
			method: "GET",
			path: ROUTE,
			request: { schemaRef: null, maxBytes: 0 },
			response: { schemaRef: SCHEMA, maxBytes: 4096 },
			errors: [
				{ status: 400, code: "INVALID_REQUEST" },
				{ status: 403, code: "FORBIDDEN" },
				{ status: 404, code: "NOT_FOUND" },
				{ status: 503, code: "UNAVAILABLE" },
			],
			security: { nativeOnly: true, capability: "read" },
		},
		{
			operationId: "putOwnerSettings",
			method: "PUT",
			path: ROUTE,
			request: { schemaRef: SCHEMA, maxBytes: 4096 },
			response: { schemaRef: SCHEMA, maxBytes: 4096 },
			errors: [
				{ status: 400, code: "INVALID_REQUEST" },
				{ status: 403, code: "FORBIDDEN" },
				{ status: 503, code: "UNAVAILABLE" },
			],
			security: { nativeOnly: true, capability: "admin" },
		},
		{
			operationId: "pageAccounts",
			method: "GET",
			path: "/api/v1/accounts",
			request: { schemaRef: null, maxBytes: 0 },
			response: { schemaRef: "draftyak.native.AccountPage", maxBytes: 1_048_576 },
			errors: [
				{ status: 400, code: "INVALID_REQUEST" },
				{ status: 403, code: "FORBIDDEN" },
				{ status: 503, code: "UNAVAILABLE" },
			],
			security: { nativeOnly: true, capability: "read" },
		},
		{
			operationId: "getAccount",
			method: "GET",
			path: "/api/v1/accounts/{accountId}",
			request: { schemaRef: null, maxBytes: 0 },
			response: { schemaRef: "draftyak.native.AccountRecord", maxBytes: 1_048_576 },
			errors: [
				{ status: 400, code: "INVALID_REQUEST" },
				{ status: 403, code: "FORBIDDEN" },
				{ status: 404, code: "NOT_FOUND" },
				{ status: 503, code: "UNAVAILABLE" },
			],
			security: { nativeOnly: true, capability: "read" },
		},
	]);
	expect(Object.isFrozen(NATIVE_API_ROUTE_DESCRIPTORS)).toBe(true);
	for (const entry of NATIVE_API_ROUTE_DESCRIPTORS) {
		for (const value of [
			entry,
			entry.request,
			entry.response,
			entry.errors,
			entry.security,
			...entry.errors,
		])
			expect(Object.isFrozen(value)).toBe(true);
		expect(Reflect.set(entry.security, "capability", "admin")).toBe(false);
	}
	const context = await open(),
		administrator = await owner(context);
	// A real generated identifier is query DATA; this fixture has no account rows.
	const missingAccountId = native.idOf(administrator);
	for (const entry of NATIVE_API_ROUTE_DESCRIPTORS) {
		const path =
			entry.operationId === "getAccount"
				? entry.path.replace("{accountId}", missingAccountId)
				: entry.path;
		const response = context.router.dispatch(
			administrator.peer,
			entry.method,
			path,
			entry.method === "PUT" ? encode(SETTINGS) : undefined,
		);
		if (entry.path === ROUTE) {
			if (entry.method === "GET") refused(response, 404, "NOT_FOUND");
			else ok(response, SETTINGS);
		} else if (entry.operationId === "pageAccounts") {
			ok(response, { accounts: [], nextId: null });
		} else {
			expect(entry.operationId).toBe("getAccount");
			refused(response, 404, "NOT_FOUND");
		}
	}
	ok(context.router.dispatch(administrator.peer, "GET", ROUTE, undefined), SETTINGS);
});

it("returns authenticated unset and canonical fresh settings bytes without changing authority", async () => {
	const context = await open(),
		administrator = await owner(context);
	const before = context.session.devices.currentState();
	refused(context.router.dispatch(administrator.peer, "GET", ROUTE, undefined), 404, "NOT_FOUND");
	const input = encode(SETTINGS);
	const saved = context.router.dispatch(administrator.peer, "PUT", ROUTE, input);
	input.fill(0);
	ok(saved, SETTINGS);
	const first = context.router.dispatch(administrator.peer, "GET", ROUTE, undefined);
	const second = context.router.dispatch(administrator.peer, "GET", ROUTE, undefined);
	ok(first, SETTINGS);
	ok(second, SETTINGS);
	expect(first).not.toBe(second);
	expect(first.body).not.toBe(second.body);
	first.body.fill(0);
	ok(second, SETTINGS);
	ok(context.router.dispatch(administrator.peer, "GET", ROUTE, undefined), SETTINGS);
	expect(context.session.devices.currentState()).toEqual(before);
	expect(Object.isFrozen(context.router)).toBe(true);
});

it("uses live read and admin capabilities instead of descriptor labels", async () => {
	const context = await open(),
		administrator = await owner(context);
	ok(context.router.dispatch(administrator.peer, "PUT", ROUTE, encode(SETTINGS)), SETTINGS);
	const reader = await native.device(context.native);
	const id = await admitDevice(context, administrator, reader);
	const proof = await context.session.pins.verify(
		native.owner(context.native),
		native.PIN,
		cliConfirmPinScope(id),
	);
	try {
		context.session.store.write((tx) => context.session.devices.confirmFromCli(tx, id, proof));
	} finally {
		context.session.pins.discard(proof);
	}
	const grant = context.session.store.read((db) =>
		context.native.authorizer.requirePeerDevice(db, reader.peer, "read"),
	);
	expect(grant.userId).toBe(native.owner(context.native));
	expect(grant.capabilities).toEqual(["read", "draft"]);
	expect(
		NATIVE_API_ROUTE_DESCRIPTORS.find((entry) => entry.method === "PUT")?.security.capability,
	).toBe("admin");
	ok(context.router.dispatch(reader.peer, "GET", ROUTE, undefined), SETTINGS);
	refused(context.router.dispatch(reader.peer, "PUT", ROUTE, encode(OTHER)), 403, "FORBIDDEN");
	refused(
		context.router.dispatch(
			reader.peer,
			"PUT",
			ROUTE,
			encode({ ...OTHER, security: { nativeOnly: true, capability: "admin" } }),
		),
		403,
		"FORBIDDEN",
	);
	ok(context.router.dispatch(administrator.peer, "GET", ROUTE, undefined), SETTINGS);
});

it("refuses a genuinely paired pending peer before request parsing", async () => {
	const context = await open(),
		administrator = await owner(context);
	const pending = await native.device(context.native);
	await admitDevice(context, administrator, pending);
	refused(context.router.dispatch(pending.peer, "GET", ROUTE, undefined), 403, "FORBIDDEN");
	refused(
		context.router.dispatch(pending.peer, "PUT", ROUTE, Buffer.from([0xff])),
		403,
		"FORBIDDEN",
	);
	refused(context.router.dispatch(administrator.peer, "GET", ROUTE, undefined), 404, "NOT_FOUND");
});

it("refuses foreign and forged peers separately from untrusted request data", async () => {
	const first = await open(),
		second = await open();
	const one = await owner(first),
		two = await owner(second);
	ok(first.router.dispatch(one.peer, "PUT", ROUTE, encode(SETTINGS)), SETTINGS);
	ok(second.router.dispatch(two.peer, "PUT", ROUTE, encode(OTHER)), OTHER);
	refused(first.router.dispatch(two.peer, "GET", ROUTE, undefined), 403, "FORBIDDEN");
	refused(first.router.dispatch(two.peer, "PUT", ROUTE, encode(OTHER)), 403, "FORBIDDEN");
	let touches = 0;
	const hostile = new Proxy(one.peer, {
		get() {
			touches++;
			throw new Error("DYTEST peer getter ran");
		},
	});
	// These are malicious DATA lookalikes only, never positive fixture authority.
	const forgeries: unknown[] = [
		Object.freeze({
			deviceId: native.idOf(one),
			userId: native.owner(first.native),
			capabilities: ["read", "admin"],
			nativeOnly: true,
		}),
		Object.create(null),
		hostile,
	];
	for (const peer of forgeries) {
		refused(
			first.router.dispatch(peer as NativeDevicePeer, "GET", ROUTE, undefined),
			403,
			"FORBIDDEN",
		);
		refused(
			first.router.dispatch(peer as NativeDevicePeer, "PUT", ROUTE, encode(OTHER)),
			403,
			"FORBIDDEN",
		);
	}
	expect(touches).toBe(0);
	ok(first.router.dispatch(one.peer, "GET", ROUTE, undefined), SETTINGS);
	ok(second.router.dispatch(two.peer, "GET", ROUTE, undefined), OTHER);
});

it("rechecks the same native peer after real device revocation", async () => {
	const context = await open(),
		administrator = await owner(context);
	ok(context.router.dispatch(administrator.peer, "PUT", ROUTE, encode(SETTINGS)), SETTINGS);
	const id = native.idOf(administrator);
	const proof = await context.session.pins.verify(
		native.owner(context.native),
		native.PIN,
		revokePinScope(id),
	);
	try {
		expect(
			context.session.store.write((tx) =>
				context.session.devices.revoke(tx, id, { kind: "device", id, proof }),
			),
		).toBe(true);
	} finally {
		context.session.pins.discard(proof);
	}
	refused(context.router.dispatch(administrator.peer, "GET", ROUTE, undefined), 403, "FORBIDDEN");
	refused(
		context.router.dispatch(administrator.peer, "PUT", ROUTE, encode(OTHER)),
		403,
		"FORBIDDEN",
	);
});

it("returns fixed unavailable responses after the original session closes", async () => {
	const context = await open(),
		administrator = await owner(context);
	ok(context.router.dispatch(administrator.peer, "PUT", ROUTE, encode(SETTINGS)), SETTINGS);
	await context.session.close();
	refused(context.router.dispatch(administrator.peer, "GET", ROUTE, undefined), 503, "UNAVAILABLE");
	refused(
		context.router.dispatch(administrator.peer, "PUT", ROUTE, encode(OTHER)),
		503,
		"UNAVAILABLE",
	);
});

it("delegates strict request bytes and the exact 4096 byte limit without replacing saved data", async () => {
	const context = await open(),
		administrator = await owner(context);
	const body = Buffer.from(encode(SETTINGS));
	ok(
		context.router.dispatch(
			administrator.peer,
			"PUT",
			ROUTE,
			Buffer.concat([body, Buffer.alloc(4096 - body.length, 0x20)]),
		),
		SETTINGS,
	);
	const hours = JSON.stringify(SETTINGS.workingHours);
	const invalid = [
		Buffer.alloc(0),
		Buffer.from([0xff]),
		Buffer.from("{"),
		Buffer.from("null"),
		Buffer.from(`{"zone":"America/Chicago","zone":"Europe/Paris","workingHours":${hours}}`),
		encode({ ...SETTINGS, zone: "America/Chicago\n" }),
		encode({ ...SETTINGS, approve: true }),
		new Uint8Array(new SharedArrayBuffer(16)),
		Buffer.concat([body, Buffer.alloc(4097 - body.length, 0x20)]),
	];
	for (const bytes of invalid) {
		refused(
			context.router.dispatch(administrator.peer, "PUT", ROUTE, bytes),
			400,
			"INVALID_REQUEST",
		);
		ok(context.router.dispatch(administrator.peer, "GET", ROUTE, undefined), SETTINGS);
	}
});

it("keeps wrong methods paths and private actions outside the dispatch table with no echo", async () => {
	const context = await open(),
		administrator = await owner(context);
	for (const method of ["POST", "DELETE", "PATCH", "OPTIONS", "get"])
		refused(
			context.router.dispatch(administrator.peer, method, ROUTE, encode(SETTINGS)),
			404,
			"NOT_FOUND",
		);
	for (const route of [
		"/api/v1/approve",
		"/api/v1/send",
		"/api/v1/admin",
		"/device/v1/pair",
		"/device/v1/approve",
		"/api/v1/login",
		"/login",
		"/consent",
		`${ROUTE}?admin=true`,
		"/DYTEST-untrusted-path",
	])
		refused(context.router.dispatch(administrator.peer, "GET", route, undefined), 404, "NOT_FOUND");
	let touches = 0;
	const hostile = new Proxy(
		{},
		{
			get() {
				touches++;
				throw new Error("DYTEST request getter ran");
			},
		},
	);
	for (const value of [undefined, null, 7, hostile]) {
		refused(
			context.router.dispatch(administrator.peer, value as unknown as string, ROUTE, undefined),
			400,
			"INVALID_REQUEST",
		);
		refused(
			context.router.dispatch(administrator.peer, "GET", value as unknown as string, undefined),
			400,
			"INVALID_REQUEST",
		);
	}
	expect(touches).toBe(0);
	refused(context.router.dispatch(administrator.peer, "GET", ROUTE, undefined), 404, "NOT_FOUND");
});

it("enforces GET body absence and PUT body presence with fresh fixed errors", async () => {
	const context = await open(),
		administrator = await owner(context);
	ok(context.router.dispatch(administrator.peer, "PUT", ROUTE, encode(SETTINGS)), SETTINGS);
	for (const body of [new Uint8Array(0), encode(OTHER)])
		refused(
			context.router.dispatch(administrator.peer, "GET", ROUTE, body),
			400,
			"INVALID_REQUEST",
		);
	const first = context.router.dispatch(administrator.peer, "PUT", ROUTE, undefined);
	const second = context.router.dispatch(administrator.peer, "PUT", ROUTE, undefined);
	refused(first, 400, "INVALID_REQUEST");
	refused(second, 400, "INVALID_REQUEST");
	expect(first.body).not.toBe(second.body);
	first.body.fill(0);
	refused(second, 400, "INVALID_REQUEST");
	ok(context.router.dispatch(administrator.peer, "GET", ROUTE, undefined), SETTINGS);
});

it("maps persisted corruption to unavailable without echoing stored text", async () => {
	const context = await open(),
		administrator = await owner(context);
	ok(context.router.dispatch(administrator.peer, "PUT", ROUTE, encode(SETTINGS)), SETTINGS);
	context.session.store.write((tx) =>
		tx.run("UPDATE owner_settings SET settings_json=? WHERE user_id=?", [
			'{"zone":"DYTEST-corrupt-settings"}',
			native.owner(context.native),
		]),
	);
	refused(context.router.dispatch(administrator.peer, "GET", ROUTE, undefined), 503, "UNAVAILABLE");
});
