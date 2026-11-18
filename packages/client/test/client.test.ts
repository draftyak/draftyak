import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ApiClientError, createApiClient } from "@draftyak/client";
import { Account } from "@draftyak/protocol/entities/account";
import { OwnerSettings } from "@draftyak/protocol/entities/settings";

type Client = ReturnType<typeof createApiClient>;
type Operation = (client: Client) => Promise<unknown>;
const origin = "https://dytest-hub.example.invalid";
const id = (value: number): string => String(value).padStart(26, "0");
const accountId = id(100);
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
let globalFetchCalls = 0;

beforeEach(() => {
	globalFetchCalls = 0;
	globalThis.fetch = async () => {
		globalFetchCalls += 1;
		throw new Error("DYTEST unexpected global network");
	};
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	assert.equal(globalFetchCalls, 0);
});

function settings() {
	return OwnerSettings.parse({
		zone: "UTC",
		workingHours: { days: ["mon", "tue"], start: "09:00", end: "17:00" },
	});
}

function record(sequence = 100) {
	return {
		account: Account.parse({
			id: id(sequence),
			userId: id(200),
			alias: "dytest-client",
			channel: "email",
			mode: "full",
			status: "active",
			deletionDeadline: null,
			historyLimitDays: 30,
			disclosureVersion: 1,
			createdAt: 1,
			pluginInstanceId: id(300),
			address: "dytest-owner@example.invalid",
		}),
		generation: 1,
	};
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function fake(run: (request: Request, index: number) => Response | Promise<Response>) {
	const requests: Request[] = [];
	const transport = {
		async fetch(request: Request): Promise<Response> {
			requests.push(request);
			return run(request, requests.length - 1);
		},
	};
	return { transport, requests };
}

function clientWith(run: (request: Request, index: number) => Response | Promise<Response>) {
	const fixture = fake(run);
	return {
		...fixture,
		client: createApiClient({ transport: fixture.transport, baseUrl: new URL(`${origin}/`) }),
	};
}

function fixed(code: ApiClientError["code"]) {
	return (error: unknown) => {
		assert.ok(error instanceof ApiClientError);
		assert.equal(error.name, "ApiClientError");
		assert.equal(error.message, "API request failed");
		assert.equal(error.code, code);
		assert.equal("cause" in error, false);
		return true;
	};
}

test("uses the four actual methods, paths, query and canonical JSON through the injected transport", async () => {
	const page = { accounts: [record()], nextId: null };
	const results = [settings(), settings(), record(), page, page];
	const fixture = clientWith((_request, index) => json(results[index]));
	const input = settings();
	Object.freeze(input.workingHours.days);
	Object.freeze(input.workingHours);
	Object.freeze(input);
	const before = JSON.stringify(input);
	assert.deepEqual(await fixture.client.getOwnerSettings(), settings());
	assert.deepEqual(await fixture.client.putOwnerSettings(input), settings());
	assert.deepEqual(await fixture.client.getAccount(accountId), record());
	assert.deepEqual(await fixture.client.pageAccounts(), page);
	assert.deepEqual(await fixture.client.pageAccounts(id(50)), page);
	assert.equal(JSON.stringify(input), before);

	assert.deepEqual(
		fixture.requests.map((request) => [request.method, request.url]),
		[
			["GET", `${origin}/api/v1/settings`],
			["PUT", `${origin}/api/v1/settings`],
			["GET", `${origin}/api/v1/accounts/${accountId}`],
			["GET", `${origin}/api/v1/accounts`],
			["GET", `${origin}/api/v1/accounts?afterId=${id(50)}`],
		],
	);
	for (const [index, request] of fixture.requests.entries()) {
		assert.ok(request instanceof Request);
		assert.equal(request.headers.get("accept"), "application/json");
		assert.equal(request.headers.get("authorization"), null);
		assert.equal(request.headers.get("cookie"), null);
		if (index === 1) {
			assert.equal(request.headers.get("content-type"), "application/json");
			assert.equal(
				await request.text(),
				'{"workingHours":{"days":["mon","tue"],"end":"17:00","start":"09:00"},"zone":"UTC"}',
			);
		} else {
			assert.equal(request.body, null);
			assert.equal(request.headers.get("content-type"), null);
		}
	}
	assert.equal(Object.isFrozen(fixture.client), true);
	assert.deepEqual(Object.keys(fixture.client).sort(), [
		"getAccount",
		"getOwnerSettings",
		"pageAccounts",
		"putOwnerSettings",
	]);
});

test("clones an admitted base URL and rejects URL authority or path ambiguity", async () => {
	const baseUrl = new URL(`${origin}/`);
	const fixture = fake(() => json(settings()));
	const client = createApiClient({ transport: fixture.transport, baseUrl });
	baseUrl.hostname = "dytest-other.example.invalid";
	baseUrl.pathname = "/DYTEST-other/";
	await client.getOwnerSettings();
	assert.equal(fixture.requests[0]?.url, `${origin}/api/v1/settings`);
	const http = fake(() => json(settings()));
	await createApiClient({
		transport: http.transport,
		baseUrl: new URL("http://dytest-hub.example.invalid/"),
	}).getOwnerSettings();
	assert.equal(http.requests[0]?.url, "http://dytest-hub.example.invalid/api/v1/settings");
	for (const value of [
		"ftp://dytest-hub.example.invalid/",
		`${origin}/api/`,
		`${origin}/?DYTEST=query`,
		`${origin}/#DYTEST-fragment`,
		"https://dytest-user@dytest-hub.example.invalid/",
	]) {
		assert.throws(
			() => createApiClient({ transport: fixture.transport, baseUrl: new URL(value) }),
			fixed("CLIENT_INVALID_REQUEST"),
		);
	}
	assert.equal(fixture.requests.length, 1);
});

test("requires the URL brand without consulting input href or coercion hooks", async () => {
	const fixture = fake(() => json(settings()));
	let reads = 0;
	const hostile = () => {
		reads += 1;
		throw new Error("DYTEST URL hook must remain unread");
	};
	for (const baseUrl of [
		{ href: `${origin}/` },
		Object.defineProperty({}, "href", { get: hostile }),
		Object.create(URL.prototype),
		Object.create(URL.prototype, { href: { value: `${origin}/` } }),
		{ toString: hostile, [Symbol.toPrimitive]: hostile },
	]) {
		assert.throws(
			() => createApiClient({ transport: fixture.transport, baseUrl: baseUrl as URL }),
			fixed("CLIENT_INVALID_REQUEST"),
		);
	}
	assert.equal(reads, 0);
	assert.equal(fixture.requests.length, 0);
	const baseUrl = new URL(`${origin}/`);
	Object.defineProperty(baseUrl, "href", { get: hostile });
	await createApiClient({ transport: fixture.transport, baseUrl }).getOwnerSettings();
	assert.equal(reads, 0);
	assert.equal(fixture.requests[0]?.url, `${origin}/api/v1/settings`);
});

test("rejects invalid canonical input before invoking transport", async () => {
	const fixture = clientWith(() => {
		throw new Error("DYTEST should not fetch");
	});
	for (const input of [
		{ ...settings(), zone: "UTC\n" },
		{ ...settings(), DYTEST_extra: true },
		{ ...settings(), workingHours: { days: ["mon", "mon"], start: "09:00", end: "17:00" } },
		{ ...settings(), workingHours: { days: ["mon"], start: "17:00", end: "09:00" } },
	])
		await assert.rejects(fixture.client.putOwnerSettings(input), fixed("CLIENT_INVALID_REQUEST"));
	for (const invalid of ["../DYTEST", "01arz3ndektsv4rrffq69g5fav", `${accountId}\n`, ""]) {
		await assert.rejects(fixture.client.getAccount(invalid), fixed("CLIENT_INVALID_REQUEST"));
		await assert.rejects(fixture.client.pageAccounts(invalid), fixed("CLIENT_INVALID_REQUEST"));
	}
	assert.equal(fixture.requests.length, 0);
});

test("validates direct settings, point-account identity and exact envelope keys", async () => {
	const cases: readonly [Operation, unknown][] = [
		[(client) => client.getOwnerSettings(), { ...settings(), DYTEST_extra: true }],
		[(client) => client.putOwnerSettings(settings()), { ...settings(), zone: "UTC\n" }],
		[(client) => client.getOwnerSettings(), { settings: settings() }],
		[(client) => client.getAccount(accountId), record(101)],
		[(client) => client.getAccount(accountId), { ...record(), generation: 0 }],
		[(client) => client.getAccount(accountId), { ...record(), generation: 1.5 }],
		[
			(client) => client.getAccount(accountId),
			{ ...record(), generation: Number.MAX_SAFE_INTEGER + 1 },
		],
		[(client) => client.getAccount(accountId), { ...record(), DYTEST_extra: true }],
		[
			(client) => client.getAccount(accountId),
			{ account: { ...record().account, DYTEST_extra: true }, generation: 1 },
		],
		[
			(client) => client.getAccount(accountId),
			{
				account: { ...record().account, status: "credential_lost", deletionDeadline: null },
				generation: 1,
			},
		],
		[(client) => client.pageAccounts(), { accounts: [record()], nextId: null, DYTEST_extra: true }],
		[(client) => client.pageAccounts(), { accounts: [record()] }],
		[
			(client) => client.pageAccounts(),
			{ accounts: [{ ...record(), generation: 0 }], nextId: null },
		],
	];
	for (const [operation, value] of cases) {
		const fixture = clientWith(() => json(value));
		await assert.rejects(operation(fixture.client), fixed("CLIENT_INVALID_RESPONSE"));
		assert.equal(fixture.requests.length, 1);
	}
});

test("preserves documented page data without inventing ordering, cursor-last or owner authority rules", async () => {
	const page = { accounts: [record(102), record(101)], nextId: id(999) };
	const fixture = clientWith(() => json(page));
	assert.deepEqual(await fixture.client.pageAccounts(null), page);
	assert.equal(new URL(fixture.requests[0]?.url as string).search, "");
	const hundred = {
		accounts: Array.from({ length: 100 }, (_, index) => record(index + 1)),
		nextId: null,
	};
	assert.deepEqual(await clientWith(() => json(hundred)).client.pageAccounts(), hundred);
	const excessive = { accounts: [...hundred.accounts, record(101)], nextId: null };
	await assert.rejects(
		clientWith(() => json(excessive)).client.pageAccounts(),
		fixed("CLIENT_INVALID_RESPONSE"),
	);
});

test("accepts only native status/code pairs documented for each actual operation", async () => {
	const operations: readonly [Operation, boolean][] = [
		[(client) => client.getOwnerSettings(), true],
		[(client) => client.putOwnerSettings(settings()), false],
		[(client) => client.getAccount(accountId), true],
		[(client) => client.pageAccounts(), false],
	];
	for (const [operation, permitsNotFound] of operations) {
		for (const [status, code] of [
			[400, "INVALID_REQUEST"],
			[403, "FORBIDDEN"],
			[503, "UNAVAILABLE"],
		] as const) {
			await assert.rejects(operation(clientWith(() => json({ code }, status)).client), fixed(code));
		}
		await assert.rejects(
			operation(clientWith(() => json({ code: "NOT_FOUND" }, 404)).client),
			fixed(permitsNotFound ? "NOT_FOUND" : "CLIENT_INVALID_RESPONSE"),
		);
	}
	for (const [status, value] of [
		[400, { code: "FORBIDDEN" }],
		[403, { code: "FORBIDDEN", DYTEST_extra: "private detail" }],
		[503, settings()],
		[500, { code: "UNAVAILABLE" }],
		[201, settings()],
		[200, { code: "FORBIDDEN" }],
	] as const) {
		await assert.rejects(
			clientWith(() => json(value, status)).client.getOwnerSettings(),
			fixed("CLIENT_INVALID_RESPONSE"),
		);
	}
});

test("uses the actual settings and account byte caps on complete valid JSON", async () => {
	for (const [operation, value, maxBytes] of [
		[(client: Client) => client.getOwnerSettings(), settings(), 4096],
		[(client: Client) => client.getAccount(accountId), record(), 1024 * 1024],
	] as const) {
		const encoded = JSON.stringify(value);
		const exact = encoded + " ".repeat(maxBytes - encoder.encode(encoded).length);
		assert.equal(encoder.encode(exact).length, maxBytes);
		assert.deepEqual(
			await operation(
				clientWith(() => new Response(exact, { headers: { "content-type": "application/json" } }))
					.client,
			),
			value,
		);
		await assert.rejects(
			operation(
				clientWith(
					() => new Response(`${exact} `, { headers: { "content-type": "application/json" } }),
				).client,
			),
			fixed("CLIENT_INVALID_RESPONSE"),
		);
	}
});

test("maps malformed JSON, UTF-8, BOM and MIME to a fixed local response error", async () => {
	const valid = JSON.stringify(settings());
	const fixtures = [
		() => new Response('{"DYTEST":', { headers: { "content-type": "application/json" } }),
		() =>
			new Response(Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode(valid)]), {
				headers: { "content-type": "application/json" },
			}),
		() =>
			new Response(Uint8Array.from([...encoder.encode(valid), 0xc3, 0x28]), {
				headers: { "content-type": "application/json" },
			}),
		() => new Response(valid, { headers: { "content-type": "text/plain" } }),
	];
	for (const response of fixtures) {
		await assert.rejects(
			clientWith(response).client.getOwnerSettings(),
			fixed("CLIENT_INVALID_RESPONSE"),
		);
	}
});

test("pre-aborted calls do not invoke transport for any of the four methods", async () => {
	const abort = new AbortController();
	abort.abort(new Error("DYTEST-private-abort-detail"));
	const fixture = clientWith(() => {
		throw new Error("DYTEST should not fetch");
	});
	const options = { signal: abort.signal };
	for (const operation of [
		() => fixture.client.getOwnerSettings(options),
		() => fixture.client.putOwnerSettings(settings(), options),
		() => fixture.client.getAccount(accountId, options),
		() => fixture.client.pageAccounts(null, options),
	])
		await assert.rejects(operation(), fixed("CLIENT_ABORTED"));
	assert.equal(fixture.requests.length, 0);
});

test("propagates the real abort signal to Request and uses actual signal state for transport failure", async () => {
	const abort = new AbortController();
	let requestSignal: AbortSignal | undefined;
	const fixture = clientWith((request) => {
		requestSignal = request.signal;
		assert.equal(request.signal.aborted, false);
		abort.abort(new Error("DYTEST-private-abort-detail"));
		assert.equal(request.signal.aborted, true);
		throw new Error("DYTEST-transport-private-detail");
	});
	await assert.rejects(
		fixture.client.getOwnerSettings({ signal: abort.signal }),
		fixed("CLIENT_ABORTED"),
	);
	assert.ok(requestSignal instanceof AbortSignal);
	assert.equal(requestSignal.aborted, true);
	assert.equal(fixture.requests.length, 1);
});

test("an abort-ignoring transport's returned body is cancelled and joined before rejection", async () => {
	const abort = new AbortController();
	let finishCancel!: () => void;
	const cleanup = new Promise<void>((resolve) => {
		finishCancel = resolve;
	});
	let markCancel!: () => void;
	const entered = new Promise<void>((resolve) => {
		markCancel = resolve;
	});
	let pulls = 0;
	let cancels = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull() {
				pulls += 1;
			},
			cancel() {
				cancels += 1;
				markCancel();
				return cleanup;
			},
		},
		{ highWaterMark: 0 },
	);
	const fixture = clientWith(() => {
		abort.abort();
		return new Response(stream, { headers: { "content-type": "application/json" } });
	});
	const operation = fixture.client.getOwnerSettings({ signal: abort.signal });
	let settled = false;
	void operation.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await entered;
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
	assert.equal(settled, false);
	assert.equal(pulls, 0);
	assert.equal(cancels, 1);
	assert.equal(stream.locked, true);
	finishCancel();
	await assert.rejects(operation, fixed("CLIENT_ABORTED"));
	assert.equal(cancels, 1);
	assert.equal(stream.locked, false);
});

test("opaque hostile transport rejections cannot supply a native code or invoke traps", async () => {
	let prototypes = 0;
	let getters = 0;
	const reasons: unknown[] = [
		new Proxy(
			{},
			{
				getPrototypeOf() {
					prototypes += 1;
					throw new Error("DYTEST-prototype-private-detail");
				},
				get() {
					getters += 1;
					throw new Error("DYTEST-getter-private-detail");
				},
			},
		),
		Object.create(ApiClientError.prototype, {
			code: {
				get() {
					getters += 1;
					throw new Error("DYTEST-code-private-detail");
				},
			},
		}),
		Object.create(ApiClientError.prototype, { code: { value: "FORBIDDEN" } }),
	];
	for (const reason of reasons) {
		const fixture = clientWith(() => Promise.reject(reason));
		let fulfilled = false;
		let refusal: unknown;
		try {
			await fixture.client.getOwnerSettings();
			fulfilled = true;
		} catch (error) {
			refusal = error;
		}
		assert.equal(fulfilled, false);
		assert.equal(refusal === reason, false);
		assert.equal(prototypes, 0);
		assert.equal(getters, 0);
		fixed("CLIENT_UNAVAILABLE")(refusal);
		assert.equal(fixture.requests.length, 1);
	}
});

test("rejects overflowed raw account values before JSON normalization can rehabilitate them", async () => {
	const expected = record();
	assert.equal(expected.account.status, "active");
	assert.equal(expected.account.deletionDeadline, null);
	const original = JSON.stringify(expected);
	const marker = '"deletionDeadline":null';
	assert.equal(original.split(marker).length - 1, 1);
	const raw = original.replace(marker, '"deletionDeadline":1e999');
	const inflated = JSON.parse(raw);
	assert.equal(inflated.account.deletionDeadline, Infinity);
	assert.equal(Account.safeParse(inflated.account).success, false);
	const normalized = JSON.parse(JSON.stringify(inflated));
	assert.deepEqual(normalized, expected);
	assert.deepEqual(Account.parse(normalized.account), expected.account);

	const fixture = clientWith(
		() =>
			new Response(raw, {
				headers: { "content-type": "application/json" },
			}),
	);
	await assert.rejects(fixture.client.getAccount(accountId), fixed("CLIENT_INVALID_RESPONSE"));
	assert.equal(fixture.requests.length, 1);
});
