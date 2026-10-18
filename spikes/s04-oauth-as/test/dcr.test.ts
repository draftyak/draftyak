import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	DcrWindow,
	dcrWindowRequested,
	MAX_REGISTRATIONS,
	requestWindow,
	WINDOW_MS,
} from "../src/dcr-window.ts";
import { METADATA_PATH } from "../src/routes.ts";
import {
	type CimdAs,
	claudeAi,
	codex,
	FakeVendorHost,
	ScriptedClient,
	startCimdAs,
	typesCode,
} from "./connectors.ts";
import { authorizeUrl, Browser } from "./flow.ts";

let clock = Date.now();
const window = new DcrWindow({ now: () => clock });
let vendor: FakeVendorHost;
let as: CimdAs;
// Registration requests that got past the route's check into oidc-provider, body unread.
let entered = 0;

beforeAll(async () => {
	vendor = await FakeVendorHost.start();
	as = await startCimdAs(vendor, { window });
	as.provider.use(async (ctx, next) => {
		if (ctx.path === "/oauth/register") entered += 1;
		await next();
	});
});
afterAll(async () => {
	await as?.close();
	await vendor?.close();
});
beforeEach(() => {
	window.close();
});

const registration = (): Record<string, unknown> => ({ ...codex().registration });
const register = (body: unknown) =>
	fetch(`${as.origin}/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
const advertised = async (): Promise<unknown> =>
	((await (await fetch(`${as.origin}${METADATA_PATH}`)).json()) as Record<string, unknown>)
		.registration_endpoint;

interface Answer {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

// A registration whose headers and all but its last byte arrive now; send() delivers the rest.
function held(body: unknown = registration()): { send(): Promise<Answer> } {
	const payload = Buffer.from(JSON.stringify(body));
	const { hostname, port } = new URL(as.origin);
	const req = request({
		host: hostname,
		port,
		method: "POST",
		path: "/oauth/register",
		headers: { "content-type": "application/json", "content-length": payload.length },
	});
	const answer = new Promise<Answer>((resolve, reject) => {
		req
			.once("response", (res) => {
				let text = "";
				res.setEncoding("utf8").on("data", (chunk: string) => {
					text += chunk;
				});
				res.once("end", () => {
					const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
					resolve({ status: res.statusCode ?? 0, body: parsed });
				});
			})
			.once("error", reject);
	});
	req.write(payload.subarray(0, -1));
	return {
		send: () => {
			req.end(payload.subarray(-1));
			return answer;
		},
	};
}

async function untilEntered(count: number): Promise<void> {
	for (let waited = 0; entered < count; waited += 10) {
		if (waited > 10_000) throw new Error(`${entered} of ${count} registrations got in`);
		await sleep(10);
	}
}

test("DRAFTYAK_DCR_WINDOW=1 opens the window as the AS starts", () => {
	expect(dcrWindowRequested({})).toBe(false);
	expect(dcrWindowRequested({ DRAFTYAK_DCR_WINDOW: "1" })).toBe(true);
	expect(dcrWindowRequested({ DRAFTYAK_DCR_WINDOW: "0" })).toBe(false);
	expect(() => dcrWindowRequested({ DRAFTYAK_DCR_WINDOW: "true" })).toThrow('not "true"');
});

describe("the dcr-window command, for an AS that is already running", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "draftyak-dcr-"));
		return () => rmSync(dir, { recursive: true, force: true });
	});

	test("opens the window of an AS watching for it; without one it opens nothing", async () => {
		const file = path.join(dir, "dcr-window");
		const watched = new DcrWindow();
		expect(await requestWindow(file, 300)).toBe(false);
		expect(existsSync(file)).toBe(false);
		writeFileSync(file, "");
		{
			using _watching = watched.watch(file, 20);
			// A request left from before the AS started opens nothing.
			expect(existsSync(file)).toBe(false);
			await sleep(100);
			expect(watched.isOpen).toBe(false);
			expect(await requestWindow(file, 5_000)).toBe(true);
			expect(watched.isOpen).toBe(true);
		}
		watched.close();
		expect(await requestWindow(file, 300)).toBe(false);
		expect(watched.isOpen).toBe(false);
	});

	test("is the package's dcr-window script, which drops its file in the owner's cache folder", async () => {
		const file = path.join(dir, "s04-oauth-as", "dcr-window");
		mkdirSync(path.dirname(file));
		const watched = new DcrWindow();
		using _watching = watched.watch(file, 20);
		const script = path.join(import.meta.dirname, "..", "src", "dcr-window.ts");
		const { stdout } = await promisify(execFile)(process.execPath, [script], {
			env: { ...process.env, DRAFTYAK_CACHE_DIR: dir },
		});
		expect(stdout).toContain("registration is open for 10 minutes or 10 registrations");
		expect(watched.isOpen).toBe(true);
	});
});

describe("dynamic client registration", () => {
	test("is closed unless the window is open: a 404, and no registration_endpoint", async () => {
		const response = await register(registration());
		expect([response.status, await response.json()]).toStrictEqual([404, { error: "not_found" }]);
		expect(await advertised()).toBeUndefined();
	});

	test("works only inside the 10-minute window, and the registered client outlives it", async () => {
		const closesAt = window.open();
		expect(closesAt - clock).toBe(WINDOW_MS);
		expect(WINDOW_MS).toBe(600_000);
		expect(await advertised()).toBe(`${as.origin}/oauth/register`);
		const cli = new ScriptedClient(codex(), { origin: as.origin, approve: typesCode(as) });
		expect((await cli.discover()).unmet).toStrictEqual([]);
		const tokens = await cli.connect();
		expect(cli.clientId).toEqual(expect.any(String));
		expect(as.pushes.at(-1)?.clientName).toBe("Codex CLI (stand-in)");
		clock = closesAt - 1;
		expect(await advertised()).toBe(`${as.origin}/oauth/register`);
		clock = closesAt;
		expect((await register(registration())).status).toBe(404);
		expect(await advertised()).toBeUndefined();
		const rotated = await cli.refresh(tokens.refreshToken);
		expect(rotated.status).toBe(200);
		expect(await cli.callMcp(String(rotated.body.access_token))).toBe(200);
		expect((await cli.refresh(tokens.refreshToken)).body.error).toBe("invalid_grant");
	});

	test("a registered client gets no secret and no registration access token", async () => {
		window.open();
		const response = await register(registration());
		expect(response.status).toBe(201);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			client_name: "Codex CLI (stand-in)",
			application_type: "native",
			token_endpoint_auth_method: "none",
		});
		for (const key of ["client_secret", "registration_access_token", "registration_client_uri"]) {
			expect(body, key).not.toHaveProperty(key);
		}
		const read = await fetch(`${as.origin}/oauth/register/${String(body.client_id)}`);
		expect(read.status).toBe(404);
	});

	test("refuses shared-secret authentication, so no secret is ever issued, and counts no refusal", async () => {
		window.open();
		for (const method of ["client_secret_basic", "client_secret_post", "client_secret_jwt"]) {
			const response = await register({ ...registration(), token_endpoint_auth_method: method });
			const body = (await response.json()) as Record<string, unknown>;
			expect([response.status, body.error], method).toStrictEqual([400, "invalid_client_metadata"]);
		}
		expect(window.registered).toBe(0);
	});

	test(`closes early after ${MAX_REGISTRATIONS} registrations`, async () => {
		window.open();
		for (let made = 0; made < MAX_REGISTRATIONS; made++) {
			expect((await register(registration())).status).toBe(201);
		}
		expect(window.registered).toBe(MAX_REGISTRATIONS);
		expect(window.isOpen).toBe(false);
		expect((await register(registration())).status).toBe(404);
		expect(await advertised()).toBeUndefined();
		window.open();
		expect((await register(registration())).status).toBe(201);
	});

	test("close() ends it at once", async () => {
		window.open();
		window.close();
		expect((await register(registration())).status).toBe(404);
	});

	describe("is checked where the client is made, not only when the request arrives", () => {
		test("a request let in while open, whose body comes after close(), registers nothing", async () => {
			window.open();
			const late = held();
			await untilEntered(entered + 1);
			window.close();
			expect(await late.send()).toStrictEqual({ status: 404, body: { error: "not_found" } });
			expect(window.registered).toBe(0);
		});

		test("so does one whose body comes after the 10 minutes", async () => {
			const closesAt = window.open();
			const late = held();
			await untilEntered(entered + 1);
			clock = closesAt;
			expect((await late.send()).status).toBe(404);
			expect(window.registered).toBe(0);
		});

		test(`requests held open together still make only ${MAX_REGISTRATIONS} clients`, async () => {
			window.open();
			const before = entered;
			const pending = Array.from({ length: MAX_REGISTRATIONS + 5 }, () => held());
			await untilEntered(before + pending.length);
			const answers = await Promise.all(pending.map((one) => one.send()));
			const made = answers.filter(({ status }) => status === 201);
			expect(made).toHaveLength(MAX_REGISTRATIONS);
			expect(answers.filter(({ status }) => status === 404)).toHaveLength(5);
			expect(window.registered).toBe(MAX_REGISTRATIONS);
			for (const { body } of made) {
				expect(await as.provider.Client.find(String(body.client_id))).toBeDefined();
			}
		});
	});

	test("a registered loopback client's redirect URI matches exactly, port included", async () => {
		window.open();
		const response = await register(registration());
		const body = (await response.json()) as Record<string, unknown>;
		const [registered = ""] = body.redirect_uris as string[];
		const other = new URL(registered);
		other.port = String(Number(other.port) === 65_535 ? 49_152 : Number(other.port) + 1);
		const client = { id: String(body.client_id), kind: "public" as const, metadata: {} };
		const start = async (redirectUri: string) =>
			(await new Browser().get(authorizeUrl(as, client, { redirect_uri: redirectUri }).url)).status;
		expect(await start(registered)).toBe(303);
		expect(await start(other.href)).toBe(400);
	});

	test("a CIMD client needs no window", async () => {
		const ai = claudeAi();
		vendor.serveAll(ai.documents);
		const client = new ScriptedClient(ai, { origin: as.origin, approve: typesCode(as) });
		expect((await client.connect()).scope).toBe("inbox:read drafts:write outbox:propose");
		expect(window.isOpen).toBe(false);
	});
});
