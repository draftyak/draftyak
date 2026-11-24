import { aiProviderV1 } from "@draftyak/protocol/ai-provider-v1";
import type { HeaderList } from "@draftyak/protocol/hash";
import { headersSha256 } from "@draftyak/protocol/hash";
import { HOST_MAX_HEADER_BYTES } from "@draftyak/protocol/host-channel";
import { parseStrict } from "@draftyak/protocol/jcs";
import { AI_HTTP_PROFILES, type AiProfile } from "@draftyak/protocol/manifest/ai-http";
import {
	addressFacts,
	captureEgressPolicy,
	type EgressPolicy,
	egressHost,
	egressPort,
	type PinnedAddress,
	validateEgressAnswers,
} from "../network/index.ts";
import { copyBytes, copyEmptyBytes, fields, record, text, vector } from "./boundary.ts";
import {
	type AiRequestLifecycle,
	failAiRequestCapture,
	type MessagesMetadataReservation,
	messagesMetadataLifecycle,
	reserveMessagesMetadata,
} from "./messages-metadata.ts";
import {
	captureResponsesMetadataBinding,
	responsesMetadataEndpoint,
} from "./responses-metadata.ts";
import {
	type AiCandidateRequest,
	type AiProviderSettings,
	type AiRequestBinding,
	type AiRequestBindingWithoutNetwork,
	type AiRequestSnapshot,
	type CapturedAiRequestInputs,
	type MessagesMetadataBindingWithoutNetwork,
	type ResponsesMetadataBindingWithoutNetwork,
	refuse,
	type VerifiedAiRequest,
} from "./types.ts";
import { builtinRegistrations } from "./verifiers.ts";

export interface AiVerifierInput {
	readonly body: unknown;
	readonly headers: ReadonlyMap<string, string>;
	readonly binding: AiRequestBindingWithoutNetwork;
}
export interface AiProfileRegistration {
	readonly profile: AiProfile;
	readonly verify: (input: AiVerifierInput) => void;
	readonly verifyMetadata?: (input: AiMetadataVerifierInput) => void;
}
export interface AiMetadataVerifierInput {
	readonly method: "GET";
	readonly url: string;
	readonly body: Uint8Array;
	readonly headers: ReadonlyMap<string, string>;
	readonly binding: ResponsesMetadataBindingWithoutNetwork | MessagesMetadataBindingWithoutNetwork;
}
declare const profileRegistry: unique symbol;
export interface AiProfileRegistry {
	readonly [profileRegistry]: true;
}

const registries = new WeakMap<object, ReadonlyMap<AiProfile, AiProfileRegistration>>();
type Capture =
	| {
			readonly kind: "draft";
			readonly candidate: AiCandidateRequest;
			readonly binding: AiRequestBindingWithoutNetwork;
	  }
	| {
			readonly kind: "metadata";
			readonly candidate: AiCandidateRequest;
			readonly binding: ResponsesMetadataBindingWithoutNetwork;
	  }
	| {
			readonly kind: "messages";
			readonly candidate: AiCandidateRequest;
			readonly binding: MessagesMetadataBindingWithoutNetwork;
			readonly reservation: MessagesMetadataReservation;
	  };
const captures = new WeakMap<object, Capture>();
const verified = new WeakMap<object, AiRequestSnapshot>();
const lifecycles = new WeakMap<object, AiRequestLifecycle>();

function profile(value: unknown): AiProfile {
	if (typeof value !== "string" || !(AI_HTTP_PROFILES as readonly string[]).includes(value))
		refuse();
	return value as AiProfile;
}

/** The registry is internal native configuration, never a plugin-supplied selection table. */
export function createAiProfileRegistry(
	registrations: readonly AiProfileRegistration[],
): AiProfileRegistry {
	try {
		const table = new Map<AiProfile, AiProfileRegistration>();
		for (const raw of vector(registrations, AI_HTTP_PROFILES.length)) {
			const entry = fields(raw, ["profile", "verify", "verifyMetadata"], ["profile", "verify"]);
			const id = profile(entry.profile);
			if (table.has(id) || typeof entry.verify !== "function") refuse();
			if (Object.hasOwn(entry, "verifyMetadata") && typeof entry.verifyMetadata !== "function")
				refuse();
			table.set(id, Object.freeze(entry) as unknown as AiProfileRegistration);
		}
		// Every bundled profile is required. A listed profile that no bundled plugin ships may stay
		// unregistered, and verification refuses each request under it.
		if (builtinRegistrations.some(({ profile: id }) => !table.has(id))) refuse();
		const handle = Object.freeze(Object.create(null)) as AiProfileRegistry;
		registries.set(handle, table);
		return handle;
	} catch {
		return refuse();
	}
}

export function createBuiltinAiProfileRegistry(): AiProfileRegistry {
	return createAiProfileRegistry(builtinRegistrations);
}

function captureSettings(raw: unknown): AiProviderSettings {
	const kind = fields(
		raw,
		["kind", "effort", "maxTokens", "stream", "fallback", "format", "allowPlaintextLan"],
		["kind"],
	).kind;
	if (kind === "messages") {
		const value = fields(raw, ["kind", "effort", "maxTokens", "stream", "fallback"]);
		if (
			!["low", "medium", "high", "xhigh", "max"].includes(value.effort as string) ||
			!Number.isSafeInteger(value.maxTokens) ||
			Number(value.maxTokens) < 1 ||
			Number(value.maxTokens) > 16_000 ||
			(typeof value.stream !== "boolean" && value.stream !== "omit") ||
			typeof value.fallback !== "boolean"
		)
			refuse();
		return Object.freeze(value) as unknown as AiProviderSettings;
	}
	if (kind === "responses") {
		const value = fields(raw, ["kind", "effort"], ["kind"]);
		if (
			Object.hasOwn(value, "effort") &&
			!["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.effort as string)
		)
			refuse();
		return Object.freeze(value) as unknown as AiProviderSettings;
	}
	if (kind === "compatible") {
		const value = fields(raw, ["kind", "format", "allowPlaintextLan"]);
		if (
			!["json_schema", "json_object", "ollama"].includes(value.format as string) ||
			typeof value.allowPlaintextLan !== "boolean"
		)
			refuse();
		return Object.freeze(value) as unknown as AiProviderSettings;
	}
	return refuse();
}

function captureHeaders(raw: unknown): HeaderList {
	const seen = new Set<string>();
	let bytes = 0;
	const result = vector(raw, 64).map((rawRow): readonly [string, string] => {
		const row = vector(rawRow, 2);
		if (row.length !== 2) refuse();
		const name = text(row[0], 128).toLowerCase();
		const value = text(row[1], 8192);
		bytes += name.length + value.length;
		if (seen.has(name) || bytes > HOST_MAX_HEADER_BYTES) refuse();
		seen.add(name);
		return Object.freeze([name, value]);
	});
	headersSha256(result);
	return Object.freeze(result);
}

export function captureAiRequestInputs(
	candidate: unknown,
	binding: unknown,
): CapturedAiRequestInputs {
	try {
		if (Object.hasOwn(record(binding), "operation"))
			return Object.hasOwn(record(binding), "call")
				? captureMessagesMetadataInputs(candidate, binding)
				: captureResponsesMetadataInputs(candidate, binding);
		const value = fields(candidate, ["method", "url", "headers", "body"]);
		if (value.method !== "POST") refuse();
		const source = fields(binding, ["draft", "settings", "endpoint"]);
		const endpoint = text(source.endpoint, 2048);
		if (text(value.url, 2048) !== endpoint) refuse();
		const url = new URL(endpoint);
		if (url.href !== endpoint || url.username || url.password || url.hash) refuse();
		const draft = fields(source.draft, ["model", "system", "prompt", "contextIds"]);
		const contextIds = vector(draft.contextIds, 3);
		text(draft.model, 256);
		text(draft.system, 200_000);
		text(draft.prompt, 2_000_000);
		const parsed = aiProviderV1.tools.ai_draft_generate.input.safeParse(
			{ ...draft, contextIds },
			{ jitless: true },
		);
		if (!parsed.success) refuse();
		const capturedBinding = Object.freeze({
			draft: Object.freeze({
				...parsed.data,
				contextIds: Object.freeze([...parsed.data.contextIds]),
			}),
			settings: captureSettings(source.settings),
			endpoint,
		});
		const snapshot = Object.freeze({
			method: "POST",
			url: endpoint,
			headers: captureHeaders(value.headers),
			body: copyBytes(value.body),
		});
		const handle = Object.freeze(Object.create(null)) as CapturedAiRequestInputs;
		captures.set(handle, { kind: "draft", candidate: snapshot, binding: capturedBinding });
		return handle;
	} catch {
		failAiRequestCapture(binding);
		return refuse();
	}
}

export function captureMessagesMetadataInputs(
	candidate: unknown,
	binding: unknown,
): CapturedAiRequestInputs {
	try {
		const reserved = reserveMessagesMetadata(binding);
		const value = fields(
			candidate,
			["method", "url", "headers", "body"],
			["method", "url", "headers"],
		);
		if (value.method !== "GET" || text(value.url, 2048) !== reserved.reservation.url) refuse();
		const snapshot: AiCandidateRequest = Object.freeze({
			method: "GET",
			url: reserved.reservation.url,
			headers: captureHeaders(value.headers),
			body: Object.hasOwn(value, "body") ? copyEmptyBytes(value.body) : new Uint8Array(0),
		});
		const handle = Object.freeze(Object.create(null)) as CapturedAiRequestInputs;
		captures.set(handle, { kind: "messages", candidate: snapshot, ...reserved });
		return handle;
	} catch {
		failAiRequestCapture(binding);
		return refuse();
	}
}

/** Native operation/config/input are captured separately from the plugin's HTTP candidate. */
export function captureResponsesMetadataInputs(
	candidate: unknown,
	binding: unknown,
): CapturedAiRequestInputs {
	try {
		const value = fields(
			candidate,
			["method", "url", "headers", "body"],
			["method", "url", "headers"],
		);
		if (value.method !== "GET") refuse();
		const native = captureResponsesMetadataBinding(binding);
		const endpoint = responsesMetadataEndpoint(native);
		if (text(value.url, 2048) !== endpoint) refuse();
		const snapshot: AiCandidateRequest = Object.freeze({
			method: "GET",
			url: endpoint,
			headers: captureHeaders(value.headers),
			body: Object.hasOwn(value, "body") ? copyEmptyBytes(value.body) : new Uint8Array(0),
		});
		const handle = Object.freeze(Object.create(null)) as CapturedAiRequestInputs;
		captures.set(handle, { kind: "metadata", candidate: snapshot, binding: native });
		return handle;
	} catch {
		return refuse();
	}
}

function captured(raw: unknown) {
	if (raw === null || typeof raw !== "object") refuse();
	const result = captures.get(raw);
	if (!result) refuse();
	return result;
}

export function aiRequestEndpoint(handle: CapturedAiRequestInputs): string {
	const source = captured(handle);
	return source.kind === "draft"
		? source.binding.endpoint
		: source.kind === "metadata"
			? responsesMetadataEndpoint(source.binding)
			: source.reservation.url;
}

function routing(
	endpoint: string,
	settings: AiProviderSettings,
	network: { readonly answers: readonly PinnedAddress[]; readonly policy: EgressPolicy },
): void {
	const url = new URL(endpoint);
	const policy = captureEgressPolicy(network.policy);
	const localAllowed = settings.kind === "compatible";
	if (!localAllowed && policy.allowLocal) {
		// Fixed cloud providers never inherit a compatible/local destination permission.
		validateEgressAnswers(network.answers, { ...policy, allowLocal: false });
	}
	const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
	egressHost(host, localAllowed && policy.allowLocal);
	egressPort(Number(url.port || (url.protocol === "https:" ? 443 : 80)), policy);
	const pin = validateEgressAnswers(network.answers, policy);
	const locality = addressFacts(pin.address).locality;
	if (
		url.protocol !== "https:" &&
		!(
			url.protocol === "http:" &&
			settings.kind === "compatible" &&
			(locality === "loopback" || (locality !== "public" && settings.allowPlaintextLan))
		)
	)
		refuse();
	if (settings.kind !== "compatible" && locality !== "public") refuse();
	if (settings.kind === "compatible") {
		const path = settings.format === "ollama" ? "/api/chat" : "/v1/chat/completions";
		if (endpoint !== `${url.origin}${path}`) refuse();
	}
}

export function verifyCapturedAiRequest(
	registry: AiProfileRegistry,
	id: unknown,
	input: CapturedAiRequestInputs,
	network: { readonly answers: readonly PinnedAddress[]; readonly policy: EgressPolicy },
): VerifiedAiRequest {
	try {
		const selected = profile(id);
		const table = registries.get(registry);
		const registration = table?.get(selected);
		if (!registration) refuse();
		const source = captured(input);
		const { candidate } = source;
		if (
			source.kind !== "draft" &&
			(selected !==
				(source.kind === "metadata" ? source.binding.configuration.profile : "messages-api-v1") ||
				!registration.verifyMetadata)
		)
			refuse();
		const facts = fields(network, ["answers", "policy"]);
		routing(
			aiRequestEndpoint(input),
			source.kind === "draft" ? source.binding.settings : { kind: "responses" },
			{
				answers: facts.answers as readonly PinnedAddress[],
				policy: facts.policy as EgressPolicy,
			},
		);
		if (source.kind === "draft") {
			const body = parseStrict(candidate.body);
			registration.verify({ body, headers: new Map(candidate.headers), binding: source.binding });
		} else {
			registration.verifyMetadata?.({
				method: "GET",
				url: candidate.url,
				body: Uint8Array.from(candidate.body),
				headers: new Map(candidate.headers),
				binding: source.binding,
			});
		}
		const handle = Object.freeze(Object.create(null)) as VerifiedAiRequest;
		verified.set(handle, {
			profile: selected,
			method: source.kind === "draft" ? "POST" : "GET",
			url: candidate.url,
			headers: candidate.headers,
			body: candidate.body,
		});
		if (source.kind === "messages")
			lifecycles.set(handle, messagesMetadataLifecycle(source.reservation));
		return handle;
	} catch {
		if (input !== null && typeof input === "object") {
			const source = captures.get(input);
			if (source?.kind === "messages") failAiRequestCapture(source.binding);
		}
		return refuse();
	}
}

export function verifiedAiRequestLifecycle(
	handle: VerifiedAiRequest,
): AiRequestLifecycle | undefined {
	if (handle === null || typeof handle !== "object" || !verified.has(handle)) refuse();
	return lifecycles.get(handle);
}

export function verifyAiRequest(
	registry: AiProfileRegistry,
	id: unknown,
	candidate: AiCandidateRequest,
	binding: AiRequestBinding,
): VerifiedAiRequest {
	const input = fields(binding, ["draft", "settings", "endpoint", "answers", "policy"]);
	const capture = captureAiRequestInputs(candidate, {
		draft: input.draft,
		settings: input.settings,
		endpoint: input.endpoint,
	});
	return verifyCapturedAiRequest(registry, id, capture, {
		answers: input.answers as readonly PinnedAddress[],
		policy: input.policy as EgressPolicy,
	});
}

/** A new detached byte copy on every access; lookalike objects and copied handles are refused. */
export function snapshotVerifiedAiRequest(raw: VerifiedAiRequest): AiRequestSnapshot {
	if (raw === null || typeof raw !== "object") refuse();
	const snapshot = verified.get(raw);
	if (!snapshot) refuse();
	return Object.freeze({
		...snapshot,
		headers: Object.freeze(
			snapshot.headers.map(([name, value]) => Object.freeze([name, value] as const)),
		),
		body: Uint8Array.from(snapshot.body),
	});
}
