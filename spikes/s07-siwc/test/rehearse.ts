import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnvLiveOptions } from "@draftyak/spike-kit";
import { type Access, type FakeAuth, type FakeAuthOptions, startFakeAuth } from "./fake-auth.ts";
import {
	type FakeResponses,
	MODELS,
	type Received,
	type Reply,
	requestId,
	startFakeResponses,
} from "./fake-responses.ts";
import { answer, SAMPLE_DRAFT } from "./harness.ts";
import { LIVE_JOB } from "./live-record.ts";
import { type LiveDeps, type LiveResult, runLiveSession } from "./live-session.ts";
import { API_KEY } from "./session-env.ts";

// The live procedure against M0.26's fakes, with a temporary .env.live and evidence folder: what the
// rehearsals (rehearsal.test.ts, rehearsal.heavy.test.ts) run. Nothing touches the real .env.live.

// A request this process sends: discovery, sign-in, refresh, revocation or through the broker.
export interface Sent {
	readonly url: URL;
	readonly method: string;
	readonly form: URLSearchParams;
}

// What GET /v1/models answers for an API key: {"object": "list", "data": [...]}, as the SDK's
// models.list() expects, unlike plan usage's {"models": [...]}.
export const keyModels = (ids: readonly string[]): Record<string, unknown> => ({
	object: "list",
	data: ids.map((id, index) => ({
		id,
		object: "model",
		created: 1_790_000_000 + index,
		owned_by: "system",
	})),
});

export interface RehearsalOptions {
	readonly auth?: Partial<FakeAuthOptions>;
	readonly script?: (request: Received) => Reply;
	readonly topLevel?: "reject" | "accept";
	// .env.live lines written before the run.
	readonly envLines?: readonly string[];
	// An API key the fake Responses endpoint accepts, saved as DY_LIVE_RESPONSES_API_KEY.
	readonly apiKey?: boolean;
	// The key's GET /v1/models answer; by default it lists the fake's models.
	readonly keyModels?: unknown;
	// An answer in place of the fakes' for a request this process sends (the hub process talks to the
	// fakes directly): a revocation that revokes nothing, a refresh that fails. A throw is a dropped
	// connection; undefined passes the request on.
	readonly intercept?: (request: Sent) => Response | undefined;
	// Where the evidence/ folder goes; a new temporary folder by default.
	readonly root?: string;
}

export interface Rehearsal {
	readonly auth: FakeAuth;
	readonly api: FakeResponses;
	readonly envFile: string;
	readonly envLive: EnvLiveOptions;
	readonly evidenceFile: string;
	readonly said: string[];
	readonly apiKey?: string;
	run(overrides?: Partial<LiveDeps>): Promise<LiveResult>;
	envText(): string;
	evidenceText(): string;
	// Every token, ID and synthetic text the evidence must never hold.
	secrets(): string[];
	close(): Promise<void>;
}

// The fake Responses endpoint's grants, plus the rehearsal's API key.
class Grants extends Map<string, Access> {
	readonly #inner: ReadonlyMap<string, Access>;
	readonly #key: string | undefined;
	readonly #grant: Access;

	constructor(inner: ReadonlyMap<string, Access>, key: string | undefined) {
		super();
		this.#inner = inner;
		this.#key = key;
		this.#grant = {
			clientId: "api-key",
			subject: "api-key",
			scopes: ["chatgpt.tokens.use.direct"],
			expiresAt: Number.MAX_SAFE_INTEGER,
			family: { revoked: false },
		};
	}

	override get(id: string): Access | undefined {
		return id === this.#key ? this.#grant : this.#inner.get(id);
	}
}

export async function rehearsal(options: RehearsalOptions = {}): Promise<Rehearsal> {
	const envDir = mkdtempSync(path.join(os.tmpdir(), "draftyak-s07-env-"));
	const root = options.root ?? mkdtempSync(path.join(os.tmpdir(), "draftyak-s07-evidence-"));
	const envFile = path.join(envDir, ".env.live");
	const evidenceFile = path.join(root, "spikes", "s07-siwc", "evidence", "live.json");
	mkdirSync(path.dirname(evidenceFile), { recursive: true });
	const apiKey = options.apiKey ? `rehearsal-key-${randomBytes(12).toString("hex")}` : undefined;
	const lines = [...(options.envLines ?? []), ...(apiKey ? [`${API_KEY}=${apiKey}`] : [])];
	writeFileSync(envFile, lines.map((line) => `${line}\n`).join(""));
	const auth = await startFakeAuth({
		subject: `user-rehearsal-${randomBytes(6).toString("hex")}`,
		email: `owner-${randomBytes(4).toString("hex")}@example.com`,
		...options.auth,
	});
	const api = await startFakeResponses(new Grants(auth.access, apiKey), options.script ?? answer);
	if (options.topLevel) api.topLevelFunctions = options.topLevel;
	const said: string[] = [];
	const wire = new Set<string>();
	const listed = options.keyModels ?? keyModels(MODELS.flatMap((model) => model.slug ?? []));
	// The parent's side of the wire: request IDs and the tokens the code exchange returns.
	const watched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const method = (init?.method ?? "GET").toUpperCase();
		const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
		const instead = options.intercept?.({ url, method, form });
		let response = instead ?? (await fetch(input, init));
		const bearer = new Headers(init?.headers).get("authorization");
		if (apiKey && bearer === `Bearer ${apiKey}` && url.pathname === "/v1/models" && response.ok) {
			await response.body?.cancel();
			response = Response.json(listed, { headers: { "x-request-id": requestId() } });
		}
		const id = response.headers.get("x-request-id");
		if (id) wire.add(id);
		if (response.headers.get("content-type")?.startsWith("application/json")) {
			const body: unknown = await response
				.clone()
				.json()
				.catch(() => undefined);
			for (const field of ["access_token", "refresh_token", "id_token"]) {
				const value = (body as Record<string, unknown> | undefined)?.[field];
				if (typeof value === "string") wire.add(value);
			}
		}
		return response;
	};
	const envLive: EnvLiveOptions = { env: { DRAFTYAK_ENV_LIVE: envFile } };
	const read = (file: string): string => {
		try {
			return readFileSync(file, "utf8");
		} catch {
			return "";
		}
	};
	return {
		auth,
		api,
		envFile,
		envLive,
		evidenceFile,
		said,
		...(apiKey !== undefined && { apiKey }),
		run: (overrides = {}) =>
			runLiveSession({
				run: "rehearsal",
				issuer: auth.url,
				apiOrigin: api.url,
				evidenceFile,
				openBrowser: auth.browse,
				say: (text) => said.push(text),
				envLive,
				env: {},
				port: 0,
				fetch: watched as typeof fetch,
				// Under a full parallel verify the fake sign-in alone can pass 20 s; the test's own limit is higher.
				signInTimeoutMs: 90_000,
				pollMs: 250,
				...overrides,
			}),
		envText: () => read(envFile),
		evidenceText: () => read(evidenceFile),
		secrets: () => {
			const params = auth.authorizations.flatMap((form) =>
				["ext_agent_host_id", "state", "nonce", "code_challenge"].map((key) => form.get(key) ?? ""),
			);
			const forms = auth.tokenForms.flatMap((form) =>
				["code", "code_verifier", "refresh_token"].map((key) => form.get(key) ?? ""),
			);
			const texts = [
				LIVE_JOB.prompt,
				LIVE_JOB.instructions,
				SAMPLE_DRAFT.body,
				SAMPLE_DRAFT.ownerNotes,
			];
			return [
				...auth.access.keys(),
				...auth.refresh.keys(),
				...auth.clients.keys(),
				...wire,
				...params,
				...forms,
				...texts,
				auth.options.subject,
				auth.options.email,
				...(apiKey ? [apiKey] : []),
			].filter((value) => value.length >= 8);
		},
		close: async () => {
			await Promise.all([auth.close(), api.close()]);
			rmSync(envDir, { recursive: true, force: true });
			if (options.root === undefined) rmSync(root, { recursive: true, force: true });
		},
	};
}
