import {
	Participant,
	type ToolArgumentsV1,
	toolKindsV1,
	validatePresetItem,
} from "@draftyak/protocol/tool-v1";
import { calendarWindow } from "./clock.ts";
import { metadata } from "./metadata.ts";
import { LookupError, type OwnerState, type PresetItem, type VerifiedThreadMeta } from "./model.ts";

export function verifiedSender(meta: VerifiedThreadMeta): string | undefined {
	meta = metadata(meta);
	const sender = meta.sender;
	if (
		meta.channel === "gmail" &&
		sender?.kind === "gmail" &&
		sender.topmostDmarc === "pass" &&
		sender.aligned === true &&
		sender.singleFrom === true &&
		sender.address.includes("@") &&
		Participant.safeParse(sender.address).success
	)
		return sender.address;
	if (
		meta.channel === "slack" &&
		sender?.kind === "slack" &&
		sender.isBot === false &&
		/^[UW][A-Z0-9]{2,20}$/.test(sender.userId) &&
		Participant.safeParse(sender.userId).success
	)
		return sender.userId;
	return undefined;
}
export function bindLookup(
	item: PresetItem,
	meta: VerifiedThreadMeta,
	owner: OwnerState,
	now: number,
): { arguments: ToolArgumentsV1[PresetItem["kind"]]; messageDerived: boolean } {
	item = structuredClone(item);
	meta = metadata(meta);
	owner = structuredClone(owner);
	const checked = validatePresetItem(item, { channel: meta.channel });
	if (!checked.ok) throw new LookupError("INVALID_PRESET");
	const args: Record<string, unknown> = {};
	let messageDerived = false;
	for (const [field, binding] of Object.entries(checked.value.bindings)) {
		switch (binding.source) {
			case "const":
				args[field] = binding.value;
				break;
			case "owner":
				args[field] = binding.field === "zone" ? owner.zone : structuredClone(owner.workingHours);
				break;
			case "clock":
				args[field] = calendarWindow(owner, now, binding.horizonDays);
				break;
			case "participant.verifiedSender":
				args[field] = verifiedSender(meta);
				messageDerived = true;
				break;
			case "participant.ownerRecipient":
				args[field] =
					meta.channel === "gmail" && meta.ownerRecipient?.includes("@")
						? meta.ownerRecipient
						: meta.channel === "slack" && /^[UW][A-Z0-9]{2,20}$/.test(meta.ownerRecipient ?? "")
							? meta.ownerRecipient
							: undefined;
				messageDerived = true;
				break;
		}
	}
	const parsed = toolKindsV1[item.kind].arguments.safeParse(args);
	if (!parsed.success) throw new LookupError("BINDING_UNAVAILABLE");
	return { arguments: parsed.data, messageDerived };
}
