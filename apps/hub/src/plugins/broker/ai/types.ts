import type { DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import type { HeaderList } from "@draftyak/protocol/hash";
import type { AiProfile } from "@draftyak/protocol/manifest/ai-http";
import type { EgressPolicy, PinnedAddress } from "../network/index.ts";

export type AiProviderSettings =
	| {
			readonly kind: "messages";
			readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
			readonly maxTokens: number;
			readonly stream: boolean | "omit";
			readonly fallback: boolean;
	  }
	| {
			readonly kind: "responses";
			readonly effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	  }
	| {
			readonly kind: "compatible";
			readonly format: "json_schema" | "json_object" | "ollama";
			readonly allowPlaintextLan: boolean;
	  };

/** Internal native data. This carries no caller, account, job or disclosure permission. */
export interface AiRequestBinding {
	readonly draft: DraftRequest;
	readonly settings: AiProviderSettings;
	readonly endpoint: string;
	readonly answers: readonly PinnedAddress[];
	readonly policy: EgressPolicy;
}
export type AiRequestBindingWithoutNetwork = Omit<AiRequestBinding, "answers" | "policy">;

/** Captured from the native provider invocation, never from host/fetch fields. */
export interface ResponsesMetadataBindingWithoutNetwork {
	readonly operation: "ai_models_list" | "ai_probe";
	readonly configuration: {
		readonly profile: "responses-api-v1";
		readonly endpoint: "https://api.openai.com/v1";
		readonly model?: string;
	};
	readonly input: Readonly<{ readonly model?: string }>;
}

declare const messagesCall: unique symbol;
export interface MessagesMetadataCall {
	readonly [messagesCall]: true;
}
export interface MessagesMetadataCallBinding {
	readonly operation: "ai_models_list" | "ai_probe";
	readonly configuration: {
		readonly profile: "messages-api-v1";
		readonly endpoint: "https://api.anthropic.com";
		readonly model?: string;
	};
	readonly input: Readonly<{ readonly model?: string }>;
}
export interface MessagesMetadataBindingWithoutNetwork {
	readonly operation: "ai_models_list" | "ai_probe";
	readonly call: MessagesMetadataCall;
}
declare const capturedInputs: unique symbol;
export interface CapturedAiRequestInputs {
	readonly [capturedInputs]: true;
}

export interface AiCandidateRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: HeaderList;
	readonly body: Uint8Array;
}

export interface AiRequestSnapshot {
	readonly profile: AiProfile;
	readonly method: "GET" | "POST";
	readonly url: string;
	readonly headers: HeaderList;
	readonly body: Uint8Array;
}

declare const verifiedRequest: unique symbol;
/** Only the registry can create this handle; native transport must use its snapshot accessor. */
export interface VerifiedAiRequest {
	readonly [verifiedRequest]: true;
}

export class AiVerificationError extends Error {
	readonly code = "AI_REQUEST_REFUSED";
	constructor() {
		super("Provider request refused");
		this.name = "AiVerificationError";
	}
}
export function refuse(): never {
	throw new AiVerificationError();
}
