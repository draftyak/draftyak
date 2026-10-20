import type { VerifiedThreadMeta } from "./model.ts";

/** Project only hub-verified binding facts; message contents never enter a plan. */
export function metadata(value: VerifiedThreadMeta): VerifiedThreadMeta {
	const sender = value.sender;
	const automatic = value.automatic;
	return {
		account: value.account,
		channel: structuredClone(value.channel),
		sender:
			sender?.kind === "gmail"
				? {
						kind: sender.kind,
						address: sender.address,
						topmostDmarc: sender.topmostDmarc,
						aligned: sender.aligned,
						singleFrom: sender.singleFrom,
					}
				: sender?.kind === "slack"
					? { kind: sender.kind, userId: sender.userId, isBot: sender.isBot }
					: undefined,
		ownerRecipient: value.ownerRecipient,
		sensitivity: value.sensitivity,
		automatic:
			automatic === undefined
				? undefined
				: {
						directToOwner: automatic.directToOwner,
						knownContact: automatic.knownContact,
						bulk: automatic.bulk,
						list: automatic.list,
						noReply: automatic.noReply,
					},
	};
}
