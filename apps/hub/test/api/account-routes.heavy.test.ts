import { afterEach, expect, it } from "vitest";
import type { AccountPage } from "../../src/accounts/records.ts";
import {
	ACCOUNT_API_MAX_RESPONSE_BYTES,
	createNativeAccountApiRoutes,
} from "../../src/api/account-routes.ts";
import { createNativeAccountReads } from "../../src/api/accounts.ts";
import { createNativeApiRouter, type NativeApiResponse } from "../../src/api/router.ts";
import { Authorizer } from "../../src/authz/authorizer.ts";
import { newId } from "../../src/kernel/ids.ts";
import {
	type AccountRouteFixture,
	accountRouteDeviceKeys,
	accountRouteFixture,
	seedRouteAccounts,
} from "./fixtures/account-routes.ts";

const BASE = "/api/v1/accounts";
const fixtures: AccountRouteFixture[] = [];
async function fixture(
	keys?: Awaited<ReturnType<typeof accountRouteDeviceKeys>>,
): Promise<AccountRouteFixture> {
	const f = await accountRouteFixture(keys);
	fixtures.push(f);
	return f;
}
afterEach(async () => {
	for (const f of fixtures.splice(0).reverse()) await f.close();
});
function checked(
	result: NativeApiResponse | undefined,
	status: NativeApiResponse["status"],
): NativeApiResponse {
	if (result === undefined) throw new Error("Account route did not handle its own path");
	expect(result.status).toBe(status);
	expect(Object.isFrozen(result)).toBe(true);
	return result;
}
function json(response: NativeApiResponse): unknown {
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
}
function error(
	result: NativeApiResponse | undefined,
	status: NativeApiResponse["status"],
	code: string,
): void {
	expect(json(checked(result, status))).toEqual({ code });
}

it("serializes the genuine owner record and gives identical missing and foreign-account refusals", async () => {
	const f = await fixture();
	const [id] = seedRouteAccounts(f, 1),
		[privateId] = seedRouteAccounts(f, 1, newId());
	if (!id || !privateId) throw new Error("Missing fixture account");
	const routes = createNativeAccountApiRoutes(f.session);
	expect(Object.isFrozen(routes)).toBe(true);
	const actual = checked(routes.dispatch(f.peer, "GET", `${BASE}/${id}`, undefined), 200);
	const record = createNativeAccountReads(f.session).get(f.peer, id);
	expect(Object.isFrozen(record)).toBe(true);
	expect(Object.isFrozen(record?.account)).toBe(true);
	expect(json(actual)).toEqual(record);
	const missing = checked(routes.dispatch(f.peer, "GET", `${BASE}/${newId()}`, undefined), 404);
	const foreign = checked(routes.dispatch(f.peer, "GET", `${BASE}/${privateId}`, undefined), 404);
	expect(missing.body).toEqual(foreign.body);
	expect(json(missing)).toEqual({ code: "NOT_FOUND" });
});

it("returns exact bounded pages using the emitted continuation id", async () => {
	const f = await fixture(),
		ids = seedRouteAccounts(f, 103);
	seedRouteAccounts(f, 2, newId());
	const routes = createNativeAccountApiRoutes(f.session),
		reads = createNativeAccountReads(f.session);
	const first = json(checked(routes.dispatch(f.peer, "GET", BASE, undefined), 200)) as AccountPage;
	expect(first).toEqual(reads.page(f.peer, null));
	expect(first.accounts.map((record) => record.account.id)).toEqual(ids.slice(0, 100));
	expect(first.nextId).toBe(ids[99]);
	const second = json(
		checked(routes.dispatch(f.peer, "GET", `${BASE}?afterId=${first.nextId}`, undefined), 200),
	) as AccountPage;
	expect(second).toEqual(reads.page(f.peer, first.nextId));
	expect(second.accounts.map((record) => record.account.id)).toEqual(ids.slice(100));
	expect(second.nextId).toBeNull();
	expect(
		new Set([...first.accounts, ...second.accounts].map((record) => record.account.id)).size,
	).toBe(103);
	expect(
		[...first.accounts, ...second.accounts].every((record) => record.account.userId === f.owner),
	).toBe(true);
});

it("serves both GET forms to a genuine owner whose durable capability is read only", async () => {
	const f = await fixture(),
		[id] = seedRouteAccounts(f, 1);
	if (!id) throw new Error("Missing fixture account");
	const routes = createNativeAccountApiRoutes(f.session);
	f.session.store.write((sql) => {
		expect(sql.run("UPDATE main.devices SET capabilities=1 WHERE id=?", [f.deviceId]).changes).toBe(
			1,
		);
	});
	const authorizer = new Authorizer(f.session.devices);
	expect(
		f.session.store.read((sql) => authorizer.requirePeerDevice(sql, f.peer, "read").capabilities),
	).toEqual(["read"]);
	checked(routes.dispatch(f.peer, "GET", `${BASE}/${id}`, undefined), 200);
	checked(routes.dispatch(f.peer, "GET", BASE, undefined), 200);
});

it("forwards the actual native peer and refuses another genuine session even with identical device keys", async () => {
	const keys = await accountRouteDeviceKeys(),
		a = await fixture(keys),
		b = await fixture(keys);
	const [id] = seedRouteAccounts(a, 1);
	if (!id) throw new Error("Missing fixture account");
	const routes = createNativeAccountApiRoutes(a.session);
	checked(routes.dispatch(a.peer, "GET", `${BASE}/${id}`, undefined), 200);
	error(routes.dispatch(b.peer, "GET", `${BASE}/${id}`, undefined), 403, "FORBIDDEN");
	error(routes.dispatch(b.peer, "GET", BASE, undefined), 403, "FORBIDDEN");
});

it("rechecks revocation and reports closed-session unavailability without exposing diagnostics", async () => {
	const f = await fixture(),
		[id] = seedRouteAccounts(f, 1);
	if (!id) throw new Error("Missing fixture account");
	const routes = createNativeAccountApiRoutes(f.session);
	f.session.store.write((sql) => {
		sql.run("UPDATE main.devices SET capabilities=1 WHERE id=?", [f.deviceId]);
		expect(f.session.devices.revoke(sql, f.deviceId, { kind: "cli" })).toBe(true);
	});
	error(routes.dispatch(f.peer, "GET", BASE, undefined), 403, "FORBIDDEN");
	error(routes.dispatch(f.peer, "GET", `${BASE}/${id}`, undefined), 403, "FORBIDDEN");
	await f.session.close();
	error(routes.dispatch(f.peer, "GET", BASE, undefined), 503, "UNAVAILABLE");
	error(routes.dispatch(f.peer, "GET", `${BASE}/${id}`, undefined), 503, "UNAVAILABLE");
});

it("rejects noncanonical account paths, queries, methods and every supplied GET body", async () => {
	const f = await fixture(),
		[id] = seedRouteAccounts(f, 1);
	if (!id) throw new Error("Missing fixture account");
	const routes = createNativeAccountApiRoutes(f.session);
	const lowercaseId = `0a${id.slice(2)}`;
	for (const route of [
		`${BASE}?`,
		`${BASE}?afterId=`,
		`${BASE}?afterId=null`,
		`${BASE}?limit=100`,
		`${BASE}?afterId=${id}&afterId=${id}`,
		`${BASE}?afterId=${id}&extra=1`,
		`${BASE}?afterId=%30${id.slice(1)}`,
		`${BASE}?afterId=${lowercaseId}`,
		`${BASE}/`,
		`${BASE}//${id}`,
		`${BASE}/${id}/`,
		`${BASE}/${id}?afterId=${id}`,
		`${BASE}/%30${id.slice(1)}`,
		`${BASE}/${lowercaseId}`,
		`${BASE}/..`,
		`${BASE}#fragment`,
		`${BASE}\\${id}`,
		`${BASE}/\u0000`,
		`${BASE}/${"0".repeat(1024)}`,
	])
		error(routes.dispatch(f.peer, "GET", route, undefined), 400, "INVALID_REQUEST");
	for (const method of ["POST", "PUT", "DELETE", "get", ""])
		error(routes.dispatch(f.peer, method, BASE, undefined), 400, "INVALID_REQUEST");
	for (const body of [new Uint8Array(), new TextEncoder().encode("{}")]) {
		error(routes.dispatch(f.peer, "GET", BASE, body), 400, "INVALID_REQUEST");
		error(routes.dispatch(f.peer, "GET", `${BASE}/${id}`, body), 400, "INVALID_REQUEST");
	}
});

it("does not coerce request objects and delegates unrelated paths without consuming their bodies", async () => {
	const f = await fixture(),
		routes = createNativeAccountApiRoutes(f.session);
	let touches = 0;
	const hostile = new Proxy(
		{},
		{
			get() {
				touches++;
				throw new Error("Request object touched");
			},
		},
	);
	error(routes.dispatch(f.peer, hostile as never, BASE, undefined), 400, "INVALID_REQUEST");
	error(routes.dispatch(f.peer, "GET", hostile as never, undefined), 400, "INVALID_REQUEST");
	for (const other of [
		"/api/v1/settings",
		"/api/v1/conversations",
		"/api/v1/accounts-export",
		"/api/v1/accounts2",
		"/api/v1/accounts.export",
		"/api/v1/accounts~export",
	])
		expect(routes.dispatch(f.peer, "PUT", other, hostile as never)).toBeUndefined();
	expect(touches).toBe(0);
});

it("bounds a full real Unicode page by UTF-8 bytes without substituting a producer", async () => {
	const f = await fixture();
	seedRouteAccounts(f, 100, f.owner, true);
	const response = checked(
		createNativeAccountApiRoutes(f.session).dispatch(f.peer, "GET", BASE, undefined),
		200,
	);
	const text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
	expect(Buffer.byteLength(text, "utf8")).toBe(response.body.byteLength);
	expect(response.body.byteLength).toBeGreaterThan(text.length);
	expect(response.body.byteLength).toBeLessThanOrEqual(ACCOUNT_API_MAX_RESPONSE_BYTES);
	const page = JSON.parse(text) as AccountPage;
	expect(page.accounts).toHaveLength(100);
	expect(page.accounts.every((record) => record.account.userId === f.owner)).toBe(true);
	expect(page.nextId).toBeNull();
});

it("maps unavailable native account data to a fixed response without echoing stored text", async () => {
	const f = await fixture(),
		[id] = seedRouteAccounts(f, 1);
	if (!id) throw new Error("Missing fixture account");
	const routes = createNativeAccountApiRoutes(f.session);
	f.session.store.write((sql) => {
		sql.run("UPDATE main.accounts SET account_json=? WHERE id=?", [
			'{"unavailable-canary":true}',
			id,
		]);
	});
	error(routes.dispatch(f.peer, "GET", `${BASE}/${id}`, undefined), 503, "UNAVAILABLE");
	error(routes.dispatch(f.peer, "GET", BASE, undefined), 503, "UNAVAILABLE");
});

it("mounts account point, page and cursor handlers in the real native API router", async () => {
	const f = await fixture(),
		ids = seedRouteAccounts(f, 3);
	const firstId = ids[0];
	if (!firstId) throw new Error("Missing fixture account");
	const router = createNativeApiRouter(f.session),
		reads = createNativeAccountReads(f.session);
	expect(
		json(checked(router.dispatch(f.peer, "GET", `${BASE}/${firstId}`, undefined), 200)),
	).toEqual(reads.get(f.peer, firstId));
	expect(json(checked(router.dispatch(f.peer, "GET", BASE, undefined), 200))).toEqual(
		reads.page(f.peer, null),
	);
	expect(
		json(checked(router.dispatch(f.peer, "GET", `${BASE}?afterId=${firstId}`, undefined), 200)),
	).toEqual(reads.page(f.peer, firstId));
	error(router.dispatch(f.peer, "GET", `${BASE}/${newId()}`, undefined), 404, "NOT_FOUND");
});

it("preserves settings GET and PUT while mounted account reads accept a read-only owner", async () => {
	const f = await fixture(),
		[id] = seedRouteAccounts(f, 1);
	if (!id) throw new Error("Missing fixture account");
	const router = createNativeApiRouter(f.session),
		SETTINGS = "/api/v1/settings";
	const settings = {
		zone: "Europe/Sofia",
		workingHours: { days: ["mon", "fri"], start: "09:00", end: "17:00" },
	};
	const bytes = new TextEncoder().encode(JSON.stringify(settings));
	error(router.dispatch(f.peer, "GET", SETTINGS, undefined), 404, "NOT_FOUND");
	expect(json(checked(router.dispatch(f.peer, "PUT", SETTINGS, bytes), 200))).toEqual(settings);
	expect(json(checked(router.dispatch(f.peer, "GET", SETTINGS, undefined), 200))).toEqual(settings);
	f.session.store.write((sql) => {
		expect(sql.run("UPDATE main.devices SET capabilities=1 WHERE id=?", [f.deviceId]).changes).toBe(
			1,
		);
	});
	error(router.dispatch(f.peer, "PUT", SETTINGS, bytes), 403, "FORBIDDEN");
	expect(json(checked(router.dispatch(f.peer, "GET", SETTINGS, undefined), 200))).toEqual(settings);
	checked(router.dispatch(f.peer, "GET", `${BASE}/${id}`, undefined), 200);
	checked(router.dispatch(f.peer, "GET", BASE, undefined), 200);
	error(router.dispatch(f.peer, "GET", SETTINGS, new Uint8Array()), 400, "INVALID_REQUEST");
	error(router.dispatch(f.peer, "GET", "/api/v1/unrelated", undefined), 404, "NOT_FOUND");
});
