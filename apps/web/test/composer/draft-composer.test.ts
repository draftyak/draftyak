import { Draft, DraftContent, DraftRevision } from "@draftyak/protocol/entities/draft";
import { OutboxItem, type OutboxState } from "@draftyak/protocol/entities/outbox";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftComposer, type DraftComposerProps } from "../../src/composer/DraftComposer.tsx";

const DRAFT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ACCOUNT = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const USER = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const ITEM = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";

function email(body = "Original body"): DraftContent {
	return DraftContent.parse({
		channel: "email",
		to: ["recipient@example.invalid"],
		cc: ["copy@example.invalid"],
		bcc: ["private@example.invalid"],
		subject: "Subject remains unchanged",
		body,
		attachments: [
			{
				blobId: OTHER,
				filename: "note.txt",
				contentType: "text/plain",
				size: 4,
				sha256: "b".repeat(64),
			},
		],
	});
}

function revision(rev = 2, content = email()): DraftRevision {
	return DraftRevision.parse({
		draftId: DRAFT,
		rev,
		author: { kind: "owner", id: USER },
		content,
		contentSha256: "a".repeat(64),
		flags: [],
		createdAt: 10,
	});
}

function draft(rev = 2): Draft {
	return Draft.parse({
		id: DRAFT,
		accountId: ACCOUNT,
		conversationId: null,
		rev,
		state: "open",
		createdAt: 1,
		updatedAt: 10,
	});
}

function item(state: Exclude<OutboxState, "NEEDS_REAPPROVAL"> = "PENDING_APPROVAL"): OutboxItem {
	return OutboxItem.parse({
		id: ITEM,
		accountId: ACCOUNT,
		draftId: DRAFT,
		rev: 2,
		proposedBy: { kind: "owner", id: USER },
		contentHash: "c".repeat(64),
		flagsHash: "d".repeat(64),
		notBefore: null,
		deliverBy: null,
		requiredApprovals: 1,
		createdAt: 10,
		updatedAt: 10,
		state,
		stateReason: null,
	});
}

function props(overrides: Partial<DraftComposerProps> = {}): DraftComposerProps {
	return {
		draft: draft(),
		currentRevision: revision(),
		history: [revision(1, email("Earlier body"))],
		outboxItems: [],
		onEditIntent: vi.fn(),
		...overrides,
	};
}

function view(input: DraftComposerProps) {
	return createElement(DraftComposer, input);
}

function edit(body: string): void {
	fireEvent.change(screen.getByRole("textbox", { name: "Draft body" }), {
		target: { value: body },
	});
}

afterEach(() => cleanup());

describe("DraftComposer", () => {
	it("emits only a detached body edit intent with the current expected revision", () => {
		const onEditIntent = vi.fn();
		const input = props({ onEditIntent, outboxItems: [item()] });
		const original = structuredClone(input.currentRevision);
		render(view(input));
		edit("New body\nSecond line");
		fireEvent.click(screen.getByRole("button", { name: "Request new revision" }));
		expect(onEditIntent).toHaveBeenCalledTimes(1);
		const intent = onEditIntent.mock.calls[0]?.[0];
		expect(intent).toEqual({
			draftId: DRAFT,
			expectedRev: 2,
			content: { ...original.content, body: "New body\nSecond line" },
		});
		expect(Object.isFrozen(intent)).toBe(true);
		expect(Object.isFrozen(intent.content)).toBe(true);
		expect(Object.isFrozen(intent.content.to)).toBe(true);
		expect(Object.isFrozen(intent.content.attachments[0])).toBe(true);
		expect(intent.content).not.toBe(input.currentRevision.content);
		expect(input.currentRevision).toEqual(original);
		expect(screen.getByRole("status").textContent).toBe(
			"Edit requested; waiting for a new revision.",
		);
		expect(
			(screen.getByRole("button", { name: "Request new revision" }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(screen.queryByText(/saved successfully/i)).toBeNull();
	});

	it("preserves actual chat thread and broadcast fields in an edit intent", () => {
		const onEditIntent = vi.fn();
		const content = DraftContent.parse({
			channel: "chat",
			threadTs: "123.456",
			broadcast: true,
			body: "Original body",
		});
		render(
			view(
				props({
					draft: { ...draft(), conversationId: OTHER },
					currentRevision: revision(2, content),
					history: [],
					onEditIntent,
				}),
			),
		);
		edit("Changed chat body");
		fireEvent.click(screen.getByRole("button", { name: "Request new revision" }));
		expect(onEditIntent).toHaveBeenCalledWith({
			draftId: DRAFT,
			expectedRev: 2,
			content: { ...content, body: "Changed chat body" },
		});
	});

	it.each([
		["cross-draft current revision", { currentRevision: { ...revision(), draftId: OTHER } }],
		["stale current revision", { currentRevision: revision(1) }],
		["cross-draft history", { history: [{ ...revision(1), draftId: OTHER }] }],
		["duplicate history revision", { history: [revision(1), revision(1)] }],
		["future history revision", { history: [revision(3)] }],
		["mismatched current history content", { history: [revision(2, email("Different body"))] }],
		["cross-account live outbox", { outboxItems: [{ ...item("APPROVED"), accountId: OTHER }] }],
		["cross-draft outbox", { outboxItems: [{ ...item(), draftId: OTHER }] }],
		["future outbox revision", { outboxItems: [{ ...item(), rev: 3 }] }],
		["duplicate outbox item", { outboxItems: [item(), item()] }],
	] as const)("refuses %s before offering an edit", (_name, overrides) => {
		const onEditIntent = vi.fn();
		render(view(props({ ...overrides, onEditIntent })));
		expect(screen.getByRole("alert").textContent).toBe("Draft unavailable");
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.queryByRole("button", { name: "Request new revision" })).toBeNull();
		expect(onEditIntent).not.toHaveBeenCalled();
	});

	it.each(["APPROVED", "SCHEDULED", "SENDING", "RETRY_WAIT", "UNKNOWN"] as const)(
		"keeps a draft with a live %s proposal read-only",
		(state) => {
			const onEditIntent = vi.fn();
			const input = props({ onEditIntent });
			const rendered = render(view(input));
			edit("Valid buffer edited before locking");
			expect(
				(screen.getByRole("button", { name: "Request new revision" }) as HTMLButtonElement)
					.disabled,
			).toBe(false);
			rendered.rerender(view({ ...input, outboxItems: [item(state)] }));
			const form = screen.getByRole("textbox", { name: "Draft body" }).closest("form");
			if (!form) throw new Error("Expected the draft edit form");
			fireEvent.submit(form);
			expect(onEditIntent).not.toHaveBeenCalled();
			expect(
				(screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value,
			).toBe("Valid buffer edited before locking");
			expect(
				(screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).readOnly,
			).toBe(true);
			expect(screen.getByText("A live outbox item locks this draft.")).toBeDefined();
			expect(
				(screen.getByRole("button", { name: "Request new revision" }) as HTMLButtonElement)
					.disabled,
			).toBe(true);
		},
	);

	it.each(["sent", "discarded"] as const)(
		"does not accept new revisions for a %s draft",
		(state) => {
			const onEditIntent = vi.fn();
			const input = props({ onEditIntent });
			const rendered = render(view(input));
			edit("Valid buffer edited before terminal state");
			expect(
				(screen.getByRole("button", { name: "Request new revision" }) as HTMLButtonElement)
					.disabled,
			).toBe(false);
			rendered.rerender(view({ ...input, draft: { ...input.draft, state } }));
			const form = screen.getByRole("textbox", { name: "Draft body" }).closest("form");
			if (!form) throw new Error("Expected the draft edit form");
			fireEvent.submit(form);
			expect(onEditIntent).not.toHaveBeenCalled();
			expect(
				(screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value,
			).toBe("Valid buffer edited before terminal state");
			expect(
				(screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).readOnly,
			).toBe(true);
			expect(
				(screen.getByRole("button", { name: "Request new revision" }) as HTMLButtonElement)
					.disabled,
			).toBe(true);
		},
	);

	it.each([
		["non-NFC", "e\u0301"],
		["lone surrogate", "\uD800"],
		["over the email scalar limit", "x".repeat(100_001)],
	] as const)("does not request a revision for %s input", (_name, body) => {
		const onEditIntent = vi.fn();
		render(view(props({ onEditIntent })));
		edit(body);
		expect(screen.getByRole("alert").textContent).toContain("NFC text and LF line endings");
		fireEvent.click(screen.getByRole("button", { name: "Request new revision" }));
		expect(onEditIntent).not.toHaveBeenCalled();
	});

	it("refuses a non-LF current body without normalizing it", () => {
		const invalid = { ...revision(), content: { ...email(), body: "first\rsecond" } };
		render(view(props({ currentRevision: invalid })));
		expect(screen.getByRole("alert").textContent).toBe("Draft unavailable");
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("accepts the canonical chat scalar maximum and refuses the next scalar", () => {
		const onEditIntent = vi.fn();
		const content = DraftContent.parse({
			channel: "chat",
			threadTs: null,
			broadcast: false,
			body: "Original body",
		});
		render(
			view(
				props({
					draft: { ...draft(), conversationId: OTHER },
					currentRevision: revision(2, content),
					history: [],
					onEditIntent,
				}),
			),
		);
		edit("\u{1F600}".repeat(40_000));
		expect(
			(screen.getByRole("button", { name: "Request new revision" }) as HTMLButtonElement).disabled,
		).toBe(false);
		edit("\u{1F600}".repeat(40_001));
		expect(
			(screen.getByRole("button", { name: "Request new revision" }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(onEditIntent).not.toHaveBeenCalled();
	});

	it("preserves the canonical email maximum without clipping the edit intent", () => {
		const onEditIntent = vi.fn();
		render(view(props({ onEditIntent })));
		const body = "\u{1F600}".repeat(100_000);
		edit(body);
		fireEvent.click(screen.getByRole("button", { name: "Request new revision" }));
		expect(onEditIntent).toHaveBeenCalledWith({
			draftId: DRAFT,
			expectedRev: 2,
			content: email(body),
		});
	});

	it("selects supplied history and displays a body diff without editing the current body", () => {
		const onEditIntent = vi.fn();
		render(view(props({ onEditIntent })));
		fireEvent.click(screen.getByRole("button", { name: "Revision 1" }));
		expect(screen.getByLabelText("Revision 1 body").textContent).toBe("Earlier body");
		expect(screen.getByLabelText("Body changes").querySelector("del")?.textContent).toBe("Earlier");
		expect(screen.getByLabelText("Body changes").querySelector("ins")?.textContent).toBe(
			"Original",
		);
		expect((screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value).toBe(
			"Original body",
		);
		expect(onEditIntent).not.toHaveBeenCalled();
	});

	it("keeps a dirty buffer bound to its old revision until Load latest is chosen", () => {
		const onEditIntent = vi.fn();
		const input = props({ onEditIntent });
		const rendered = render(view(input));
		edit("Unsaved buffer");
		const next = {
			...input,
			draft: draft(3),
			currentRevision: revision(3, email("Server revision")),
			history: [input.currentRevision, ...input.history],
		};
		rendered.rerender(view(next));
		expect((screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value).toBe(
			"Unsaved buffer",
		);
		expect(
			(screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).readOnly,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Request new revision" }));
		expect(onEditIntent).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Load latest revision" }));
		expect((screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value).toBe(
			"Server revision",
		);
		edit("New edit on revision three");
		fireEvent.click(screen.getByRole("button", { name: "Request new revision" }));
		expect(onEditIntent).toHaveBeenCalledWith({
			draftId: DRAFT,
			expectedRev: 3,
			content: email("New edit on revision three"),
		});
	});

	it("clears a draft buffer when a different canonical draft is selected", () => {
		const input = props();
		const rendered = render(view(input));
		edit("First draft buffer");
		rendered.rerender(
			view({
				...input,
				draft: { ...draft(), id: OTHER },
				currentRevision: { ...revision(2, email("Other draft body")), draftId: OTHER },
				history: [],
			}),
		);
		expect((screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value).toBe(
			"Other draft body",
		);
	});

	it("reports a failed edit intent without displaying or recording its raw error", () => {
		const onEditIntent = vi.fn(() => {
			throw new Error("not for display");
		});
		render(view(props({ onEditIntent })));
		edit("New body");
		fireEvent.click(screen.getByRole("button", { name: "Request new revision" }));
		expect(screen.getByRole("alert").textContent).toBe("Edit request unavailable");
		expect(screen.queryByText("not for display")).toBeNull();
		expect(screen.queryByText("Edit requested; waiting for a new revision.")).toBeNull();
	});

	it("consumes an asynchronous rejection and retries the current buffer without duplicate delivery", async () => {
		const first = Promise.withResolvers<void>();
		const retry = Promise.withResolvers<void>();
		const onEditIntent = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(retry.promise);
		render(view(props({ onEditIntent })));
		edit("Retained edit buffer");
		const request = screen.getByRole("button", { name: "Request new revision" });
		fireEvent.click(request);
		fireEvent.click(request);
		expect(onEditIntent).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("status").textContent).toBe("Requesting a new revision");
		expect(
			(screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).readOnly,
		).toBe(true);
		await act(async () => {
			first.reject(new Error("asynchronous detail must remain unavailable"));
		});
		expect(screen.getByRole("alert").textContent).toBe("Edit request unavailable");
		expect(screen.queryByText("asynchronous detail must remain unavailable")).toBeNull();
		expect((screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value).toBe(
			"Retained edit buffer",
		);
		expect((request as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(request);
		expect(onEditIntent).toHaveBeenCalledTimes(2);
		expect(onEditIntent.mock.calls.map((call) => call[0])).toEqual([
			{ draftId: DRAFT, expectedRev: 2, content: email("Retained edit buffer") },
			{ draftId: DRAFT, expectedRev: 2, content: email("Retained edit buffer") },
		]);
		await act(async () => {
			retry.resolve();
		});
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("status").textContent).toBe(
			"Edit requested; waiting for a new revision.",
		);
		expect((request as HTMLButtonElement).disabled).toBe(true);
	});

	it("ignores an old rejection after a newer revision is loaded and another delivery is pending", async () => {
		const oldDelivery = Promise.withResolvers<void>();
		const currentDelivery = Promise.withResolvers<void>();
		const onEditIntent = vi
			.fn()
			.mockReturnValueOnce(oldDelivery.promise)
			.mockReturnValueOnce(currentDelivery.promise);
		const input = props({ onEditIntent });
		const rendered = render(view(input));
		edit("Old revision buffer");
		fireEvent.click(screen.getByRole("button", { name: "Request new revision" }));
		rendered.rerender(
			view({
				...input,
				draft: draft(3),
				currentRevision: revision(3, email("New current revision")),
				history: [input.currentRevision, ...input.history],
			}),
		);
		expect(screen.queryByText("Requesting a new revision")).toBeNull();
		expect((screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value).toBe(
			"Old revision buffer",
		);
		fireEvent.click(screen.getByRole("button", { name: "Load latest revision" }));
		edit("Revision three buffer");
		fireEvent.click(screen.getByRole("button", { name: "Request new revision" }));
		await act(async () => {
			oldDelivery.reject(new Error("old delivery rejected"));
		});
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("status").textContent).toBe("Requesting a new revision");
		expect((screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value).toBe(
			"Revision three buffer",
		);
		expect(onEditIntent.mock.calls[1]?.[0]).toEqual({
			draftId: DRAFT,
			expectedRev: 3,
			content: email("Revision three buffer"),
		});
		await act(async () => {
			currentDelivery.resolve();
		});
		expect(screen.getByRole("status").textContent).toBe(
			"Edit requested; waiting for a new revision.",
		);
	});

	it("does not let a late success overwrite a newer revision's failed delivery", async () => {
		const oldDelivery = Promise.withResolvers<void>();
		const currentDelivery = Promise.withResolvers<void>();
		const onEditIntent = vi
			.fn()
			.mockReturnValueOnce(oldDelivery.promise)
			.mockReturnValueOnce(currentDelivery.promise);
		const input = props({ onEditIntent });
		const rendered = render(view(input));
		edit("Old revision buffer");
		fireEvent.click(screen.getByRole("button", { name: "Request new revision" }));
		rendered.rerender(
			view({
				...input,
				draft: draft(3),
				currentRevision: revision(3, email("New current revision")),
				history: [input.currentRevision, ...input.history],
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Load latest revision" }));
		edit("Retryable revision three buffer");
		fireEvent.click(screen.getByRole("button", { name: "Request new revision" }));
		await act(async () => {
			currentDelivery.reject(new Error("current delivery rejected"));
		});
		await act(async () => {
			oldDelivery.resolve();
		});
		expect(screen.getByRole("alert").textContent).toBe("Edit request unavailable");
		expect(screen.queryByRole("status")).toBeNull();
		expect((screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value).toBe(
			"Retryable revision three buffer",
		);
		expect(
			(screen.getByRole("button", { name: "Request new revision" }) as HTMLButtonElement).disabled,
		).toBe(false);
	});

	it("ignores a rejected delivery after unmount without changing a newly mounted draft", async () => {
		const delivery = Promise.withResolvers<void>();
		const input = props({ onEditIntent: vi.fn(() => delivery.promise) });
		const rendered = render(view(input));
		edit("Old editor buffer");
		fireEvent.click(screen.getByRole("button", { name: "Request new revision" }));
		rendered.unmount();
		const onEditIntent = vi.fn();
		render(
			view(
				props({
					draft: { ...draft(), id: OTHER },
					currentRevision: { ...revision(2, email("New editor body")), draftId: OTHER },
					history: [],
					onEditIntent,
				}),
			),
		);
		edit("New editor buffer");
		await act(async () => {
			delivery.reject(new Error("unmounted delivery rejected"));
		});
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
		expect((screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value).toBe(
			"New editor buffer",
		);
		expect(
			(screen.getByRole("button", { name: "Request new revision" }) as HTMLButtonElement).disabled,
		).toBe(false);
		expect(onEditIntent).not.toHaveBeenCalled();
	});

	it("reuses flags and the supplied source disclosure without treating a snippet as a body", () => {
		const disclosure = createElement(
			"p",
			null,
			"Source body refused; removed content is unavailable",
		);
		render(
			view(
				props({
					currentRevision: { ...revision(), flags: [{ code: "NEW_RECIPIENT", severity: "ack" }] },
					sourceBodyDisclosure: disclosure,
				}),
			),
		);
		expect(screen.getByText("New recipient", { exact: true })).toBeDefined();
		expect(screen.getByText("Source body refused; removed content is unavailable")).toBeDefined();
		expect(screen.queryByText("Source body unavailable")).toBeNull();
		expect(screen.queryByRole("button", { name: /^(approve|send)$/i })).toBeNull();
	});
});
