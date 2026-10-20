import { jcsSha256 } from "@draftyak/protocol/hash";
import { validatePresets } from "@draftyak/protocol/tool-v1";
import { bindLookup, verifiedSender } from "./binder.ts";
import { metadata } from "./metadata.ts";
import {
	isChannel,
	LookupError,
	type LookupPlan,
	type LookupTrigger,
	type OwnerConfig,
	type PendingLookupConfirmation,
	type PlannedLookup,
	type SkipReason,
	type VerifiedThreadMeta,
} from "./model.ts";

const issuedPlans = new WeakSet<object>();

// These values were just created by this module from detached trusted configuration.
// Freezing preserves issued-plan immutability; it does not admit or validate caller objects.
function freezeIssuedData(value: unknown): void {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeIssuedData(child);
		Object.freeze(value);
	}
}

/** Object provenance only; authorization and current hub facts remain separate gates. */
export function isPlannedLookup(value: unknown): value is LookupPlan {
	return typeof value === "object" && value !== null && issuedPlans.has(value);
}

export function planLookups(
	meta: VerifiedThreadMeta,
	config: OwnerConfig,
	trigger: LookupTrigger,
	now: number,
): LookupPlan {
	try {
		meta = metadata(meta);
		const route = config.route;
		if (typeof route !== "function") throw new LookupError("INVALID_INPUT");
		config = {
			...structuredClone({
				owner: config.owner,
				presets: config.presets,
				instances: config.instances,
				consents: config.consents,
				aiDestination: config.aiDestination,
				aiDestinationClass: config.aiDestinationClass,
			}),
			route,
		};
		trigger = structuredClone(trigger);
		if (
			!Number.isSafeInteger(now) ||
			now < 0 ||
			!trigger.jobId ||
			!meta.account ||
			!isChannel(meta.channel)
		)
			throw new LookupError("INVALID_INPUT");
		const checked = validatePresets(config.presets, { channel: meta.channel });
		if (!checked.ok) throw new LookupError("INVALID_PRESET");
		const calls: PlannedLookup[] = [];
		const skipped: { index: number; reason: SkipReason }[] = [];
		const pendingConfirmations: PendingLookupConfirmation[] = [];
		const plan = (): LookupPlan => {
			const issued = structuredClone({
				jobId: trigger.jobId,
				trigger: trigger.kind,
				calls,
				skipped,
				pendingConfirmations,
			});
			freezeIssuedData(issued);
			issuedPlans.add(issued);
			return issued;
		};
		const deny = (reason: SkipReason): LookupPlan => {
			skipped.push({ index: -1, reason });
			return plan();
		};
		if (trigger.kind !== "on-demand" && trigger.kind !== "automatic")
			return deny("TRIGGER_REFUSED");
		if (meta.channel === "sms" && meta.sensitivity !== "normal") return deny("SENSITIVE");
		const auto = meta.automatic;
		if (
			trigger.kind === "automatic" &&
			(meta.channel === "sms" ||
				!["local", "cloud-no-train"].includes(config.aiDestinationClass) ||
				!verifiedSender(meta) ||
				auto?.directToOwner !== true ||
				auto.knownContact !== true ||
				auto.bulk !== false ||
				auto.list !== false ||
				auto.noReply !== false)
		)
			return deny("AUTOMATIC_INELIGIBLE");
		const preset = trigger.presetId
			? checked.value.find((item) => item.id === trigger.presetId)
			: checked.value.find((item) => item.isDefault);
		if (!preset) return plan();
		const seen = new Set<string>();
		for (const [index, item] of preset.items.entries()) {
			const skip = (reason: SkipReason): void => {
				skipped.push({ index, reason });
			};
			if (
				trigger.disabledItems?.includes(index) ||
				!(trigger.kind === "automatic" ? item.autoDraft : item.onDemand) ||
				(trigger.kind === "automatic" && item.kind === "contact.notes")
			) {
				skip("DISABLED");
				continue;
			}
			const instance = config.instances.find((tool) => tool.id === item.toolInstance);
			if (
				instance?.status !== "active" ||
				!["no-train", "may-train"].includes(instance.posture) ||
				!["local", "local-network", "cloud-tool"].includes(instance.destination) ||
				!Array.isArray(instance.hosts) ||
				!instance.hosts.every((host) => typeof host === "string" && host.length > 0) ||
				!instance.kinds.includes(item.kind) ||
				!/^[a-f0-9]{64}$/.test(instance.approvedDigest) ||
				instance.approvedDigest !== instance.currentDigest ||
				!/^[a-f0-9]{64}$/.test(instance.currentFieldsDigest) ||
				!Number.isSafeInteger(instance.currentDisclosureVersion) ||
				instance.currentDisclosureVersion < 1 ||
				!Number.isSafeInteger(instance.outputMaxBytes?.[item.kind]) ||
				(instance.outputMaxBytes[item.kind] ?? 0) <= 0
			) {
				skip("INSTANCE_UNAVAILABLE");
				continue;
			}
			if (
				!config.consents.some(
					(consent) =>
						consent.active === true &&
						consent.revoked === false &&
						consent.account === meta.account &&
						consent.instance === instance.id &&
						consent.aiDestination === config.aiDestination &&
						consent.kinds.includes(item.kind) &&
						consent.fieldsDigest === instance.currentFieldsDigest &&
						consent.disclosureVersion === instance.currentDisclosureVersion,
				)
			) {
				skip("CONSENT_REQUIRED");
				continue;
			}
			let bound: ReturnType<typeof bindLookup>;
			try {
				bound = bindLookup(item, meta, config.owner, now);
			} catch {
				skip("BINDING_UNAVAILABLE");
				continue;
			}
			if (bound.messageDerived && instance.posture !== "no-train") {
				skip("ROUTE_REFUSED");
				continue;
			}
			const metadataClasses = bound.messageDerived ? [`${meta.channel}.metadata`] : [];
			const common = {
				account: meta.account,
				channel: meta.channel,
				toolPosture: instance.posture,
				sensitivity: meta.sensitivity ?? "normal",
			};
			if (
				config.route(
					structuredClone({
						...common,
						phase: "arguments",
						classes: bound.messageDerived ? metadataClasses : ["hub.state"],
						target: instance.id,
						destinationClass: instance.destination,
						effect: "lookup",
					}),
				) !== true ||
				config.route(
					structuredClone({
						...common,
						phase: "result",
						classes: [`tool.${item.kind}`, ...metadataClasses],
						target: config.aiDestination,
						destinationClass: config.aiDestinationClass,
						effect: "prompt",
					}),
				) !== true
			) {
				skip("ROUTE_REFUSED");
				continue;
			}
			const argumentDigest = jcsSha256({
				instance: instance.id,
				kind: item.kind,
				arguments: bound.arguments,
			});
			const confirmation = trigger.confirmation;
			if (
				trigger.kind === "on-demand" &&
				instance.destination === "cloud-tool" &&
				bound.messageDerived &&
				!(
					confirmation?.jobId === trigger.jobId &&
					confirmation.account === meta.account &&
					confirmation.argumentDigests.includes(argumentDigest)
				)
			) {
				pendingConfirmations.push({
					index,
					instance: instance.id,
					kind: item.kind,
					boundFields: Object.keys(bound.arguments).sort(),
					argumentDigest,
				});
				skip("CONFIRMATION_REQUIRED");
				continue;
			}
			if (seen.has(argumentDigest)) {
				skip("DUPLICATE");
				continue;
			}
			seen.add(argumentDigest);
			calls.push({
				ref: `c${calls.length + 1}` as PlannedLookup["ref"],
				jobId: trigger.jobId,
				account: meta.account,
				channel: meta.channel,
				aiDestination: config.aiDestination,
				instance: structuredClone(instance),
				kind: item.kind,
				arguments: bound.arguments,
				argumentDigest,
				messageDerived: bound.messageDerived,
				slackDerived: meta.channel === "slack" && bound.messageDerived,
				owner: structuredClone(config.owner),
			});
		}
		return plan();
	} catch (error) {
		throw new LookupError(
			error instanceof LookupError && ["INVALID_INPUT", "INVALID_PRESET"].includes(error.code)
				? error.code
				: "INVALID_INPUT",
		);
	}
}
