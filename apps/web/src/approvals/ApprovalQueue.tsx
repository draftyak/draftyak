import type { SendReview } from "@draftyak/protocol/device-api";
import { OutboxItem, type StateReason } from "@draftyak/protocol/entities/outbox";
import { type ReactElement, useId } from "react";
import { FlagList } from "../composer/FlagList.tsx";

export interface ApprovalQueueProps {
	readonly items: readonly OutboxItem[];
	readonly reviews?: readonly SendReview[];
}

interface DisplayAttachment {
	readonly key: string;
	readonly filename: string;
	readonly contentType: string;
	readonly size: number;
}

type DisplaySnapshot = {
	readonly body: { readonly text: string; readonly footer: string };
	readonly attachments: readonly DisplayAttachment[];
} & (
	| {
			readonly kind: "email";
			readonly email: {
				readonly from: string;
				readonly to: readonly string[];
				readonly cc: readonly string[];
				readonly bcc: readonly string[];
				readonly subject: string;
			};
	  }
	| {
			readonly kind: "chat";
			readonly chat: {
				readonly channelName: string;
				readonly channelType: string;
				readonly shared: boolean | undefined;
			};
	  }
);

interface ReviewDisplay {
	readonly snapshot: DisplaySnapshot;
	readonly flags: unknown;
}

const REASONS: Readonly<Record<StateReason, string>> = {
	missed: "Delivery window missed",
	new_reply: "New reply received",
	channel_changed: "Conversation changed",
	approver_revoked: "Approver revoked",
	credential_lost: "Credential unavailable",
	plugin_quarantined: "Plugin quarantined",
	policy: "Policy changed",
	restored: "Restored data",
	not_found: "Proposal not found",
};

function readItems(input: readonly OutboxItem[]): readonly OutboxItem[] | undefined {
	try {
		const items = input.map((item) => OutboxItem.parse(item));
		return new Set(items.map((item) => item.id)).size === items.length ? items : undefined;
	} catch {
		return undefined;
	}
}

function displayStrings(input: unknown): readonly string[] | undefined {
	if (!Array.isArray(input)) return undefined;
	const result: string[] = [];
	for (const value of input) {
		if (typeof value !== "string") return undefined;
		result.push(value);
	}
	return result;
}

function captureDisplay(review: SendReview): ReviewDisplay | undefined {
	const snapshot = review.snapshot;
	const { text, footer } = snapshot.body;
	const rawAttachments = snapshot.attachments;
	if (typeof text !== "string" || typeof footer !== "string" || !Array.isArray(rawAttachments))
		return undefined;
	const attachments: DisplayAttachment[] = [];
	const occurrences = new Map<string, number>();
	for (const file of rawAttachments) {
		if (file === null || typeof file !== "object") return undefined;
		const { filename, contentType, size } = file;
		if (
			typeof filename !== "string" ||
			typeof contentType !== "string" ||
			!Number.isSafeInteger(size) ||
			size < 0
		)
			return undefined;
		const identity = JSON.stringify([filename, contentType, size]);
		const occurrence = occurrences.get(identity) ?? 0;
		occurrences.set(identity, occurrence + 1);
		attachments.push({ key: `${identity}:${occurrence}`, filename, contentType, size });
	}
	const common = { body: { text, footer }, attachments };
	if (snapshot.kind === "email") {
		const email = snapshot.email;
		const { from, subject } = email;
		const to = displayStrings(email.to);
		const cc = displayStrings(email.cc);
		const bcc = displayStrings(email.bcc);
		if (typeof from !== "string" || typeof subject !== "string" || !to || !cc || !bcc)
			return undefined;
		return {
			snapshot: { ...common, kind: "email", email: { from, to, cc, bcc, subject } },
			flags: review.flags,
		};
	}
	if (snapshot.kind === "chat") {
		const { channelName, channelType, shared } = snapshot.chat;
		if (
			typeof channelName !== "string" ||
			!["dm", "group_dm", "public", "private"].includes(channelType) ||
			(shared !== undefined && typeof shared !== "boolean")
		)
			return undefined;
		return {
			snapshot: { ...common, kind: "chat", chat: { channelName, channelType, shared } },
			flags: review.flags,
		};
	}
	return undefined;
}

function matchingReview(
	item: OutboxItem,
	reviews: readonly SendReview[],
): ReviewDisplay | undefined {
	try {
		const matches = reviews.filter((review) => review.id === item.id);
		if (matches.length !== 1) return undefined;
		const review = matches[0];
		if (
			!review ||
			review.state !== item.state ||
			review.stateReason !== item.stateReason ||
			review.contentHash !== item.contentHash ||
			review.flagsHash !== item.flagsHash ||
			review.snapshot.outbox !== item.id ||
			review.snapshot.account !== item.accountId ||
			review.snapshot.source.draft !== item.draftId ||
			review.snapshot.source.rev !== item.rev
		)
			return undefined;
		return captureDisplay(review);
	} catch {
		return undefined;
	}
}

function Proposal({
	item,
	review,
}: {
	readonly item: OutboxItem;
	readonly review: ReviewDisplay | undefined;
}): ReactElement {
	return (
		<article>
			<h3>Draft revision {item.rev}</h3>
			<dl>
				<dt>Proposal</dt>
				<dd>
					<code>{item.id}</code>
				</dd>
				<dt>Draft</dt>
				<dd>
					<code>{item.draftId}</code>
				</dd>
				<dt>Account</dt>
				<dd>
					<code>{item.accountId}</code>
				</dd>
				<dt>Status</dt>
				<dd>{item.state === "NEEDS_REAPPROVAL" ? "Needs approval again" : "Pending approval"}</dd>
				<dt>Required approvals</dt>
				<dd>{item.requiredApprovals}</dd>
				<dt>Not before (UTC milliseconds)</dt>
				<dd>{item.notBefore ?? "Not scheduled"}</dd>
				<dt>Deliver by (UTC milliseconds)</dt>
				<dd>{item.deliverBy ?? "Not supplied"}</dd>
			</dl>
			{item.state === "NEEDS_REAPPROVAL" && <p>{REASONS[item.stateReason]}</p>}
			{review === undefined ? (
				<p>Proposal details unavailable</p>
			) : (
				<section aria-label="Frozen proposal snapshot">
					<p>This is the proposal snapshot. Editing the draft does not change this content.</p>
					{review.snapshot.kind === "email" ? (
						<dl>
							<dt>From</dt>
							<dd>{review.snapshot.email.from}</dd>
							<dt>To</dt>
							<dd>{review.snapshot.email.to.join(", ")}</dd>
							<dt>Cc</dt>
							<dd>{review.snapshot.email.cc.join(", ") || "None"}</dd>
							<dt>Bcc</dt>
							<dd>{review.snapshot.email.bcc.join(", ") || "None"}</dd>
							<dt>Subject</dt>
							<dd>{review.snapshot.email.subject || "No subject"}</dd>
						</dl>
					) : (
						<p>
							Chat: {review.snapshot.chat.channelName}; {review.snapshot.chat.channelType};{" "}
							{review.snapshot.chat.shared === undefined
								? "sharing fact unavailable"
								: review.snapshot.chat.shared
									? "shared"
									: "not shared"}
						</p>
					)}
					<section aria-label="Proposal body">
						<pre dir="auto">{review.snapshot.body.text}</pre>
					</section>
					<section aria-label="Proposal footer">
						<pre dir="auto">{review.snapshot.body.footer}</pre>
					</section>
					{review.snapshot.attachments.length > 0 && (
						<ul aria-label="Proposal attachments">
							{review.snapshot.attachments.map((file) => (
								<li key={file.key}>
									{file.filename}, {file.contentType}, {file.size} bytes
								</li>
							))}
						</ul>
					)}
					<FlagList flags={review.flags} />
				</section>
			)}
		</article>
	);
}

export function ApprovalQueue({ items: input, reviews = [] }: ApprovalQueueProps): ReactElement {
	const heading = useId();
	const items = readItems(input);
	if (items === undefined) return <p role="alert">Approval queue unavailable</p>;
	const pending = items.filter(
		(item) => item.state === "PENDING_APPROVAL" || item.state === "NEEDS_REAPPROVAL",
	);
	return (
		<section className="approval-queue" aria-labelledby={heading}>
			<h2 id={heading}>Pending approval queue</h2>
			<p>Approval is unavailable in this browser. Use the trusted approval window.</p>
			{pending.length === 0 ? (
				<p>No proposals awaiting approval</p>
			) : (
				<ul>
					{pending.map((item) => (
						<li key={item.id}>
							<Proposal item={item} review={matchingReview(item, reviews)} />
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
