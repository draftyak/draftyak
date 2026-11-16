import type { Conversation } from "@draftyak/protocol/entities/conversation";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
	type KeyboardEvent,
	type ReactElement,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
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

const ROW_HEIGHT = 320;
const INITIAL_HEIGHT = 640;

function readRows(data: ConversationListData): readonly Conversation[] | undefined {
	try {
		if (data.status !== "ready" || !Array.isArray(data.items)) return undefined;
		return readConversations(data.items);
	} catch {
		return undefined;
	}
}

function Spacer({ rows }: { readonly rows: number }): ReactElement {
	return (
		<li role="presentation" aria-hidden="true" className="inbox-panel__gap">
			<svg width={1} height={rows * ROW_HEIGHT} aria-hidden="true" focusable="false" />
		</li>
	);
}

export function ConversationList({
	data,
	selectedConversationId,
	intents,
}: ConversationListProps): ReactElement {
	const headingId = useId();
	const section = useRef<HTMLElement | null>(null);
	const viewport = useRef<HTMLDivElement | null>(null);
	const controls = useRef(new Map<string, HTMLButtonElement>());
	const focusInside = useRef(false);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const [focusTarget, setFocusTarget] = useState<string | null>(null);
	const rows = readRows(data);
	const virtualizer = useVirtualizer<HTMLDivElement, HTMLLIElement>({
		count: rows?.length ?? 0,
		getScrollElement: () => viewport.current,
		estimateSize: () => ROW_HEIGHT,
		getItemKey: (index) => rows?.[index]?.id ?? index,
		initialRect: { width: 0, height: INITIAL_HEIGHT },
		overscan: 2,
		directDomUpdates: false,
		rangeExtractor(range) {
			const result = new Set(defaultRangeExtractor(range));
			for (const id of [focusedId, focusTarget]) {
				const index = id === null ? -1 : (rows?.findIndex((row) => row.id === id) ?? -1);
				if (index >= 0) result.add(index);
			}
			return [...result].sort((left, right) => left - right);
		},
	});
	const virtualItems = virtualizer.getVirtualItems();

	useLayoutEffect(() => {
		if (focusTarget !== null) {
			const target = controls.current.get(focusTarget);
			if (target !== undefined && rows?.some((row) => row.id === focusTarget)) {
				target.focus({ preventScroll: true });
				setFocusTarget(null);
			} else if (!rows?.some((row) => row.id === focusTarget)) {
				setFocusTarget(null);
			}
		}
		if (focusedId !== null && !rows?.some((row) => row.id === focusedId)) {
			if (focusInside.current) section.current?.focus({ preventScroll: true });
			setFocusedId(null);
		}
	}, [focusTarget, focusedId, rows]);

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
		const target = rows[next];
		if (target === undefined) return;
		event.preventDefault();
		setFocusTarget(target.id);
		virtualizer.scrollToIndex(next, { align: "auto", behavior: "auto" });
	};

	let previous = -1;
	const visible = virtualItems.flatMap((item) => {
		const conversation = rows?.[item.index];
		if (conversation === undefined) return [];
		const gap = item.index - previous - 1;
		previous = item.index;
		const title = conversationTitle(conversation);
		const time = displayTime(conversation.lastMessageAt);
		return [
			gap > 0 ? <Spacer key={`gap-${conversation.id}`} rows={gap} /> : null,
			<li
				key={conversation.id}
				className="inbox-panel__row"
				aria-posinset={item.index + 1}
				aria-setsize={rows?.length}
			>
				<button
					type="button"
					className="inbox-panel__conversation"
					aria-current={conversation.id === selectedConversationId ? "true" : undefined}
					ref={(element) => {
						if (element === null) controls.current.delete(conversation.id);
						else controls.current.set(conversation.id, element);
					}}
					onFocus={() => setFocusedId(conversation.id)}
					onClick={() => intents.selectConversation(conversation.id)}
					onKeyDown={(event) => moveFocus(event, item.index)}
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
					{conversation.channel === "chat" && conversation.shared && <span>Shared channel</span>}
					{conversation.channel === "chat" && !conversation.member && <span>Not a member</span>}
					{title.truncated && <span>Title truncated</span>}
					<time dateTime={time.dateTime ?? undefined}>{time.text}</time>
				</button>
			</li>,
		];
	});
	const trailing = Math.max(0, (rows?.length ?? 0) - previous - 1);

	return (
		<section
			ref={section}
			tabIndex={-1}
			className="inbox-panel"
			aria-labelledby={headingId}
			onFocusCapture={() => {
				focusInside.current = true;
			}}
			onBlurCapture={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) {
					focusInside.current = false;
					setFocusedId(null);
				}
			}}
		>
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
				<div className="inbox-panel__viewport" ref={viewport}>
					<ul className="inbox-panel__items" aria-label="Conversations">
						{visible}
						{trailing > 0 && <Spacer rows={trailing} />}
					</ul>
				</div>
			)}
		</section>
	);
}
