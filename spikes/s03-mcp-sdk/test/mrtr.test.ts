import { readFileSync } from "node:fs";
import { writeEvidence } from "@draftyak/spike-kit";
import {
	type AuthInfo,
	CLIENT_CAPABILITIES_META_KEY,
	createMcpHandler,
} from "@modelcontextprotocol/server";
import fc from "fast-check";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	type RunnerTask,
	vi,
} from "vitest";
import {
	canonicalJson,
	MAX_OPEN_PER_PRINCIPAL,
	paramsDigest,
	STATE_KEY_LABEL,
	STATE_TTL_SECONDS,
} from "../src/elicit.ts";
import { createHub, GUIDE_URI, type Hub, sessionKey } from "../src/resources.ts";
import { createApp, surfaceFactory } from "../src/server.ts";
import { type Fetcher, legacy, modern, type Served, serve } from "./harness.ts";

const ulid = (n: number): string => `01J${String(n).padStart(23, "0")}`;
const [CONVERSATION, MESSAGE] = [ulid(1), ulid(2)];
const MESSAGE_URI = `draftyak://message/${MESSAGE}`;
const CONVERSATION_URI = `draftyak://conversation/${CONVERSATION}`;
const BASE_URL = "https://hub.example.net";
const FORM = { elicitation: { form: {} } };
const URL_MODE = { elicitation: { url: {} } };
const BOTH = { elicitation: { form: {}, url: {} } };
const INVALID_STATE = {
	code: -32602,
	message: "Invalid or expired requestState",
	data: { reason: "invalid_request_state" },
};
// Every test principal is a grant of one OAuth client: binding must go by grant, never by client.
const CLIENT = "shared-client";
const STUB = "token:stub-agent";

function newHub(): Hub {
	const aliases = ["gmail-1", "slack-1"];
	return createHub({
		aliases: {
			"grant:alice": aliases,
			"grant:bob": aliases,
			[STUB]: aliases,
			"grant:solo": ["gmail-1"],
		},
		items: {
			[CONVERSATION]: { kind: "conversation", account: "gmail-1", text: "conversation text" },
			[MESSAGE]: { kind: "message", account: "gmail-1", text: "message text" },
		},
		publicBaseUrl: BASE_URL,
	});
}

function principal(hub: Hub, grant: string): Fetcher {
	const handler = createMcpHandler(surfaceFactory(hub), { legacy: "reject", responseMode: "json" });
	const authInfo: AuthInfo = {
		token: `token-of-${grant}`,
		clientId: CLIENT,
		scopes: ["inbox:read"],
		extra: { grantId: grant },
	};
	return { fetch: (request) => handler.fetch(request, { authInfo }) };
}

type Params = Record<string, unknown>;
interface Round {
	readonly method: string;
	readonly params: Params;
	readonly capabilities: Record<string, unknown>;
}
const TRIAGE: Round = {
	method: "prompts/get",
	params: { name: "triage_inbox", arguments: {} },
	capabilities: FORM,
};
const READ: Round = {
	method: "resources/read",
	params: { uri: MESSAGE_URI },
	capabilities: URL_MODE,
};

let nextId = 1;
const send = (target: Fetcher, round: Round, extra: Params = {}): Promise<Served> =>
	serve(
		target,
		modern(
			round.method,
			{ ...round.params, ...extra },
			{
				capabilities: round.capabilities,
				id: nextId++,
			},
		),
	);

// The first round: an InputRequiredResult and its state.
async function opened(target: Fetcher, round: Round): Promise<string> {
	const response = await send(target, round);
	expect(response.body.result.resultType).toBe("input_required");
	return response.body.result.requestState;
}

const ACCEPT_URL = { session: { action: "accept" } };
const accept = (account: string) => ({ account: { action: "accept", content: { account } } });
const textOf = (response: Served): string => response.body.result.messages[0].content.text;

// Evidence: every planned case's outcome, written only when asked (DRAFTYAK_RECORD_EVIDENCE=1) or in
// CI, and only when every test in this file ran and passed (never from a filtered or failing run).
function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (!["", "0", "1"].includes(value)) {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1" || (value === "" && !!env.CI);
}
const NEGATIVE = [
	"tampered-payload",
	"tampered-mac",
	"non-canonical-mac",
	"malformed",
	"forged-key",
	"replayed",
	"expired",
	"cross-principal",
	"params-swapped",
	"method-swapped",
	"other-prompt",
	"other-resource",
	"tool-call",
	"legacy-retry",
	"wrong-epoch",
] as const;
const FLOWS = [
	"account-form",
	"account-form-answered",
	"session-url",
	"auto-accept",
	"approved-between-rounds",
	"undeclared-mode",
	"pending-limit",
	"legacy-era",
	"capability-check",
] as const;
type Case = (typeof NEGATIVE)[number] | (typeof FLOWS)[number];
const observed = new Map<Case, Record<string, unknown>>();

// A case's outcome reaches the evidence only once the test that observed it has passed.
function record(name: Case, outcome: Record<string, unknown>): void {
	onTestFinished(({ task }) => {
		if (task.result?.state === "pass") observed.set(name, outcome);
	});
}
function observe(name: Case, response: Served): void {
	const { result, error } = response.body;
	record(name, {
		httpStatus: response.status,
		resultType: result?.resultType ?? (result ? "complete" : null),
		errorCode: error?.code ?? null,
		errorMessage: error?.message ?? null,
		reason: error?.data?.reason ?? error?.data?.code ?? null,
		contentReturned: Array.isArray(result?.contents) || Array.isArray(result?.messages),
	});
}

const testsIn = (suite: { readonly tasks: readonly RunnerTask[] }): RunnerTask[] =>
	suite.tasks.flatMap((task) => (task.type === "suite" ? testsIn(task) : [task]));
let thisFile: { readonly tasks: readonly RunnerTask[] } | undefined;
beforeEach(({ task }) => {
	thisFile = task.file;
});

afterAll(async () => {
	if (!recording()) return;
	const unpassed = testsIn(thisFile ?? { tasks: [] }).filter(
		(task) => task.result?.state !== "pass",
	);
	const missing = [...NEGATIVE, ...FLOWS].filter((name) => !observed.has(name));
	if (unpassed.length > 0 || missing.length > 0) {
		const why = unpassed.length > 0 ? `${unpassed.length} test(s) not run or not passed` : "";
		console.log(`evidence not recorded: ${why || `no passing case for ${missing.join(", ")}`}`);
		return;
	}
	const sdk = JSON.parse(
		readFileSync(
			new URL("../node_modules/@modelcontextprotocol/server/package.json", import.meta.url),
			"utf8",
		),
	).version;
	const written = await writeEvidence(new URL("../evidence/mrtr.json", import.meta.url), {
		serverSdkVersion: sdk,
		codec: {
			mac: "HMAC-SHA256 (createRequestStateCodec), canonical base64url MAC only",
			keyDerivation: `HKDF-SHA256 over the master key, info ${STATE_KEY_LABEL}`,
			ttlSeconds: STATE_TTL_SECONDS,
			bind: ["principal", "method", "epoch"],
			payloadFields: ["v", "epoch", "principal", "method", "digest", "pendingId", "exp"],
			principal: "the grant or agent token id (grant:<id> or token:<id>), never the OAuth client",
			digest: "SHA-256 of JCS(params as sent) without _meta, requestState and inputResponses",
			checkedIn: "ServerOptions.requestState.verify, before any handler, for every MRTR method",
		},
		openPendingPerPrincipal: MAX_OPEN_PER_PRINCIPAL,
		negativeCases: Object.fromEntries(NEGATIVE.map((name) => [name, observed.get(name)])),
		flows: Object.fromEntries(FLOWS.map((name) => [name, observed.get(name)])),
	});
	console.log(`evidence: ${written}`);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the account form (prompts/get triage_inbox)", () => {
	it("asks once, with a form of the allowlisted aliases, when the request declares form mode", async () => {
		const alice = principal(newHub(), "alice");
		const response = await send(alice, TRIAGE);
		const { inputRequests, requestState, ttlMs, cacheScope } = response.body.result;
		expect([ttlMs, cacheScope]).toEqual([undefined, undefined]);
		expect(inputRequests).toEqual({
			account: {
				method: "elicitation/create",
				params: {
					mode: "form",
					message: "Which account should the triage cover?",
					requestedSchema: {
						$schema: "https://json-schema.org/draft/2020-12/schema",
						type: "object",
						properties: {
							account: { type: "string", description: "Account", enum: ["gmail-1", "slack-1"] },
						},
						required: ["account"],
					},
				},
			},
		});
		// Signed, not encrypted: the client can read the payload, which holds ids only.
		const payload = JSON.parse(Buffer.from(requestState.split(".")[1], "base64url").toString()).p;
		expect(Object.keys(payload).toSorted()).toEqual(
			["digest", "epoch", "exp", "method", "pendingId", "principal", "v"].toSorted(),
		);
		expect(payload).toMatchObject({
			v: 1,
			epoch: 1,
			principal: "grant:alice",
			method: "prompts/get",
		});
		expect(payload.digest).toBe(paramsDigest(TRIAGE.params));
		observe("account-form", response);
	});

	it("renders for the chosen account, re-checked against the allowlist; anything else renders for all", async () => {
		const hub = newHub();
		const alice = principal(hub, "alice");
		const answered = await send(alice, TRIAGE, {
			requestState: await opened(alice, TRIAGE),
			inputResponses: accept("slack-1"),
		});
		expect(textOf(answered)).toContain("in the account slack-1.");
		for (const inputResponses of [
			accept("sms-9"),
			accept("GMAIL-1"),
			{ account: { action: "decline" } },
			{ account: { action: "cancel" } },
			{},
		]) {
			const retry = await send(alice, TRIAGE, {
				requestState: await opened(alice, TRIAGE),
				inputResponses,
			});
			expect(textOf(retry)).toContain("in every account you can read");
		}
		observe("account-form-answered", answered);
	});

	it("doesn't ask with fewer than two accounts, or once the account is an argument", async () => {
		const hub = newHub();
		const solo = await send(principal(hub, "solo"), TRIAGE);
		expect(textOf(solo)).toContain("in every account you can read");
		const named = await send(principal(hub, "alice"), {
			...TRIAGE,
			params: { name: "triage_inbox", arguments: { account: "gmail-1" } },
		});
		expect(textOf(named)).toContain("in the account gmail-1.");
	});
});

describe("the session-pending URL (resources/read)", () => {
	it("points at the fixed, static /status URL, the same for every principal and request", async () => {
		const hub = newHub();
		const responses = [];
		for (const who of ["alice", "bob", "alice"]) {
			const response = await send(principal(hub, who), READ);
			expect(response.body.result.resultType).toBe("input_required");
			expect([response.body.result.ttlMs, response.body.result.cacheScope]).toEqual([
				undefined,
				undefined,
			]);
			responses.push(response);
		}
		const prompts = responses.map((response) => response.body.result.inputRequests);
		expect(prompts[0]).toEqual({
			session: {
				method: "elicitation/create",
				params: {
					mode: "url",
					message:
						"Approve the agent session for gmail-1 (read) on your paired desktop, then continue",
					url: `${BASE_URL}/status`,
				},
			},
		});
		expect(new Set(prompts.map((p) => JSON.stringify(p))).size).toBe(1);
		// One device prompt per principal, account and tool class, however often it's read.
		expect(hub.devicePrompts).toEqual([
			sessionKey("grant:alice", "gmail-1", "read"),
			sessionKey("grant:bob", "gmail-1", "read"),
		]);
		observe("session-url", responses[1] as Served);
	});

	it("gives an auto-accepting client nothing: the retry ends in 1001 and the state is spent", async () => {
		const hub = newHub();
		const alice = principal(hub, "alice");
		const requestState = await opened(alice, READ);
		const retry = await send(alice, READ, { requestState, inputResponses: ACCEPT_URL });
		expect(retry.body.error).toEqual({
			code: 1001,
			message:
				"Approve an agent session for gmail-1 (read) on your paired desktop (DraftYak › AI apps › Sessions), then retry.",
			data: { code: "AGENT_SESSION_REQUIRED" },
		});
		expect(hub.sessions.size).toBe(0);
		const again = await send(alice, READ, { requestState, inputResponses: ACCEPT_URL });
		expect(again.body.error).toEqual(INVALID_STATE);
		observe("auto-accept", retry);
	});

	it("serves the read on the retry once the owner approved the session in between", async () => {
		const hub = newHub();
		const alice = principal(hub, "alice");
		const requestState = await opened(alice, READ);
		hub.sessions.add(sessionKey("grant:alice", "gmail-1", "read"));
		const retry = await send(alice, READ, { requestState, inputResponses: ACCEPT_URL });
		expect(retry.body.result.contents[0].text).toContain('"message text"');
		observe("approved-between-rounds", retry);
	});

	it("gives the readable 1001 when L3 is off", async () => {
		const hub = createHub({
			aliases: { "grant:alice": ["gmail-1"] },
			items: { [MESSAGE]: { kind: "message", account: "gmail-1", text: "x" } },
		});
		const response = await send(principal(hub, "alice"), READ);
		expect(response.body.error.code).toBe(1001);
	});
});

describe("refused states: tampered, replayed, expired, rebound, swapped, misdirected, wrong epoch", () => {
	const refused = async (name: Case, target: Fetcher, round: Round, requestState: string) => {
		const response = await send(target, round, { requestState, inputResponses: ACCEPT_URL });
		expect(response.body.error).toEqual(INVALID_STATE);
		expect(response.body.result).toBeUndefined();
		observe(name, response);
	};
	const flip = (text: string, at: number): string =>
		text.slice(0, at) + (text[at] === "A" ? "B" : "A") + text.slice(at + 1);
	const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

	it("refuses a changed payload, a changed MAC, a malformed state and one signed with another key", async () => {
		const hub = newHub();
		const alice = principal(hub, "alice");
		const state = await opened(alice, READ);
		const [prefix, body, mac] = state.split(".") as [string, string, string];
		await refused("tampered-payload", alice, READ, `${prefix}.${flip(body, 20)}.${mac}`);
		await refused("tampered-mac", alice, READ, `${prefix}.${body}.${flip(mac, 5)}`);
		await refused("malformed", alice, READ, "not-a-request-state");
		const elsewhere = principal(newHub(), "alice");
		await refused("forged-key", alice, READ, await opened(elsewhere, READ));
	});

	it("refuses another spelling of the same MAC, which the SDK's decoder alone would accept", async () => {
		const hub = newHub();
		const alice = principal(hub, "alice");
		const state = await opened(alice, TRIAGE);
		const last = state.at(-1) ?? "";
		// The MAC's last base64url digit carries 4 bits of the MAC and 2 spare bits.
		const respelled = state.slice(0, -1) + (B64URL[B64URL.indexOf(last) ^ 1] ?? "");
		const mac = (text: string) => Buffer.from(text.slice(text.lastIndexOf(".") + 1), "base64url");
		expect(mac(respelled).equals(mac(state))).toBe(true);
		await refused("non-canonical-mac", alice, TRIAGE, respelled);
		const answered = await send(alice, TRIAGE, {
			requestState: state,
			inputResponses: accept("gmail-1"),
		});
		expect(textOf(answered)).toContain("in the account gmail-1.");
	});

	it("refuses a state used twice", async () => {
		const hub = newHub();
		const alice = principal(hub, "alice");
		const state = await opened(alice, TRIAGE);
		const first = await send(alice, TRIAGE, {
			requestState: state,
			inputResponses: accept("gmail-1"),
		});
		expect(textOf(first)).toContain("in the account gmail-1.");
		await refused("replayed", alice, TRIAGE, state);
	});

	it("refuses a state after its 600 s TTL", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
		const hub = newHub();
		const alice = principal(hub, "alice");
		const state = await opened(alice, READ);
		vi.setSystemTime(new Date("2026-10-17T12:10:00Z"));
		const inTime = await send(alice, READ, { requestState: state, inputResponses: ACCEPT_URL });
		expect(inTime.body.error.code).toBe(1001);
		const late = await opened(alice, READ);
		vi.setSystemTime(new Date("2026-10-17T12:20:01Z"));
		await refused("expired", alice, READ, late);
	});

	it("refuses another grant's state, though both grants belong to one OAuth client", async () => {
		const hub = newHub();
		const state = await opened(principal(hub, "alice"), READ);
		await refused("cross-principal", principal(hub, "bob"), READ, state);
	});

	it("refuses a state on other params or another method", async () => {
		const hub = newHub();
		const alice = principal(hub, "alice");
		const other: Round = { ...READ, params: { uri: CONVERSATION_URI } };
		await refused("params-swapped", alice, other, await opened(alice, READ));
		const week = { ...TRIAGE, params: { name: "triage_inbox", arguments: { window: "7d" } } };
		const swapped = await send(alice, week, {
			requestState: await opened(alice, TRIAGE),
			inputResponses: accept("gmail-1"),
		});
		expect(swapped.body.error).toEqual(INVALID_STATE);
		await refused(
			"method-swapped",
			alice,
			{ ...READ, capabilities: BOTH },
			await opened(alice, TRIAGE),
		);
	});

	it("refuses a state on another prompt, the guide or a tool, and spends it there", async () => {
		const hub = newHub();
		const alice = principal(hub, "alice");
		const triageState = await opened(alice, TRIAGE);
		const summary: Round = { ...TRIAGE, params: { name: "summarize_thread", arguments: {} } };
		await refused("other-prompt", alice, summary, triageState);
		expect(
			(await send(alice, TRIAGE, { requestState: triageState, inputResponses: accept("gmail-1") }))
				.body.error,
		).toEqual(INVALID_STATE);
		const readState = await opened(alice, READ);
		await refused("other-resource", alice, { ...READ, params: { uri: GUIDE_URI } }, readState);
		expect((await send(alice, READ, { requestState: readState })).body.error).toEqual(
			INVALID_STATE,
		);
		const tool: Round = {
			method: "tools/call",
			params: { name: "accounts_list", arguments: {} },
			capabilities: BOTH,
		};
		await refused("tool-call", alice, tool, await opened(alice, TRIAGE));
	});

	it("refuses a 2026-era state retried on the 2025-era leg", async () => {
		const app = createApp({ hub: newHub() });
		const first = await serve(app, modern("prompts/get", TRIAGE.params, { capabilities: FORM }));
		const requestState = first.body.result.requestState;
		const retry = await serve(
			app,
			legacy("prompts/get", { ...TRIAGE.params, requestState, inputResponses: accept("gmail-1") }),
		);
		expect(retry.body.error).toEqual(INVALID_STATE);
		observe("legacy-retry", retry);
	});

	it("refuses a state from before an epoch change", async () => {
		const hub = newHub();
		const alice = principal(hub, "alice");
		const state = await opened(alice, READ);
		hub.mrtr.epoch += 1;
		await refused("wrong-epoch", alice, READ, state);
	});
});

describe("the per-request capability check (-32021 never reaches the client)", () => {
	it("asks only in a mode the request declares, and otherwise falls back readably (fast-check)", async () => {
		const present = fc.oneof(fc.constant({}), fc.record({ applyDefaults: fc.boolean() }));
		const modes = fc.record(
			{ form: present, url: fc.constant({}), extra: fc.constant({}) },
			{ requiredKeys: [] },
		);
		const declared = fc.oneof(
			fc.constant({}),
			fc.record({ sampling: fc.constant({}) }),
			fc.record({ roots: fc.constant({}) }),
			fc.record({ elicitation: modes }),
			fc.record({ elicitation: modes, sampling: fc.constant({}) }),
		);
		const alice = principal(newHub(), "alice");
		const tally = { runs: 0, inputRequired: 0, fallbacks: 0, missingCapabilityErrors: 0 };
		await fc.assert(
			fc.asyncProperty(declared, fc.boolean(), async (capabilities, reading) => {
				const round = { ...(reading ? READ : TRIAGE), capabilities };
				const response = await send(alice, round);
				tally.runs += 1;
				if (response.body.error?.code === -32021) tally.missingCapabilityErrors += 1;
				const elicitation = (capabilities as { elicitation?: Record<string, unknown> }).elicitation;
				const form =
					!!elicitation && (elicitation.form !== undefined || elicitation.url === undefined);
				const url = elicitation?.url !== undefined;
				const asked = response.body.result?.resultType === "input_required";
				expect(response.status).toBe(200);
				expect(response.body.error?.code).not.toBe(-32021);
				expect(asked).toBe(reading ? url : form);
				if (!asked && reading) expect(response.body.error.code).toBe(1001);
				if (!asked && !reading) expect(textOf(response)).toContain("in every account you can read");
				tally[asked ? "inputRequired" : "fallbacks"] += 1;
				// Spend the state, so the open pendingIds never reach the limit.
				if (asked) await send(alice, round, { requestState: response.body.result.requestState });
			}),
			{ numRuns: 120 },
		);
		record("capability-check", tally);
	});

	it("leaves a malformed declaration to the SDK's envelope check, which answers -32602, not -32021", async () => {
		const alice = principal(newHub(), "alice");
		for (const elicitation of [true, [], "form", { form: null }]) {
			const response = await send(alice, { ...READ, capabilities: { elicitation } });
			expect(response.body.error.code).toBe(-32602);
		}
	});

	it("falls back without a declaration: the read gets 1001, the triage renders for every account", async () => {
		const alice = principal(newHub(), "alice");
		const read = await send(alice, { ...READ, capabilities: FORM });
		expect(read.body.error.code).toBe(1001);
		expect(textOf(await send(alice, { ...TRIAGE, capabilities: URL_MODE }))).toContain(
			"in every account you can read",
		);
		observe("undeclared-mode", read);
	});
});

describe("open pendingIds", () => {
	it("holds at most 5 per principal; further requests fall back until one is spent or expires", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
		const hub = newHub();
		const alice = principal(hub, "alice");
		const states = [];
		for (let n = 0; n < 5; n++) states.push(await opened(alice, TRIAGE));
		const sixth = await send(alice, TRIAGE);
		expect(textOf(sixth)).toContain("in every account you can read");
		const blockedRead = await send(alice, READ);
		expect(blockedRead.body.error.code).toBe(1001);
		expect((await send(principal(hub, "bob"), TRIAGE)).body.result.resultType).toBe(
			"input_required",
		);
		await send(alice, TRIAGE, { requestState: states[0], inputResponses: accept("gmail-1") });
		expect((await send(alice, TRIAGE)).body.result.resultType).toBe("input_required");
		expect((await send(alice, TRIAGE)).body.result.messages).toBeDefined();
		vi.setSystemTime(new Date("2026-10-17T12:10:01Z"));
		expect((await send(alice, TRIAGE)).body.result.resultType).toBe("input_required");
		observe("pending-limit", blockedRead);
	});
});

describe("2025-era requests never elicit, and the SDK's legacy shim never runs", () => {
	const app = createApp({ hub: newHub() });
	const claims = {
		_meta: { [CLIENT_CAPABILITIES_META_KEY]: BOTH },
	};

	it("renders triage_inbox for every account and answers a pending session read with 1001", async () => {
		let claimed: Served | undefined;
		for (const extra of [{}, claims]) {
			const triage = await serve(app, legacy("prompts/get", { ...TRIAGE.params, ...extra }));
			expect([triage.status, triage.headers.get("content-type")]).toEqual([
				200,
				"application/json",
			]);
			expect(textOf(triage)).toContain("in every account you can read");
			const read = await serve(app, legacy("resources/read", { uri: MESSAGE_URI, ...extra }));
			expect(read.body.error.code).toBe(1001);
			expect(JSON.stringify([triage.body, read.body])).not.toContain("elicitation/create");
			if (extra === claims) claimed = read;
		}
		observe("legacy-era", claimed as Served);
	});

	it("serves the same 2026-era round trip through the hub's middleware, headers included", async () => {
		const hubApp = createApp({ hub: newHub() });
		const first = await serve(hubApp, modern("prompts/get", TRIAGE.params, { capabilities: FORM }));
		expect(first.body.result.resultType).toBe("input_required");
		const payload = JSON.parse(
			Buffer.from(first.body.result.requestState.split(".")[1], "base64url").toString(),
		).p;
		expect(payload.principal).toBe(STUB);
		const retry = await serve(
			hubApp,
			modern(
				"prompts/get",
				{
					...TRIAGE.params,
					requestState: first.body.result.requestState,
					inputResponses: accept("gmail-1"),
				},
				{ capabilities: FORM, id: 2 },
			),
		);
		expect(textOf(retry)).toContain("in the account gmail-1.");
	});
});

describe("the params digest (JCS)", () => {
	it("canonicalizes as RFC 8785 does", () => {
		expect(canonicalJson({ b: 1, a: [1, "x", null, true], c: { z: 1, y: 2 } })).toBe(
			'{"a":[1,"x",null,true],"b":1,"c":{"y":2,"z":1}}',
		);
		expect(canonicalJson([1e21, 0.000001, 1e-7, -0, 333333333.3333333])).toBe(
			"[1e+21,0.000001,1e-7,0,333333333.3333333]",
		);
		expect(canonicalJson({ "€": 1, "\r": 2, "1": 3, "😀": 4, a: 5 })).toBe(
			'{"\\r":2,"1":3,"a":5,"€":1,"😀":4}',
		);
		expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
	});

	it("leaves out _meta, requestState and inputResponses, and ignores key order", () => {
		const params = { name: "triage_inbox", arguments: { window: "7d", account: "gmail-1" } };
		expect(
			paramsDigest({
				arguments: { account: "gmail-1", window: "7d" },
				_meta: { progressToken: 1 },
				requestState: "v1.x.y",
				inputResponses: { account: { action: "accept" } },
				name: "triage_inbox",
			}),
		).toBe(paramsDigest(params));
		expect(paramsDigest({ ...params, arguments: { window: "24h" } })).not.toBe(
			paramsDigest(params),
		);
		expect(paramsDigest({ name: "triage_inbox" })).not.toBe(
			paramsDigest({ name: "triage_inbox", arguments: {} }),
		);
	});
});
