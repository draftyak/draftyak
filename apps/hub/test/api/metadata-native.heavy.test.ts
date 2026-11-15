import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { AccountPage, AccountRecord } from "../../src/accounts/records.ts";
import type { NativeApiResponse } from "../../src/api/router.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { OriginalSessionAdminFixture } from "../identity/original-session-admin-fixture.ts";

requireLoopbackNetworkGuard();
const [
	{ NativeAccounts },
	{ createNativeApiRouter, NATIVE_API_ROUTE_DESCRIPTORS },
	{ EventLog },
	{ WorkDatabase },
	{ newId },
	{ originalSessionAdminFixture, closeOriginalSessionAdminFixtures, pairingExchange },
	{ nativePairingWindows },
	{ connectFakeDevice },
	nativeFixture,
	{ CONFIRMATION_PRESETS },
	{ canonicalize },
	{ signStatement },
	{ pairConfirmPinScope, revokePinScope },
] = await Promise.all([
	import("../../src/accounts/records.ts"),
	import("../../src/api/router.ts"),
	import("../../src/events/log.ts"),
	import("../../src/jobs/database.ts"),
	import("../../src/kernel/ids.ts"),
	import("../identity/original-session-admin-fixture.ts"),
	import("../../src/lifecycle/session.ts"),
	import("../support/fake-device/harness.ts"),
	import("../authz/native-fixture.ts"),
	import("@draftyak/protocol/entities/device"),
	import("@draftyak/protocol/jcs"),
	import("@draftyak/protocol/sign"),
	import("../../src/authz/scopes.ts"),
]);

const fixtures = new Set<OriginalSessionAdminFixture>();
const SETTINGS = Object.freeze({
	zone: "America/Chicago",
	workingHours: Object.freeze({
		days: Object.freeze(["mon", "wed", "fri"]),
		start: "09:00",
		end: "17:00",
	}),
});
const encode = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));

async function fixture(): Promise<OriginalSessionAdminFixture> {
	const value = await originalSessionAdminFixture();
	fixtures.add(value);
	return value;
}

async function confirmedCli(value: OriginalSessionAdminFixture) {
	const session = value.originalSession;
	const windows = await nativePairingWindows(session);
	const opened = await windows.open(value.owner.device.peer, {
		role: "device",
		pin: nativeFixture.PIN,
	});
	const connection = await connectFakeDevice(value.native);
	value.clients.push(connection.client);
	const exchange = pairingExchange(connection.client, opened.pairingCode);
	try {
		const answer = windows.claim(connection.device.peer, exchange.claim);
		const candidate = windows.reveal(connection.device.peer, exchange.reveal);
		expect(answer.deviceId).toBe(candidate.deviceId);
		expect(answer.epoch).toBe(candidate.epoch);
		connection.device.id = candidate.deviceId;
		const nonceBytes = randomBytes(16);
		try {
			const nonce = nonceBytes.toString("base64url");
			const at = Date.now();
			const state = session.store.read((db) => session.devices.state(db));
			const statementBody = {
				v: 1,
				hub: session.identity.hid,
				epoch: state.epoch,
				device: nativeFixture.idOf(value.device),
				nonce,
				iat: at,
				exp: at + 30_000,
				candidate: candidate.deviceId,
				role: "device",
				transportSpkiSha256: connection.client.transportSpkiSha256,
				signingKey: connection.client.signingKey,
				capabilities: [...CONFIRMATION_PRESETS.cli],
			};
			const statement = Buffer.from(canonicalize(statementBody));
			try {
				const proof = await session.pins.verify(
					value.account.account.userId,
					nativeFixture.PIN,
					pairConfirmPinScope(nonce),
				);
				try {
					const confirmed = session.store.write((tx) =>
						session.devices.confirmByApprover(
							tx,
							{
								approver: nativeFixture.idOf(value.device),
								candidate: candidate.deviceId,
								preset: "cli",
								statement,
								signature: signStatement("pair-confirm.v1", statementBody, value.device.privateKey),
							},
							proof,
						),
					);
					expect(confirmed.deviceId).toBe(candidate.deviceId);
				} finally {
					session.pins.discard(proof);
				}
			} finally {
				statement.fill(0);
			}
		} finally {
			nonceBytes.fill(0);
		}
	} finally {
		exchange.claim.fill(0);
		exchange.reveal.fill(0);
	}
	expect(connection.device.socket.getProtocol()).toBe("TLSv1.3");
	expect(
		session.store.read((db) => session.devices.facts(db, nativeFixture.idOf(connection.device)))
			?.confirmedPreset,
	).toBe("cli");
	return connection;
}

afterEach(async () => {
	let failure: unknown;
	for (const value of [...fixtures].reverse()) {
		try {
			await value.close();
			fixtures.delete(value);
		} catch (error) {
			failure ??= error;
		}
	}
	try {
		await closeOriginalSessionAdminFixtures();
	} catch (error) {
		failure ??= error;
	}
	if (failure !== undefined) throw failure;
});

function body(response: NativeApiResponse, status: NativeApiResponse["status"]): unknown {
	expect(response.status).toBe(status);
	expect(Object.isFrozen(response)).toBe(true);
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
}

function seedAccounts(value: OriginalSessionAdminFixture, count: number): string[] {
	const database = new WorkDatabase(value.originalSession.store);
	const accounts = new NativeAccounts(
		database,
		new EventLog(database, Date.now),
		value.originalSession.audit,
		Date.now,
	);
	return database.write((scope) => {
		const ids: string[] = [];
		for (let index = 0; index < count; index++) {
			const id = newId();
			accounts.create(scope, {
				...value.account.account,
				id,
				alias: `mail-${index}`,
				pluginInstanceId: newId(),
			});
			ids.push(id);
		}
		return ids;
	});
}

it("serves all four metadata operations using the original Session and real TLS owner", async () => {
	const value = await fixture();
	const router = createNativeApiRouter(value.originalSession);
	const peer = value.device.peer;
	expect(value.device.socket.getProtocol()).toBe("TLSv1.3");
	expect(NATIVE_API_ROUTE_DESCRIPTORS.map((route) => route.operationId).sort()).toEqual([
		"getAccount",
		"getOwnerSettings",
		"pageAccounts",
		"putOwnerSettings",
	]);
	expect(body(router.dispatch(peer, "GET", "/api/v1/settings", undefined), 404)).toEqual({
		code: "NOT_FOUND",
	});
	expect(body(router.dispatch(peer, "PUT", "/api/v1/settings", encode(SETTINGS)), 200)).toEqual(
		SETTINGS,
	);
	expect(body(router.dispatch(peer, "GET", "/api/v1/settings", undefined), 200)).toEqual(SETTINGS);
	expect(
		body(
			router.dispatch(peer, "GET", `/api/v1/accounts/${value.account.account.id}`, undefined),
			200,
		),
	).toEqual(value.current());
	const page = body(
		router.dispatch(peer, "GET", "/api/v1/accounts", undefined),
		200,
	) as AccountPage;
	expect(page.accounts).toEqual([value.current()]);
	expect(page.nextId).toBeNull();
});

it("returns bounded original account pages through the emitted continuation id", async () => {
	const value = await fixture();
	const expected = [value.account.account.id, ...seedAccounts(value, 102)].sort();
	const router = createNativeApiRouter(value.originalSession);
	const first = body(
		router.dispatch(value.device.peer, "GET", "/api/v1/accounts", undefined),
		200,
	) as AccountPage;
	expect(first.accounts.map((record) => record.account.id)).toEqual(expected.slice(0, 100));
	expect(first.nextId).toBe(expected[99]);
	if (first.nextId === null) throw new Error("Expected account continuation");
	const second = body(
		router.dispatch(
			value.device.peer,
			"GET",
			`/api/v1/accounts?afterId=${first.nextId}`,
			undefined,
		),
		200,
	) as AccountPage;
	expect(second.accounts.map((record) => record.account.id)).toEqual(expected.slice(100));
	expect(second.nextId).toBeNull();
	expect(
		new Set([...first.accounts, ...second.accounts].map((record) => record.account.id)).size,
	).toBe(103);
	expect(
		[...first.accounts, ...second.accounts].every(
			(record) => record.account.userId === value.account.account.userId,
		),
	).toBe(true);
});

it("refuses another genuine Session peer and does not reveal foreign-store accounts", async () => {
	const first = await fixture();
	const second = await fixture();
	const router = createNativeApiRouter(first.originalSession);
	for (const path of ["/api/v1/accounts", "/api/v1/settings"]) {
		expect(body(router.dispatch(second.device.peer, "GET", path, undefined), 403)).toEqual({
			code: "FORBIDDEN",
		});
	}
	expect(
		body(router.dispatch(second.device.peer, "PUT", "/api/v1/settings", encode(SETTINGS)), 403),
	).toEqual({ code: "FORBIDDEN" });
	const missing = router.dispatch(
		first.device.peer,
		"GET",
		`/api/v1/accounts/${newId()}`,
		undefined,
	);
	const foreign = router.dispatch(
		first.device.peer,
		"GET",
		`/api/v1/accounts/${second.account.account.id}`,
		undefined,
	);
	expect(body(missing, 404)).toEqual({ code: "NOT_FOUND" });
	expect(body(foreign, 404)).toEqual({ code: "NOT_FOUND" });
	expect(foreign.body).toEqual(missing.body);
});

it("refuses malformed metadata requests with closed fixed error DATA", async () => {
	const value = await fixture();
	const router = createNativeApiRouter(value.originalSession);
	const peer = value.device.peer;
	for (const response of [
		router.dispatch(peer, "GET", "/api/v1/accounts", encode({})),
		router.dispatch(peer, "POST", "/api/v1/accounts", undefined),
		router.dispatch(peer, "GET", "/api/v1/accounts?afterId=not-an-id", undefined),
		router.dispatch(peer, "GET", "/api/v1/settings", encode({})),
		router.dispatch(peer, "PUT", "/api/v1/settings", new Uint8Array([255])),
	]) {
		expect(body(response, 400)).toEqual({ code: "INVALID_REQUEST" });
	}
	expect(body(router.dispatch(peer, "GET", "/api/v1/unknown", undefined), 404)).toEqual({
		code: "NOT_FOUND",
	});
});

it("accepts the exact request byte limit and refuses a larger otherwise valid settings write", async () => {
	const value = await fixture();
	const router = createNativeApiRouter(value.originalSession);
	const peer = value.device.peer;
	const json = JSON.stringify(SETTINGS);
	const atLimit = Buffer.from(json.padEnd(4096, " "));
	expect(atLimit.byteLength).toBe(4096);
	expect(body(router.dispatch(peer, "PUT", "/api/v1/settings", atLimit), 200)).toEqual(SETTINGS);
	const changed = { ...SETTINGS, zone: "Etc/UTC" };
	const oversized = Buffer.from(JSON.stringify(changed).padEnd(4097, " "));
	expect(oversized.byteLength).toBe(4097);
	expect(body(router.dispatch(peer, "PUT", "/api/v1/settings", oversized), 400)).toEqual({
		code: "INVALID_REQUEST",
	});
	expect(body(router.dispatch(peer, "GET", "/api/v1/settings", undefined), 200)).toEqual(SETTINGS);
});

it("refuses duplicate keys and shared request storage without changing owner settings", async () => {
	const value = await fixture();
	const router = createNativeApiRouter(value.originalSession);
	const peer = value.device.peer;
	expect(body(router.dispatch(peer, "PUT", "/api/v1/settings", encode(SETTINGS)), 200)).toEqual(
		SETTINGS,
	);
	const changed = { ...SETTINGS, zone: "Etc/UTC" };
	const bytes = encode(changed);
	const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
	shared.set(bytes);
	const duplicate = Buffer.from(`{"zone":"America/Chicago",${JSON.stringify(changed).slice(1)}`);
	for (const payload of [encode({ ...SETTINGS, extra: true }), duplicate, shared]) {
		expect(body(router.dispatch(peer, "PUT", "/api/v1/settings", payload), 400)).toEqual({
			code: "INVALID_REQUEST",
		});
		expect(body(router.dispatch(peer, "GET", "/api/v1/settings", undefined), 200)).toEqual(
			SETTINGS,
		);
	}
});

it("lets a genuinely confirmed CLI peer read metadata but not administer owner settings", async () => {
	const value = await fixture();
	const router = createNativeApiRouter(value.originalSession);
	expect(
		body(router.dispatch(value.device.peer, "PUT", "/api/v1/settings", encode(SETTINGS)), 200),
	).toEqual(SETTINGS);
	const reader = await confirmedCli(value);
	expect(
		body(router.dispatch(reader.device.peer, "GET", "/api/v1/settings", undefined), 200),
	).toEqual(SETTINGS);
	expect(
		(
			body(
				router.dispatch(reader.device.peer, "GET", "/api/v1/accounts", undefined),
				200,
			) as AccountPage
		).accounts,
	).toEqual([value.current()]);
	expect(
		body(
			router.dispatch(
				reader.device.peer,
				"PUT",
				"/api/v1/settings",
				encode({ ...SETTINGS, zone: "Etc/UTC" }),
			),
			403,
		),
	).toEqual({ code: "FORBIDDEN" });
	expect(
		body(router.dispatch(value.device.peer, "GET", "/api/v1/settings", undefined), 200),
	).toEqual(SETTINGS);
});

it("rechecks a real peer revocation on every metadata route without retiring the owner", async () => {
	const value = await fixture();
	const router = createNativeApiRouter(value.originalSession);
	const reader = await confirmedCli(value);
	const path = `/api/v1/accounts/${value.account.account.id}`;
	expect(
		(body(router.dispatch(reader.device.peer, "GET", path, undefined), 200) as AccountRecord)
			.account.id,
	).toBe(value.account.account.id);
	const id = nativeFixture.idOf(reader.device);
	const proof = await value.originalSession.pins.verify(
		value.account.account.userId,
		nativeFixture.PIN,
		revokePinScope(id),
	);
	try {
		expect(
			value.originalSession.store.write((tx) =>
				value.originalSession.devices.revoke(tx, id, {
					kind: "device",
					id: nativeFixture.idOf(value.device),
					proof,
				}),
			),
		).toBe(true);
	} finally {
		value.originalSession.pins.discard(proof);
	}
	for (const route of [path, "/api/v1/accounts", "/api/v1/settings"]) {
		expect(body(router.dispatch(reader.device.peer, "GET", route, undefined), 403)).toEqual({
			code: "FORBIDDEN",
		});
	}
	expect(
		body(router.dispatch(reader.device.peer, "PUT", "/api/v1/settings", encode(SETTINGS)), 403),
	).toEqual({ code: "FORBIDDEN" });
	expect(
		(body(router.dispatch(value.device.peer, "GET", path, undefined), 200) as AccountRecord).account
			.id,
	).toBe(value.account.account.id);
});

it("retires every metadata handle when its actual original Session closes", async () => {
	const value = await fixture();
	const router = createNativeApiRouter(value.originalSession);
	const path = `/api/v1/accounts/${value.account.account.id}`;
	expect(
		(body(router.dispatch(value.device.peer, "GET", path, undefined), 200) as AccountRecord).account
			.id,
	).toBe(value.account.account.id);
	await value.originalSession.close();
	for (const response of [
		router.dispatch(value.device.peer, "GET", path, undefined),
		router.dispatch(value.device.peer, "GET", "/api/v1/accounts", undefined),
		router.dispatch(value.device.peer, "GET", "/api/v1/settings", undefined),
		router.dispatch(value.device.peer, "PUT", "/api/v1/settings", encode(SETTINGS)),
	]) {
		expect(body(response, 503)).toEqual({ code: "UNAVAILABLE" });
	}
	expect(() => createNativeApiRouter(value.originalSession)).toThrow();
});
