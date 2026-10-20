import {
	type ContextPresetItem,
	canonicalToolsList,
	toolExtensionDeclaration,
	toolKindsV1,
} from "@draftyak/protocol/tool-v1";
import {
	type LookupHost,
	type LookupPlan,
	type OwnerConfig,
	planLookups,
	type VerifiedThreadMeta,
} from "../src/index.ts";

export const toolId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const secondId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const presetId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
export const now: number = Date.parse("2026-10-19T08:00:00Z");
export const canary = "PRIVATE_LOOKUP_CANARY";
export const meta: VerifiedThreadMeta = {
	account: "account-one",
	channel: "gmail",
	sender: {
		kind: "gmail",
		address: "synthetic@example.invalid",
		topmostDmarc: "pass",
		aligned: true,
		singleFrom: true,
	},
	ownerRecipient: "recipient@example.invalid",
	automatic: { directToOwner: true, knownContact: true, bulk: false, list: false, noReply: false },
};
export function item(
	kind: ContextPresetItem["kind"] = "kb.lookup",
	id: string = toolId,
): ContextPresetItem {
	return {
		toolInstance: id,
		kind,
		onDemand: true,
		autoDraft: kind !== "contact.notes",
		bindings:
			kind === "calendar.freebusy"
				? { window: { source: "clock", horizonDays: 3 }, tz: { source: "owner", field: "zone" } }
				: kind === "contact.notes"
					? { participant: { source: "participant.verifiedSender" } }
					: { topic: { source: "const", value: "company" } },
	};
}
export function config(items: ContextPresetItem[] = [item()]): OwnerConfig {
	return {
		owner: {
			zone: "UTC",
			workingHours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
		},
		presets: [{ id: presetId, name: "Synthetic", isDefault: true, items }],
		instances: [toolId, secondId].map((id) => ({
			id,
			pluginId: presetId,
			createdAt: now,
			kinds: ["calendar.freebusy", "contact.notes", "kb.lookup"],
			hosts: ["tools.example.invalid"],
			destination: "local",
			posture: "no-train",
			status: "active",
			approvedDigest: "a".repeat(64),
			currentDigest: "a".repeat(64),
			currentFieldsDigest: "b".repeat(64),
			currentDisclosureVersion: 1,
			outputMaxBytes: {
				"calendar.freebusy": toolKindsV1["calendar.freebusy"].maxBytes,
				"contact.notes": toolKindsV1["contact.notes"].maxBytes,
				"kb.lookup": toolKindsV1["kb.lookup"].maxBytes,
			},
		})),
		consents: [toolId, secondId].map((instance) => ({
			account: meta.account,
			instance,
			aiDestination: "ai-one",
			active: true,
			revoked: false,
			kinds: ["calendar.freebusy", "contact.notes", "kb.lookup"],
			fieldsDigest: "b".repeat(64),
			disclosureVersion: 1,
		})),
		aiDestination: "ai-one",
		aiDestinationClass: "local",
		route: () => true,
	};
}
export function plan(jobId: string = "job-one", topic: string = "company"): LookupPlan {
	const entry = item();
	entry.bindings = { topic: { source: "const", value: topic } };
	return planLookups(meta, config([entry]), { kind: "on-demand", jobId }, now);
}
export const raw = (value: unknown): string => JSON.stringify(value);
export const result = (value: unknown): string =>
	raw({ resultType: "complete", content: [], structuredContent: value });
export function host(): LookupHost {
	return {
		now: () => now,
		authorize: () => true,
		discover: async () =>
			raw({
				capabilities: {
					tools: {},
					extensions: { "io.github.draftyak/tool": toolExtensionDeclaration },
				},
			}),
		list: async () =>
			raw({
				resultType: "complete",
				tools: canonicalToolsList(config().instances[0]?.kinds ?? []),
			}),
		call: async (lookup, context) => {
			context.acquireRequest();
			return result(
				lookup.kind === "kb.lookup"
					? { entries: [{ label: "Synthetic", text: "Safe fact" }] }
					: lookup.kind === "contact.notes"
						? { notes: [{ label: "Synthetic", text: "Safe note" }] }
						: { busy: [] },
			);
		},
		hygiene: async (_kind, value) => ({
			data: value,
			findings: { instructions: 0, delimiters: 0 },
		}),
		stop: () => {},
		quarantine: () => {},
	};
}
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
