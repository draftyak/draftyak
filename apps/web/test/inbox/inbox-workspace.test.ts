import { Account } from "@draftyak/protocol/entities/account";
import { Conversation } from "@draftyak/protocol/entities/conversation";
import { Draft, DraftContent, DraftRevision } from "@draftyak/protocol/entities/draft";
import { Message } from "@draftyak/protocol/entities/message";
import { OutboxItem } from "@draftyak/protocol/entities/outbox";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftComposerProps } from "../../src/composer/DraftComposer.tsx";
import { InboxWorkspace, type InboxWorkspaceProps } from "../../src/inbox/InboxWorkspace.tsx";

const id = (value: number): string => String(value).padStart(26, "0");
const text = (value: string) => ({ untrusted: true, text: value });
const BODY = "DYTEST selected message body";
const REPLY = "DYTEST current reply body";
function account(channel: "email" | "chat" = "email"): Account {
	const common = {
		id: id(channel === "email" ? 20 : 21),
		userId: id(90),
		alias: channel === "email" ? "primary-mail" : "team-chat",
		mode: "full",
		status: "active",
		deletionDeadline: null,
		historyLimitDays: 30,
		disclosureVersion: 1,
		createdAt: 0,
		pluginInstanceId: id(99),
	};
	return Account.parse(
		channel === "email"
			? { ...common, channel, address: "owner@example.invalid" }
			: { ...common, channel, teamId: "team-1", selfUserId: "owner-1" },
	);
}
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
		subject: text("DYTEST selected conversation"),
		labelIds: [],
		...overrides,
	});
}
function message(overrides: Record<string, unknown> = {}): Message {
	return Message.parse({
		channel: "email",
		id: id(30),
		accountId: id(20),
		conversationId: id(10),
		direction: "inbound",
		sentAt: 0,
		provenance: { via: "plugin", sourceId: id(99), receivedAt: 0 },
		providerRef: { messageId: "message-1", threadId: "thread-1" },
		from: [{ address: text("sender@example.invalid"), name: text("DYTEST sender") }],
		replyTo: [],
		to: [],
		cc: [],
		bcc: [],
		subject: text("DYTEST message subject"),
		snippet: text("DYTEST snippet is not a body"),
		labelIds: [],
		dmarc: "none",
		attachments: [],
		...overrides,
	});
}
function composer(overrides: Partial<DraftComposerProps> = {}): DraftComposerProps {
	const content = DraftContent.parse({
		channel: "email",
		to: ["recipient@example.invalid"],
		cc: [],
		bcc: [],
		subject: "DYTEST reply subject",
		body: REPLY,
		attachments: [],
	});
	return {
		draft: Draft.parse({
			id: id(40),
			accountId: id(20),
			conversationId: id(10),
			rev: 2,
			state: "open",
			createdAt: 1,
			updatedAt: 10,
		}),
		currentRevision: DraftRevision.parse({
			draftId: id(40),
			rev: 2,
			author: { kind: "owner", id: id(90) },
			content,
			contentSha256: "a".repeat(64),
			flags: [],
			createdAt: 10,
		}),
		history: [],
		outboxItems: [],
		onEditIntent: vi.fn(),
		...overrides,
	};
}
function props(overrides: Partial<InboxWorkspaceProps> = {}): InboxWorkspaceProps {
	return {
		accounts: { status: "ready", items: [account(), account("chat")] },
		selectedAccountId: id(20),
		onSelectAccount: vi.fn(),
		conversationList: {
			accountId: id(20),
			data: { status: "ready", items: [conversation()] },
			selectedConversationId: id(10),
			intents: { selectConversation: vi.fn(), retry: vi.fn() },
		},
		conversationView: {
			accountId: id(20),
			conversationId: id(10),
			conversation: conversation(),
			messages: { status: "ready", items: [message()] },
			selectedMessageId: id(30),
			bodyPresentation: {
				messageId: id(30),
				status: "ready",
				content: createElement("p", null, BODY),
			},
			intents: { back: vi.fn(), selectMessage: vi.fn(), retry: vi.fn() },
		},
		composer: { accountId: id(20), conversationId: id(10), status: "ready", props: composer() },
		...overrides,
	};
}
function view(input: InboxWorkspaceProps): ReactElement {
	return createElement(InboxWorkspace, input);
}
function edit(body: string): void {
	fireEvent.change(screen.getByRole("textbox", { name: "Draft body" }), {
		target: { value: body },
	});
}
function expectNoContent(): void {
	expect(screen.queryByRole("list", { name: "Conversations" })).toBeNull();
	expect(screen.queryByRole("list", { name: "Messages" })).toBeNull();
	expect(screen.queryByRole("article", { name: "Selected message" })).toBeNull();
	expect(screen.queryByText(BODY)).toBeNull();
	expect(screen.queryByText("DYTEST selected conversation")).toBeNull();
	expect(screen.queryByText("DYTEST message subject")).toBeNull();
	expect(screen.queryByText(REPLY)).toBeNull();
	expect(screen.queryByRole("textbox", { name: "Draft body" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Request new revision" })).toBeNull();
}
type FeedState = "loading" | "error" | "empty";
function listData(state: FeedState): InboxWorkspaceProps["conversationList"]["data"] {
	return state === "empty" ? { status: "ready", items: [] } : { status: state };
}
function messagesData(state: FeedState): InboxWorkspaceProps["conversationView"]["messages"] {
	return state === "empty" ? { status: "ready", items: [] } : { status: state };
}
function nonReadyComposer(
	state: "none" | "loading" | "error",
	accountId: Account["id"] | null,
	conversationId: Conversation["id"] | null,
	retry: () => void,
): InboxWorkspaceProps["composer"] {
	return state === "error"
		? { status: "error", accountId, conversationId, retry }
		: { status: state, accountId, conversationId };
}
function transitionFixture(kind: "account" | "conversation"): {
	before: InboxWorkspaceProps;
	after: InboxWorkspaceProps;
	accountId: Account["id"];
	conversationId: Conversation["id"];
} {
	const second = Account.parse({
		...account(),
		id: id(21),
		alias: "second-mail",
		address: "second@example.invalid",
	});
	const before = props({ accounts: { status: "ready", items: [account(), second] } });
	const accountId = kind === "account" ? second.id : id(20);
	const next = conversation({
		id: id(11),
		accountId,
		threadId: "thread-2",
		subject: text("DYTEST next conversation"),
	});
	const after: InboxWorkspaceProps = {
		...before,
		selectedAccountId: accountId,
		conversationList: {
			accountId,
			data: { status: "ready", items: [next] },
			selectedConversationId: next.id,
			intents: { selectConversation: vi.fn(), retry: vi.fn() },
		},
		conversationView: {
			accountId,
			conversationId: next.id,
			conversation: next,
			messages: { status: "ready", items: [] },
			selectedMessageId: null,
			bodyPresentation: null,
			intents: { back: vi.fn(), selectMessage: vi.fn(), retry: vi.fn() },
		},
		composer: { accountId, conversationId: next.id, status: "none" },
	};
	return { before, after, accountId, conversationId: next.id };
}
function expectScopeBlocked(): void {
	expect(screen.getByRole("alert").textContent).toBe("Inbox workspace unavailable");
	expectNoContent();
	for (const label of [
		"Loading conversations",
		"Conversations unavailable",
		"No conversations",
		"Choose a conversation",
		"Loading messages",
		"Messages unavailable",
		"No messages",
		"Choose a message",
		"Loading reply draft",
		"Reply draft unavailable",
		"No reply draft",
		"DYTEST next conversation",
	])
		expect(screen.queryByText(label, { exact: true })).toBeNull();
	for (const name of [
		"Retry conversations",
		"Retry messages",
		"Retry reply draft",
		"Back to inbox",
	])
		expect(screen.queryByRole("button", { name })).toBeNull();
}
afterEach(cleanup);

describe("inbox workspace", () => {
	it("composes the actual children and forwards their original exact intents", () => {
		const input = props();
		if (input.composer.status !== "ready") throw new Error("DYTEST ready composer required");
		const onEditIntent = vi.fn();
		const draftProps = { ...input.composer.props, onEditIntent };
		render(
			view({
				...input,
				composer: { accountId: id(20), conversationId: id(10), status: "ready", props: draftProps },
			}),
		);
		expect(screen.getByRole("region", { name: "Inbox workspace" })).toBeDefined();
		expect(screen.getByText(BODY)).toBeDefined();
		expect(screen.queryByText("DYTEST snippet is not a body")).toBeNull();
		expect(onEditIntent).not.toHaveBeenCalled();
		expect(input.onSelectAccount).not.toHaveBeenCalled();
		fireEvent.click(
			within(screen.getByRole("list", { name: "Conversations" })).getByRole("button"),
		);
		expect(input.conversationList.intents.selectConversation).toHaveBeenCalledExactlyOnceWith(
			id(10),
		);
		fireEvent.click(within(screen.getByRole("list", { name: "Messages" })).getByRole("button"));
		expect(input.conversationView.intents.selectMessage).toHaveBeenCalledExactlyOnceWith(id(30));
		fireEvent.click(screen.getByRole("button", { name: "Back to inbox" }));
		expect(input.conversationView.intents.back).toHaveBeenCalledExactlyOnceWith();
		edit("DYTEST revised reply");
		fireEvent.click(screen.getByRole("button", { name: "Request new revision" }));
		expect(onEditIntent).toHaveBeenCalledExactlyOnceWith({
			draftId: id(40),
			expectedRev: 2,
			content: { ...draftProps.currentRevision.content, body: "DYTEST revised reply" },
		});
		expect(draftProps.currentRevision.content.body).toBe(REPLY);
		expect(screen.queryByRole("button", { name: /^(?:approve|send|cancel)\b/i })).toBeNull();
	});

	it("keeps account selection controlled and emits only current canonical account IDs", () => {
		const input = props();
		render(view(input));
		const first = screen.getByRole("button", { name: /primary-mail/ });
		const second = screen.getByRole("button", { name: /team-chat/ });
		expect(first.getAttribute("aria-current")).toBe("true");
		expect(second.getAttribute("aria-current")).toBeNull();
		fireEvent.click(second);
		expect(input.onSelectAccount).toHaveBeenCalledExactlyOnceWith(id(21));
		expect(first.getAttribute("aria-current")).toBe("true");
		expect(screen.getByText(BODY)).toBeDefined();
	});

	it("withholds every old panel and dirty edit on a controlled account switch", () => {
		const input = props();
		if (input.composer.status !== "ready") throw new Error("DYTEST ready composer required");
		const onEditIntent = vi.fn();
		const current = {
			...input,
			composer: {
				accountId: id(20),
				conversationId: id(10),
				status: "ready" as const,
				props: { ...input.composer.props, onEditIntent },
			},
		};
		const result = render(view(current));
		edit("DYTEST unsent local edit");
		result.rerender(view({ ...current, selectedAccountId: id(21) }));
		expect(screen.getByRole("alert").textContent).toBe("Inbox workspace unavailable");
		expectNoContent();
		expect(screen.queryByDisplayValue("DYTEST unsent local edit")).toBeNull();
		expect(onEditIntent).not.toHaveBeenCalled();
		expect(input.conversationList.intents.selectConversation).not.toHaveBeenCalled();
		expect(input.conversationView.intents.selectMessage).not.toHaveBeenCalled();
		result.rerender(view(current));
		expect((screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value).toBe(
			REPLY,
		);
		expect(
			(screen.getByRole("button", { name: "Request new revision" }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(onEditIntent).not.toHaveBeenCalled();
	});

	it("accepts coherent actual chat entities after an account switch without old content", () => {
		const input = props();
		const chatConversation = Conversation.parse({
			channel: "chat",
			id: id(11),
			accountId: id(21),
			workspaceId: null,
			assigneeUserId: null,
			archived: false,
			read: true,
			lastMessageAt: 0,
			channelId: "channel-1",
			name: text("DYTEST team discussion"),
			type: "public",
			external: false,
			shared: false,
			memberCount: 2,
			channelArchived: false,
			member: true,
		});
		const chatMessage = Message.parse({
			channel: "chat",
			id: id(31),
			accountId: id(21),
			conversationId: id(11),
			direction: "inbound",
			sentAt: 0,
			provenance: { via: "plugin", sourceId: id(99), receivedAt: 0 },
			providerRef: { channelId: "channel-1", ts: "123.001" },
			threadTs: null,
			author: { kind: "bot", id: "bot-1" },
			subtype: null,
			text: text("DYTEST chat metadata"),
			editedAt: null,
			deleted: false,
			attachments: [],
		});
		const chatContent = DraftContent.parse({
			channel: "chat",
			threadTs: "123.001",
			broadcast: false,
			body: "DYTEST chat reply",
		});
		const draftProps = composer();
		const result = render(view(input));
		result.rerender(
			view({
				...input,
				selectedAccountId: id(21),
				conversationList: {
					...input.conversationList,
					accountId: id(21),
					data: { status: "ready", items: [chatConversation] },
					selectedConversationId: id(11),
				},
				conversationView: {
					...input.conversationView,
					accountId: id(21),
					conversationId: id(11),
					conversation: chatConversation,
					messages: { status: "ready", items: [chatMessage] },
					selectedMessageId: id(31),
					bodyPresentation: { messageId: id(31), status: "ready", content: "DYTEST chat body" },
				},
				composer: {
					accountId: id(21),
					conversationId: id(11),
					status: "ready",
					props: {
						...draftProps,
						draft: Draft.parse({ ...draftProps.draft, accountId: id(21), conversationId: id(11) }),
						currentRevision: DraftRevision.parse({
							...draftProps.currentRevision,
							content: chatContent,
						}),
					},
				},
			}),
		);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByText("DYTEST chat body")).toBeDefined();
		expect((screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value).toBe(
			"DYTEST chat reply",
		);
		expect(screen.queryByText(BODY)).toBeNull();
	});

	it.each([
		["loading", { status: "loading" }, "Loading accounts"],
		["error", { status: "error", retry: vi.fn() }, "Accounts unavailable"],
		["empty", { status: "ready", items: [] }, "No accounts"],
	] as const)(
		"keeps account %s distinct and withholds subordinate data",
		(_name, accounts, label) => {
			render(view(props({ accounts })));
			expect(screen.getByText(label, { exact: true })).toBeDefined();
			expectNoContent();
			if (accounts.status === "error") {
				fireEvent.click(screen.getByRole("button", { name: "Retry accounts" }));
				expect(accounts.retry).toHaveBeenCalledExactlyOnceWith();
			}
		},
	);

	it("offers account choice without rendering retained subordinate props", () => {
		const input = props({ selectedAccountId: null });
		render(view(input));
		expect(screen.getByText("Choose an account", { exact: true })).toBeDefined();
		expectNoContent();
		fireEvent.click(screen.getByRole("button", { name: /primary-mail/ }));
		expect(input.onSelectAccount).toHaveBeenCalledExactlyOnceWith(id(20));
	});

	it.each([
		["malformed account", [account(), { ...account("chat"), alias: "<img src=x>" }]],
		["duplicate account ID", [account(), account()]],
		["non-array accounts", { length: 1, 0: account() }],
		["null row", [account(), null]],
	] as const)("refuses %s as a whole without partial account controls", (_name, items) => {
		const input = props({
			accounts: { status: "ready", items: items as unknown as readonly Account[] },
		});
		render(view(input));
		expect(screen.getByRole("alert").textContent).toBe("Inbox workspace unavailable");
		expect(screen.queryByRole("button", { name: /primary-mail|team-chat/ })).toBeNull();
		expectNoContent();
		expect(input.onSelectAccount).not.toHaveBeenCalled();
	});

	it("refuses a selected account absent from the canonical current account set", () => {
		render(view(props({ selectedAccountId: id(22) })));
		expect(screen.getByRole("alert").textContent).toBe("Inbox workspace unavailable");
		expectNoContent();
	});

	it.each([
		[
			"foreign list row",
			(p: InboxWorkspaceProps) => ({
				...p,
				conversationList: {
					...p.conversationList,
					data: {
						status: "ready" as const,
						items: [conversation(), conversation({ id: id(12), accountId: id(21) })],
					},
				},
			}),
		],
		[
			"foreign detail",
			(p: InboxWorkspaceProps) => ({
				...p,
				conversationView: {
					...p.conversationView,
					conversation: conversation({ accountId: id(21) }),
				},
			}),
		],
		[
			"different selected detail ID",
			(p: InboxWorkspaceProps) => ({
				...p,
				conversationView: { ...p.conversationView, conversation: conversation({ id: id(12) }) },
			}),
		],
		[
			"detail without list selection",
			(p: InboxWorkspaceProps) => ({
				...p,
				conversationList: { ...p.conversationList, selectedConversationId: null },
			}),
		],
		[
			"selection without detail",
			(p: InboxWorkspaceProps) => ({
				...p,
				conversationView: { ...p.conversationView, conversation: null },
			}),
		],
		[
			"malformed list row",
			(p: InboxWorkspaceProps) => ({
				...p,
				conversationList: {
					...p.conversationList,
					data: {
						status: "ready" as const,
						items: [
							conversation(),
							{ ...conversation({ id: id(12) }), read: "yes" } as unknown as Conversation,
						],
					},
				},
			}),
		],
		[
			"duplicate list ID",
			(p: InboxWorkspaceProps) => ({
				...p,
				conversationList: {
					...p.conversationList,
					data: { status: "ready" as const, items: [conversation(), conversation()] },
				},
			}),
		],
		[
			"account channel mismatch",
			(p: InboxWorkspaceProps) => ({
				...p,
				accounts: {
					status: "ready" as const,
					items: [Account.parse({ ...account("chat"), id: id(20) })],
				},
			}),
		],
	] as const)("withholds all children on %s", (_name, change) => {
		const input = props();
		render(view(change(input)));
		expect(screen.getByRole("alert").textContent).toBe("Inbox workspace unavailable");
		expectNoContent();
		expect(input.conversationList.intents.selectConversation).not.toHaveBeenCalled();
		expect(input.conversationView.intents.selectMessage).not.toHaveBeenCalled();
	});

	it.each([
		["foreign account", { accountId: id(21) }],
		["different conversation", { conversationId: id(12) }],
		["new-conversation draft", { conversationId: null }],
	] as const)("refuses a reply composer bound to %s", (_name, changes) => {
		const input = props();
		const draftProps = composer();
		render(
			view({
				...input,
				composer: {
					accountId: id(20),
					conversationId: id(10),
					status: "ready",
					props: { ...draftProps, draft: Draft.parse({ ...draftProps.draft, ...changes }) },
				},
			}),
		);
		expect(screen.getByRole("alert").textContent).toBe("Inbox workspace unavailable");
		expectNoContent();
		expect(draftProps.onEditIntent).not.toHaveBeenCalled();
	});

	it("refuses a current reply channel different from the selected conversation", () => {
		const draftProps = composer();
		const content = DraftContent.parse({
			channel: "chat",
			threadTs: null,
			broadcast: false,
			body: "DYTEST wrong-channel reply",
		});
		render(
			view(
				props({
					composer: {
						accountId: id(20),
						conversationId: id(10),
						status: "ready",
						props: {
							...draftProps,
							currentRevision: DraftRevision.parse({ ...draftProps.currentRevision, content }),
						},
					},
				}),
			),
		);
		expect(screen.getByRole("alert").textContent).toBe("Inbox workspace unavailable");
		expectNoContent();
		expect(draftProps.onEditIntent).not.toHaveBeenCalled();
	});

	it.each([
		["none", { status: "none" }, "No reply draft"],
		["loading", { status: "loading" }, "Loading reply draft"],
		["error", { status: "error", retry: vi.fn() }, "Reply draft unavailable"],
	] as const)(
		"preserves the distinct composer %s state without manufacturing a draft",
		(_name, state, label) => {
			render(view(props({ composer: { accountId: id(20), conversationId: id(10), ...state } })));
			expect(screen.getByText(label, { exact: true })).toBeDefined();
			expect(screen.getByText(BODY)).toBeDefined();
			expect(screen.queryByRole("textbox", { name: "Draft body" })).toBeNull();
			if (state.status === "error") {
				fireEvent.click(screen.getByRole("button", { name: "Retry reply draft" }));
				expect(state.retry).toHaveBeenCalledExactlyOnceWith();
			}
		},
	);

	it.each([
		["loading", { status: "loading" }, "Loading conversations"],
		["error", { status: "error" }, "Conversations unavailable"],
		["empty", { status: "ready", items: [] }, "No conversations"],
	] as const)(
		"preserves delivered list %s state and retry without invented selection",
		(_name, data, label) => {
			const input = props();
			render(
				view({
					...input,
					conversationList: { ...input.conversationList, data, selectedConversationId: null },
					conversationView: {
						...input.conversationView,
						conversationId: null,
						conversation: null,
						selectedMessageId: null,
						bodyPresentation: null,
					},
					composer: { accountId: id(20), conversationId: null, status: "none" },
				}),
			);
			expect(screen.getByText(label, { exact: true })).toBeDefined();
			expect(screen.getByText("Choose a conversation", { exact: true })).toBeDefined();
			expect(screen.queryByRole("textbox", { name: "Draft body" })).toBeNull();
			if (data.status === "error") {
				fireEvent.click(screen.getByRole("button", { name: "Retry conversations" }));
				expect(input.conversationList.intents.retry).toHaveBeenCalledExactlyOnceWith();
			}
		},
	);

	it.each([
		["loading", { status: "loading" }, "Loading messages"],
		["error", { status: "error" }, "Messages unavailable"],
		["empty", { status: "ready", items: [] }, "No messages"],
	] as const)("delegates actual message %s presentation and retry", (_name, messages, label) => {
		const input = props();
		render(
			view({
				...input,
				conversationView: {
					...input.conversationView,
					messages,
					selectedMessageId: null,
					bodyPresentation: null,
				},
				composer: { accountId: id(20), conversationId: id(10), status: "none" },
			}),
		);
		expect(screen.getByText(label, { exact: true })).toBeDefined();
		expect(screen.queryByText(BODY)).toBeNull();
		if (messages.status === "error") {
			fireEvent.click(screen.getByRole("button", { name: "Retry messages" }));
			expect(input.conversationView.intents.retry).toHaveBeenCalledExactlyOnceWith();
		}
	});

	it.each([
		["another account", { accountId: id(21) }],
		["another conversation", { conversationId: id(12) }],
	] as const)("retains the delivered message refusal for %s", (_name, changes) => {
		const input = props();
		render(
			view({
				...input,
				conversationView: {
					...input.conversationView,
					messages: { status: "ready", items: [message(changes)] },
				},
				composer: { accountId: id(20), conversationId: id(10), status: "none" },
			}),
		);
		expect(screen.getByRole("alert").textContent).toBe("Conversation unavailable");
		expect(screen.queryByRole("list", { name: "Messages" })).toBeNull();
		expect(screen.queryByText(BODY)).toBeNull();
		expect(input.conversationView.intents.selectMessage).not.toHaveBeenCalled();
	});

	it("retains the delivered revision refusal instead of synthesizing a valid composer", () => {
		const draftProps = composer();
		render(
			view(
				props({
					composer: {
						accountId: id(20),
						conversationId: id(10),
						status: "ready",
						props: {
							...draftProps,
							currentRevision: DraftRevision.parse({
								...draftProps.currentRevision,
								draftId: id(41),
							}),
						},
					},
				}),
			),
		);
		expect(screen.getByRole("alert").textContent).toBe("Draft unavailable");
		expect(screen.queryByRole("textbox", { name: "Draft body" })).toBeNull();
		expect(draftProps.onEditIntent).not.toHaveBeenCalled();
	});

	it("inherits list navigation and native activation without automatic selection", () => {
		const input = props();
		render(
			view({
				...input,
				conversationList: {
					...input.conversationList,
					data: {
						status: "ready",
						items: [
							conversation(),
							conversation({ id: id(12), subject: text("DYTEST second conversation") }),
							conversation({ id: id(13), subject: text("DYTEST third conversation") }),
						],
					},
				},
			}),
		);
		const rows = within(screen.getByRole("list", { name: "Conversations" })).getAllByRole("button");
		const [first, second, last] = rows;
		if (!first || !second || !last) throw new Error("DYTEST three conversation controls required");
		first.focus();
		for (const [from, key, target] of [
			[first, "ArrowDown", second],
			[second, "End", last],
			[last, "ArrowUp", second],
			[second, "Home", first],
		] as const) {
			fireEvent.keyDown(from, { key });
			expect(document.activeElement).toBe(target);
		}
		expect(input.conversationList.intents.selectConversation).not.toHaveBeenCalled();
		for (const key of ["Enter", " "]) {
			const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
			fireEvent(first, event);
			expect(event.defaultPrevented).toBe(false);
			fireEvent.click(first, { detail: 0 });
		}
		expect(input.conversationList.intents.selectConversation).toHaveBeenCalledTimes(2);
		expect(input.conversationList.intents.selectConversation).toHaveBeenNthCalledWith(1, id(10));
		expect(input.conversationList.intents.selectConversation).toHaveBeenNthCalledWith(2, id(10));
		expect(first.tagName).toBe("BUTTON");
		expect(first.getAttribute("type")).toBe("button");
	});

	it("keeps hostile presentation as text without introducing active content", () => {
		const hostile = '<img src=x onerror="alert(1)"><a href="https://example.invalid">DYTEST</a>';
		const input = props();
		const row = conversation({ subject: text(hostile) });
		const result = render(
			view({
				...input,
				conversationList: { ...input.conversationList, data: { status: "ready", items: [row] } },
				conversationView: {
					...input.conversationView,
					conversation: row,
					bodyPresentation: { messageId: id(30), status: "ready", content: hostile },
				},
			}),
		);
		expect(screen.getAllByText(hostile, { exact: true }).length).toBeGreaterThanOrEqual(3);
		expect(result.container.querySelector("img,a,script,iframe,object")).toBeNull();
	});

	it("retains the delivered live-outbox lock instead of offering an edit", () => {
		const draftProps = composer();
		const item = OutboxItem.parse({
			id: id(50),
			accountId: id(20),
			draftId: id(40),
			rev: 2,
			proposedBy: { kind: "owner", id: id(90) },
			contentHash: "c".repeat(64),
			flagsHash: "d".repeat(64),
			notBefore: null,
			deliverBy: null,
			requiredApprovals: 1,
			createdAt: 10,
			updatedAt: 10,
			state: "APPROVED",
			stateReason: null,
		});
		render(
			view(
				props({
					composer: {
						accountId: id(20),
						conversationId: id(10),
						status: "ready",
						props: { ...draftProps, outboxItems: [item] },
					},
				}),
			),
		);
		expect(screen.getByText("A live outbox item locks this draft.")).toBeDefined();
		expect(
			(screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).readOnly,
		).toBe(true);
		expect(
			(screen.getByRole("button", { name: "Request new revision" }) as HTMLButtonElement).disabled,
		).toBe(true);
		const form = screen.getByRole("textbox", { name: "Draft body" }).closest("form");
		if (!form) throw new Error("DYTEST actual composer form required");
		fireEvent.submit(form);
		expect(draftProps.onEditIntent).not.toHaveBeenCalled();
	});

	it("retains the delivered refusal of a body presentation for another message", () => {
		const input = props();
		render(
			view({
				...input,
				conversationView: {
					...input.conversationView,
					bodyPresentation: { messageId: id(31), status: "ready", content: BODY },
				},
				composer: { accountId: id(20), conversationId: id(10), status: "none" },
			}),
		);
		expect(screen.getByRole("alert").textContent).toBe("Conversation unavailable");
		expect(screen.queryByText(BODY)).toBeNull();
		expect(input.conversationView.intents.selectMessage).not.toHaveBeenCalled();
	});

	it("contains an exception from malformed account data without exposing it or old content", () => {
		const hostile = Object.defineProperty({}, "channel", {
			get: () => {
				throw new Error("DYTEST private account parse canary");
			},
			enumerable: true,
		});
		const input = props({ accounts: { status: "ready", items: [account(), hostile as Account] } });
		render(view(input));
		expect(screen.getByRole("alert").textContent).toBe("Inbox workspace unavailable");
		expect(screen.queryByText(/DYTEST private account parse canary/)).toBeNull();
		expectNoContent();
		expect(input.onSelectAccount).not.toHaveBeenCalled();
	});

	it("discards a pending old-account edit result rather than reviving stale content", async () => {
		let finish: (() => void) | undefined;
		const onEditIntent = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const input = props({
			composer: {
				accountId: id(20),
				conversationId: id(10),
				status: "ready",
				props: composer({ onEditIntent }),
			},
		});
		const result = render(view(input));
		edit("DYTEST pending old reply");
		fireEvent.click(screen.getByRole("button", { name: "Request new revision" }));
		expect(onEditIntent).toHaveBeenCalledTimes(1);
		result.rerender(view({ ...input, selectedAccountId: id(21) }));
		await act(async () => {
			finish?.();
		});
		expectNoContent();
		expect(screen.queryByText("Edit requested; waiting for a new revision.")).toBeNull();
		expect(onEditIntent).toHaveBeenCalledTimes(1);
	});
});

describe("inbox workspace feed-scope transitions", () => {
	it.each([
		["loading", "Loading conversations"],
		["error", "Conversations unavailable"],
		["empty", "No conversations"],
	] as const)(
		"withholds an old %s list until the new account feed and callback arrive",
		(state, label) => {
			const context = transitionFixture("account");
			const oldRetry = vi.fn(),
				newRetry = vi.fn(),
				newSelect = vi.fn();
			const newBack = vi.fn(),
				newViewRetry = vi.fn(),
				newMessageSelect = vi.fn();
			const before: InboxWorkspaceProps = {
				...context.before,
				conversationList: {
					...context.before.conversationList,
					accountId: id(20),
					data: listData(state),
					selectedConversationId: null,
					intents: { selectConversation: vi.fn(), retry: oldRetry },
				},
				conversationView: {
					...context.before.conversationView,
					accountId: id(20),
					conversationId: null,
					conversation: null,
					messages: { status: "ready", items: [] },
					selectedMessageId: null,
					bodyPresentation: null,
				},
				composer: { status: "none", accountId: id(20), conversationId: null },
			};
			const result = render(view(before));
			expect(screen.getByText(label, { exact: true })).toBeDefined();
			// Retaining every old bundle must not expose even an old empty or loading slot.
			result.rerender(view({ ...before, selectedAccountId: context.accountId }));
			expectScopeBlocked();
			expect(oldRetry).not.toHaveBeenCalled();
			// Rebind the other two bundles: this leaves only the old list scope at fault.
			const waiting: InboxWorkspaceProps = {
				...before,
				selectedAccountId: context.accountId,
				conversationView: {
					...before.conversationView,
					accountId: context.accountId,
					messages: { status: "ready", items: [] },
					intents: { back: newBack, selectMessage: newMessageSelect, retry: newViewRetry },
				},
				composer: { status: "none", accountId: context.accountId, conversationId: null },
			};
			result.rerender(view(waiting));
			expectScopeBlocked();
			expect(before.conversationList.intents.selectConversation).not.toHaveBeenCalled();
			expect(before.conversationView.intents.back).not.toHaveBeenCalled();
			expect(before.conversationView.intents.retry).not.toHaveBeenCalled();
			result.rerender(
				view({
					...waiting,
					conversationList: {
						...before.conversationList,
						accountId: context.accountId,
						data: listData(state),
						intents: { selectConversation: newSelect, retry: newRetry },
					},
				}),
			);
			expect(screen.queryByText("Inbox workspace unavailable", { exact: true })).toBeNull();
			expect(screen.getByText(label, { exact: true })).toBeDefined();
			expect(screen.getByText("Choose a conversation", { exact: true })).toBeDefined();
			if (state === "error") {
				fireEvent.click(screen.getByRole("button", { name: "Retry conversations" }));
				expect(newRetry).toHaveBeenCalledExactlyOnceWith();
			} else expect(newRetry).not.toHaveBeenCalled();
			expect(oldRetry).not.toHaveBeenCalled();
			expect(newSelect).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: "Back to inbox" }));
			expect(newBack).toHaveBeenCalledExactlyOnceWith();
			expect(before.conversationView.intents.back).not.toHaveBeenCalled();
			expect(newViewRetry).not.toHaveBeenCalled();
			expect(newMessageSelect).not.toHaveBeenCalled();
		},
	);

	it.each([
		["account", "loading", "Loading messages"],
		["account", "error", "Messages unavailable"],
		["account", "empty", "No messages"],
		["conversation", "loading", "Loading messages"],
		["conversation", "error", "Messages unavailable"],
		["conversation", "empty", "No messages"],
	] as const)(
		"withholds old %s-scoped %s messages and actions until the matching view feed arrives",
		(kind, state, label) => {
			const context = transitionFixture(kind),
				oldRetry = vi.fn(),
				oldBack = vi.fn(),
				oldSelect = vi.fn();
			const newRetry = vi.fn(),
				newBack = vi.fn(),
				newSelect = vi.fn();
			const before: InboxWorkspaceProps = {
				...context.before,
				conversationView: {
					...context.before.conversationView,
					messages: messagesData(state),
					selectedMessageId: null,
					bodyPresentation: null,
					intents: { back: oldBack, selectMessage: oldSelect, retry: oldRetry },
				},
				composer: { accountId: id(20), conversationId: id(10), status: "none" },
			};
			const result = render(view(before));
			expect(screen.getByText(label, { exact: true })).toBeDefined();
			result.rerender(view({ ...context.after, conversationView: before.conversationView }));
			expectScopeBlocked();
			// New selected metadata does not refresh the retained message feed or its callbacks.
			const waiting: InboxWorkspaceProps = {
				...context.after,
				conversationView: {
					...before.conversationView,
					conversation: context.after.conversationView.conversation,
				},
			};
			result.rerender(view(waiting));
			expectScopeBlocked();
			expect(oldRetry).not.toHaveBeenCalled();
			expect(oldBack).not.toHaveBeenCalled();
			expect(oldSelect).not.toHaveBeenCalled();
			expect(context.after.conversationList.intents.selectConversation).not.toHaveBeenCalled();
			result.rerender(
				view({
					...waiting,
					conversationView: {
						...context.after.conversationView,
						messages: messagesData(state),
						intents: { back: newBack, selectMessage: newSelect, retry: newRetry },
					},
				}),
			);
			expect(screen.getByText(label, { exact: true })).toBeDefined();
			fireEvent.click(screen.getByRole("button", { name: "Back to inbox" }));
			expect(newBack).toHaveBeenCalledExactlyOnceWith();
			fireEvent.click(
				within(screen.getByRole("list", { name: "Conversations" })).getByRole("button"),
			);
			expect(
				context.after.conversationList.intents.selectConversation,
			).toHaveBeenCalledExactlyOnceWith(context.conversationId);
			if (state === "error") {
				fireEvent.click(screen.getByRole("button", { name: "Retry messages" }));
				expect(newRetry).toHaveBeenCalledExactlyOnceWith();
			} else expect(newRetry).not.toHaveBeenCalled();
			expect(oldRetry).not.toHaveBeenCalled();
			expect(oldBack).not.toHaveBeenCalled();
			expect(oldSelect).not.toHaveBeenCalled();
			expect(newSelect).not.toHaveBeenCalled();
		},
	);

	it.each([
		["account", "none", "No reply draft"],
		["account", "loading", "Loading reply draft"],
		["account", "error", "Reply draft unavailable"],
		["conversation", "none", "No reply draft"],
		["conversation", "loading", "Loading reply draft"],
		["conversation", "error", "Reply draft unavailable"],
	] as const)(
		"withholds an old %s-scoped composer %s state until its matching feed and retry arrive",
		(kind, state, label) => {
			const context = transitionFixture(kind),
				oldRetry = vi.fn(),
				newRetry = vi.fn();
			const before: InboxWorkspaceProps = {
				...context.before,
				composer: nonReadyComposer(state, id(20), id(10), oldRetry),
			};
			const result = render(view(before));
			expect(screen.getByText(label, { exact: true })).toBeDefined();
			result.rerender(view({ ...context.after, composer: before.composer }));
			expectScopeBlocked();
			expect(oldRetry).not.toHaveBeenCalled();
			expect(context.after.conversationList.intents.selectConversation).not.toHaveBeenCalled();
			expect(context.after.conversationView.intents.back).not.toHaveBeenCalled();
			expect(context.after.conversationView.intents.selectMessage).not.toHaveBeenCalled();
			result.rerender(
				view({
					...context.after,
					composer: nonReadyComposer(state, context.accountId, context.conversationId, newRetry),
				}),
			);
			expect(screen.getByText(label, { exact: true })).toBeDefined();
			expect(screen.getByRole("heading", { name: "DYTEST next conversation" })).toBeDefined();
			if (state === "error") {
				fireEvent.click(screen.getByRole("button", { name: "Retry reply draft" }));
				expect(newRetry).toHaveBeenCalledExactlyOnceWith();
			} else expect(newRetry).not.toHaveBeenCalled();
			expect(oldRetry).not.toHaveBeenCalled();
		},
	);

	it.each(["list", "view", "composer"] as const)(
		"rejects an unknown null account scope on the otherwise coherent %s bundle",
		(bundle) => {
			const input = props();
			const stale: InboxWorkspaceProps =
				bundle === "list"
					? { ...input, conversationList: { ...input.conversationList, accountId: null } }
					: bundle === "view"
						? { ...input, conversationView: { ...input.conversationView, accountId: null } }
						: { ...input, composer: { ...input.composer, accountId: null } };
			const result = render(view(input));
			expect(screen.getByText(BODY)).toBeDefined();
			result.rerender(view(stale));
			expectScopeBlocked();
			result.rerender(view(input));
			expect(screen.getByText(BODY)).toBeDefined();
			expect(input.conversationList.intents.selectConversation).not.toHaveBeenCalled();
			expect(input.conversationView.intents.back).not.toHaveBeenCalled();
			if (input.composer.status === "ready")
				expect(input.composer.props.onEditIntent).not.toHaveBeenCalled();
		},
	);

	it.each(["view", "composer"] as const)(
		"rejects a null %s conversation scope while a conversation is selected",
		(bundle) => {
			const input = props();
			const stale: InboxWorkspaceProps =
				bundle === "view"
					? { ...input, conversationView: { ...input.conversationView, conversationId: null } }
					: { ...input, composer: { ...input.composer, conversationId: null } };
			const result = render(view(input));
			result.rerender(view(stale));
			expectScopeBlocked();
			result.rerender(view(input));
			expect(screen.getByText(BODY)).toBeDefined();
			expect(input.conversationView.intents.retry).not.toHaveBeenCalled();
			if (input.composer.status === "ready")
				expect(input.composer.props.onEditIntent).not.toHaveBeenCalled();
		},
	);

	it("refuses legacy unscoped bundles instead of inferring a fresh origin from ready entities", () => {
		const input = props();
		const list = { ...input.conversationList },
			detail = { ...input.conversationView },
			reply = { ...input.composer };
		Reflect.deleteProperty(list, "accountId");
		for (const bundle of [detail, reply]) {
			Reflect.deleteProperty(bundle, "accountId");
			Reflect.deleteProperty(bundle, "conversationId");
		}
		const result = render(
			view({ ...input, conversationList: list, conversationView: detail, composer: reply }),
		);
		expectScopeBlocked();
		result.rerender(view(input));
		expect(screen.getByText(BODY)).toBeDefined();
		expect(input.onSelectAccount).not.toHaveBeenCalled();
		expect(input.conversationList.intents.retry).not.toHaveBeenCalled();
		expect(input.conversationView.intents.retry).not.toHaveBeenCalled();
		if (input.composer.status === "ready")
			expect(input.composer.props.onEditIntent).not.toHaveBeenCalled();
	});
});
