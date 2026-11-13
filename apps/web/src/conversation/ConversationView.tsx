import type { Conversation } from "@draftyak/protocol/entities/conversation";
import { Message } from "@draftyak/protocol/entities/message";
import { type KeyboardEvent, type ReactElement, type ReactNode, useId, useRef } from "react";
import { conversationTitle, displayTime, readConversation } from "../inbox/presentation.ts";
import "./conversation.css";

export type ConversationMessages =
	| { readonly status: "loading" }
	| { readonly status: "error" }
	| { readonly status: "ready"; readonly items: readonly Message[] };

export type MessageBodyPresentation =
	| { readonly messageId: Message["id"]; readonly status: "pending" | "unavailable" }
	| { readonly messageId: Message["id"]; readonly status: "ready"; readonly content: ReactNode };

export interface ConversationViewIntents {
	back(): void;
	selectMessage(id: Message["id"]): void;
	retry(): void;
}

export interface ConversationViewProps {
	readonly conversation: Conversation | null;
	readonly messages: ConversationMessages;
	readonly selectedMessageId: Message["id"] | null;
	/** Presentation from the owning body renderer, not a client response or authority. */
	readonly bodyPresentation: MessageBodyPresentation | null;
	readonly intents: ConversationViewIntents;
}

function readMessages(
	values: readonly Message[],
	conversation: Conversation,
): readonly Message[] | undefined {
	try {
		if (!Array.isArray(values)) return undefined;
		const result: Message[] = [];
		const seen = new Set<string>();
		for (const value of values) {
			const parsed = Message.safeParse(value);
			if (!parsed.success) return undefined;
			const message = parsed.data;
			if (
				seen.has(message.id) ||
				message.accountId !== conversation.accountId ||
				message.conversationId !== conversation.id ||
				message.channel !== conversation.channel
			)
				return undefined;
			seen.add(message.id);
			result.push(message);
		}
		return Object.freeze(result);
	} catch {
		return undefined;
	}
}

function sender(message: Message): string {
	if (message.channel === "chat") return `${message.author.kind}: ${message.author.id}`;
	return (
		message.from
			.map((mailbox) =>
				mailbox.name?.text
					? `${mailbox.name.text} <${mailbox.address.text}>`
					: mailbox.address.text,
			)
			.join(", ") || "Sender unavailable"
	);
}

function keyedOccurrences<Value>(
	values: readonly Value[],
	identity: (value: Value) => string,
): readonly { readonly key: string; readonly value: Value }[] {
	const occurrences = new Map<string, number>();
	return values.map((value) => {
		const identityKey = identity(value);
		const occurrence = occurrences.get(identityKey) ?? 0;
		occurrences.set(identityKey, occurrence + 1);
		return { key: JSON.stringify([identityKey, occurrence]), value };
	});
}

function MessageMetadata({ message }: { readonly message: Message }): ReactElement {
	const time = displayTime(message.sentAt);
	return (
		<dl className="conversation-view__metadata">
			<dt>Direction</dt>
			<dd>{message.direction === "inbound" ? "Incoming" : "Outgoing"}</dd>
			<dt>Sender</dt>
			<dd>
				<bdi>{sender(message)}</bdi>
			</dd>
			<dt>Sent</dt>
			<dd>
				<time dateTime={time.dateTime ?? undefined}>{time.text}</time>
			</dd>
			{message.channel === "email" && (
				<>
					<dt>Subject</dt>
					<dd>
						<bdi>{message.subject.text || "(No subject)"}</bdi>
					</dd>
					<dt>To</dt>
					<dd>
						{message.to.length
							? keyedOccurrences(message.to, (mailbox) => mailbox.address.text).map(
									({ key, value: mailbox }) => <bdi key={key}>{mailbox.address.text} </bdi>,
								)
							: "No recipients recorded"}
					</dd>
					{message.replyTo.length > 0 && (
						<>
							<dt>Reply-To</dt>
							<dd>
								<bdi>{message.replyTo.map((mailbox) => mailbox.address.text).join(", ")}</bdi>
							</dd>
						</>
					)}
					{message.cc.length > 0 && (
						<>
							<dt>Cc</dt>
							<dd>
								<bdi>{message.cc.map((mailbox) => mailbox.address.text).join(", ")}</bdi>
							</dd>
						</>
					)}
					{message.bcc.length > 0 && (
						<>
							<dt>Bcc</dt>
							<dd>
								<bdi>{message.bcc.map((mailbox) => mailbox.address.text).join(", ")}</bdi>
							</dd>
						</>
					)}
					<dt>DMARC</dt>
					<dd>{message.dmarc}</dd>
					{message.subject.truncated && (
						<>
							<dt>Subject disclosure</dt>
							<dd>Subject truncated</dd>
						</>
					)}
					{message.fromTruncated && (
						<>
							<dt>Sender disclosure</dt>
							<dd>Sender list truncated</dd>
						</>
					)}
					{message.toTruncated && (
						<>
							<dt>Recipient disclosure</dt>
							<dd>Recipient list truncated</dd>
						</>
					)}
					{message.replyToTruncated && (
						<>
							<dt>Reply-To disclosure</dt>
							<dd>Reply-To list truncated</dd>
						</>
					)}
					{message.ccTruncated && (
						<>
							<dt>Cc disclosure</dt>
							<dd>Cc list truncated</dd>
						</>
					)}
					{message.bccTruncated && (
						<>
							<dt>Bcc disclosure</dt>
							<dd>Bcc list truncated</dd>
						</>
					)}
					{message.attachmentsTruncated && (
						<>
							<dt>Attachment disclosure</dt>
							<dd>Attachment list truncated</dd>
						</>
					)}
				</>
			)}
			{message.channel === "chat" && message.editedAt !== null && (
				<>
					<dt>Edit status</dt>
					<dd>Edited</dd>
				</>
			)}
			{message.channel === "chat" && message.text.truncated && (
				<>
					<dt>Text disclosure</dt>
					<dd>Message text truncated</dd>
				</>
			)}
			{message.attachments.length > 0 && (
				<>
					<dt>Attachments</dt>
					<dd>
						<ul aria-label="Attachment metadata">
							{keyedOccurrences(message.attachments, (attachment) =>
								JSON.stringify([attachment.filename, attachment.size]),
							).map(({ key, value: attachment }) => (
								<li key={key}>
									<bdi>{attachment.filename.text}</bdi> ({attachment.size} bytes)
									{attachment.filename.truncated && " — filename truncated"}
								</li>
							))}
						</ul>
					</dd>
				</>
			)}
		</dl>
	);
}

export function ConversationView({
	conversation: rawConversation,
	messages,
	selectedMessageId,
	bodyPresentation,
	intents,
}: ConversationViewProps): ReactElement {
	const headingId = useId();
	const controls = useRef<Array<HTMLButtonElement | null>>([]);
	const conversation = rawConversation === null ? null : readConversation(rawConversation);
	const rows =
		conversation && messages.status === "ready"
			? readMessages(messages.items, conversation)
			: undefined;
	const selected = rows?.find((message) => message.id === selectedMessageId);
	const invalidStatus =
		messages.status !== "ready" && messages.status !== "loading" && messages.status !== "error";
	const mismatch =
		conversation === undefined ||
		invalidStatus ||
		(messages.status === "ready" &&
			(rows === undefined ||
				(selectedMessageId !== null && !selected) ||
				(bodyPresentation != null && bodyPresentation.messageId !== selected?.id)));
	const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
		if (event.altKey || event.ctrlKey || event.metaKey || !rows?.length) return;
		let next: number;
		switch (event.key) {
			case "ArrowDown":
				next = Math.min(index + 1, rows.length - 1);
				break;
			case "ArrowUp":
				next = Math.max(index - 1, 0);
				break;
			case "Home":
				next = 0;
				break;
			case "End":
				next = rows.length - 1;
				break;
			default:
				return;
		}
		event.preventDefault();
		controls.current[next]?.focus();
	};
	const title = conversation ? conversationTitle(conversation) : undefined;
	return (
		<section className="conversation-view" aria-labelledby={headingId}>
			<button type="button" onClick={() => intents.back()}>
				Back to inbox
			</button>
			<h2 id={headingId}>
				<bdi>{title?.text ?? "Conversation"}</bdi>
			</h2>
			{title?.truncated && <p>Title truncated</p>}
			{rawConversation === null ? (
				<p>Choose a conversation</p>
			) : mismatch ? (
				<>
					<p role="alert">Conversation unavailable</p>
					<button type="button" onClick={() => intents.retry()}>
						Retry messages
					</button>
				</>
			) : messages.status === "loading" ? (
				<p role="status">Loading messages</p>
			) : messages.status === "error" ? (
				<>
					<p role="alert">Messages unavailable</p>
					<button type="button" onClick={() => intents.retry()}>
						Retry messages
					</button>
				</>
			) : rows?.length === 0 ? (
				<p>No messages</p>
			) : (
				<>
					<ul className="conversation-view__messages" aria-label="Messages">
						{rows?.map((message, index) => {
							const time = displayTime(message.sentAt);
							return (
								<li key={message.id}>
									<button
										type="button"
										aria-current={message.id === selectedMessageId ? "true" : undefined}
										ref={(element) => {
											controls.current[index] = element;
										}}
										onClick={() => intents.selectMessage(message.id)}
										onKeyDown={(event) => moveFocus(event, index)}
									>
										<bdi>{sender(message)}</bdi>{" "}
										<time dateTime={time.dateTime ?? undefined}>{time.text}</time>
										{message.channel === "chat" && message.deleted && " — deleted"}
									</button>
								</li>
							);
						})}
					</ul>
					{selected ? (
						<article aria-label="Selected message">
							<MessageMetadata message={selected} />
							{selected.channel === "chat" && selected.deleted ? (
								<p>Message deleted</p>
							) : bodyPresentation?.status === "ready" ? (
								<section aria-label="Message body">{bodyPresentation.content}</section>
							) : bodyPresentation?.status === "pending" ? (
								<p role="status">Loading message body</p>
							) : (
								<p>Message body unavailable</p>
							)}
						</article>
					) : (
						<p>Choose a message</p>
					)}
				</>
			)}
		</section>
	);
}
