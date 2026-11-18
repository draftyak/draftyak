import { Conversation } from "@draftyak/protocol/entities/conversation";
import { Message } from "@draftyak/protocol/entities/message";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ConversationView,
	type ConversationViewProps,
} from "../../src/conversation/ConversationView.tsx";

const id = (value: number): string => String(value).padStart(26, "0");
const text = (value: string) => ({ untrusted: true, text: value });
function conversation(overrides: Record<string, unknown> = {}): Conversation {
	return Conversation.parse({
		channel: "email",
		id: id(10),
		accountId: id(20),
		workspaceId: null,
		assigneeUserId: null,
		archived: false,
		read: false,
		lastMessageAt: 0,
		threadId: "thread-1",
		subject: text("Conversation subject"),
		labelIds: [],
		...overrides,
	});
}
function email(overrides: Record<string, unknown> = {}): Message {
	return Message.parse({
		channel: "email",
		id: id(30),
		accountId: id(20),
		conversationId: id(10),
		direction: "inbound",
		sentAt: 0,
		provenance: { via: "plugin", sourceId: id(99), receivedAt: 0 },
		providerRef: { messageId: "provider-message", threadId: "thread-1" },
		from: [{ address: text("sender@example.invalid"), name: text("Sender") }],
		replyTo: [],
		to: [],
		cc: [],
		bcc: [],
		subject: text("Message subject"),
		snippet: text("DYTEST metadata must never become the body"),
		labelIds: [],
		dmarc: "none",
		attachments: [],
		...overrides,
	});
}
function chat(overrides: Record<string, unknown> = {}): Message {
	return Message.parse({
		channel: "chat",
		id: id(40),
		accountId: id(20),
		conversationId: id(10),
		direction: "inbound",
		sentAt: 0,
		provenance: { via: "plugin", sourceId: id(99), receivedAt: 0 },
		providerRef: { channelId: "channel-1", ts: "123.001" },
		threadTs: null,
		author: { kind: "bot", id: "provider-bot" },
		subtype: null,
		text: text("Actual chat text"),
		editedAt: null,
		deleted: false,
		attachments: [],
		...overrides,
	});
}
function chatConversation(): Conversation {
	return Conversation.parse({
		channel: "chat",
		id: id(10),
		accountId: id(20),
		workspaceId: null,
		assigneeUserId: null,
		archived: false,
		read: true,
		lastMessageAt: 0,
		channelId: "channel-1",
		name: text("Chat"),
		type: "public",
		external: false,
		shared: false,
		memberCount: 2,
		channelArchived: false,
		member: true,
	});
}
function view(overrides: Partial<ConversationViewProps> = {}): ReactElement {
	return createElement(ConversationView, {
		conversation: conversation(),
		messages: { status: "ready", items: [email()] },
		selectedMessageId: id(30),
		bodyPresentation: {
			messageId: id(30),
			status: "ready",
			content: createElement("p", null, "DYTEST body presentation"),
		},
		intents: { back: vi.fn(), selectMessage: vi.fn(), retry: vi.fn() },
		...overrides,
	});
}
afterEach(cleanup);

describe("conversation view", () => {
	it("renders only associated entity metadata and the selected presentation slot", () => {
		render(view());
		expect(screen.getByRole("heading", { name: "Conversation subject" })).toBeDefined();
		expect(screen.getByRole("list", { name: "Messages" })).toBeDefined();
		expect(
			within(screen.getByRole("article", { name: "Selected message" })).getByText(
				"Message subject",
			),
		).toBeDefined();
		expect(screen.getByText("DYTEST body presentation")).toBeDefined();
		expect(screen.queryByText("DYTEST metadata must never become the body")).toBeNull();
		expect(screen.queryByRole("button", { name: /^(?:approve|send)\b/i })).toBeNull();
	});

	it("keeps repeated recipient and attachment entries stable when other metadata is inserted", () => {
		const recipient = { address: text("DYTEST-repeat@example.invalid"), name: null };
		const attachment = {
			filename: text("DYTEST-repeat.txt"),
			contentType: "text/plain",
			size: 7,
		};
		const renderMessage = (to: unknown[], attachments: unknown[]) =>
			view({ messages: { status: "ready", items: [email({ to, attachments })] } });
		const result = render(renderMessage([recipient, recipient], [attachment, attachment]));
		const recipients = screen.getAllByText("DYTEST-repeat@example.invalid");
		const attachments = within(
			screen.getByRole("list", { name: "Attachment metadata" }),
		).getAllByRole("listitem");
		expect(recipients).toHaveLength(2);
		expect(attachments).toHaveLength(2);
		result.rerender(
			renderMessage(
				[{ address: text("DYTEST-first@example.invalid"), name: null }, recipient, recipient],
				[{ ...attachment, filename: text("DYTEST-first.txt") }, attachment, attachment],
			),
		);
		const nextRecipients = screen.getAllByText("DYTEST-repeat@example.invalid");
		const nextAttachments = within(
			screen.getByRole("list", { name: "Attachment metadata" }),
		).getAllByRole("listitem");
		expect(nextRecipients).toHaveLength(2);
		expect(nextAttachments).toHaveLength(3);
		expect(nextRecipients[0]).toBe(recipients[0]);
		expect(nextRecipients[1]).toBe(recipients[1]);
		expect(nextAttachments[1]).toBe(attachments[0]);
		expect(nextAttachments[2]).toBe(attachments[1]);
	});

	it.each([
		["another account", () => email({ accountId: id(21) })],
		["another conversation", () => email({ conversationId: id(11) })],
		["another channel", () => chat()],
	] as const)("refuses messages from %s before rendering or selection", (_name, makeMessage) => {
		const selectMessage = vi.fn();
		render(
			view({
				messages: { status: "ready", items: [makeMessage()] },
				intents: { back: vi.fn(), selectMessage, retry: vi.fn() },
			}),
		);
		expect(screen.getByRole("alert").textContent).toBe("Conversation unavailable");
		expect(screen.queryByRole("list", { name: "Messages" })).toBeNull();
		expect(screen.queryByText("DYTEST body presentation")).toBeNull();
		expect(selectMessage).not.toHaveBeenCalled();
	});

	it("refuses duplicate and malformed messages as a whole", () => {
		const result = render(view());
		for (const items of [
			[email(), email()],
			[email(), { ...email({ id: id(31) }), sentAt: -1 } as unknown as Message],
		]) {
			result.rerender(view({ messages: { status: "ready", items } }));
			expect(screen.getByRole("alert").textContent).toBe("Conversation unavailable");
			expect(screen.queryByRole("list", { name: "Messages" })).toBeNull();
			expect(screen.queryByText("DYTEST body presentation")).toBeNull();
		}
	});

	it("refuses a stale selected ID and a body slot for a different message", () => {
		const result = render(view({ selectedMessageId: id(31), bodyPresentation: null }));
		expect(screen.getByRole("alert").textContent).toBe("Conversation unavailable");
		result.rerender(
			view({
				bodyPresentation: {
					messageId: id(31),
					status: "ready",
					content: createElement("p", null, "DYTEST wrong-message body"),
				},
			}),
		);
		expect(screen.getByRole("alert").textContent).toBe("Conversation unavailable");
		expect(screen.queryByText("DYTEST wrong-message body")).toBeNull();
		expect(screen.queryByRole("list", { name: "Messages" })).toBeNull();
	});

	it("keeps no-selection, loading, error and empty states distinct", () => {
		const retry = vi.fn(),
			back = vi.fn();
		const intents = { back, retry, selectMessage: vi.fn() };
		const result = render(view({ conversation: null, intents }));
		expect(screen.getByText("Choose a conversation")).toBeDefined();
		expect(screen.queryByText("DYTEST body presentation")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Back to inbox" }));
		expect(back).toHaveBeenCalledTimes(1);
		result.rerender(view({ messages: { status: "loading" }, intents }));
		expect(screen.getByRole("status").textContent).toBe("Loading messages");
		expect(screen.queryByText("DYTEST body presentation")).toBeNull();
		result.rerender(view({ messages: { status: "error" }, intents }));
		expect(screen.getByRole("alert").textContent).toBe("Messages unavailable");
		fireEvent.click(screen.getByRole("button", { name: "Retry messages" }));
		expect(retry).toHaveBeenCalledTimes(1);
		result.rerender(
			view({
				messages: { status: "ready", items: [] },
				selectedMessageId: null,
				bodyPresentation: null,
				intents,
			}),
		);
		expect(screen.getByText("No messages")).toBeDefined();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows body pending/unavailable without using email snippet as content", () => {
		const result = render(view({ bodyPresentation: { messageId: id(30), status: "pending" } }));
		expect(screen.getByRole("status").textContent).toBe("Loading message body");
		result.rerender(view({ bodyPresentation: { messageId: id(30), status: "unavailable" } }));
		expect(screen.getByText("Message body unavailable")).toBeDefined();
		expect(screen.queryByText("DYTEST metadata must never become the body")).toBeNull();
	});

	it("renders hostile metadata as text and only schema-declared truncation disclosures", () => {
		const hostile = '<img src=x onerror="alert(1)"><a href="https://example.invalid">open</a>';
		const item = email({
			subject: { ...text(hostile), truncated: true },
			fromTruncated: true,
			toTruncated: true,
			replyToTruncated: true,
			ccTruncated: true,
			bccTruncated: true,
			attachmentsTruncated: true,
			attachments: [
				{ filename: { ...text(hostile), truncated: true }, contentType: "text/plain", size: 12 },
			],
		});
		const { container } = render(view({ messages: { status: "ready", items: [item] } }));
		expect(screen.getAllByText(hostile, { exact: true })).toHaveLength(2);
		expect(container.querySelector("img,a,script,iframe,object")).toBeNull();
		for (const value of [
			"Subject truncated",
			"Sender list truncated",
			"Recipient list truncated",
			"Reply-To list truncated",
			"Cc list truncated",
			"Bcc list truncated",
			"Attachment list truncated",
		])
			expect(screen.getByText(value, { exact: true })).toBeDefined();
	});

	it("uses actual chat deletion to withhold even a matching old presentation", () => {
		const item = chat({
			deleted: true,
			editedAt: 1,
			text: { ...text("old text"), truncated: true },
		});
		render(
			view({
				conversation: chatConversation(),
				messages: { status: "ready", items: [item] },
				selectedMessageId: item.id,
				bodyPresentation: {
					messageId: item.id,
					status: "ready",
					content: createElement("p", null, "DYTEST stale deleted content"),
				},
			}),
		);
		expect(screen.getByText("Message deleted", { exact: true })).toBeDefined();
		expect(screen.getByText("Edited", { exact: true })).toBeDefined();
		expect(screen.getByText("Message text truncated")).toBeDefined();
		expect(screen.queryByText("DYTEST stale deleted content")).toBeNull();
		expect(screen.queryByText("old text")).toBeNull();
	});

	it("navigates message focus and emits only validated message IDs", () => {
		const selectMessage = vi.fn();
		render(
			view({
				messages: { status: "ready", items: [email(), email({ id: id(31), sentAt: 1 })] },
				selectedMessageId: null,
				bodyPresentation: null,
				intents: { back: vi.fn(), retry: vi.fn(), selectMessage },
			}),
		);
		const controls = within(screen.getByRole("list", { name: "Messages" })).getAllByRole("button");
		const first = controls[0],
			last = controls[1];
		if (!first || !last) throw new Error("DYTEST missing message controls");
		first.focus();
		fireEvent.keyDown(first, { key: "ArrowDown" });
		expect(document.activeElement).toBe(last);
		fireEvent.keyDown(last, { key: "Home" });
		expect(document.activeElement).toBe(first);
		expect(selectMessage).not.toHaveBeenCalled();
		fireEvent.click(first, { detail: 0 });
		expect(selectMessage).toHaveBeenCalledExactlyOnceWith(id(30));
	});
});
