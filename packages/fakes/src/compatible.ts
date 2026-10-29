import { Hono } from "hono";
import { acceptsDraft, type Completion } from "./compatible/request.ts";
import {
	type CompatibleStep,
	createScript,
	type Prepared,
	prepareStep,
	streamed,
} from "./compatible/script.ts";
import { COMPATIBLE_MODEL } from "./compatible/wire.ts";
import { type Clock, createFaults, type Faults, wait } from "./faults.ts";
import type { Recorder } from "./recorder.ts";
import { createFake, type Fake } from "./server.ts";
import { rawTarget } from "./target.ts";

export type { CompatibleStep } from "./compatible/script.ts";
export {
	type ChatCompletionReply,
	COMPATIBLE_DRAFT,
	COMPATIBLE_MODEL,
	type CompatibleDraft,
	type CompatibleToolCall,
	type CompatibleUsage,
	chatCompletionBody,
	type OllamaChatReply,
	ollamaChatBody,
} from "./compatible/wire.ts";

/** A logical host under RFC 2606's .example: fetch stays in memory and listen binds 127.0.0.1. */
export const COMPATIBLE_HOST = "compatible.draftyak.example";
export const COMPATIBLE_CHAT_PATH = "/v1/chat/completions";
export const COMPATIBLE_OLLAMA_PATH = "/api/chat";
export const COMPATIBLE_MODELS_PATH = "/v1/models";
export const COMPATIBLE_TAGS_PATH = "/api/tags";

export interface CompatibleFakeOptions {
	readonly clock?: Clock;
	readonly recorder?: Recorder;
	/** Responses for completion requests in either dialect, one step per admitted request. */
	readonly steps?: readonly CompatibleStep[];
	/** The model the listings name by default and the draft fixture requires: COMPATIBLE_MODEL. */
	readonly model?: string;
	/** The ids both listings serve, at most 500: `[model]` by default. */
	readonly models?: readonly string[];
	/** Sent instead of both listings on every listing request, taking no step; not with `models`. */
	readonly listing?: CompatibleStep;
}

export interface CompatibleFake extends Fake {
	/** Encodes and snapshots trusted fixtures atomically; later changes to them change nothing. */
	enqueue(...steps: readonly CompatibleStep[]): void;
	/** Steps not yet taken by a request that reached the app. */
	pending(): number;
}

// The compatible core's own request cap, so its largest request still arrives whole.
const MAX_REQUEST_BYTES = 8 * 1_024 * 1_024;
const MAX_MODELS = 500;
const MODEL_ID = /^[!-~]{1,256}$/;
const encoder = new TextEncoder();

type Route = Completion | "models" | "tags";
const ROUTES = new Map<string, readonly [method: string, route: Route]>([
	[COMPATIBLE_CHAT_PATH, ["POST", "chat"]],
	[COMPATIBLE_OLLAMA_PATH, ["POST", "ollama"]],
	[COMPATIBLE_MODELS_PATH, ["GET", "models"]],
	[COMPATIBLE_TAGS_PATH, ["GET", "tags"]],
]);

function modelId(value: unknown): string {
	if (typeof value !== "string" || !MODEL_ID.test(value))
		throw new TypeError("A compatible model id is 1 to 256 visible ASCII characters");
	return value;
}

function listings(model: string, models: readonly string[] | undefined) {
	const ids: string[] = [];
	if (models === undefined) ids.push(model);
	else {
		if (models.length > MAX_MODELS) throw new RangeError("Compatible fake model listing limit");
		for (const id of models) {
			if (ids.length === MAX_MODELS) throw new RangeError("Compatible fake model listing limit");
			ids.push(modelId(id));
		}
	}
	const encoded = (value: unknown) => encoder.encode(JSON.stringify(value));
	return {
		models: encoded({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }),
		tags: encoded({ models: ids.map((name) => ({ name, model: name })) }),
	};
}

const failure = (status: number, error: string, headers?: HeadersInit): Response =>
	Response.json({ error }, { status, headers });

async function deliver(step: Prepared, request: Request): Promise<Response> {
	request.signal.throwIfAborted();
	if (step.delayMs > 0) await wait(step.delayMs, request.signal);
	request.signal.throwIfAborted();
	return new Response(streamed(step, request.signal), {
		status: step.status,
		headers: [...step.headers],
	});
}

// An after-app fault can replace a scripted body; cancel the unused one so its waits end.
function releasing(base: Faults): Faults {
	return {
		...base,
		async run(request, app) {
			let produced: Response | undefined;
			let returned: Response | undefined;
			try {
				returned = await base.run(request, async (forwarded) => {
					produced = await app(forwarded);
					return produced;
				});
				return returned;
			} finally {
				if (produced?.body && produced.body !== returned?.body)
					await produced.body.cancel().catch(() => {});
			}
		},
	};
}

/**
 * A finite scripted chat-completions-compatible upstream. `POST /v1/chat/completions` and Ollama's
 * `POST /api/chat` share one queue: each takes the next step when the request reaches the app,
 * after the shared 8 MiB intake, so a fault before the app takes none and one after it does.
 * `GET /v1/models` and `GET /api/tags` list the models, or send the `listing` step, and take no
 * step. Any other target gets 404, another method 405, and a request after the script runs out
 * 503. Steps are wire fixtures: nothing here verifies, accepts or authorizes a request, and a step
 * may break every limit its consumer enforces.
 */
export function createCompatibleFake(options: CompatibleFakeOptions = {}): CompatibleFake {
	return createCompatible(options, false);
}

/**
 * The same fake, refusing completion requests that are not the compatible core's draft request:
 * application/json in strict UTF-8 with no byte order mark, holding exactly `model` (the
 * option's), `messages` (system text, then user text), `stream: false` and either
 * `response_format` (json_object, or strict json_schema draft_output_v1) on /v1/chat/completions
 * or an object `format`, the schema, on /api/chat. The request still takes its step first, so a
 * refused one uses it up and gets a fixed 400.
 */
export function createCompatibleDraftFake(options: CompatibleFakeOptions = {}): CompatibleFake {
	return createCompatible(options, true);
}

function createCompatible(options: CompatibleFakeOptions, strict: boolean): CompatibleFake {
	const model = modelId(options.model ?? COMPATIBLE_MODEL);
	if (options.models !== undefined && options.listing !== undefined)
		throw new TypeError("A compatible fake takes models or a scripted listing, not both");
	const listing = listings(model, options.models);
	const scripted = options.listing === undefined ? undefined : prepareStep(options.listing);
	const script = createScript();
	script.enqueue(...(options.steps ?? []));
	const handler = async (request: Request): Promise<Response> => {
		const entry = ROUTES.get(rawTarget(request));
		if (entry === undefined) return failure(404, "not_found");
		const [method, route] = entry;
		if (request.method !== method) return failure(405, "method_not_allowed", { allow: method });
		if (route === "models" || route === "tags") {
			if (scripted !== undefined) return await deliver(scripted, request);
			return new Response(listing[route], { headers: { "content-type": "application/json" } });
		}
		const step = script.take();
		if (step === undefined) return failure(503, "script_exhausted");
		if (strict && !(await acceptsDraft(request, route, model)))
			return failure(400, "request_refused");
		return await deliver(step, request);
	};
	const app = new Hono();
	app.onError((error) => {
		throw error;
	});
	app.all("*", (context) => handler(context.req.raw));
	const fake = createFake(app, {
		host: COMPATIBLE_HOST,
		recorder: options.recorder,
		faults: releasing(createFaults({ clock: options.clock })),
		maxRequestBodyBytes: MAX_REQUEST_BYTES,
	});
	// Extend the createFake result itself, so resolveFakeTransport still recognizes it.
	return Object.assign(fake, { enqueue: script.enqueue, pending: script.pending });
}
