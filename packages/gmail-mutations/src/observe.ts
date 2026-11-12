import { types } from "node:util";
import { parseStrict } from "@draftyak/protocol/jcs";
import { array, gmailId, record, refuse, unique } from "./input.ts";
import { planGmailMutation } from "./plan.ts";

export const MAX_OBSERVATION_BYTES = 16_384;
const prototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(prototype, "byteLength")?.get;
const buffer = Object.getOwnPropertyDescriptor(prototype, "buffer")?.get;
const setBytes = Uint8Array.prototype.set;

function copyBytes(value: unknown): Uint8Array {
	if (!types.isUint8Array(value) || types.isProxy(value)) return refuse();
	const length: unknown = byteLength?.call(value);
	if (typeof length !== "number" || length > MAX_OBSERVATION_BYTES) return refuse();
	if (types.isSharedArrayBuffer(buffer?.call(value))) return refuse();
	// Bound the intrinsic VIEW length before allocating; no caller-owned length/buffer reads.
	const copy = new Uint8Array(length);
	setBytes.call(copy, value);
	return copy;
}

export interface GmailObservedMessage {
	readonly untrusted: true;
	readonly id: string;
	readonly threadId: string;
	readonly labelIds: readonly string[];
}
export interface GmailMutationObservation {
	readonly requestedId: string;
	readonly state: "observed" | "missing" | "refused" | "unverified";
	readonly provider?: GmailObservedMessage;
}
export interface GmailMutationObservations {
	/** Provider-DATA consistency only; not native admission, durable state or success. */
	readonly completeObservation: boolean;
	readonly observations: readonly GmailMutationObservation[];
}

/** Re-plan the original channel request; supplied plan DTOs confer nothing. */
export function observeGmailMutation(
	input: unknown,
	responses: unknown,
): GmailMutationObservations {
	const plan = planGmailMutation(input);
	const expected = new Set(plan.requests.map((request) => request.providerId));
	const rows = array(responses, 100, (entry) => {
		const row = record(entry, ["providerId", "status", "body"]);
		const providerId = gmailId(row.providerId);
		if (
			!expected.has(providerId) ||
			!Number.isInteger(row.status) ||
			Number(row.status) < 100 ||
			Number(row.status) > 599
		)
			return refuse();
		return { providerId, status: row.status, body: row.body };
	});
	unique(rows.map((row) => row.providerId));
	const byId = new Map(rows.map((row) => [row.providerId, row]));
	const changes = JSON.parse(plan.requests[0]?.body ?? "{}") as {
		addLabelIds: string[];
		removeLabelIds: string[];
	};
	const observations = plan.requests.map((request): GmailMutationObservation => {
		const row = byId.get(request.providerId);
		if (!row) return Object.freeze({ requestedId: request.providerId, state: "missing" });
		if (row.status !== 200)
			return Object.freeze({ requestedId: request.providerId, state: "refused" });
		try {
			const parsed = parseStrict(copyBytes(row.body));
			if (
				!parsed ||
				typeof parsed !== "object" ||
				Array.isArray(parsed) ||
				Object.hasOwn(parsed, "error")
			)
				return refuse();
			const body = parsed as Record<string, unknown>;
			const id = gmailId(body.id),
				threadId = gmailId(body.threadId);
			// The merged normalized email contract admits up to 256 observed labels.
			const labels = array(body.labelIds, 256, gmailId);
			unique(labels);
			if (id !== request.providerId) return refuse();
			if (
				changes.addLabelIds.some((label) => !labels.includes(label)) ||
				changes.removeLabelIds.some((label) => labels.includes(label))
			)
				return refuse();
			return Object.freeze({
				requestedId: request.providerId,
				state: "observed",
				provider: Object.freeze({ untrusted: true, id, threadId, labelIds: Object.freeze(labels) }),
			});
		} catch {
			return Object.freeze({ requestedId: request.providerId, state: "unverified" });
		}
	});
	return Object.freeze({
		completeObservation: observations.every((row) => row.state === "observed"),
		observations: Object.freeze(observations),
	});
}
