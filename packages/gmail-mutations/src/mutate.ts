import { types } from "node:util";
import type { MutateRequest } from "@draftyak/protocol/channel-v1";
import type { ChannelPluginDefinition } from "@draftyak/sdk/channel";
import { PluginError } from "@draftyak/sdk/errors";
import { HostError } from "@draftyak/sdk/host";
import { record } from "./input.ts";
import { MAX_OBSERVATION_BYTES, observeGmailMutation } from "./observe.ts";
import { type GmailMutationPlan, planGmailMutation } from "./plan.ts";

// Includes the EOF read: permits a full bounded body in one-byte chunks and caps empty work.
export const MAX_MUTATION_RESPONSE_READS: number = MAX_OBSERVATION_BYTES + 1;
const bytePrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(bytePrototype, "byteLength")?.get;
const byteBuffer = Object.getOwnPropertyDescriptor(bytePrototype, "buffer")?.get;
const setBytes = Uint8Array.prototype.set;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const transient = (): PluginError => new PluginError("TRANSIENT");

function hostDenied(error: unknown): boolean {
	try {
		if (
			types.isProxy(error) ||
			!types.isNativeError(error) ||
			Object.getPrototypeOf(error) !== HostError.prototype
		)
			return false;
		const code = Object.getOwnPropertyDescriptor(error, "code");
		return code !== undefined && Object.hasOwn(code, "value") && code.value === "DENIED";
	} catch {
		return false;
	}
}

function active(signal: AbortSignal): void {
	try {
		if (aborted?.call(signal) === false) return;
	} catch {
		// A caller object cannot substitute for a readable native cancellation state.
	}
	throw transient();
}

/** Rebuild owned channel DATA from the validated plan, before any asynchronous work. */
function snapshot(plan: GmailMutationPlan): MutateRequest {
	const messages = Object.freeze(
		plan.requests.map(({ providerId }) => Object.freeze({ kind: "email" as const, providerId })),
	);
	if (plan.operation === "label" || plan.operation === "unlabel") {
		const body = JSON.parse(plan.requests[0]?.body ?? "") as {
			addLabelIds: string[];
			removeLabelIds: string[];
		};
		const labels = plan.operation === "label" ? body.addLabelIds : body.removeLabelIds;
		return Object.freeze({ op: plan.operation, messages, labelIds: Object.freeze([...labels]) });
	}
	return Object.freeze({ op: plan.operation, messages });
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
	try {
		if (body) void body.cancel().catch(() => {});
	} catch {
		// Refusal never waits for an untrusted cleanup hook.
	}
}

async function responseBytes(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): Promise<Uint8Array> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0,
		cancelled = false;
	let rejectAbort: (error: PluginError) => void = () => {};
	const interrupted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const cancel = (): void => {
		if (cancelled) return;
		cancelled = true;
		try {
			void reader.cancel().catch(() => {});
		} catch {
			/* Refusal remains final. */
		}
	};
	const onAbort = (): void => {
		cancel();
		rejectAbort(transient());
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		for (let reads = 0; reads < MAX_MUTATION_RESPONSE_READS; reads++) {
			active(signal);
			const next = record(await Promise.race([reader.read(), interrupted]), ["done", "value"]);
			active(signal);
			if (next.done === true) {
				const bytes = new Uint8Array(size);
				let offset = 0;
				for (const chunk of chunks) {
					setBytes.call(bytes, chunk, offset);
					offset += chunk.length;
				}
				return bytes;
			}
			if (next.done !== false || !types.isUint8Array(next.value) || types.isProxy(next.value))
				throw transient();
			const length: unknown = byteLength?.call(next.value);
			if (typeof length !== "number" || length > MAX_OBSERVATION_BYTES - size) throw transient();
			if (types.isSharedArrayBuffer(byteBuffer?.call(next.value))) throw transient();
			if (length > 0) {
				const copy = new Uint8Array(length);
				setBytes.call(copy, next.value);
				chunks.push(copy);
				size += length;
			}
		}
		throw transient();
	} finally {
		signal.removeEventListener("abort", onAbort);
		cancel();
		try {
			reader.releaseLock();
		} catch {
			/* A pending read cannot delay refusal. */
		}
	}
}

/** An unmounted SDK callback. The host retains account, credential and native authorization. */
export const mutateGmail: NonNullable<ChannelPluginDefinition["mutate"]> = async (
	input,
	context,
) => {
	let plan: GmailMutationPlan;
	try {
		plan = planGmailMutation(input);
	} catch {
		throw new PluginError("INVALID_INPUT");
	}
	const requested = snapshot(plan);
	const signal = context.signal;
	const fetch = context.fetch;
	try {
		active(signal);
		for (const request of plan.requests) {
			active(signal);
			const response = await fetch(request.url, {
				method: request.method,
				headers: request.headers,
				body: request.body,
				stream: true,
				signal,
			});
			const body = response.body;
			try {
				active(signal);
				if (response.status !== 200 || Object.hasOwn(response, "bodyRef") || !body)
					throw transient();
				const bytes = await responseBytes(body, signal);
				active(signal);
				const one = {
					...requested,
					messages: [{ kind: "email" as const, providerId: request.providerId }],
				};
				const observed = observeGmailMutation(one, [
					{ providerId: request.providerId, status: response.status, body: bytes },
				]);
				if (!observed.completeObservation) throw transient();
			} catch (error) {
				cancelBody(body);
				throw error;
			}
		}
		active(signal);
		return Object.freeze({});
	} catch (error) {
		active(signal);
		if (hostDenied(error)) throw new PluginError("PERMISSION_DENIED");
		throw transient();
	}
};
