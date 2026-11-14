import { Conversation } from "@draftyak/protocol/entities/conversation";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

// jsdom has no layout. Supply DOM geometry, not a replacement virtualizer.
const rectangle = HTMLElement.prototype.getBoundingClientRect;
const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
	HTMLElement.prototype,
	"scrollHeight",
);
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
beforeAll(() => {
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
		this: HTMLElement,
	) {
		return this.classList.contains("inbox-panel__viewport")
			? DOMRect.fromRect({ width: 800, height: 640 })
			: rectangle.call(this);
	});
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.classList.contains("inbox-panel__viewport") ? 640 : 0;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
		configurable: true,
		get(this: HTMLElement) {
			const size = this.querySelector("[aria-setsize]")?.getAttribute("aria-setsize");
			return this.classList.contains("inbox-panel__viewport")
				? Math.max(640, Number(size ?? 0) * 320)
				: 0;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "scrollTo", {
		configurable: true,
		value(this: HTMLElement, options: ScrollToOptions | number, top?: number) {
			this.scrollTop = typeof options === "number" ? (top ?? 0) : (options.top ?? this.scrollTop);
		},
	});
});
afterAll(() => {
	vi.restoreAllMocks();
	for (const [name, descriptor] of [
		["clientHeight", heightDescriptor],
		["scrollHeight", scrollHeightDescriptor],
		["scrollTo", scrollDescriptor],
	] as const) {
		if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name);
		else Object.defineProperty(HTMLElement.prototype, name, descriptor);
	}
});

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

function manyConversations(count = 1000): Conversation[] {
	return Array.from({ length: count }, (_, index) =>
		email({
			id: id(index + 1),
			subject: text(`Conversation ${index + 1}`),
		}),
	);
}

describe("virtual conversation presentation", () => {
	it("renders the actual changing virtual window with stable IDs and no inline styles", async () => {
		const items = manyConversations();
		const selectConversation = vi.fn();
		const { container } = render(
			view({
				data: { status: "ready", items },
				selectedConversationId: id(500),
				intents: { selectConversation, retry: vi.fn() },
			}),
		);
		const list = screen.getByRole("list", { name: "Conversations" });
		expect(within(list).getAllByRole("listitem").length).toBeLessThan(20);
		expect(screen.queryByText("Conversation 500", { exact: true })).toBeNull();
		const viewport = container.querySelector<HTMLDivElement>(".inbox-panel__viewport");
		if (viewport === null) throw new Error("DYTEST missing real scroll viewport");
		fireEvent.scroll(viewport, { target: { scrollTop: 499 * 320 } });
		const label = await screen.findByText("Conversation 500", { exact: true });
		const selected = label.closest("button");
		if (selected === null) throw new Error("DYTEST missing canonical row control");
		expect(selected.getAttribute("aria-current")).toBe("true");
		expect(selected.closest("li")?.getAttribute("aria-posinset")).toBe("500");
		expect(selected.closest("li")?.getAttribute("aria-setsize")).toBe("1000");
		expect(screen.queryByText("Conversation 1", { exact: true })).toBeNull();
		fireEvent.click(selected);
		expect(selectConversation).toHaveBeenCalledExactlyOnceWith(id(500));
		expect(within(list).getAllByRole("listitem").length).toBeLessThan(20);
		expect(container.querySelector("[style]")).toBeNull();
		const gaps = [...container.querySelectorAll(".inbox-panel__gap")];
		expect(gaps.length).toBeGreaterThan(0);
		for (const gap of gaps) {
			const spacer = gap.querySelector("svg");
			expect(spacer).not.toBeNull();
			const height = Number(spacer?.getAttribute("height"));
			expect(height).toBeGreaterThan(0);
			expect(height % 320).toBe(0);
			expect(height).toBeLessThanOrEqual(1000 * 320);
			expect(gap.getAttribute("aria-hidden")).toBe("true");
		}
	});

	it("pins current focus while scrolling and commits End/Home/Arrow focus across virtual rows", async () => {
		const selectConversation = vi.fn();
		const { container } = render(
			view({
				data: { status: "ready", items: manyConversations() },
				intents: { selectConversation, retry: vi.fn() },
			}),
		);
		const first = screen.getByText("Conversation 1", { exact: true }).closest("button");
		const viewport = container.querySelector<HTMLDivElement>(".inbox-panel__viewport");
		if (first === null || viewport === null) throw new Error("DYTEST missing focus controls");
		first.focus();
		fireEvent.scroll(viewport, { target: { scrollTop: 499 * 320 } });
		await screen.findByText("Conversation 500", { exact: true });
		expect(first.isConnected).toBe(true);
		expect(document.activeElement).toBe(first);
		const beforeEnd = viewport.scrollTop;
		expect(beforeEnd).toBe(499 * 320);
		fireEvent.keyDown(first, { key: "End" });
		const last = (await screen.findByText("Conversation 1000", { exact: true })).closest("button");
		await waitFor(() => expect(document.activeElement).toBe(last));
		expect(viewport.scrollTop).toBeGreaterThan(beforeEnd);
		if (last === null) throw new Error("DYTEST missing last focus control");
		fireEvent.keyDown(last, { key: "Home" });
		const home = (await screen.findByText("Conversation 1", { exact: true })).closest("button");
		if (home === null) throw new Error("DYTEST missing home focus control");
		await waitFor(() => expect(document.activeElement).toBe(home));
		expect(viewport.scrollTop).toBe(0);
		fireEvent.keyDown(home, { key: "ArrowDown" });
		const second = (await screen.findByText("Conversation 2", { exact: true })).closest("button");
		await waitFor(() => expect(document.activeElement).toBe(second));
		expect(selectConversation).not.toHaveBeenCalled();
		expect(container.querySelector("[style]")).toBeNull();
	});

	it("preserves focused identity across reordering and restores a local focus stop when rows disappear", async () => {
		const items = manyConversations();
		const result = render(
			view({ data: { status: "ready", items }, selectedConversationId: id(1) }),
		);
		const first = screen.getByText("Conversation 1", { exact: true }).closest("button");
		if (first === null) throw new Error("DYTEST missing first focus control");
		first.focus();
		result.rerender(
			view({
				data: { status: "ready", items: [...items].reverse() },
				selectedConversationId: id(1),
			}),
		);
		await waitFor(() => expect(document.activeElement).toBe(first));
		expect(first.isConnected).toBe(true);
		expect(first.closest("li")?.getAttribute("aria-posinset")).toBe("1000");
		expect(first.getAttribute("aria-current")).toBe("true");
		result.rerender(view({ data: { status: "ready", items: [] } }));
		expect(screen.getByText("No conversations")).toBeDefined();
		expect(document.activeElement).toBe(screen.getByRole("region", { name: "Inbox" }));
	});

	it("keeps a larger canonical collection available without truncation or an invented row cap", async () => {
		const { container } = render(
			view({ data: { status: "ready", items: manyConversations(1500) } }),
		);
		const list = screen.getByRole("list", { name: "Conversations" });
		const viewport = container.querySelector<HTMLDivElement>(".inbox-panel__viewport");
		if (viewport === null) throw new Error("DYTEST missing scroll viewport");
		fireEvent.scroll(viewport, { target: { scrollTop: 1499 * 320 } });
		const last = await screen.findByText("Conversation 1500", { exact: true });
		expect(last.closest("li")?.getAttribute("aria-posinset")).toBe("1500");
		expect(last.closest("li")?.getAttribute("aria-setsize")).toBe("1500");
		expect(within(list).getAllByRole("listitem").length).toBeLessThan(20);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(container.querySelector("[style]")).toBeNull();
	});
});
