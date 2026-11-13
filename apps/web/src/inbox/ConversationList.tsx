import type { Conversation } from "@draftyak/protocol/entities/conversation";
import { type KeyboardEvent, type ReactElement, useId, useRef } from "react";
import { conversationTitle, displayTime, readConversations } from "./presentation.ts";
import "./conversations.css";

export type ConversationListData =
	| { readonly status: "loading" }
	| { readonly status: "error" }
	| { readonly status: "ready"; readonly items: readonly Conversation[] };

export interface ConversationListIntents {
	selectConversation(id: Conversation["id"]): void;
	retry(): void;
}

export interface ConversationListProps {
	readonly data: ConversationListData;
	readonly selectedConversationId: Conversation["id"] | null;
	readonly intents: ConversationListIntents;
}

export function ConversationList({
	data,
	selectedConversationId,
	intents,
}: ConversationListProps): ReactElement {
	const headingId = useId();
	const controls = useRef<Array<HTMLButtonElement | null>>([]);
	const rows = data.status === "ready" ? readConversations(data.items) : undefined;
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

	return (
		<section className="inbox-panel" aria-labelledby={headingId}>
			<h2 id={headingId}>Inbox</h2>
			{data.status === "loading" ? (
				<p role="status">Loading conversations</p>
			) : data.status === "error" || rows === undefined ? (
				<div>
					<p role="alert">Conversations unavailable</p>
					<button type="button" onClick={() => intents.retry()}>
						Retry conversations
					</button>
				</div>
			) : rows.length === 0 ? (
				<p>No conversations</p>
			) : (
				<ul className="inbox-panel__items" aria-label="Conversations">
					{rows.map((conversation, index) => {
						const title = conversationTitle(conversation);
						const time = displayTime(conversation.lastMessageAt);
						return (
							<li key={conversation.id}>
								<button
									type="button"
									className="inbox-panel__conversation"
									aria-current={conversation.id === selectedConversationId ? "true" : undefined}
									ref={(element) => {
										controls.current[index] = element;
									}}
									onClick={() => intents.selectConversation(conversation.id)}
									onKeyDown={(event) => moveFocus(event, index)}
								>
									<strong>
										<bdi>{title.text}</bdi>
									</strong>
									<span>{conversation.channel === "email" ? "Email" : "Chat"}</span>
									<span>{conversation.read ? "Read" : "Unread"}</span>
									{conversation.archived && <span>Archived in inbox</span>}
									{conversation.channel === "chat" && conversation.channelArchived && (
										<span>Channel archived</span>
									)}
									{conversation.channel === "chat" && conversation.external && (
										<span>External channel</span>
									)}
									{conversation.channel === "chat" && conversation.shared && (
										<span>Shared channel</span>
									)}
									{conversation.channel === "chat" && !conversation.member && (
										<span>Not a member</span>
									)}
									{title.truncated && <span>Title truncated</span>}
									<time dateTime={time.dateTime ?? undefined}>{time.text}</time>
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
