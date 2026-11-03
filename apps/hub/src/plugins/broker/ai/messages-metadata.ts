import { addAbortListener } from "node:events";
import { aiProviderV1, ModelId } from "@draftyak/protocol/ai-provider-v1";
import { parseStrict } from "@draftyak/protocol/jcs";
import {
	type CredentialBinding,
	type CredentialUse,
	CredentialVault,
} from "../../../credentials/vault.ts";
import { copyBoundedBytes, fields, modelPathSegment, record, vector } from "./boundary.ts";
import {
	type MessagesMetadataBindingWithoutNetwork,
	type MessagesMetadataCall,
	type MessagesMetadataCallBinding,
	refuse,
} from "./types.ts";

const MAX_PAGE_BYTES = 1_048_576;
const MAX_PAGES = 5;
const PAGE_SIZE = 100;
const MAX_MODELS = MAX_PAGES * PAGE_SIZE;
const queryComponent = (value: string): string =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
const describe = CredentialVault.prototype.describe;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
interface CredentialPin {
	readonly vault: CredentialVault;
	readonly reference: string;
	readonly generation: number;
	readonly binding: CredentialBinding;
}
interface CallState {
	readonly native: MessagesMetadataCallBinding;
	readonly original: AbortSignal;
	readonly controller: AbortController;
	readonly signal: AbortSignal;
	readonly ids: Set<string>;
	listener: Disposable | undefined;
	credential: CredentialPin | undefined;
	pending: MessagesMetadataReservation | undefined;
	pages: number;
	expected: string;
	closed: boolean;
}
export interface MessagesMetadataReservation {
	readonly state: CallState;
	readonly url: string;
	phase: "captured" | "verified" | "bound" | "prepared" | "complete";
	use: CredentialUse | undefined;
	listener: Disposable | undefined;
	prepared: PreparedPage | undefined;
}
interface PreparedPage {
	readonly finished: boolean;
	readonly ids: readonly string[];
	readonly pages: number;
	readonly next: string | undefined;
}
export interface AiRequestLifecycle {
	readonly signal: AbortSignal;
	readonly maxResponseBytes: 1_048_576;
	bindCredential(vault: CredentialVault, use: CredentialUse, originalCallSignal: AbortSignal): void;
	complete(status: number, body: Uint8Array): void;
	acknowledge(): void;
	fail(): void;
}
const calls = new WeakMap<object, CallState>();

function signal(value: unknown): AbortSignal {
	try {
		if (typeof aborted?.call(value) !== "boolean") refuse();
		return value as AbortSignal;
	} catch {
		return refuse();
	}
}
function isAborted(value: AbortSignal): boolean {
	return aborted?.call(value) !== false;
}
function active(state: CallState): void {
	if (state.closed || isAborted(state.original) || isAborted(state.signal)) refuse();
}
function close(state: CallState, failure: boolean): void {
	state.closed = true;
	state.listener?.[Symbol.dispose]();
	state.listener = undefined;
	state.pending?.listener?.[Symbol.dispose]();
	if (state.pending) state.pending.listener = undefined;
	state.pending = undefined;
	if (failure) state.controller.abort();
}
function stateFor(call: unknown): CallState {
	if (call === null || typeof call !== "object") refuse();
	const state = calls.get(call);
	if (!state) refuse();
	return state;
}
function captureNative(raw: unknown): MessagesMetadataCallBinding {
	const value = fields(raw, ["operation", "configuration", "input"]);
	if (value.operation !== "ai_models_list" && value.operation !== "ai_probe") refuse();
	const configuration = fields(
		value.configuration,
		["profile", "endpoint", "model"],
		["profile", "endpoint"],
	);
	if (
		configuration.profile !== "messages-api-v1" ||
		configuration.endpoint !== "https://api.anthropic.com"
	)
		refuse();
	if (
		Object.hasOwn(configuration, "model") &&
		!ModelId.safeParse(configuration.model, { jitless: true }).success
	)
		refuse();
	const input = fields(value.input, value.operation === "ai_probe" ? ["model"] : [], []);
	if (Object.hasOwn(input, "model") && !ModelId.safeParse(input.model, { jitless: true }).success)
		refuse();
	const parsed = aiProviderV1.tools[value.operation].input.safeParse(input, { jitless: true });
	if (!parsed.success) refuse();
	return Object.freeze({
		operation: value.operation,
		configuration: Object.freeze({
			profile: "messages-api-v1",
			endpoint: "https://api.anthropic.com",
			...(Object.hasOwn(configuration, "model") ? { model: configuration.model as string } : {}),
		}),
		input: Object.freeze({ ...parsed.data }),
	});
}

/** A native call guard, not a principal, credential or authorization grant. */
export function beginMessagesMetadataCall(
	binding: MessagesMetadataCallBinding,
	originalCallSignal: AbortSignal,
): MessagesMetadataCall {
	try {
		const native = captureNative(binding),
			original = signal(originalCallSignal);
		if (isAborted(original)) refuse();
		let expected = `${native.configuration.endpoint}/v1/models?limit=100`;
		if (native.operation === "ai_probe") {
			const model = native.input.model ?? native.configuration.model;
			if (model === undefined) refuse();
			expected = `${native.configuration.endpoint}/v1/models/${modelPathSegment(model)}`;
		}
		const controller = new AbortController();
		const state: CallState = {
			native,
			original,
			controller,
			signal: AbortSignal.any([original, controller.signal]),
			ids: new Set(),
			listener: undefined,
			credential: undefined,
			pending: undefined,
			pages: 0,
			expected,
			closed: false,
		};
		state.listener = addAbortListener(original, () => close(state, true));
		active(state);
		const handle = Object.freeze(Object.create(null)) as MessagesMetadataCall;
		calls.set(handle, state);
		return handle;
	} catch {
		return refuse();
	}
}

export function closeMessagesMetadataCall(call: MessagesMetadataCall): void {
	close(stateFor(call), true);
}

/** Safe even when capture failed before a candidate or verified handle could be produced. */
export function failAiRequestCapture(binding: unknown): void {
	try {
		const value = record(binding);
		const descriptor = Object.getOwnPropertyDescriptor(value, "call");
		if (
			descriptor &&
			Object.hasOwn(descriptor, "value") &&
			descriptor.value !== null &&
			typeof descriptor.value === "object"
		) {
			const state = calls.get(descriptor.value);
			if (state) close(state, true);
		}
	} catch {
		// Cleanup cannot replace the original refusal or inspect a getter.
	}
}

export function reserveMessagesMetadata(binding: unknown): {
	readonly binding: MessagesMetadataBindingWithoutNetwork;
	readonly reservation: MessagesMetadataReservation;
} {
	try {
		const value = fields(binding, ["operation", "call"]);
		const state = stateFor(value.call);
		active(state);
		if (value.operation !== state.native.operation || state.pending) refuse();
		const reservation: MessagesMetadataReservation = {
			state,
			url: state.expected,
			phase: "captured",
			use: undefined,
			listener: undefined,
			prepared: undefined,
		};
		state.pending = reservation;
		return {
			binding: Object.freeze({
				operation: state.native.operation,
				call: value.call as MessagesMetadataCall,
			}),
			reservation,
		};
	} catch {
		failAiRequestCapture(binding);
		return refuse();
	}
}

export function assertMessagesMetadataReservation(
	binding: MessagesMetadataBindingWithoutNetwork,
	url: string,
): void {
	const state = stateFor(binding.call);
	active(state);
	if (
		binding.operation !== state.native.operation ||
		!state.pending ||
		state.pending.url !== url ||
		state.pending.phase !== "captured"
	)
		refuse();
}

function sameBinding(left: CredentialBinding, right: CredentialBinding): boolean {
	return (
		left.ownerKind === right.ownerKind && left.ownerId === right.ownerId && left.kind === right.kind
	);
}
function captureUse(raw: CredentialUse): CredentialUse {
	const use = fields(raw, ["reference", "generation", "binding", "signal"]);
	const binding = fields(use.binding, ["ownerKind", "ownerId", "kind"]);
	if (
		typeof use.reference !== "string" ||
		!Number.isSafeInteger(use.generation) ||
		Number(use.generation) < 1 ||
		binding.ownerKind !== "provider" ||
		binding.kind !== "provider-key" ||
		typeof binding.ownerId !== "string"
	)
		refuse();
	return Object.freeze({
		reference: use.reference,
		generation: use.generation as number,
		binding: Object.freeze({
			ownerKind: "provider",
			ownerId: binding.ownerId,
			kind: "provider-key",
		}),
		signal: signal(use.signal),
	});
}
function current(
	reservation: MessagesMetadataReservation,
	phase: "bound" | "prepared" = "bound",
): void {
	const { state, use } = reservation;
	active(state);
	if (
		state.pending !== reservation ||
		reservation.phase !== phase ||
		!use ||
		!state.credential ||
		isAborted(use.signal)
	)
		refuse();
	const actual = describe.call(state.credential.vault, use.reference, use.binding);
	if (
		actual.generation !== use.generation ||
		actual.reference !== state.credential.reference ||
		actual.generation !== state.credential.generation ||
		!sameBinding(actual.binding, state.credential.binding)
	)
		refuse();
}
function model(value: unknown, allowRetired = false): string {
	const row = record(value);
	if (
		!ModelId.safeParse(row.id, { jitless: true }).success ||
		typeof row.display_name !== "string" ||
		typeof row.lifecycle !== "string" ||
		!(allowRetired ? ["active", "deprecated", "retired"] : ["active", "deprecated"]).includes(
			row.lifecycle,
		) ||
		(row.max_input_tokens !== null &&
			(!Number.isSafeInteger(row.max_input_tokens) || Number(row.max_input_tokens) < 1))
	)
		refuse();
	const projected = {
		id: row.id,
		name: row.display_name,
		...(row.max_input_tokens === null ? {} : { contextTokens: row.max_input_tokens }),
	};
	if (
		!aiProviderV1.tools.ai_models_list.output.safeParse({ models: [projected] }, { jitless: true })
			.success
	)
		refuse();
	return row.id as string;
}

export function messagesMetadataLifecycle(
	reservation: MessagesMetadataReservation,
): AiRequestLifecycle {
	const { state } = reservation;
	active(state);
	if (state.pending !== reservation || reservation.phase !== "captured") refuse();
	reservation.phase = "verified";
	return Object.freeze({
		signal: state.signal,
		maxResponseBytes: MAX_PAGE_BYTES,
		bindCredential(vault: CredentialVault, raw: CredentialUse, originalCallSignal: AbortSignal) {
			try {
				active(state);
				if (
					state.pending !== reservation ||
					reservation.phase !== "verified" ||
					originalCallSignal !== state.original
				)
					refuse();
				const use = captureUse(raw);
				if (isAborted(use.signal)) refuse();
				const actual = describe.call(vault, use.reference, use.binding);
				if (actual.generation !== use.generation) refuse();
				if (
					state.credential &&
					(state.credential.vault !== vault ||
						state.credential.reference !== use.reference ||
						state.credential.generation !== use.generation ||
						!sameBinding(state.credential.binding, use.binding))
				)
					refuse();
				state.credential ??= Object.freeze({
					vault,
					reference: use.reference,
					generation: use.generation,
					binding: use.binding,
				});
				reservation.use = use;
				reservation.phase = "bound";
				reservation.listener = addAbortListener(use.signal, () => close(state, true));
				current(reservation);
			} catch {
				close(state, true);
				refuse();
			}
		},
		complete(status: number, body: Uint8Array) {
			try {
				current(reservation);
				if (!Number.isSafeInteger(status) || status < 200 || status > 599) refuse();
				const bytes = copyBoundedBytes(body, MAX_PAGE_BYTES);
				let prepared: PreparedPage = {
					finished: true,
					ids: [],
					pages: state.pages,
					next: undefined,
				};
				if (status >= 300) {
					// Preserve the native HTTP error while closing reuse after its delivery ACK.
				} else if (state.native.operation === "ai_probe") {
					model(parseStrict(bytes), true);
				} else {
					const page = record(parseStrict(bytes)),
						data = vector(page.data, PAGE_SIZE);
					if (
						typeof page.has_more !== "boolean" ||
						state.pages >= MAX_PAGES ||
						state.ids.size + data.length > MAX_MODELS
					)
						refuse();
					const ids = data.map((row) => model(row));
					if (new Set(ids).size !== ids.length || ids.some((id) => state.ids.has(id))) refuse();
					if (page.has_more && (ids.length === 0 || page.last_id !== ids.at(-1))) refuse();
					const finished = !page.has_more || state.pages + 1 >= MAX_PAGES;
					prepared = {
						finished,
						ids: Object.freeze(ids),
						pages: state.pages + 1,
						next: finished
							? undefined
							: `${state.native.configuration.endpoint}/v1/models?limit=100&after_id=${queryComponent(page.last_id as string)}`,
					};
				}
				current(reservation);
				reservation.prepared = Object.freeze(prepared);
				reservation.phase = "prepared";
			} catch {
				close(state, true);
				refuse();
			}
		},
		acknowledge() {
			try {
				current(reservation, "prepared");
				const prepared = reservation.prepared;
				if (!prepared) refuse();
				for (const id of prepared.ids) state.ids.add(id);
				state.pages = prepared.pages;
				if (prepared.next !== undefined) state.expected = prepared.next;
				state.closed = prepared.finished;
				reservation.phase = "complete";
				reservation.prepared = undefined;
				reservation.listener?.[Symbol.dispose]();
				reservation.listener = undefined;
				state.pending = undefined;
				if (state.closed) close(state, false);
			} catch {
				close(state, true);
				refuse();
			}
		},
		fail() {
			close(state, true);
		},
	});
}
