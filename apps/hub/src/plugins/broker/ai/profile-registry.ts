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
import { copyBytes, fields, text, vector } from "./boundary.ts";
import {
	type AiCandidateRequest,
	type AiProviderSettings,
	type AiRequestBinding,
	type AiRequestBindingWithoutNetwork,
	type AiRequestSnapshot,
	type CapturedAiRequestInputs,
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
}
declare const profileRegistry: unique symbol;
export interface AiProfileRegistry {
	readonly [profileRegistry]: true;
}

const registries = new WeakMap<object, ReadonlyMap<AiProfile, AiProfileRegistration["verify"]>>();
const captures = new WeakMap<
	object,
	{ candidate: AiCandidateRequest; binding: AiRequestBindingWithoutNetwork }
>();
const verified = new WeakMap<object, AiRequestSnapshot>();

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
		const table = new Map<AiProfile, AiProfileRegistration["verify"]>();
		for (const raw of vector(registrations, AI_HTTP_PROFILES.length)) {
			const entry = fields(raw, ["profile", "verify"]);
			const id = profile(entry.profile);
			if (table.has(id) || typeof entry.verify !== "function") refuse();
			table.set(id, entry.verify as AiProfileRegistration["verify"]);
		}
		if (AI_HTTP_PROFILES.some((id) => !table.has(id))) refuse();
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
		captures.set(handle, { candidate: snapshot, binding: capturedBinding });
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
	return captured(handle).binding.endpoint;
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
		const verifier = table?.get(selected);
		if (!verifier) refuse();
		const { candidate, binding } = captured(input);
		const facts = fields(network, ["answers", "policy"]);
		routing(binding.endpoint, binding.settings, {
			answers: facts.answers as readonly PinnedAddress[],
			policy: facts.policy as EgressPolicy,
		});
		const body = parseStrict(candidate.body);
		verifier({ body, headers: new Map(candidate.headers), binding });
		const handle = Object.freeze(Object.create(null)) as VerifiedAiRequest;
		verified.set(handle, {
			profile: selected,
			method: "POST",
			url: candidate.url,
			headers: candidate.headers,
			body: candidate.body,
		});
		return handle;
	} catch {
		return refuse();
	}
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
