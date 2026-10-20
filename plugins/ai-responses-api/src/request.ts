import { aiProviderV1, type DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import { canonicalize } from "@draftyak/protocol/jcs";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { ResponsesError } from "./shared.ts";

export const API_URL = "https://api.openai.com/v1/responses";
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
z.config({ jitless: true });
// The shared contextRefs uniqueness metadata is not supported by strict Structured Outputs.
// The protocol parser still normalizes/deduplicates refs and validates every returned field.
const wireSchema = z.toJSONSchema(DraftOutputV1, {
	target: "draft-7",
	override: ({ jsonSchema }) => {
		delete jsonSchema.uniqueItems;
	},
});
const formatJson = canonicalize(zodTextFormat(z.fromJSONSchema(wireSchema), "draft_output"));

export interface Settings {
	readonly effort?: Effort;
}
export interface Pin {
	readonly model: string;
	readonly effort?: Effort;
}
export interface RequestBody {
	readonly model: string;
	readonly instructions: string;
	readonly input: readonly [{ readonly role: "user"; readonly content: string }];
	readonly text: {
		readonly format: {
			readonly type: "json_schema";
			readonly name: "draft_output";
			readonly strict: true;
			readonly schema: Record<string, unknown>;
		};
	};
	readonly reasoning?: { readonly effort: Effort };
	readonly stream: true;
	readonly store: false;
}
export interface ResponsesRequest {
	readonly method: "POST";
	readonly url: typeof API_URL;
	readonly headers: {
		readonly "content-type": "application/json";
		readonly authorization: "Bearer brokered";
	};
	readonly body: RequestBody;
}
export interface OutgoingRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: Headers | Readonly<Record<string, string>>;
	readonly body: unknown;
}
export type Verdict =
	| { readonly ok: true; readonly request: ResponsesRequest }
	| { readonly ok: false; readonly problems: readonly string[] };

export function buildRequest(input: DraftRequest, settings: Settings = {}): ResponsesRequest {
	try {
		const parsed = aiProviderV1.tools.ai_draft_generate.input.safeParse({
			model: input.model,
			system: input.system,
			prompt: input.prompt,
			contextIds: input.contextIds,
		});
		if (!parsed.success || (settings.effort !== undefined && !EFFORTS.includes(settings.effort)))
			throw new ResponsesError("INVALID_INPUT");
		return {
			method: "POST",
			url: API_URL,
			headers: { "content-type": "application/json", authorization: "Bearer brokered" },
			body: {
				model: parsed.data.model,
				instructions: parsed.data.system,
				input: [{ role: "user", content: parsed.data.prompt }],
				text: { format: JSON.parse(formatJson) as RequestBody["text"]["format"] },
				...(settings.effort === undefined ? {} : { reasoning: { effort: settings.effort } }),
				stream: true,
				store: false,
			},
		};
	} catch {
		throw new ResponsesError("INVALID_INPUT");
	}
}

// Rebuilding from allowlisted scalars also detaches the returned value from the caller's objects.
export function verifyRequest(request: OutgoingRequest, pin: Pin): Verdict {
	try {
		if (request.method !== "POST" || request.url !== API_URL)
			return { ok: false, problems: ["target: refused"] };
		const body = request.body as Partial<RequestBody> | null;
		if (body === null || typeof body !== "object" || Array.isArray(body))
			return { ok: false, problems: ["body: refused"] };
		const first = Array.isArray(body.input) && body.input.length === 1 ? body.input[0] : null;
		if (!first || typeof first !== "object" || first.role !== "user")
			return { ok: false, problems: ["input: refused"] };
		const clean = buildRequest(
			{
				model: pin.model,
				system: body.instructions as string,
				prompt: first.content,
				contextIds: [],
			},
			{ effort: pin.effort },
		);
		if (canonicalize(body) !== canonicalize(clean.body))
			return { ok: false, problems: ["body: refused"] };
		const headers = new Headers(request.headers);
		const accepted = new Headers(clean.headers);
		if (canonicalize(Object.fromEntries(headers)) !== canonicalize(Object.fromEntries(accepted)))
			return { ok: false, problems: ["headers: refused"] };
		return { ok: true, request: clean };
	} catch {
		return { ok: false, problems: ["request: refused"] };
	}
}
