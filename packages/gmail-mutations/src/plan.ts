import { channelV1, type Mutation } from "@draftyak/protocol/channel-v1";
import { array, gmailId, record, refuse, unique } from "./input.ts";

export interface GmailModifyRequest {
	readonly providerId: string;
	readonly method: "POST";
	readonly url: string;
	readonly headers: Readonly<{ "content-type": "application/json" }>;
	readonly body: string;
}

/** Request DATA only: no account, mode, role, credential or native permission. */
export interface GmailMutationPlan {
	readonly operation: Mutation;
	readonly requests: readonly GmailModifyRequest[];
}

export function planGmailMutation(input: unknown): GmailMutationPlan {
	const value = record(input, ["op", "messages", "labelIds"]);
	const messages = array(value.messages, 100, (entry) => {
		const message = record(entry, ["kind", "providerId"]);
		if (message.kind !== "email") return refuse();
		return { kind: "email" as const, providerId: gmailId(message.providerId) };
	});
	const candidate = {
		op: value.op,
		messages,
		...(Object.hasOwn(value, "labelIds") ? { labelIds: array(value.labelIds, 20, gmailId) } : {}),
	};
	const parsed = channelV1.tools.channel_mutate.input.safeParse(candidate);
	if (!parsed.success) return refuse();
	const request = parsed.data;
	unique(
		request.messages.map((message) => {
			if (message.kind !== "email") return refuse();
			return message.providerId;
		}),
	);
	let adds: readonly string[] = [];
	let removes: readonly string[] = [];
	if (request.op === "label" || request.op === "unlabel") {
		// Deliberate supported user-label subset. Other opaque labels need a later policy.
		if (request.labelIds.some((id) => !/^Label_[A-Za-z0-9_-]+$/.test(id))) return refuse();
		unique(request.labelIds);
		if (request.op === "label") adds = request.labelIds;
		else removes = request.labelIds;
	} else if (request.op === "archive") removes = ["INBOX"];
	else if (request.op === "unarchive") adds = ["INBOX"];
	else if (request.op === "read") removes = ["UNREAD"];
	else adds = ["UNREAD"];
	const body = JSON.stringify({ addLabelIds: adds, removeLabelIds: removes });
	return Object.freeze({
		operation: request.op,
		requests: Object.freeze(
			messages.map(({ providerId }) =>
				Object.freeze({
					providerId,
					method: "POST" as const,
					url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${providerId}/modify`,
					headers: Object.freeze({ "content-type": "application/json" as const }),
					body,
				}),
			),
		),
	});
}
