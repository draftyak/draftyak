import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	deleteEnvLive,
	type EnvLiveOptions,
	type Fingerprint,
	fingerprint,
	loadEnvLive,
	Secret,
	saveEnvLive,
	writeEvidence,
} from "@draftyak/spike-kit";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type CtxFetchStub, createClient, createCtxFetchStub, liveStub } from "../src/client.ts";
import { DEFAULT_MODEL, DRAFT_EFFORT } from "../src/draft.ts";
import type { Pin } from "../src/verify.ts";
import {
	errorReply,
	type FakeMessagesApi,
	message,
	type Reply,
	replies,
	type Script,
	startFake,
} from "./fake-messages-api.ts";
import { failure, fakeKey } from "./harness.ts";
import {
	CHECK_MODEL,
	costOf,
	HASH_NAME,
	KEY_NAME,
	type LiveOptions,
	type LiveOutcome,
	type MeterOptions,
	meter,
	runLive as ordinaryRunLive,
	PROBE_FLAG,
	plannedCalls,
	promptCost,
	runRehearsal,
	runSession,
	SESSION_ACCEPTANCE,
	StopError,
	TINY_MAX_TOKENS,
	worstCase,
} from "./live-session.ts";

// Lifecycle fixtures alone assume a one-hop 5/25 fake routing bound. They do not establish live
// default-routing acceptance. Independent ordinaryRunLive tests retain the unresolved live hold.
const syntheticRouting = { maxHops: 1, price: [5, 25] as const };
const fixtureMeter = (stub: CtxFetchStub, options: MeterOptions = {}) =>
	meter(stub, { ...options, syntheticRouting });
const runLive = (options: LiveOptions): Promise<LiveOutcome> => runRehearsal(options, fixtureMeter);

const spikeDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(spikeDir, "..", "..");
const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "draftyak-s09-rehearsal-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let serial = 0;
const fresh = (name: string): string => path.join(base, `${name}-${++serial}`);
// <repo>/spikes/s09-messages-api/evidence/live.json, as writeEvidence and vendor-guard expect.
const evidenceFile = (): string =>
	path.join(fresh("repo"), "spikes", "s09-messages-api", "evidence", "live.json");
const repoOf = (file: string): string => path.resolve(file, "..", "..", "..", "..");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const linesOf = (outcome: LiveOutcome): readonly string[] =>
	outcome.step === "skipped" ? [] : outcome.lines;

// A temp .env.live, written with saveEnvLive as notes/session.md tells the owner.
function envLive(entries: Readonly<Record<string, string>>): { env: NodeJS.ProcessEnv } {
	const file = path.join(fresh("env"), ".env.live");
	mkdirSync(path.dirname(file), { recursive: true });
	const options = { env: { DRAFTYAK_ENV_LIVE: file } };
	for (const [name, value] of Object.entries(entries)) saveEnvLive(name, value, options);
	return options;
}
// An entry's value, or null when that .env.live doesn't hold it.
function held(options: EnvLiveOptions | undefined, name: string): string | null {
	try {
		return loadEnvLive([name], options)[name]?.reveal() ?? null;
	} catch (error) {
		if (String(error).includes("not set in ")) return null;
		throw error;
	}
}
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const key = new Secret(fakeKey());
const canary = randomBytes(8).toString("hex");
const organizations: string[] = [];
const draftOutput = {
	body: `Yes, 10:00 on Tuesday works. ${canary}`,
	ownerNotes: `Moves the call. ${canary}`,
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: [],
};

// What the API sends besides content: an organization id, rate limits (one a 10-digit count), an
// edge id, and one content-shaped value under a kept name, which evidence must redact.
function apiHeaders(): Record<string, string> {
	const organization = randomUUID();
	organizations.push(organization);
	return {
		"anthropic-organization-id": organization,
		"anthropic-ratelimit-requests-limit": "50",
		"anthropic-ratelimit-requests-remaining": "49",
		"anthropic-ratelimit-requests-reset": "2026-10-20T12:00:01Z",
		"anthropic-ratelimit-tokens-limit": "1250000000",
		"anthropic-ratelimit-note": `owner.${canary}@example.com`,
		"cf-ray": `${randomBytes(8).toString("hex")}-IAD`,
	};
}

const schemaFields = (body: Record<string, unknown>): string[] => {
	const format = (body.output_config as { format?: { schema?: { properties?: object } } }).format;
	return Object.keys(format?.schema?.properties ?? {});
};

// Answers like the API: a draft, a cut-off answer for the tiny max_tokens, a reasoning_extraction
// refusal for the probe's format, and a 404 for the revocation check's model while the key works.
const realistic: Script = (request) => {
	const model = String(request.body.model);
	let reply: Reply = replies.draft(model, draftOutput);
	if (model === CHECK_MODEL) reply = errorReply(404, "not_found_error", `model: ${model}`);
	else if (request.body.max_tokens === TINY_MAX_TOKENS) reply = replies.truncated(model, "", 16);
	else if (schemaFields(request.body).includes("reasoning")) {
		reply = replies.refusal(model, "reasoning_extraction");
	}
	return { ...reply, headers: { ...apiHeaders(), ...reply.headers } };
};

let open: FakeMessagesApi | undefined;
afterEach(async () => {
	await open?.close();
	open = undefined;
});
const start = async (script: Script = realistic): Promise<FakeMessagesApi> => {
	open = await startFake({ key: key.reveal(), script });
	return open;
};
// liveStub(pin) is createCtxFetchStub({ upstream: API_ORIGIN, key, pin }); here the upstream is the fake.
const stubs =
	(server: FakeMessagesApi, secret: Secret = key) =>
	async (pin: Pin): Promise<CtxFetchStub> =>
		createCtxFetchStub({ upstream: server.url, key: secret, pin });
// As liveStub reads it, from the temp .env.live: no key there, no stub.
const fromEnv =
	(server: FakeMessagesApi, env: { env: NodeJS.ProcessEnv }) =>
	async (pin: Pin): Promise<CtxFetchStub> =>
		createCtxFetchStub({ upstream: server.url, key: loadEnvLive([KEY_NAME], env)[KEY_NAME], pin });

const overloaded = (): Reply => ({
	...errorReply(529, "overloaded_error", "Overloaded"),
	headers: { "retry-after-ms": "1" },
});
const firstTry = (request: { readonly headers: Headers }): boolean =>
	request.headers.get("x-stainless-retry-count") === "0";

// The network as the stub meets it: a request that never reaches the API ("before"), or one whose
// answer is lost after the API has it ("after").
async function network<T>(
	drop: (nth: number) => "before" | "after" | null,
	run: () => Promise<T>,
): Promise<T> {
	const real = globalThis.fetch;
	let nth = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const mode = drop(++nth);
		if (mode === "before") throw new TypeError("fetch failed");
		const response = await real(input, init);
		if (mode === "after") {
			await response.body?.cancel();
			throw new TypeError("fetch failed");
		}
		return response;
	}) as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = real;
	}
}

// What the meter counts for a request that got no answer, from the body the fake received.
const unanswered = (raw: string): number =>
	worstCase(JSON.parse(raw), Buffer.byteLength(raw), 8_192, syntheticRouting) as number;

let clean: Fingerprint;
beforeAll(async () => {
	const print = await fingerprint({ cwd: base, sampleMs: 50 });
	clean = { ...print, commit: "0".repeat(40), dirty: false };
});

const options = (server: FakeMessagesApi, extra: Partial<LiveOptions> = {}): LiveOptions => ({
	file: evidenceFile(),
	openStub: stubs(server),
	env: { DRAFTYAK_RECORD_EVIDENCE: "1" },
	envLive: envLive({ [KEY_NAME]: key.reveal() }),
	fingerprint: async () => clean,
	...extra,
});

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

function run(
	command: string,
	args: readonly string[],
	settings: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<Run> {
	return new Promise((resolve, reject) => {
		const spec = { ...settings, windowsHide: true, maxBuffer: 16 * 2 ** 20 };
		execFile(command, [...args], spec, (error, stdout, stderr) => {
			if (error && typeof error.code !== "number") reject(error);
			else resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
		});
	});
}

// No GIT_* variable, so a hook or `git rebase -x` can't point git at another repository.
const gitless = (): NodeJS.ProcessEnv =>
	Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));

// vendor-guard's CLI, as `pnpm guard` runs it, on a throwaway repo holding the evidence/ folder.
async function guard(
	repo: string,
	signal: AbortSignal,
): Promise<{ file?: string; rule: string }[]> {
	const env = gitless();
	if (!existsSync(path.join(repo, ".git"))) {
		await run("git", ["init", "-q", repo], { env, signal });
		// Background maintenance would write into .git while the repo is scanned or removed.
		await run("git", ["-C", repo, "config", "maintenance.auto", "false"], { env, signal });
	}
	const cli = path.join(repoRoot, "tools", "vendor-guard", "src", "cli.ts");
	const result = await run(process.execPath, [cli, "--json"], { cwd: repo, env, signal });
	if (result.code === 2) throw new Error(`vendor-guard: ${result.stderr}`);
	return JSON.parse(result.stdout).findings;
}

const sentHeaders = [
	...["accept", "anthropic-beta", "anthropic-version", "content-type", "user-agent"],
	...["x-api-key", "x-stainless-retry-count", "x-stainless-timeout"],
];

describe("the live session against the fake API", () => {
	it("maps the acceptance lines and keeps only shapes, usage and header names", async ({
		signal,
	}) => {
		const server = await start();
		const env = envLive({ [KEY_NAME]: key.reveal(), [PROBE_FLAG]: "yes" });
		const settings = options(server, { envLive: env });
		const accepted = [...SESSION_ACCEPTANCE, "refusal: probed (reasoning_extraction)"];
		expect(await runLive(settings)).toMatchObject({ step: "session", acceptance: accepted });
		expect(server.received.map((request) => request.body.max_tokens)).toEqual([
			16_000, 16_000, 16, 2_048,
		]);
		const text = readFileSync(settings.file, "utf8");
		const document = JSON.parse(text);
		expect(document.fingerprint).toEqual(clean);
		expect(document.data.session).toEqual({
			step: "session",
			ranAt: expect.any(String),
			sdk: "0.135.0",
			model: DEFAULT_MODEL,
			effort: DRAFT_EFFORT,
			maxTokens: 16_000,
			callCap: 6,
			calls: 4,
			budgetUsd: 1,
			// 1,200 tokens in at US$4 per million, and 300, 300, 16 and 0 out at US$20.
			costUsd: 0.03152,
			accountingVersion: 2,
			accountedUsd: expect.closeTo(0.03152, 9),
			pricesAsOf: "2026-10-06",
			refusalProbe: "allowed",
			revoked: "no",
		});
		expect(document.data.acceptance).toEqual(accepted);
		expect(document.data.revocation).toBeNull();
		expect(document.data.stops).toEqual([]);
		const [production, plain, tiny, probe] = document.data.calls;
		const raw = server.received[0]?.raw ?? "";
		expect(production).toEqual({
			label: "fallbacks",
			status: 200,
			errorType: null,
			skipped: null,
			failed: null,
			costUsd: 0.0108,
			attempts: [
				{
					request: {
						endpoint: "POST /v1/messages",
						betaQuery: true,
						headerNames: sentHeaders,
						bodyFields: ["fallbacks", "max_tokens", "messages", "model", "output_config", "system"],
						model: DEFAULT_MODEL,
						maxTokens: 16_000,
						effort: DRAFT_EFFORT,
						format: "json_schema",
						schemaFields: [
							...["body", "contextRefs", "needsOwnerInput", "ownerNotes"],
							"suspectedInstructions",
						],
						fallbacks: "default",
						fallbackBeta: true,
						otherBetas: 0,
						verdict: "ok",
					},
					response: {
						status: 200,
						headerNames: expect.arrayContaining([
							"anthropic-organization-id",
							"cf-ray",
							"request-id",
						]),
						headerValues: {
							"anthropic-ratelimit-note": "[redacted:email]",
							"anthropic-ratelimit-requests-limit": 50,
							"anthropic-ratelimit-requests-remaining": 49,
							"anthropic-ratelimit-requests-reset": "2026-10-20T12:00:01Z",
							"anthropic-ratelimit-tokens-limit": 1_250_000_000,
							"content-type": "application/json",
						},
						body: {
							fields: [
								...["container", "content", "context_management", "id", "model", "role"],
								...["stop_details", "stop_reason", "stop_sequence", "type", "usage"],
							],
							type: "message",
							model: DEFAULT_MODEL,
							stopReason: "end_turn",
							stopSequence: null,
							stopDetails: null,
							content: [
								{ type: "thinking", chars: 0, signed: true },
								{ type: "text", chars: JSON.stringify(draftOutput).length },
							],
							usage: {
								input_tokens: 1_200,
								output_tokens: 300,
								cache_creation_input_tokens: 0,
								cache_read_input_tokens: 0,
								iterations: null,
							},
						},
					},
					ms: expect.any(Number),
					costUsd: 0.0108,
					worstUsd: expect.closeTo(unanswered(raw), 5),
				},
			],
			result: {
				kind: "draft",
				model: DEFAULT_MODEL,
				fallback: false,
				usage: { input: 1_200, output: 300 },
				draft: {
					bodyChars: draftOutput.body.length,
					ownerNotesChars: draftOutput.ownerNotes.length,
					needsOwnerInput: 0,
					suspectedInstructions: false,
					contextRefs: [],
				},
			},
		});
		// Only the production request carries fallbacks and their beta.
		for (const call of [plain, tiny, probe]) {
			expect(call.attempts[0].request).toMatchObject({
				bodyFields: ["max_tokens", "messages", "model", "output_config", "system"],
				fallbacks: null,
				fallbackBeta: false,
				otherBetas: 0,
				headerNames: sentHeaders.filter((name) => name !== "anthropic-beta"),
			});
		}
		expect(held(env, HASH_NAME)).toBe(sha256(key.reveal()));
		expect(tiny.result).toMatchObject({ kind: "truncated", stopReason: "max_tokens" });
		expect(probe.attempts[0].request.schemaFields).toEqual(["body", "reasoning"]);
		expect(probe.attempts[0].response.body).toMatchObject({
			stopReason: "refusal",
			content: [],
			stopDetails: {
				type: "refusal",
				category: "reasoning_extraction",
				explanation: "present",
				recommendedModel: null,
				fallbackCreditToken: null,
			},
		});
		// No prompt or answer text, no key, no organization, request or message id, no signature.
		const leaks = [canary, key.reveal(), "brokered", "req_fake", "msg_fake", "ZmFrZS1zaWduYXR1cmU"];
		for (const leak of [...leaks, "Tuesday", "declined", ...organizations]) {
			expect(text).not.toContain(leak);
		}
		expect(await guard(repoOf(settings.file), signal)).toEqual([]);
		// The guard reads that folder as evidence: an id that bypassed writeEvidence is a finding. Its
		// digits become letters, so no digit run adds an evidence-digits finding by chance.
		const leak = path.join(path.dirname(settings.file), "leak.json");
		const organization = randomUUID().replace(/\d/g, "f");
		writeFileSync(leak, `${JSON.stringify({ data: { organization } }, null, 2)}\n`);
		expect(await guard(repoOf(settings.file), signal)).toMatchObject([
			{ file: "spikes/s09-messages-api/evidence/leak.json", rule: "evidence-uuid" },
		]);
	});

	it("makes 3 calls without the owner's opt-in and takes the refusal from the documentation", async () => {
		const server = await start();
		const env = envLive({ [KEY_NAME]: key.reveal(), [PROBE_FLAG]: "no" });
		const settings = options(server, { envLive: env });
		const outcome = await runLive(settings);
		expect(outcome).toMatchObject({
			acceptance: [...SESSION_ACCEPTANCE, "refusal: from the documentation"],
		});
		expect(server.received).toHaveLength(3);
		expect(read(settings.file).data.session).toMatchObject({
			calls: 3,
			refusalProbe: "not allowed",
		});
		expect(linesOf(outcome)).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^fallbacks: 200 draft from claude-opus-5-5, 1 attempt, /),
				"calls: 3 of 6; estimated US$0.0267 of US$1",
				`evidence: ${settings.file}`,
				"next: revoke the key in the Claude Console, then run the same command again",
			]),
		);
	});

	it("retains a fallback rejection reservation and refuses the next request without acceptance", async () => {
		const server = await start((request) =>
			"fallbacks" in request.body
				? errorReply(400, "invalid_request_error", "fallbacks: Extra inputs are not permitted")
				: realistic(request),
		);
		const lines: string[] = [];
		const settings = options(server, { log: (line) => lines.push(line) });
		await expect(runLive(settings)).rejects.toThrow("could pass US$1.00");
		// The API's message reaches the console only; the owner decides what happens next.
		expect(lines).toEqual(
			expect.arrayContaining([
				expect.stringMatching(
					/^fallbacks: 400 invalid_request_error \(fallbacks: Extra inputs are not permitted\), 1 attempt, /,
				),
			]),
		);
		expect(readFileSync(settings.file, "utf8")).not.toContain("Extra inputs");
		expect(server.received).toHaveLength(1);
		expect(read(settings.file).data).toMatchObject({
			session: {
				calls: 1,
				accountedUsd: expect.closeTo(unanswered(server.received[0]?.raw ?? ""), 9),
			},
			acceptance: [],
			stops: [{ stop: "budget", call: "parse-effort" }],
		});
	});
});

describe("ordinary live routing is held", () => {
	it("refuses the exact ordinary entry before transport and cannot take fixture bounds from the environment", async () => {
		const server = await start();
		const settings = options(server, {
			env: { DRAFTYAK_RECORD_EVIDENCE: "1", DY_SYNTHETIC_ROUTING: "5,25,1" },
		});
		await expect(ordinaryRunLive(settings)).rejects.toThrow(
			"default fallback routing has no established target, hop or price bound",
		);
		expect(server.received).toHaveLength(0);
		expect(existsSync(settings.file)).toBe(false);
		expect(held(settings.envLive, HASH_NAME)).toBeNull();
		const entry = readFileSync(path.join(spikeDir, "test/messages.live.test.ts"), "utf8");
		expect(entry).toContain(
			"await runLive({ file, openStub: liveStub, signal: ctx.signal, log: console.log })",
		);
		expect(entry).not.toContain("runRehearsal");
	});

	it("refuses unresolved routing before even its beforeSend callback", async () => {
		const server = await start();
		let records = 0;
		const strict = meter(await stubs(server)({ model: DEFAULT_MODEL, effort: DRAFT_EFFORT }), {
			beforeSend: async () => {
				records++;
			},
		});
		const client = createClient(strict, { maxRetries: 1 });
		await expect(runSession(client, strict, plannedCalls(false))).rejects.toThrow(
			"default fallback routing has no established",
		);
		expect(records).toBe(0);
		expect(strict.used()).toBe(0);
		expect(server.received).toHaveLength(0);
	});

	it("refuses old under-reserved records before opening a transport and preserves their bytes", async () => {
		const server = await start();
		const settings = options(server);
		await runLive(settings);
		const legacy = read(settings.file);
		delete legacy.data.session.accountingVersion;
		delete legacy.data.session.accountedUsd;
		legacy.data.session.costUsd = 0.001;
		writeFileSync(settings.file, JSON.stringify(legacy));
		const before = readFileSync(settings.file, "utf8");
		let opened = 0;
		await expect(
			ordinaryRunLive({
				...settings,
				openStub: async () => {
					opened++;
					throw new Error("must not open");
				},
			}),
		).rejects.toThrow("no durable reservation accounting");
		expect(opened).toBe(0);
		expect(readFileSync(settings.file, "utf8")).toBe(before);
	});

	it.each([
		{ name: "missing", value: undefined },
		{ name: "old", value: 1 },
		{ name: "future", value: 3 },
		{ name: "null", value: null },
		{ name: "string", value: "2" },
		{ name: "array", value: [2] },
		{ name: "object", value: { version: 2 } },
		{ name: "boolean", value: true },
		{ name: "fraction", value: 2.5 },
	])(
		"refuses accounting versions independently of valid raw accounting: $name",
		async ({ value }) => {
			const server = await start();
			const settings = options(server);
			await runLive(settings);
			const recorded = read(settings.file);
			expect(recorded.data.session).toMatchObject({
				accountingVersion: 2,
				calls: 3,
				revoked: "no",
			});
			expect(recorded.data.session.accountedUsd).toBeGreaterThan(0);
			expect(recorded.data.revocation).toBeNull();
			if (value === undefined) delete recorded.data.session.accountingVersion;
			else recorded.data.session.accountingVersion = value;
			const before = Buffer.from(JSON.stringify(recorded));
			writeFileSync(settings.file, before);
			const sent = server.received.length;
			let opened = 0;
			const error = await failure(
				ordinaryRunLive({
					...settings,
					openStub: async (pin) => {
						opened++;
						return stubs(server)(pin);
					},
				}),
			);
			expect(opened).toBe(0);
			expect(server.received).toHaveLength(sent);
			expect(readFileSync(settings.file)).toEqual(before);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("no durable reservation accounting");
		},
	);

	it("retains raw accounted reservations when a resumed display amount was rounded down", async () => {
		const server = await start();
		const settings = options(server);
		await runLive(settings);
		const recorded = read(settings.file);
		recorded.data.session.step = "stopped";
		recorded.data.session.costUsd = 0.7;
		recorded.data.session.accountedUsd = 0.7000004;
		recorded.data.stops = [{ calls: 3, call: "parse-effort", stop: "no answer" }];
		writeFileSync(settings.file, JSON.stringify(recorded));
		const sent = server.received.length;
		await expect(runLive(settings)).rejects.toThrow("could pass US$1.00");
		expect(server.received).toHaveLength(sent);
		expect(read(settings.file).data.session.accountedUsd).toBe(0.7000004);
	});

	it("refuses malformed version2 request counters before opening transport and preserves their bytes", async () => {
		const server = await start();
		const settings = options(server);
		await runLive(settings);
		const valid = read(settings.file);
		for (const [calls, checks] of [
			[3, -1],
			[3, 0.5],
			[3, Number.MAX_SAFE_INTEGER + 1],
			[Number.MAX_SAFE_INTEGER, 1],
			[3, "nonfinite"],
			[3, "invalid-container"],
		]) {
			const malformed = structuredClone(valid);
			malformed.data.session.calls = calls;
			malformed.data.revocation = checks === "invalid-container" ? [] : { checks };
			const bytes = JSON.stringify(malformed).replace('"checks":"nonfinite"', '"checks":1e309');
			writeFileSync(settings.file, bytes);
			let opened = 0;
			await expect(
				ordinaryRunLive({
					...settings,
					openStub: async () => {
						opened++;
						throw new Error("must not open");
					},
				}),
			).rejects.toThrow("isn't an S9b session record");
			expect(opened).toBe(0);
			expect(readFileSync(settings.file, "utf8")).toBe(bytes);
		}
	});

	it("keeps full reservations for incomplete successful usage and unknown model prices", async () => {
		for (const body of [
			message(DEFAULT_MODEL, { usage: { input_tokens: 100 } }),
			message(DEFAULT_MODEL, {
				usage: { iterations: [{ model: DEFAULT_MODEL, input_tokens: 100, output_tokens: 1 }, {}] },
			}),
			message("claude-unlisted", { usage: { input_tokens: 100, output_tokens: 1 } }),
		]) {
			const server = await start(() => ({ status: 200, body }));
			const strict = meter(await stubs(server)({ model: DEFAULT_MODEL, effort: DRAFT_EFFORT }));
			const planned = plannedCalls(false)[1];
			if (!planned) throw new Error("missing plain fixture");
			await createClient(strict, { maxRetries: 0 })
				.beta.messages.parse(planned.params, { headers: planned.headers })
				.catch(() => null);
			expect(strict.spentUsd()).toBe(strict.attempts[0]?.worstUsd);
			await server.close();
			open = undefined;
		}
	});

	it.each([
		{
			name: "unknown final model",
			model: "claude-unlisted",
			serving: DEFAULT_MODEL,
			type: "message",
			retain: true,
		},
		{
			name: "inconsistent serving model",
			model: DEFAULT_MODEL,
			serving: "claude-opus-4-8",
			type: "message",
			retain: true,
		},
		{
			name: "non-serving iteration type",
			model: DEFAULT_MODEL,
			serving: DEFAULT_MODEL,
			type: "advisor",
			retain: true,
		},
		{
			name: "consistent serving model",
			model: DEFAULT_MODEL,
			serving: DEFAULT_MODEL,
			type: "message",
			retain: false,
		},
	])(
		"persists ordinary revocation accounting for ambiguous serving attribution: $name",
		async ({ model, serving, type, retain }) => {
			const server = await start();
			const settings = options(server);
			await runLive(settings);
			let accounted = read(settings.file).data.session.accountedUsd as number;
			const pending: number[] = [];
			const reservations: number[] = [];
			const body = message(model, {
				content: [{ type: "text", text: JSON.stringify(draftOutput) }],
				usage: {
					input_tokens: 100,
					output_tokens: 1,
					iterations: [{ type, model: serving, input_tokens: 100, output_tokens: 1 }],
				},
			});
			server.script = (request) => {
				if (request.body.model !== CHECK_MODEL) return realistic(request);
				pending.push(read(settings.file).data.session.accountedUsd);
				const reservation = worstCase(request.body, Buffer.byteLength(request.raw));
				if (reservation === undefined) throw new Error("plain revocation reservation missing");
				reservations.push(reservation);
				return { status: 200, body };
			};
			for (let index = 0; index < 2; index++) {
				await expect(ordinaryRunLive(settings)).rejects.toThrow("the key still works (200)");
				const reservation = reservations[index] ?? 0;
				expect(reservation).toBeGreaterThan(0.00042);
				expect(pending[index]).toBeCloseTo(accounted + reservation, 9);
				accounted += retain ? reservation : 0.00042;
				const recorded = read(settings.file).data;
				expect(recorded.session.accountedUsd).toBeCloseTo(accounted, 9);
				expect(recorded.session.costUsd).toBe(Math.round(accounted * 1e6) / 1e6);
				expect(recorded.session).toMatchObject({ accountingVersion: 2, calls: 3, revoked: "no" });
				expect(recorded.revocation).toMatchObject({ checks: index + 1, check: "200", deleted: [] });
				expect(server.received).toHaveLength(4 + index);
			}
			expect(costOf(body)).toBe(retain ? undefined : 0.00042);
			expect(await guard(repoOf(settings.file), AbortSignal.timeout(10_000))).toEqual([]);
			const recorded = readFileSync(settings.file, "utf8");
			expect(recorded).not.toContain(key.reveal());
			expect(recorded).not.toContain(canary);
			expect(held(settings.envLive, KEY_NAME)).toBe(key.reveal());
		},
	);
});

describe("limits and stops", () => {
	it("retains non2xx reservations through actual SDK retries and durable resume", async () => {
		const server = await start((request) =>
			"fallbacks" in request.body
				? realistic(request)
				: {
						...errorReply(500, "api_error", "synthetic failure"),
						headers: { "retry-after-ms": "1" },
					},
		);
		const settings = options(server);
		await expect(runLive(settings)).rejects.toThrow("500 api_error");
		expect(server.received).toHaveLength(3);
		const errors = server.received.slice(1);
		const reserve = errors.reduce((total, request) => total + unanswered(request.raw), 0);
		const accounted = read(settings.file).data.session.accountedUsd;
		expect(accounted).toBeGreaterThanOrEqual(reserve);
		expect(accounted).toBeGreaterThan(0.7);
		await expect(runLive(settings)).rejects.toThrow("could pass US$1.00");
		expect(server.received).toHaveLength(3);
		expect(read(settings.file).data.session.accountedUsd).toBeGreaterThanOrEqual(accounted);
	});

	it("refuses a 7th request before it is sent", async () => {
		const server = await start();
		const metered = fixtureMeter(
			await stubs(server)({ model: DEFAULT_MODEL, effort: DRAFT_EFFORT }),
		);
		const tiny = plannedCalls(false).find((call) => call.label === "max-tokens");
		if (!tiny) throw new Error("no max-tokens call");
		const client = createClient(metered, { maxRetries: 1 });
		const error = await failure(runSession(client, metered, Array(7).fill(tiny)));
		expect(error).toBeInstanceOf(StopError);
		expect(error).toMatchObject({
			reason: "call-cap",
			message: "max-tokens: refused before sending: all 6 requests are used",
		});
		expect(server.received).toHaveLength(6);
		expect(metered.attempts).toHaveLength(6);
	});

	it("records each request before it is sent, so a run that dies still counts it", async () => {
		const server = await start();
		const settings = options(server);
		const seen: unknown[] = [];
		const reservations: Array<readonly [number, number]> = [];
		server.script = (request) => {
			const data = existsSync(settings.file) ? read(settings.file).data : null;
			const stop = data?.stops.at(-1)?.stop;
			const hash = held(settings.envLive, HASH_NAME);
			seen.push(data && { step: data.session.step, calls: data.session.calls, stop, hash });
			if (data) reservations.push([data.session.accountedUsd, unanswered(request.raw)]);
			return realistic(request);
		};
		await runLive(settings);
		// The key's hash is in .env.live from the first request on.
		const hash = sha256(key.reveal());
		const pending = (calls: number) => ({ step: "stopped", calls, stop: "interrupted", hash });
		expect(seen).toEqual([pending(1), pending(2), pending(3)]);
		for (const [accounted, reservation] of reservations)
			expect(accounted).toBeGreaterThanOrEqual(reservation);
		expect(read(settings.file).data).toMatchObject({
			session: { step: "session", calls: 3 },
			stops: [],
		});
	});

	it("refuses a request whose worst case could take the estimate past US$1, and ends the session", async () => {
		const usage = { input_tokens: 1_200, output_tokens: 40_000, iterations: null };
		const server = await start((request) =>
			request.body.model === CHECK_MODEL
				? realistic(request)
				: {
						body: message(String(request.body.model), {
							content: [{ type: "text", text: JSON.stringify(draftOutput) }],
							usage,
						}),
					},
		);
		const settings = options(server);
		await expect(runLive(settings)).rejects.toThrow(
			/^parse-effort: refused before sending: US\$0\.8048 estimated and up to US\$0\.\d{4} more could pass US\$1\.00 \(1 of 6 requests used, US\$0\.8048 estimated, recorded in .+\); the session can't go on: revoke the key in the Claude Console, then run the same command again$/,
		);
		expect(server.received).toHaveLength(1);
		const { data } = read(settings.file);
		expect(data).toMatchObject({
			session: { step: "stopped", calls: 1, costUsd: 0.8048, revoked: "no" },
			acceptance: [],
			calls: [],
		});
		expect(data.stops).toEqual([
			{
				ranAt: expect.any(String),
				calls: 1,
				costUsd: 0.8048,
				call: "parse-effort",
				stop: "budget",
			},
		]);
		// Nothing more fits, so the next run is the revocation check, not another session.
		await expect(runLive(settings)).rejects.toThrow("the key still works (404 not_found_error)");
		expect(server.received.map((request) => request.body.model)).toEqual([
			DEFAULT_MODEL,
			CHECK_MODEL,
		]);
	});

	it("retains an early error reservation and refuses a retry that cannot fit", async ({
		signal,
	}) => {
		const server = await start((request) =>
			request.body.model === CHECK_MODEL ? realistic(request) : overloaded(),
		);
		const settings = options(server);
		await expect(runLive(settings)).rejects.toThrow("could pass US$1.00");
		const stop = {
			ranAt: expect.any(String),
			calls: 1,
			costUsd: expect.closeTo(unanswered(server.received[0]?.raw ?? ""), 5),
			call: "fallbacks",
			stop: "budget",
		};
		expect(read(settings.file).data).toMatchObject({
			session: { step: "stopped", calls: 1, revoked: "no" },
			stops: [stop],
		});
		expect(await guard(repoOf(settings.file), signal)).toEqual([]);
		expect(server.received).toHaveLength(1);
		await expect(runLive(settings)).rejects.toThrow("the key still works (404 not_found_error)");
		expect(server.received).toHaveLength(2);
		expect(read(settings.file).data.session.accountedUsd).toBeGreaterThan(0.9);
	});

	it("goes to the revocation check once stops leave too few requests for a session", async () => {
		const server = await start((request) =>
			request.body.max_tokens === TINY_MAX_TOKENS ? overloaded() : realistic(request),
		);
		const settings = options(server);
		await expect(runLive(settings)).rejects.toThrow(
			/\(4 of 6 requests used, US\$0\.\d{4} estimated, recorded in [^)]+\); the session can't go on: revoke the key in the Claude Console, then run the same command again$/,
		);
		await expect(runLive(settings)).rejects.toThrow("the key still works (404 not_found_error)");
		expect(server.received.map((request) => request.body.model)).toEqual([
			...Array(4).fill(DEFAULT_MODEL),
			CHECK_MODEL,
		]);
		expect(read(settings.file).data).toMatchObject({
			session: { step: "stopped", calls: 4, revoked: "no" },
			revocation: { check: "404 not_found_error", checks: 1, deleted: [] },
		});
		// The last request left confirms the revocation; the session itself never ran.
		const revoked = await runLive({ ...settings, openStub: stubs(server, new Secret(fakeKey())) });
		expect(revoked).toMatchObject({ step: "revocation", acceptance: ["revoked: yes"] });
		expect(linesOf(revoked)).toEqual([
			expect.stringMatching(
				/^the recorded session stopped and can't go on: 1 of 6 requests left, US\$0\.\d{4} estimated$/,
			),
			"revocation check: 401 authentication_error",
			`deleted from .env.live: ${KEY_NAME}, ${HASH_NAME}`,
			"revoked: yes",
			`evidence: ${settings.file}`,
			"next: the session didn't finish: ADR 0011 records S9b as not run, unless the owner allows a new session with a new key (move evidence/live.json away first)",
		]);
	});

	it("keeps the session when retries leave no request to spare for the probe", async () => {
		const server = await start((request) =>
			!("fallbacks" in request.body) && firstTry(request) ? overloaded() : realistic(request),
		);
		const env = envLive({ [KEY_NAME]: key.reveal(), [PROBE_FLAG]: "yes" });
		const settings = options(server, { envLive: env });
		const outcome = await runLive(settings);
		expect(outcome).toMatchObject({
			step: "session",
			acceptance: [
				...SESSION_ACCEPTANCE,
				"refusal: from the documentation (probe not run: no request left)",
			],
		});
		expect(linesOf(outcome)).toContain("refusal-probe: not sent (no request left)");
		expect(server.received).toHaveLength(5);
		expect(read(settings.file).data.calls[3]).toMatchObject({
			label: "refusal-probe",
			skipped: "no request left",
			failed: null,
			attempts: [],
			result: null,
		});
	});

	it("records a probe the API doesn't answer, sends it once, and keeps the session", async () => {
		const server = await start((request) =>
			request.body.max_tokens === 2_048 ? overloaded() : realistic(request),
		);
		const env = envLive({ [KEY_NAME]: key.reveal(), [PROBE_FLAG]: "yes" });
		const settings = options(server, { envLive: env });
		expect(await runLive(settings)).toMatchObject({
			acceptance: [...SESSION_ACCEPTANCE, "refusal: probe failed (529 overloaded_error)"],
		});
		expect(server.received).toHaveLength(4);
		expect(read(settings.file).data.calls[3]).toMatchObject({
			skipped: null,
			failed: "529 overloaded_error",
			attempts: [{ response: { status: 529 } }],
		});
	});

	it("retries a lost answer while retaining its full admitted reservation", async () => {
		const server = await start();
		const settings = options(server);
		const outcome = await network(
			(nth) => (nth === 2 ? "after" : null),
			() => runLive(settings),
		);
		expect(outcome).toMatchObject({
			step: "session",
			acceptance: [...SESSION_ACCEPTANCE, "refusal: from the documentation"],
		});
		// The fake had the first request, and the SDK sent it again.
		expect(server.received).toHaveLength(4);
		const lost = unanswered(server.received[1]?.raw ?? "");
		const { data } = read(settings.file);
		expect(data.calls[1].attempts).toMatchObject([
			{ response: null, costUsd: expect.closeTo(lost, 5) },
			{ response: { status: 200 }, costUsd: 0.0108 },
		]);
		expect(data.session).toMatchObject({ calls: 4, costUsd: expect.closeTo(0.02672 + lost, 5) });
	});

	it("persists both lost-call reservations and refuses a resume that cannot fit another call", async () => {
		const server = await start();
		const settings = options(server);
		const dropped = (nth: number) => (nth === 2 || nth === 3 ? "before" : null);
		await expect(network(dropped, () => runLive(settings))).rejects.toThrow(
			/^parse-effort: no answer \(Connection error\.\): run the same command again later \(3 of 6 requests used, US\$0\.\d{4} estimated, recorded in .+\)$/,
		);
		expect(server.received).toHaveLength(1);
		expect(read(settings.file).data).toMatchObject({
			session: { step: "stopped", calls: 3 },
			stops: [{ calls: 3, call: "parse-effort", stop: "no answer" }],
		});
		const reserved = read(settings.file).data.session.accountedUsd;
		expect(reserved).toBeGreaterThan(0.7);
		await expect(runLive(settings)).rejects.toThrow("could pass US$1.00");
		expect(server.received).toHaveLength(1);
		expect(read(settings.file).data.session.accountedUsd).toBeGreaterThanOrEqual(reserved);
		expect(read(settings.file).data.session.calls).toBe(3);
		await expect(runLive(settings)).rejects.toThrow("the key still works (404 not_found_error)");
		expect(server.received).toHaveLength(2);
	});

	it("stops at the first call when the API refuses the key, and records the request", async () => {
		const server = await start();
		const settings = options(server, { openStub: stubs(server, new Secret(fakeKey())) });
		await expect(runLive(settings)).rejects.toThrow(
			`fallbacks: the API refused the key (401 authentication_error: invalid x-api-key): check ${KEY_NAME} (1 of 6 requests used`,
		);
		expect(server.received).toHaveLength(1);
		expect(read(settings.file).data.stops).toMatchObject([
			{
				calls: 1,
				costUsd: expect.closeTo(unanswered(server.received[0]?.raw ?? ""), 5),
				call: "fallbacks",
				stop: "401 authentication_error",
			},
		]);
	});

	// What the API answers when the account can't pay: these say nothing about the request.
	const unpaid: [string, Reply][] = [
		[
			"a spend limit the owner set",
			errorReply(
				400,
				"invalid_request_error",
				"You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
			),
		],
		[
			"too little credit",
			errorReply(
				400,
				"invalid_request_error",
				"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
			),
		],
		[
			"a tier's spend cap",
			{
				status: 429,
				body: {
					type: "error",
					error: {
						type: "rate_limit_error",
						message: "This organization has reached its monthly spend cap.",
						details: { error_code: "enforced_spend_limit_reached" },
					},
				},
			},
		],
	];
	it.each(unpaid)(
		"stops at %s without a retry or acceptance, and keeps the reservation after account recovery",
		async (_case, reply) => {
			let paid = false;
			const server = await start((request) => (paid ? realistic(request) : reply));
			const settings = options(server);
			const status = reply.status ?? 200;
			await expect(runLive(settings)).rejects.toThrow(
				new RegExp(
					`^fallbacks: the account can't pay for it \\(${status} \\w+: .+\\): raise the workspace's spend limit or add credits in the Claude Console, then run the same command again \\(1 of 6 requests used, US\\$0\\.\\d{4} estimated, recorded in .+\\)$`,
				),
			);
			expect(server.received).toHaveLength(1);
			const text = readFileSync(settings.file, "utf8");
			const said = String((reply.body.error as { message: string }).message);
			expect(text).not.toContain(said.slice(0, 20));
			expect(JSON.parse(text).data).toMatchObject({
				session: {
					step: "stopped",
					calls: 1,
					accountedUsd: expect.closeTo(unanswered(server.received[0]?.raw ?? ""), 9),
					revoked: "no",
				},
				acceptance: [],
				stops: [{ calls: 1, call: "fallbacks", stop: `${status} usage limit` }],
			});
			paid = true;
			await expect(runLive(settings)).rejects.toThrow("could pass US$1.00");
			expect(server.received).toHaveLength(1);
			expect(read(settings.file).data.session.accountedUsd).toBeGreaterThan(0.8);
		},
	);

	it("prices known usage per attempt and model, retains unknown-model reservations, and bounds fixtures", () => {
		expect(costOf(replies.draft(DEFAULT_MODEL).body)).toBeCloseTo(0.0108, 9);
		// A declined Opus 5.5 attempt (1,200 in) and Opus 4.8 serving it (1,200 in, 280 out).
		const served = replies.fallback([DEFAULT_MODEL, "claude-opus-4-8"]).body;
		expect(costOf(served)).toBeCloseTo(0.0178, 9);
		const unknown = message("claude-unlisted", {
			usage: { input_tokens: 1_000, output_tokens: 1_000 },
		});
		expect(costOf(unknown)).toBeUndefined();
		const request = { model: DEFAULT_MODEL, max_tokens: 16_000 };
		expect(worstCase(request, 1_000)).toBeCloseTo(0.356768, 9);
		expect(worstCase({ ...request, fallbacks: "default" }, 1_000)).toBeUndefined();
		expect(
			worstCase({ ...request, fallbacks: "default" }, 1_000, 8_192, syntheticRouting),
		).toBeCloseTo(0.882728, 9);
		expect(worstCase("not JSON", 9)).toBe(0);
		// Prompt-only comparison; an unanswered attempt retains its full reservation.
		expect(promptCost({ ...request, fallbacks: "default" }, 1_000)).toBeCloseTo(0.036768, 9);
		expect(promptCost("not JSON", 9)).toBe(0);
	});
});

describe("before any call", () => {
	it("skips without the key, through liveStub and the kit", async () => {
		const file = evidenceFile();
		expect(await runLive({ file, openStub: liveStub })).toEqual({
			step: "skipped",
			reason: `${KEY_NAME} is not in .env.live: no session run (spikes/s09-messages-api/notes/session.md)`,
		});
		expect(existsSync(file)).toBe(false);
	});

	const anthropic = { ANTHROPIC_CUSTOM_HEADERS: "x-note: 1", anthropic_log: "debug" };
	it.each([
		[
			"an ANTHROPIC_* variable",
			{ env: { DRAFTYAK_RECORD_EVIDENCE: "1", ...anthropic } },
			"unset ANTHROPIC_CUSTOM_HEADERS, anthropic_log first: the SDK reads ANTHROPIC_* variables",
		],
		["no DRAFTYAK_RECORD_EVIDENCE=1", { env: {} }, "set DRAFTYAK_RECORD_EVIDENCE=1"],
		[
			"a dirty tree",
			{ fingerprint: async () => ({ ...clean, dirty: true }) },
			"live evidence comes from a clean tree: commit or stash first (dirty: true)",
		],
		[
			"a probe flag that isn't yes or no",
			{ envLive: envLive({ [KEY_NAME]: key.reveal(), [PROBE_FLAG]: "maybe" }) },
			`${PROBE_FLAG} in .env.live is yes or no`,
		],
		[
			"a request it can't record first",
			{
				fingerprint: async () => ({
					...clean,
					load: { ...clean.load, cpuModel: ["10", "0", "0", "1"].join(".") },
				}),
			},
			"fallbacks: refused before sending: it couldn't be recorded first",
		],
	] satisfies [string, Partial<LiveOptions>, string][])(
		"refuses %s",
		async (_case, extra, problem) => {
			const server = await start();
			const settings = options(server, extra);
			await expect(runLive(settings)).rejects.toThrow(problem);
			expect(server.received).toHaveLength(0);
			expect(existsSync(settings.file)).toBe(false);
			expect(held(settings.envLive, HASH_NAME)).toBeNull();
		},
	);
});

describe("after the session", () => {
	it("retains an unanswered revocation reservation across its next check", async () => {
		const server = await start();
		const settings = options(server);
		await runLive(settings);
		const before = read(settings.file).data.session.accountedUsd;
		const pending: number[] = [];
		server.script = (request) => {
			if (request.body.model === CHECK_MODEL)
				pending.push(read(settings.file).data.session.accountedUsd);
			return realistic(request);
		};
		await expect(
			network(
				() => "after",
				() => runLive(settings),
			),
		).rejects.toThrow("revocation check got no verdict (no answer)");
		const held = read(settings.file).data.session.accountedUsd;
		expect(held).toBeCloseTo(before + unanswered(server.received.at(-1)?.raw ?? ""), 9);
		expect(pending[0]).toBeCloseTo(held, 9);
		await expect(runLive(settings)).rejects.toThrow("the key still works (404 not_found_error)");
		expect(read(settings.file).data.session.accountedUsd).toBeGreaterThanOrEqual(held);
		expect(read(settings.file).data.revocation.checks).toBe(2);
		expect(server.received).toHaveLength(5);
	});

	it("checks the revoked key once, then deletes the entries and records revoked: yes", async () => {
		const server = await start();
		const env = envLive({ [KEY_NAME]: key.reveal(), [PROBE_FLAG]: "no" });
		const settings = options(server, { envLive: env });
		await runLive(settings);
		const recorded = read(settings.file);
		// Authentication state is unchanged; the status request retains its reservation.
		await expect(runLive(settings)).rejects.toThrow(
			"the key still works (404 not_found_error): revoke it in the Claude Console, then run this again",
		);
		const check = { checkedAt: expect.any(String), check: "404 not_found_error", checks: 1 };
		expect(read(settings.file).data).toEqual({
			...recorded.data,
			session: {
				...recorded.data.session,
				costUsd: expect.any(Number),
				accountedUsd: expect.closeTo(
					recorded.data.session.accountedUsd + unanswered(server.received.at(-1)?.raw ?? ""),
					9,
				),
			},
			revocation: { ...check, deleted: [] },
		});
		expect(loadEnvLive([KEY_NAME, PROBE_FLAG], env)).toBeTruthy();
		// Revoked: the fake now refuses the key the stub injects.
		const revoked = await runLive({ ...settings, openStub: stubs(server, new Secret(fakeKey())) });
		expect(revoked).toMatchObject({ step: "revocation", acceptance: ["revoked: yes"] });
		const after = read(settings.file);
		expect(after.fingerprint).toEqual(recorded.fingerprint);
		expect(after.data).toEqual({
			...recorded.data,
			session: {
				...recorded.data.session,
				revoked: "yes",
				costUsd: expect.any(Number),
				accountedUsd: expect.closeTo(
					recorded.data.session.accountedUsd +
						server.received.slice(3).reduce((total, request) => total + unanswered(request.raw), 0),
					9,
				),
			},
			revocation: {
				checkedAt: expect.any(String),
				check: "401 authentication_error",
				checks: 2,
				deleted: [KEY_NAME, PROBE_FLAG, HASH_NAME],
			},
		});
		expect(server.received.map((request) => request.body.model)).toEqual([
			...[DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL],
			...[CHECK_MODEL, CHECK_MODEL],
		]);
		expect(server.received.at(-1)?.body.max_tokens).toBe(1);
		expect(() => loadEnvLive([KEY_NAME], env)).toThrow(/not set in .*DY_LIVE_MESSAGES_API_KEY/s);
		expect([held(env, PROBE_FLAG), held(env, HASH_NAME)]).toEqual([null, null]);
		// With the key gone from that .env.live, the next run skips and sends nothing.
		expect(await runLive({ ...settings, openStub: fromEnv(server, env) })).toEqual({
			step: "skipped",
			reason: `${KEY_NAME} is not in .env.live: the recorded session's key is revoked (spikes/s09-messages-api/notes/session.md)`,
		});
		expect(server.received).toHaveLength(5);
	});

	it("records revoked: yes before it deletes anything, so a failed write keeps the entries", async () => {
		const server = await start();
		const env = envLive({ [KEY_NAME]: key.reveal(), [PROBE_FLAG]: "no" });
		const settings = options(server, { envLive: env });
		await runLive(settings);
		// The check is recorded and sent and the API answers 401; then a folder stands where
		// live.json was, so the result can't be written.
		let held = "";
		const blocked = async (pin: Pin): Promise<CtxFetchStub> => {
			const stub = createCtxFetchStub({ upstream: server.url, key: new Secret(fakeKey()), pin });
			const fetch = async (input: string | URL | Request, init?: RequestInit) => {
				const response = await stub.fetch(input, init);
				held = readFileSync(settings.file, "utf8");
				rmSync(settings.file);
				mkdirSync(settings.file);
				return response;
			};
			return { fetch, requests: stub.requests };
		};
		await expect(runLive({ ...settings, openStub: blocked })).rejects.toThrow(/rename/);
		expect(loadEnvLive([KEY_NAME, PROBE_FLAG], env)).toBeTruthy();
		// The check was counted before it left.
		expect(JSON.parse(held).data).toMatchObject({
			session: { revoked: "no" },
			revocation: { check: "interrupted", checks: 1, deleted: [] },
		});
		// With the record back, the same command finishes the step, and the lost check still counts.
		rmSync(settings.file, { recursive: true });
		writeFileSync(settings.file, held);
		const revokedKey = stubs(server, new Secret(fakeKey()));
		expect(await runLive({ ...settings, openStub: revokedKey })).toMatchObject({
			step: "revocation",
			acceptance: ["revoked: yes"],
		});
		expect(read(settings.file).data.revocation).toMatchObject({
			check: "401 authentication_error",
			checks: 2,
			deleted: [KEY_NAME, PROBE_FLAG, HASH_NAME],
		});
		expect(() => loadEnvLive([KEY_NAME], env)).toThrow(/not set in /);
		expect(server.received).toHaveLength(5);
	});

	it("sends no check it can't record first", async () => {
		const server = await start();
		const env = envLive({ [KEY_NAME]: key.reveal(), [PROBE_FLAG]: "no" });
		const settings = options(server, { envLive: env });
		await runLive(settings);
		// A fingerprint the evidence rules refuse, so no record of the check can be written.
		const broken = read(settings.file);
		broken.fingerprint.load.cpuModel = ["10", "0", "0", "1"].join(".");
		const text = `${JSON.stringify(broken, null, 2)}\n`;
		writeFileSync(settings.file, text);
		await expect(
			runLive({ ...settings, openStub: stubs(server, new Secret(fakeKey())) }),
		).rejects.toThrow(
			/^revocation check: refused before sending: it couldn't be recorded first \(.+content-shaped values at \$\.fingerprint\.load\.cpuModel \(ipv4\)\)$/,
		);
		expect(server.received).toHaveLength(3);
		expect(readFileSync(settings.file, "utf8")).toBe(text);
		expect(loadEnvLive([KEY_NAME, PROBE_FLAG], env)).toBeTruthy();
	});

	it("leaves a record with revoked: yes alone while .env.live still holds a key, and sends nothing", async () => {
		const server = await start();
		const env = envLive({ [KEY_NAME]: key.reveal() });
		const settings = options(server, { envLive: env });
		await runLive(settings);
		await runLive({ ...settings, openStub: stubs(server, new Secret(fakeKey())) });
		const recorded = readFileSync(settings.file, "utf8");
		// As if deleting the entry had failed, or a new key went in with the record still there.
		saveEnvLive(KEY_NAME, key.reveal(), env);
		await expect(runLive({ ...settings, openStub: fromEnv(server, env) })).rejects.toThrow(
			`records revoked: yes, but .env.live still holds ${KEY_NAME}`,
		);
		expect(server.received).toHaveLength(4);
		expect(readFileSync(settings.file, "utf8")).toBe(recorded);
	});

	it("sends nothing and records nothing when all 6 calls are used, and says what to do", async () => {
		const server = await start();
		const env = envLive({ [KEY_NAME]: key.reveal(), [PROBE_FLAG]: "no" });
		const settings = options(server, { envLive: env });
		await runLive(settings);
		const recorded = read(settings.file);
		const used = { ...recorded.data, session: { ...recorded.data.session, calls: 6 } };
		await writeEvidence(settings.file, used, { fingerprint: recorded.fingerprint });
		const before = readFileSync(settings.file, "utf8");
		await expect(runLive(settings)).rejects.toThrow(
			"the key can't be checked (not run: all 6 calls are used): once the owner confirms the revocation, delete the entries as notes/session.md shows and record it in ADR 0011",
		);
		expect(server.received).toHaveLength(3);
		expect(readFileSync(settings.file, "utf8")).toBe(before);
		expect(loadEnvLive([KEY_NAME, PROBE_FLAG], env)).toBeTruthy();
	});

	it("counts only the API's own 401 authentication_error as revoked", async () => {
		const server = await start();
		const env = envLive({ [KEY_NAME]: key.reveal(), [PROBE_FLAG]: "no" });
		const settings = options(server, { envLive: env });
		await runLive(settings);
		// A 401 from something on the way, without the API's error body.
		server.script = (request) =>
			request.body.model === CHECK_MODEL
				? { status: 401, body: { message: "Unauthorized" } }
				: realistic(request);
		await expect(runLive(settings)).rejects.toThrow(
			"the revocation check got no verdict (401 error): run the same command again later",
		);
		expect(read(settings.file).data).toMatchObject({
			session: { revoked: "no" },
			revocation: { check: "401 error", checks: 1, deleted: [] },
		});
		expect(loadEnvLive([KEY_NAME, PROBE_FLAG, HASH_NAME], env)).toBeTruthy();
		expect(server.received).toHaveLength(4);
	});

	it("checks only the session's own key: a replaced key or a lost hash stops the run first", async () => {
		const server = await start();
		const env = envLive({ [KEY_NAME]: key.reveal(), [PROBE_FLAG]: "no" });
		const settings = options(server, { envLive: env });
		await runLive(settings);
		const recorded = readFileSync(settings.file, "utf8");
		// As if the clipboard command had run again on something else: a 401 for it proves nothing.
		saveEnvLive(KEY_NAME, fakeKey(), env);
		await expect(runLive({ ...settings, openStub: fromEnv(server, env) })).rejects.toThrow(
			`${KEY_NAME} isn't the key that made the recorded requests (${HASH_NAME} in .env.live)`,
		);
		// The session's key is back, but its hash is gone.
		saveEnvLive(KEY_NAME, key.reveal(), env);
		deleteEnvLive([HASH_NAME], env);
		await expect(runLive(settings)).rejects.toThrow(
			`the key can't be tied to the recorded session (${HASH_NAME} isn't in .env.live)`,
		);
		expect(server.received).toHaveLength(3);
		expect(readFileSync(settings.file, "utf8")).toBe(recorded);
		expect(loadEnvLive([KEY_NAME, PROBE_FLAG], env)).toBeTruthy();
	});

	it("won't run without the record once the key has made requests, so the 6 can't start over", async () => {
		const server = await start();
		const env = envLive({ [KEY_NAME]: key.reveal(), [PROBE_FLAG]: "no" });
		const settings = options(server, { envLive: env });
		await runLive(settings);
		// Step 2 from another checkout, or after git clean -fdx or git stash -u.
		const elsewhere = { ...settings, file: evidenceFile() };
		await expect(runLive(elsewhere)).rejects.toThrow(
			`${elsewhere.file} is missing, but the key has made requests (${HASH_NAME} in .env.live)`,
		);
		rmSync(settings.file);
		await expect(runLive(settings)).rejects.toThrow(`${settings.file} is missing, but the key`);
		expect(server.received).toHaveLength(3);
		expect(existsSync(elsewhere.file)).toBe(false);
		// Starting over with the same key is the owner's call, and the hash goes first.
		deleteEnvLive([HASH_NAME], env);
		expect(await runLive(elsewhere)).toMatchObject({ step: "session" });
		expect(server.received).toHaveLength(6);
	});
});

describe("the live tier itself, with no key anywhere", () => {
	// A clean child: no outer Vitest state, colours, CI or git variables, and no .env.live.
	const inherited = /^(?:VITEST|TEST$|NODE_ENV$|DRAFTYAK_|FORCE_COLOR$|GITHUB_ACTIONS$|CI$|GIT_)/i;
	const liveTier = (strict: boolean, signal: AbortSignal): Promise<Run> => {
		const kept = Object.entries(process.env).filter(([name]) => !inherited.test(name));
		const env = {
			...Object.fromEntries(kept),
			NO_COLOR: "1",
			DRAFTYAK_ENV_LIVE: path.join(base, "no-such", ".env.live"),
		};
		const flags = ["--live", ...(strict ? ["--strict"] : []), "--reporter=default"];
		// Its own module cache, so it never shares open files with this run's.
		const cache = ["--fsModuleCachePath", fresh("vitest-cache")];
		const kit = path.join(repoRoot, "spikes", "kit", "run.ts");
		return run(process.execPath, [kit, ...flags, ...cache], { cwd: spikeDir, env, signal });
	};

	it("skips messages.live.test.ts cleanly", { timeout: 120_000 }, async ({ signal }) => {
		const result = await liveTier(false, signal);
		expect(result.stdout).toMatch(/Tests\s+1 skipped \(1\)/);
		expect(result.code).toBe(0);
	});

	it("fails it under DRAFTYAK_STRICT_SKIPS=1, naming the key", { timeout: 120_000 }, async ({
		signal,
	}) => {
		const result = await liveTier(true, signal);
		// The rest of the reason depends on whether this checkout holds a session record.
		expect(result.stdout + result.stderr).toContain(`cannot run: ${KEY_NAME} is not in .env.live:`);
		expect(result.code).toBe(1);
	});
});
