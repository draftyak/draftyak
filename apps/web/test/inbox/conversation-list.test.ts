import { Conversation } from "@draftyak/protocol/entities/conversation";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationList, type ConversationListProps } from "../../src/inbox/ConversationList.tsx";

const id = (value: number): string => String(value).padStart(26, "0");
const text = (value: string) => ({ untrusted: true, text: value });
function email(overrides: Record<string, unknown> = {}): Conversation {
	return Conversation.parse({
		channel: "email",
		id: id(1),
		accountId: id(20),
		workspaceId: null,
		assigneeUserId: null,
		archived: false,
		read: false,
		lastMessageAt: 0,
		threadId: "thread-1",
		subject: text("A real subject"),
		labelIds: [],
		...overrides,
	});
}
function chat(overrides: Record<string, unknown> = {}): Conversation {
	return Conversation.parse({
		channel: "chat",
		id: id(2),
		accountId: id(21),
		workspaceId: null,
		assigneeUserId: null,
		archived: false,
		read: true,
		lastMessageAt: null,
		channelId: "channel-1",
		name: text("Team chat"),
		type: "public",
		external: true,
		shared: true,
		memberCount: 3,
		channelArchived: true,
		member: false,
		...overrides,
	});
}
function view(overrides: Partial<ConversationListProps> = {}): ReactElement {
	return createElement(ConversationList, {
		data: { status: "ready", items: [email()] },
		selectedConversationId: null,
		intents: { selectConversation: vi.fn(), retry: vi.fn() },
		...overrides,
	});
}
afterEach(cleanup);

describe("conversation list", () => {
	it("distinguishes loading, retryable error and genuinely empty data", () => {
		const retry = vi.fn();
		const intents = { selectConversation: vi.fn(), retry };
		const result = render(view({ data: { status: "loading" }, intents }));
		expect(screen.getByRole("status").textContent).toBe("Loading conversations");
		expect(screen.queryByRole("list")).toBeNull();
		result.rerender(view({ data: { status: "error" }, intents }));
		expect(screen.getByRole("alert").textContent).toBe("Conversations unavailable");
		fireEvent.click(screen.getByRole("button", { name: "Retry conversations" }));
		expect(retry).toHaveBeenCalledTimes(1);
		result.rerender(view({ data: { status: "ready", items: [] }, intents }));
		expect(screen.getByText("No conversations")).toBeDefined();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("list")).toBeNull();
	});

	it("projects actual email/chat fields and selection without mutation controls", () => {
		const first = email({
			archived: true,
			subject: { ...text("Truncated subject"), truncated: true },
		});
		render(
			view({ data: { status: "ready", items: [first, chat()] }, selectedConversationId: first.id }),
		);
		const rows = within(screen.getByRole("list", { name: "Conversations" })).getAllByRole("button");
		expect(rows).toHaveLength(2);
		expect(rows[0]?.getAttribute("aria-current")).toBe("true");
		expect(rows[1]?.getAttribute("aria-current")).toBeNull();
		for (const label of [
			"Email",
			"Unread",
			"Archived in inbox",
			"Title truncated",
			"Chat",
			"Read",
			"External channel",
			"Shared channel",
			"Channel archived",
			"Not a member",
			"Time unavailable",
		])
			expect(screen.getByText(label, { exact: true })).toBeDefined();
		expect(screen.queryByRole("checkbox")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.queryByRole("button", { name: /approve|send|archive conversation/i })).toBeNull();
	});

	it("renders hostile titles as isolated text and emits only the validated ID", () => {
		const hostile = '<img src=x onerror="alert(1)"><a href="https://example.invalid">open</a>';
		const selectConversation = vi.fn();
		const { container } = render(
			view({
				data: { status: "ready", items: [email({ subject: text(hostile) })] },
				intents: { selectConversation, retry: vi.fn() },
			}),
		);
		const value = screen.getByText(hostile, { exact: true });
		expect(value.tagName).toBe("BDI");
		expect(value.textContent).toBe(hostile);
		expect(container.querySelector("img,a,script,iframe,object")).toBeNull();
		fireEvent.click(
			within(screen.getByRole("list", { name: "Conversations" })).getByRole("button"),
		);
		expect(selectConversation).toHaveBeenCalledExactlyOnceWith(id(1));
	});

	it("refuses duplicate or malformed entities as a whole and removes old controls", () => {
		const selectConversation = vi.fn();
		const intents = { selectConversation, retry: vi.fn() };
		const result = render(view({ intents }));
		for (const items of [
			[email(), email()],
			[
				email(),
				{
					...email({ id: id(3) }),
					subject: { untrusted: true, text: 1 },
				} as unknown as Conversation,
			],
		]) {
			result.rerender(view({ data: { status: "ready", items }, intents }));
			expect(screen.getByRole("alert").textContent).toBe("Conversations unavailable");
			expect(screen.queryByRole("list")).toBeNull();
			expect(screen.queryByText("A real subject")).toBeNull();
		}
		expect(selectConversation).not.toHaveBeenCalled();
	});

	it("moves focus without selecting and preserves native keyboard activation", () => {
		const selectConversation = vi.fn();
		render(
			view({
				data: { status: "ready", items: [email(), email({ id: id(2) }), email({ id: id(3) })] },
				intents: { selectConversation, retry: vi.fn() },
			}),
		);
		const buttons = within(screen.getByRole("list", { name: "Conversations" })).getAllByRole(
			"button",
		);
		const first = buttons[0],
			second = buttons[1],
			last = buttons[2];
		if (!first || !second || !last) throw new Error("DYTEST missing native conversation controls");
		first.focus();
		fireEvent.keyDown(first, { key: "ArrowDown" });
		expect(document.activeElement).toBe(second);
		fireEvent.keyDown(second, { key: "End" });
		expect(document.activeElement).toBe(last);
		fireEvent.keyDown(last, { key: "Home" });
		expect(document.activeElement).toBe(first);
		expect(selectConversation).not.toHaveBeenCalled();
		for (const key of ["Enter", " "]) {
			const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
			fireEvent(first, event);
			expect(event.defaultPrevented).toBe(false);
			fireEvent.click(first, { detail: 0 });
		}
		expect(selectConversation.mock.calls).toEqual([[id(1)], [id(1)]]);
		expect(first.tagName).toBe("BUTTON");
		expect(first.getAttribute("type")).toBe("button");
	});

	it("uses truthful fallbacks for blank labels and unsupported date ranges", () => {
		render(
			view({
				data: {
					status: "ready",
					items: [
						email({ subject: text("   "), lastMessageAt: Number.MAX_SAFE_INTEGER }),
						chat({ name: null, type: "dm" }),
					],
				},
			}),
		);
		expect(screen.getByText("(No subject)")).toBeDefined();
		expect(screen.getByText("Unnamed chat")).toBeDefined();
		expect(screen.getAllByText("Time unavailable")).toHaveLength(2);
	});
});
