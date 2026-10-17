import { readFileSync } from "node:fs";
import { writeEvidence } from "@draftyak/spike-kit";
import {
	MAX_OPEN_PER_PRINCIPAL,
	paramsDigest,
	STATE_TTL_SECONDS,
} from "@draftyak/spike-s03-mcp-sdk/src/elicit.ts";
import {
	createHub,
	GUIDE_URI,
	type Hub,
	sessionKey,
} from "@draftyak/spike-s03-mcp-sdk/src/resources.ts";
import { createApp } from "@draftyak/spike-s03-mcp-sdk/src/server.ts";
import { legacy, modern, serve } from "@draftyak/spike-s03-mcp-sdk/test/harness.ts";
import {
	Client,
	DEFAULT_REQUEST_TIMEOUT_MSEC,
	type ElicitRequest,
	type ElicitResult,
	SdkError,
	SdkErrorCode,
} from "@modelcontextprotocol/client";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	type ClientCapabilities,
	InMemoryTransport,
	type JSONRPCMessage,
	PROTOCOL_VERSION_META_KEY,
	ProtocolError,
	type RequestId,
} from "@modelcontextprotocol/server";
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
	ANSWER_TIMEOUT_MS,
	DISCOVER_TIMEOUT_MS,
	EXPIRED,
	LEGACY_VERSIONS,
	MAX_NAME_LENGTH,
	MAX_ROUNDS,
	MODERN,
	STATE_TTL_MS,
	startBridge,
} from "../src/bridge.ts";

type Json = Record<string, unknown>;
type Answer = (
	params: ElicitRequest["params"],
	signal: AbortSignal,
) => ElicitResult | Promise<ElicitResult>;

const TOKEN = "bridge-test-agent-token";
const HUB_URL = "http://127.0.0.1:47613/mcp";
const HUB_DOWN = "The DraftYak hub isn't answering; check that it is running.";
const ulid = (n: number): string => `01J${String(n).padStart(23, "0")}`;
const [CONVERSATION, MESSAGE, MISSING] = [ulid(1), ulid(2), ulid(9)];
const MESSAGE_URI = `draftyak://message/${MESSAGE}`;
const BASE_URL = "https://hub.example.net";
// The principal s03's stub middleware names for the bridge's agent token.
const PRINCIPAL = "token:stub-agent";
const FORM = { elicitation: { form: {} } };
const URL_MODE = { elicitation: { url: {} } };
// What every relayed request declares besides elicitation: §6 gives the 2025 path _meta.ui always.
const UI = { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } };
const TRIAGE = { name: "triage_inbox", arguments: {} };
const T0 = new Date("2026-10-17T12:00:00Z");

function newHub(): Hub {
	return createHub({
		aliases: { [PRINCIPAL]: ["gmail-1", "slack-1"] },
		items: {
			[CONVERSATION]: { kind: "conversation", account: "gmail-1", text: "conversation text" },
			[MESSAGE]: { kind: "message", account: "gmail-1", text: "message text" },
		},
		publicBaseUrl: BASE_URL,
	});
}

interface Sent {
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Json;
}

// The hub's own Hono app, in memory, behind a fetch that records what the bridge sends it. A socket
// would set Host; here it is added from the URL.
function hubFetch(hub: Hub, seen: Sent[]): (request: Request) => Promise<Response> {
	const app = createApp({ hub, token: TOKEN });
	return async (request) => {
		seen.push({ headers: Object.fromEntries(request.headers), body: await request.clone().json() });
		const headers = new Headers(request.headers);
		headers.set("host", new URL(request.url).host);
		return app.fetch(new Request(request, { headers }));
	};
}

interface Wiring {
	readonly hub?: Hub;
	readonly revision?: string;
	readonly capabilities?: ClientCapabilities;
	readonly answer?: Answer;
	readonly maxRounds?: number;
	readonly fetch?: (request: Request) => Promise<Response>;
}

interface Wired {
	readonly client: Client;
	readonly seen: Sent[];
	readonly dialogs: ElicitRequest["params"][];
}

// A 2025 client (the SDK's Client in its default 2025 mode) talking to the bridge, which talks to the hub.
async function wire(options: Wiring = {}): Promise<Wired> {
	const seen: Sent[] = [];
	const [bridgeSide, clientSide] = InMemoryTransport.createLinkedPair();
	const fetch = options.fetch ?? hubFetch(options.hub ?? newHub(), seen);
	await startBridge(bridgeSide, {
		hub: { url: HUB_URL, token: TOKEN, fetch },
		...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
	});
	const capabilities = options.capabilities ?? {};
	const client = new Client(
		{ name: "fake-2025-client", version: "1.0.0" },
		{ capabilities, supportedProtocolVersions: [options.revision ?? "2025-11-25"] },
	);
	const dialogs: ElicitRequest["params"][] = [];
	if (capabilities.elicitation) {
		client.setRequestHandler("elicitation/create", async ({ params }, ctx) => {
			const { _meta, ...shown } = params;
			dialogs.push(shown as ElicitRequest["params"]);
			return (await options.answer?.(params, ctx.mcpReq.signal)) ?? { action: "decline" };
		});
	}
	await client.connect(clientSide);
	onTestFinished(() => client.close());
	return { client, seen, dialogs };
}

const accept =
	(account: string): Answer =>
	() => ({ action: "accept", content: { account } });
const textOf = (result: { messages: { content: unknown }[] }): string =>
	String((result.messages[0]?.content as { text?: unknown } | undefined)?.text);
const errorOf = async (pending: Promise<unknown>): Promise<ProtocolError> => {
	const error = await pending.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	if (!(error instanceof ProtocolError)) throw new Error(`expected a ProtocolError, got ${error}`);
	return error;
};
const paramsOf = (sent: Sent | undefined): Json => (sent?.body.params ?? {}) as Json;
const envelopeOf = (sent: Sent): Json => (paramsOf(sent)._meta ?? {}) as Json;
const asked = (seen: Sent[], method: string): Sent[] =>
	seen.filter((sent) => sent.body.method === method);

// Evidence: written only when asked (DRAFTYAK_RECORD_EVIDENCE=1) or in CI, and only when every test
// in this file ran and passed, never from a filtered or failing run.
function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (!["", "0", "1"].includes(value)) {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1" || (value === "" && !!env.CI);
}
const SECTIONS = [
	"accountForm",
	"answerRechecked",
	"approvalDelay",
	"dialogTimeout",
	"abandonedDialogs",
	"maxRounds",
	"retries",
	"capabilityPassThrough",
	"eras",
	"parity",
	"injectedState",
	"headers",
	"hubErrors",
] as const;
type Section = (typeof SECTIONS)[number];
const observed = new Map<Section, unknown[]>();

// Outcomes reach the evidence, in the order observed, only once the test that observed them passed.
let batch: [Section, Json][] | undefined;
function record(section: Section, outcome: Json): void {
	if (batch === undefined) {
		const mine: [Section, Json][] = [];
		batch = mine;
		onTestFinished(({ task }) => {
			if (task.result?.state !== "pass") return;
			for (const [name, item] of mine) observed.set(name, [...(observed.get(name) ?? []), item]);
		});
	}
	batch.push([section, outcome]);
}

const testsIn = (suite: { readonly tasks: readonly RunnerTask[] }): RunnerTask[] =>
	suite.tasks.flatMap((task) => (task.type === "suite" ? testsIn(task) : [task]));
let thisFile: { readonly tasks: readonly RunnerTask[] } | undefined;
beforeEach(({ task }) => {
	thisFile = task.file;
	batch = undefined;
});

const versionOf = (name: string): string =>
	JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8"))
		.version;

// The two client request timeouts the delay cases use: the SDK client's default, and one longer than
// the state's life.
const LONG_TIMEOUT_MS = 2 * STATE_TTL_MS;

afterAll(async () => {
	if (!recording()) return;
	const unpassed = testsIn(thisFile ?? { tasks: [] }).filter(
		(task) => task.result?.state !== "pass",
	);
	const missing = SECTIONS.filter((name) => !observed.has(name));
	if (unpassed.length > 0 || missing.length > 0) {
		const why = unpassed.length > 0 ? `${unpassed.length} test(s) not run or not passed` : "";
		console.log(`evidence not recorded: ${why || `no passing case for ${missing.join(", ")}`}`);
		return;
	}
	const written = await writeEvidence(new URL("../evidence/translate.json", import.meta.url), {
		sdk: {
			serverVersion: versionOf("@modelcontextprotocol/server"),
			clientVersion: versionOf("@modelcontextprotocol/client"),
		},
		bridge: {
			upstream: `${MODERN} requests: per-request envelope, MCP-Protocol-Version, Mcp-Method, Mcp-Name`,
			downstream: LEGACY_VERSIONS,
			translator: "the server SDK's legacy input-required shim (inputRequired.legacyShim)",
			maxRounds: MAX_ROUNDS,
			answerTimeoutMs: ANSWER_TIMEOUT_MS,
			stateTtlMs: STATE_TTL_MS,
			discoverTimeoutMs: DISCOVER_TIMEOUT_MS,
			maxNameLength: MAX_NAME_LENGTH,
			passedThrough:
				"the client's initialize-declared elicitation object cut to its revision, plus the UI extension",
		},
		clientTimeouts: { sdkDefaultMs: DEFAULT_REQUEST_TIMEOUT_MSEC, longMs: LONG_TIMEOUT_MS },
		...Object.fromEntries(SECTIONS.map((name) => [name, observed.get(name)])),
	});
	console.log(`evidence: ${written}`);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a 2025 client completes the account form through the bridge", () => {
	it("gets one form dialog, and the triage covers the account it chose", async () => {
		const { client, seen, dialogs } = await wire({ capabilities: FORM, answer: accept("slack-1") });
		expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
		const triage = await client.getPrompt(TRIAGE);
		expect(textOf(triage)).toContain("in the account slack-1.");
		expect(dialogs).toEqual([
			{
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
		]);
		const [first, retry, ...more] = asked(seen, "prompts/get");
		if (!first || !retry) throw new Error("the hub saw no round trip");
		expect(more).toEqual([]);
		expect(paramsOf(first).requestState).toBeUndefined();
		const state = paramsOf(retry).requestState;
		expect(typeof state).toBe("string");
		expect(paramsOf(retry).inputResponses).toEqual({
			account: { action: "accept", content: { account: "slack-1" } },
		});
		// The retry replays the original params exactly, so the state's digest still matches.
		expect(paramsDigest(paramsOf(retry))).toBe(paramsDigest(paramsOf(first)));
		// The 2025 client never sees the hub's state: it stays inside the bridge.
		expect(JSON.stringify([dialogs, triage])).not.toContain(String(state));
		record("accountForm", {
			dialogs: dialogs.length,
			hubRequests: asked(seen, "prompts/get").length,
			rendered: "the chosen account",
			retryDigestEqual: true,
			stateSeenByClient: false,
		});
	});

	it("leaves the answer to the hub, which re-checks it: anything else renders for every account", async () => {
		const answers: [string, Answer][] = [
			["alias outside the allowlist", accept("sms-9")],
			["alias in another case", accept("GMAIL-1")],
			["decline", () => ({ action: "decline" })],
			["cancel", () => ({ action: "cancel" })],
		];
		for (const [label, answer] of answers) {
			const { client, dialogs } = await wire({ capabilities: FORM, answer });
			expect(textOf(await client.getPrompt(TRIAGE))).toContain("in every account you can read");
			expect(dialogs).toHaveLength(1);
			record("answerRechecked", { answer: label, dialogs: 1, rendered: "every account" });
		}
	});
});

describe("the requestState TTL against approval delay, end to end", () => {
	// Every timer runs on faked time from the moment the request goes out: the client's own request
	// timeout, the bridge's wait for each answer and the hub's 600 s state.
	type Outcome = "served" | "client timeout" | "bridge timeout" | "readable expiry error";
	interface Delay {
		readonly flow: "account form" | "session-pending read";
		// undefined: the SDK client's default request timeout.
		readonly clientTimeoutMs?: number;
		readonly seconds: number;
		// The client reports progress on the open dialog this often, as a host may.
		readonly progressEverySeconds?: number;
		// What happens while the dialog is open: the hub restarts, or the wall clock jumps by `seconds`
		// with no timer running (a sleep and resume).
		readonly event?: "hub restart" | "clock jump";
		readonly outcome: Outcome;
	}
	const FORM_FLOW = "account form";
	const READ_FLOW = "session-pending read";
	const DELAYS: Delay[] = [
		{ flow: FORM_FLOW, seconds: 30, outcome: "served" },
		{ flow: FORM_FLOW, seconds: 59, outcome: "served" },
		{ flow: FORM_FLOW, seconds: 61, outcome: "client timeout" },
		{ flow: FORM_FLOW, clientTimeoutMs: LONG_TIMEOUT_MS, seconds: 300, outcome: "served" },
		{ flow: FORM_FLOW, clientTimeoutMs: LONG_TIMEOUT_MS, seconds: 594, outcome: "served" },
		{ flow: FORM_FLOW, clientTimeoutMs: LONG_TIMEOUT_MS, seconds: 596, outcome: "bridge timeout" },
		{
			flow: FORM_FLOW,
			clientTimeoutMs: LONG_TIMEOUT_MS,
			seconds: 700,
			progressEverySeconds: 100,
			outcome: "readable expiry error",
		},
		{ flow: FORM_FLOW, seconds: 30, event: "hub restart", outcome: "readable expiry error" },
		{ flow: FORM_FLOW, seconds: 601, event: "clock jump", outcome: "readable expiry error" },
		{ flow: READ_FLOW, seconds: 30, outcome: "served" },
		{ flow: READ_FLOW, seconds: 61, outcome: "client timeout" },
		{ flow: READ_FLOW, clientTimeoutMs: LONG_TIMEOUT_MS, seconds: 594, outcome: "served" },
		{ flow: READ_FLOW, clientTimeoutMs: LONG_TIMEOUT_MS, seconds: 596, outcome: "bridge timeout" },
	];

	interface Shown {
		readonly params: ElicitRequest["params"];
		readonly signal: AbortSignal;
		readonly answer: (result: ElicitResult) => void;
	}

	function outcomeOf(error: unknown, method: string): Outcome | string {
		if (error === undefined) return "served";
		if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
			return "client timeout";
		}
		if (!(error instanceof ProtocolError)) return `unexpected: ${error}`;
		const shim = `Fulfilling input required by '${method}' failed: Request timed out`;
		if (error.code === -32603 && error.message === shim) return "bridge timeout";
		const expired = { reason: "invalid_request_state" };
		if (
			error.code === -32602 &&
			error.message === EXPIRED &&
			JSON.stringify(error.data) === JSON.stringify(expired)
		) {
			return "readable expiry error";
		}
		return `unexpected: ${error.code} ${error.message}`;
	}

	const titled = (row: Delay): [string, Delay] => {
		const client =
			row.clientTimeoutMs === undefined
				? "an SDK-default client"
				: `a client waiting ${row.clientTimeoutMs / 1000} s`;
		const extra =
			row.progressEverySeconds === undefined
				? ""
				: `, with progress every ${row.progressEverySeconds} s`;
		const when =
			row.event === "clock jump"
				? `the clock jumps ${row.seconds} s`
				: `answered after ${row.seconds} s${row.event === "hub restart" ? ", the hub restarted" : ""}`;
		return [`${row.flow}, ${client}${extra}, ${when}: ${row.outcome}`, row];
	};

	it.each(DELAYS.map(titled))("%s", async (_title, row) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		vi.setSystemTime(T0);
		const form = row.flow === FORM_FLOW;
		const method = form ? "prompts/get" : "resources/read";
		const seen: Sent[] = [];
		let hub = newHub();
		let hubAnswers = hubFetch(hub, seen);
		const { promise: shown, resolve: show } = Promise.withResolvers<Shown>();
		const { client } = await wire({
			capabilities: form ? FORM : URL_MODE,
			fetch: (request) => hubAnswers(request),
			answer: (params, signal) => new Promise((answer) => show({ params, signal, answer })),
		});
		const options =
			row.clientTimeoutMs === undefined ? undefined : { timeout: row.clientTimeoutMs };
		const pending = form
			? client.getPrompt(TRIAGE, options)
			: client.readResource({ uri: MESSAGE_URI }, options);
		const settled = pending.then(
			(value) => ({ value, error: undefined }),
			(error: unknown) => ({ value: undefined, error }),
		);
		const dialog = await shown;
		const openedAt = Date.now();
		let closedAfterMs: number | undefined;
		dialog.signal.addEventListener("abort", () => {
			closedAfterMs = Date.now() - openedAt;
		});
		if (row.event === "clock jump") {
			vi.setSystemTime(openedAt + row.seconds * 1000);
		} else {
			const step = (row.progressEverySeconds ?? row.seconds) * 1000;
			const progressToken = dialog.params._meta?.progressToken;
			for (let waited = 0; waited < row.seconds * 1000; waited += step) {
				if (waited > 0 && progressToken !== undefined) {
					await client.notification({
						method: "notifications/progress",
						params: { progressToken, progress: waited / 1000 },
					});
				}
				await vi.advanceTimersByTimeAsync(Math.min(step, row.seconds * 1000 - waited));
			}
		}
		if (row.event === "hub restart") {
			hub = newHub();
			hubAnswers = hubFetch(hub, seen);
		}
		if (!form) hub.sessions.add(sessionKey(PRINCIPAL, "gmail-1", "read"));
		dialog.answer(
			form ? { action: "accept", content: { account: "gmail-1" } } : { action: "accept" },
		);
		const { value, error } = await settled;
		expect(outcomeOf(error, method)).toBe(row.outcome);
		const hubRequests = asked(seen, method).length;
		const clientTimeoutMs = row.clientTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
		const expected = {
			served: [undefined, 2],
			"client timeout": [clientTimeoutMs, 1],
			"bridge timeout": [ANSWER_TIMEOUT_MS, 1],
			"readable expiry error": [undefined, 2],
		}[row.outcome];
		expect([closedAfterMs, hubRequests]).toEqual(expected);
		if (row.outcome === "served") {
			const shownText = JSON.stringify(value);
			expect(shownText).toContain(form ? "in the account gmail-1." : "message text");
		}
		if (row.progressEverySeconds !== undefined) {
			expect(dialog.params._meta?.progressToken).toBeDefined();
		}
		record("approvalDelay", {
			flow: row.flow,
			clientTimeoutMs,
			clientTimeout: row.clientTimeoutMs === undefined ? "SDK default" : "set per request",
			delaySeconds: row.seconds,
			...(row.progressEverySeconds === undefined
				? {}
				: { progressEverySeconds: row.progressEverySeconds }),
			...(row.event === undefined ? {} : { event: row.event }),
			outcome: row.outcome,
			...(closedAfterMs === undefined ? {} : { dialogClosedAfterMs: closedAfterMs }),
			hubRequests,
		});
	});

	it("an accept before the owner approves spends the one round: the read ends in the readable 1001", async () => {
		const { client, seen } = await wire({
			capabilities: URL_MODE,
			answer: () => ({ action: "accept" }),
		});
		const error = await errorOf(client.readResource({ uri: MESSAGE_URI }));
		expect([error.code, error.data]).toEqual([1001, { code: "AGENT_SESSION_REQUIRED" }]);
		expect(asked(seen, "resources/read")).toHaveLength(2);
		record("approvalDelay", {
			flow: "session-pending read accepted before the approval",
			delaySeconds: 0,
			outcome: "readable 1001 after one round",
			hubRequests: 2,
		});
	});

	it("closes a dialog at exactly 595 s, 5 s before its state lapses, and never retries the hub", async () => {
		expect([STATE_TTL_MS, ANSWER_TIMEOUT_MS]).toEqual([STATE_TTL_SECONDS * 1000, 595_000]);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		vi.setSystemTime(T0);
		let cancelledAfterMs: number | undefined;
		const { promise: opened, resolve: open } = Promise.withResolvers<void>();
		// The user never answers; the shim armed its timer before the client's handler ran.
		const answer: Answer = (_params, signal) =>
			new Promise(() => {
				const at = Date.now();
				signal.addEventListener("abort", () => {
					cancelledAfterMs = Date.now() - at;
				});
				open();
			});
		const { client, seen } = await wire({ capabilities: FORM, answer });
		const pending = errorOf(client.getPrompt(TRIAGE, { timeout: LONG_TIMEOUT_MS }));
		await opened;
		await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS - 1);
		expect(cancelledAfterMs).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		const error = await pending;
		expect(cancelledAfterMs).toBe(ANSWER_TIMEOUT_MS);
		expect([error.code, error.message]).toEqual([
			-32603,
			"Fulfilling input required by 'prompts/get' failed: Request timed out",
		]);
		expect(asked(seen, "prompts/get")).toHaveLength(1);
		record("dialogTimeout", {
			closedBy: "the bridge",
			clientTimeoutMs: LONG_TIMEOUT_MS,
			cancelledAfterMs,
			errorCode: error.code,
			hubRetries: 0,
		});
	});
});

describe("a 2025 client that gives up", () => {
	it("cancels its request: the bridge closes the dialog and never retries the hub", async () => {
		const { promise: opened, resolve: open } = Promise.withResolvers<AbortSignal>();
		const answer: Answer = (_params, signal) =>
			new Promise(() => {
				open(signal);
			});
		const { client, seen } = await wire({ capabilities: FORM, answer });
		const controller = new AbortController();
		const pending = client.getPrompt(TRIAGE, { signal: controller.signal });
		const dialog = await opened;
		controller.abort("the user closed the chat");
		await expect(pending).rejects.toThrow();
		await vi.waitFor(() => expect(dialog.aborted).toBe(true));
		expect(asked(seen, "prompts/get")).toHaveLength(1);
		record("dialogTimeout", {
			closedBy: "the client's cancel",
			dialogClosed: true,
			hubRetries: 0,
		});
	});

	it("leaves the hub's state open: after five abandoned dialogs the form stops appearing until they lapse", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T0);
		const opened: AbortSignal[] = [];
		let answer: Answer = (_params, signal) =>
			new Promise(() => {
				opened.push(signal);
			});
		const { client, seen, dialogs } = await wire({
			capabilities: FORM,
			answer: (params, signal) => answer(params, signal),
		});
		for (let n = 1; n <= MAX_OPEN_PER_PRINCIPAL; n++) {
			const controller = new AbortController();
			const pending = client.getPrompt(TRIAGE, { signal: controller.signal });
			await vi.waitFor(() => expect(opened).toHaveLength(n));
			controller.abort("the user closed the chat");
			await expect(pending).rejects.toThrow();
		}
		expect(textOf(await client.getPrompt(TRIAGE))).toContain("in every account you can read");
		expect(dialogs).toHaveLength(MAX_OPEN_PER_PRINCIPAL);
		vi.setSystemTime(T0.getTime() + STATE_TTL_MS + 1_000);
		answer = accept("slack-1");
		expect(textOf(await client.getPrompt(TRIAGE))).toContain("in the account slack-1.");
		expect(dialogs).toHaveLength(MAX_OPEN_PER_PRINCIPAL + 1);
		// Every abandoned request reached the hub once; none was retried.
		expect(asked(seen, "prompts/get")).toHaveLength(MAX_OPEN_PER_PRINCIPAL + 1 + 2);
		record("abandonedDialogs", {
			abandoned: MAX_OPEN_PER_PRINCIPAL,
			openStatesPerPrincipal: MAX_OPEN_PER_PRINCIPAL,
			nextRequest: "every account, no dialog",
			afterStatesLapse: "the form again",
		});
	});
});

// A hub that asks on every request it isn't scripted to answer, and records what the bridge sends.
const ASK = {
	method: "elicitation/create",
	params: {
		mode: "form",
		message: "Which account?",
		requestedSchema: { type: "object", properties: { account: { type: "string" } } },
	},
};
const LISTS: Json = {
	"server/discover": { supportedVersions: [MODERN], capabilities: { tools: {}, prompts: {} } },
	"tools/list": { tools: [] },
	"prompts/list": { prompts: [] },
};
function scriptedHub(
	seen: Json[],
	script: Readonly<Record<string, Json[]>> = {},
): (request: Request) => Promise<Response> {
	const queues = new Map(Object.entries(script).map(([method, answers]) => [method, [...answers]]));
	return async (request) => {
		const { id, method, params } = (await request.json()) as Json;
		const issued = `state-${seen.length + 1}`;
		const { _meta, ...sent } = params as Json;
		seen.push({ method, params: sent, issued });
		const scripted = queues.get(String(method))?.shift();
		if (scripted !== undefined) return Response.json({ jsonrpc: "2.0", id, ...scripted });
		const result = LISTS[String(method)] ?? {
			resultType: "input_required",
			inputRequests: { account: ASK },
			requestState: issued,
		};
		return Response.json({ jsonrpc: "2.0", id, result });
	};
}

describe("maxRounds", () => {
	it.each([undefined, 2])(
		"stops a hub that keeps asking after maxRounds (%s) dialogs",
		async (maxRounds) => {
			const rounds = maxRounds ?? 1;
			const hubSaw: Json[] = [];
			const { client, dialogs } = await wire({
				capabilities: FORM,
				answer: accept("gmail-1"),
				fetch: scriptedHub(hubSaw),
				...(maxRounds === undefined ? {} : { maxRounds }),
			});
			const error = await errorOf(client.getPrompt(TRIAGE));
			const message = `Multi-round-trip request 'prompts/get' still required input after ${rounds} rounds (inputRequired.maxRounds)`;
			expect([error.code, error.message]).toEqual([-32603, message]);
			expect(dialogs).toHaveLength(rounds);
			const tool = await client.callTool({ name: "accounts_list", arguments: {} });
			expect(tool).toEqual({
				content: [
					{
						type: "text",
						text: `Multi-round-trip request 'tools/call' still required input after ${rounds} rounds (inputRequired.maxRounds)`,
					},
				],
				isError: true,
			});
			expect(dialogs).toHaveLength(2 * rounds);
			const prompts = hubSaw.filter((sent) => sent.method === "prompts/get");
			expect(prompts).toHaveLength(rounds + 1);
			// Each retry echoes the state of the round before it, and the first carries none.
			expect(prompts.map((sent) => (sent.params as Json).requestState)).toEqual([
				undefined,
				...prompts.slice(0, -1).map((sent) => sent.issued),
			]);
			record("maxRounds", {
				maxRounds: rounds,
				dialogsPerRequest: rounds,
				promptsError: error.code,
				toolsResult: "isError",
			});
		},
	);

	it("asks once against DraftYak's hub, which answers the retry", async () => {
		const { client, seen, dialogs } = await wire({ capabilities: FORM, answer: accept("gmail-1") });
		await client.getPrompt(TRIAGE);
		await client.getPrompt({ name: "triage_inbox", arguments: { window: "7d" } });
		expect(dialogs).toHaveLength(2);
		expect(asked(seen, "prompts/get")).toHaveLength(4);
		record("maxRounds", { hub: "s03 (one round)", dialogsPerRequest: 1 });
	});
});

describe("retries", () => {
	it("forwards the answers when the hub asks without a requestState", async () => {
		const hubSaw: Json[] = [];
		const rendered = {
			messages: [{ role: "user", content: { type: "text", text: "triage gmail-1" } }],
		};
		const ask = { resultType: "input_required", inputRequests: { account: ASK } };
		const { client, dialogs } = await wire({
			capabilities: FORM,
			answer: accept("gmail-1"),
			fetch: scriptedHub(hubSaw, { "prompts/get": [{ result: ask }, { result: rendered }] }),
		});
		expect(textOf(await client.getPrompt(TRIAGE))).toBe("triage gmail-1");
		expect(dialogs).toHaveLength(1);
		const [first, retry] = hubSaw.filter((sent) => sent.method === "prompts/get");
		expect([first?.params, retry?.params]).toEqual([
			TRIAGE,
			{
				...TRIAGE,
				inputResponses: { account: { action: "accept", content: { account: "gmail-1" } } },
			},
		]);
		record("retries", { hubState: "none", answersForwarded: true, dialogs: 1 });
	});

	it("answers a tools/call whose retry the hub refuses as expired with a readable isError result", async () => {
		const hubSaw: Json[] = [];
		const ask = {
			resultType: "input_required",
			inputRequests: { account: ASK },
			requestState: "s-1",
		};
		const refused = {
			error: {
				code: -32602,
				message: "Invalid or expired requestState",
				data: { reason: "invalid_request_state" },
			},
		};
		const { client } = await wire({
			capabilities: FORM,
			answer: accept("gmail-1"),
			fetch: scriptedHub(hubSaw, { "tools/call": [{ result: ask }, refused] }),
		});
		const tool = await client.callTool({ name: "accounts_list", arguments: {} });
		expect(tool).toEqual({ content: [{ type: "text", text: EXPIRED }], isError: true });
		const calls = hubSaw.filter((sent) => sent.method === "tools/call");
		expect(calls.map((sent) => (sent.params as Json).requestState)).toEqual([undefined, "s-1"]);
		record("retries", { method: "tools/call", hubRefusedState: true, result: "isError, readable" });
	});
});

describe("capability pass-through", () => {
	// The server SDK reads a bare `elicitation: {}` at initialize as `{ form: {} }`, its meaning, and
	// takes any mode on any revision; the bridge keeps the modes the client's revision defines.
	const BOTH = { elicitation: { form: {}, url: {} } };
	const CASES: [string, ClientCapabilities, ClientCapabilities, boolean, boolean][] = [
		["2025-11-25", {}, {}, false, false],
		["2025-11-25", { elicitation: {} }, FORM, true, false],
		["2025-11-25", FORM, FORM, true, false],
		["2025-11-25", URL_MODE, URL_MODE, false, true],
		[
			"2025-11-25",
			{ elicitation: { form: { applyDefaults: true }, url: {} }, sampling: {}, roots: {} },
			{ elicitation: { form: { applyDefaults: true }, url: {} } },
			true,
			true,
		],
		["2025-06-18", { elicitation: {} }, FORM, true, false],
		["2025-06-18", BOTH, FORM, true, false],
		["2025-06-18", URL_MODE, {}, false, false],
		["2025-03-26", BOTH, {}, false, false],
	];

	it.each(CASES)(
		"a %s client declaring %j: the hub sees %j and the UI extension",
		async (revision, declared, hubSaw, form, url) => {
			const { client, seen, dialogs } = await wire({ revision, capabilities: declared });
			expect(client.getNegotiatedProtocolVersion()).toBe(revision);
			const triage = await client.getPrompt(TRIAGE);
			expect(textOf(triage)).toContain("in every account you can read");
			const read = await errorOf(client.readResource({ uri: MESSAGE_URI }));
			expect(read.code).toBe(1001);
			expect(dialogs.map((dialog) => dialog.mode)).toEqual([
				...(form ? ["form"] : []),
				...(url ? ["url"] : []),
			]);
			const relayed = seen.filter((sent) => sent.body.method !== "server/discover");
			for (const sent of relayed) {
				expect(envelopeOf(sent)).toEqual({
					[PROTOCOL_VERSION_META_KEY]: MODERN,
					[CLIENT_CAPABILITIES_META_KEY]: { ...hubSaw, extensions: UI },
					[CLIENT_INFO_META_KEY]: { name: "fake-2025-client", version: "1.0.0" },
				});
			}
			record("capabilityPassThrough", {
				revision,
				declared: JSON.stringify(declared),
				hubSaw: JSON.stringify({ ...hubSaw, extensions: UI }),
				formDialog: form,
				urlDialog: url,
			});
		},
	);

	it("gives a 2025-06-18 client the dialog in the 2026 shape: mode and requestedSchema.$schema", async () => {
		const { client, dialogs } = await wire({
			revision: "2025-06-18",
			capabilities: FORM,
			answer: accept("gmail-1"),
		});
		expect(textOf(await client.getPrompt(TRIAGE))).toContain("in the account gmail-1.");
		const [dialog] = dialogs;
		if (dialog === undefined || !("requestedSchema" in dialog)) throw new Error("no form dialog");
		expect(Object.keys(dialog).toSorted()).toEqual(["message", "mode", "requestedSchema"]);
		expect(Object.keys(dialog.requestedSchema).toSorted()).toEqual([
			"$schema",
			"properties",
			"required",
			"type",
		]);
		record("capabilityPassThrough", {
			revision: "2025-06-18",
			dialogFieldsOutsideTheRevision: ["mode", "requestedSchema.$schema"],
		});
	});

	it("gives the 2025 client the hub's capabilities and identity", async () => {
		const { client, seen } = await wire();
		const discover = seen.find((sent) => sent.body.method === "server/discover");
		expect(discover && envelopeOf(discover)[CLIENT_CAPABILITIES_META_KEY]).toEqual({});
		expect(client.getServerCapabilities()).toEqual({
			tools: { listChanged: false },
			resources: { listChanged: false },
			prompts: { listChanged: false },
			extensions: { "io.modelcontextprotocol/ui": {} },
			completions: {},
		});
		expect(client.getServerVersion()).toEqual({ name: "draftyak-spike-s03", version: "0.0.0" });
	});
});

describe("eras", () => {
	it("serves a 2026-era client as a 2025-11-25 one: the bridge has no 2026 leg", async () => {
		const [bridgeSide, clientSide] = InMemoryTransport.createLinkedPair();
		const answers: JSONRPCMessage[] = [];
		const answer = bridgeSide.send.bind(bridgeSide);
		bridgeSide.send = (message, options) => {
			answers.push(message);
			return answer(message, options);
		};
		await startBridge(bridgeSide, {
			hub: { url: HUB_URL, token: TOKEN, fetch: hubFetch(newHub(), []) },
		});
		const probes: string[] = [];
		const send = clientSide.send.bind(clientSide);
		clientSide.send = (message, options) => {
			if ("method" in message) probes.push(message.method);
			return send(message, options);
		};
		const client = new Client(
			{ name: "fake-2026-client", version: "1.0.0" },
			{ versionNegotiation: { mode: "auto" } },
		);
		await client.connect(clientSide);
		onTestFinished(() => client.close());
		expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
		expect(probes.slice(0, 2)).toEqual(["server/discover", "initialize"]);
		const [probeAnswer] = answers;
		expect(probeAnswer && "error" in probeAnswer && probeAnswer.error.code).toBe(-32601);
		record("eras", {
			client: "2026-era SDK client, auto negotiation",
			discoverProbe: -32601,
			negotiated: client.getNegotiatedProtocolVersion(),
		});
	});
});

// A 2025 client at the wire level: JSON-RPC over the linked transport, answers matched by id.
async function rawClient(fetch: (request: Request) => Promise<Response>) {
	const [bridgeSide, clientSide] = InMemoryTransport.createLinkedPair();
	await startBridge(bridgeSide, { hub: { url: HUB_URL, token: TOKEN, fetch } });
	const waiting = new Map<RequestId, (message: Json) => void>();
	clientSide.onmessage = (message) => {
		if ("id" in message && message.id !== undefined && !("method" in message)) {
			waiting.get(message.id)?.(message as Json);
		}
	};
	await clientSide.start();
	onTestFinished(() => clientSide.close());
	let lastId = 0;
	const request = (method: string, params: Json = {}): Promise<Json> =>
		new Promise((resolve) => {
			const id = ++lastId;
			waiting.set(id, resolve);
			void clientSide.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage);
		});
	const clientInfo = { name: "raw-2025-client", version: "1.0.0" };
	const init = await request("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo,
	});
	await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
	return { init, request };
}

// The value a message carries on the wire: JSON drops undefined members, and key order doesn't count.
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

describe("everything that doesn't elicit is answered as the hub's own 2025 leg answers it", () => {
	// An argument named __proto__, as JSON.parse makes it: an own property.
	const PROTO = JSON.parse('{"__proto__":"x"}') as Json;
	const COMPLETE_REF = { type: "ref/prompt", name: "triage_inbox" };
	const WELL_FORMED: [string, Json][] = [
		["tools/list", {}],
		["tools/call", { name: "accounts_list", arguments: {} }],
		["tools/call", { name: "message_get", arguments: { messageId: MESSAGE } }],
		["tools/call", { name: "message_get", arguments: { messageId: "x" } }],
		["prompts/list", {}],
		["prompts/get", TRIAGE],
		["prompts/get", { name: "triage_inbox", arguments: { account: "gmail-1", window: "72h" } }],
		["prompts/get", { name: "summarize_thread", arguments: { conversationId: CONVERSATION } }],
		["prompts/get", { name: "draft_reply", arguments: {} }],
		["prompts/get", { name: "triage_inbox", arguments: { account: "sms-9" } }],
		["resources/list", {}],
		["resources/templates/list", {}],
		["resources/read", { uri: GUIDE_URI }],
		["resources/read", { uri: MESSAGE_URI }],
		["resources/read", { uri: `draftyak://message/${MISSING}` }],
		["resources/read", { uri: "draftyak://message/x" }],
		["completion/complete", { ref: COMPLETE_REF, argument: { name: "account", value: "g" } }],
		["ping", {}],
	];
	// Params of the wrong shape: the hub's 2025 leg checks the surfaces' params before the SDK's wire
	// check, and leaves tools/list and tools/call to the SDK.
	const MALFORMED: [string, Json][] = [
		["tools/list", { cursor: 5 }],
		["tools/call", {}],
		["tools/call", { name: 5 }],
		["prompts/list", { cursor: 5 }],
		["prompts/get", {}],
		["prompts/get", { name: 5 }],
		["prompts/get", { name: "triage_inbox", arguments: { account: 5 } }],
		["prompts/get", { name: "triage_inbox", arguments: PROTO }],
		["resources/list", { cursor: 5 }],
		["resources/templates/list", { cursor: 5 }],
		["resources/read", {}],
		["resources/read", { uri: 5 }],
		["completion/complete", {}],
		["completion/complete", { ref: COMPLETE_REF }],
	];
	const CORPUS = [...WELL_FORMED, ...MALFORMED];

	it("initialize, then each request in the corpus, as the same JSON value", async () => {
		const hub = newHub();
		const app = createApp({ hub, token: TOKEN });
		const direct = async (method: string, params: Json) => {
			const headers = { authorization: `Bearer ${TOKEN}` };
			const { body } = await serve(app, legacy(method, params, headers));
			return { result: body.result, error: body.error };
		};
		const { init, request } = await rawClient(hubFetch(hub, []));
		expect(asJson({ result: init.result, error: init.error })).toStrictEqual(
			asJson(
				await direct("initialize", {
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "raw-2025-client", version: "1.0.0" },
				}),
			),
		);
		const malformedCodes: Record<string, number> = {};
		for (const [method, params] of CORPUS) {
			const bridged = await request(method, params);
			const hubs = await direct(method, params);
			expect(asJson({ method, result: bridged.result, error: bridged.error })).toStrictEqual(
				asJson({ method, ...hubs }),
			);
			if (MALFORMED.some(([, row]) => row === params)) {
				const code = String(hubs.error?.code);
				malformedCodes[code] = (malformedCodes[code] ?? 0) + 1;
			}
		}
		record("parity", {
			requests: CORPUS.length + 1,
			wellFormed: WELL_FORMED.length + 1,
			malformed: MALFORMED.length,
			malformedCodes,
			equal: CORPUS.length + 1,
			comparison: "the same JSON value, key order aside",
		});
	});
});

describe("the bridge relays only the state the hub gave the request", () => {
	it("refuses a requestState a 2025 client puts in its own request, before the hub sees it", async () => {
		const hub = newHub();
		// A state the hub minted for the bridge's own principal (its agent token) and these params.
		const minted = await serve(
			createApp({ hub, token: TOKEN }),
			modern("prompts/get", TRIAGE, {
				capabilities: FORM,
				headers: { authorization: `Bearer ${TOKEN}` },
			}),
		);
		expect(minted.body.result.resultType).toBe("input_required");
		const relayed: Sent[] = [];
		const { request } = await rawClient(hubFetch(hub, relayed));
		const retry = {
			requestState: minted.body.result.requestState,
			inputResponses: { account: { action: "accept", content: { account: "slack-1" } } },
		};
		const ROWS: [string, Json][] = [
			["prompts/get", TRIAGE],
			["resources/read", { uri: MESSAGE_URI }],
			["tools/call", { name: "accounts_list", arguments: {} }],
		];
		for (const [method, params] of ROWS) {
			const injected = await request(method, { ...params, ...retry });
			expect(injected.error).toEqual({
				code: -32602,
				message: "Invalid or expired requestState",
				data: { reason: "invalid_request_state" },
			});
			expect(asked(relayed, method)).toEqual([]);
			record("injectedState", { method, errorCode: -32602, reachedHub: false });
		}
	});

	it("never relays a requestState or inputResponses a client puts in a request the hub didn't ask on", async () => {
		const relayed: Sent[] = [];
		const { request } = await rawClient(hubFetch(newHub(), relayed));
		const answers = { account: { action: "accept", content: { account: "slack-1" } } };
		const forged = { requestState: "v1.forged.state", inputResponses: answers };
		const complete = {
			ref: { type: "ref/prompt", name: "triage_inbox" },
			argument: { name: "account", value: "g" },
		};
		const ROWS: [string, Json][] = [
			["tools/list", forged],
			["prompts/list", { ...forged, requestState: 5 }],
			["resources/list", forged],
			["resources/templates/list", forged],
			["completion/complete", { ...complete, requestState: 7, inputResponses: answers }],
			["prompts/get", { ...TRIAGE, inputResponses: answers }],
			["resources/read", { uri: GUIDE_URI, inputResponses: answers }],
			["tools/call", { name: "accounts_list", arguments: {}, inputResponses: answers }],
		];
		for (const [method, params] of ROWS) {
			const answer = await request(method, params);
			expect(answer.error).toBeUndefined();
			const sent = paramsOf(asked(relayed, method).at(-1));
			expect(Object.keys(sent)).not.toContain("requestState");
			expect(Object.keys(sent)).not.toContain("inputResponses");
			record("injectedState", { method, served: true, reachedHub: false });
		}
	});
});

describe("2026-era headers", () => {
	it("sends Mcp-Method and Mcp-Name, in the Base64 sentinel when the name isn't header-safe", async () => {
		const { client, seen } = await wire();
		const unknown = "triage_inboxé";
		const error = await errorOf(client.getPrompt({ name: unknown, arguments: {} }));
		expect(error.code).toBe(-32602);
		const sent = seen.find((entry) => entry.body.method === "prompts/get");
		expect(sent?.headers).toMatchObject({
			authorization: `Bearer ${TOKEN}`,
			"mcp-protocol-version": MODERN,
			"mcp-method": "prompts/get",
			"mcp-name": `=?base64?${Buffer.from(unknown).toString("base64")}?=`,
		});
		await client.readResource({ uri: GUIDE_URI });
		expect(seen.at(-1)?.headers["mcp-name"]).toBe(GUIDE_URI);
		record("headers", { mcpName: "plain or Base64 sentinel", hubAnswer: error.code });
	});

	it("refuses a name or URI too long for the hub's Mcp-Name header before the hub sees it", async () => {
		const { client, seen } = await wire();
		const error = await errorOf(
			client.readResource({ uri: `draftyak://message/${"A".repeat(MAX_NAME_LENGTH)}` }),
		);
		expect([error.code, error.message, error.data]).toEqual([
			-32602,
			"Invalid resources/read params: uri: too long for the hub's Mcp-Name header",
			{ reason: "invalid_params" },
		]);
		expect(asked(seen, "resources/read")).toEqual([]);
		record("headers", { mcpNameOver: MAX_NAME_LENGTH, answer: error.code, reachedHub: false });
	});
});

describe("hub errors reach the 2025 client readably", () => {
	it("names a refused agent token, a hub that isn't answering and one that never answers", async () => {
		const refused = startBridge(InMemoryTransport.createLinkedPair()[0], {
			hub: { url: HUB_URL, token: "wrong-token", fetch: hubFetch(newHub(), []) },
		});
		await expect(refused).rejects.toThrow(
			"The DraftYak hub refused the bridge's agent token; check DRAFTYAK_TOKEN.",
		);
		const down = startBridge(InMemoryTransport.createLinkedPair()[0], {
			hub: {
				url: HUB_URL,
				token: TOKEN,
				fetch: () => Promise.reject(new TypeError("fetch failed")),
			},
		});
		await expect(down).rejects.toThrow(HUB_DOWN);
		const silent = startBridge(InMemoryTransport.createLinkedPair()[0], {
			hub: {
				url: HUB_URL,
				token: TOKEN,
				fetch: (request) =>
					new Promise((_resolve, reject) => {
						request.signal.addEventListener("abort", () => reject(request.signal.reason));
					}),
			},
			discoverTimeoutMs: 20,
		});
		await expect(silent).rejects.toThrow(HUB_DOWN);
		expect(DISCOVER_TIMEOUT_MS).toBe(10_000);
		record("hubErrors", {
			refusedToken: "readable",
			hubDown: "readable",
			silentHub: "readable, after the discover timeout",
		});
	});
});
