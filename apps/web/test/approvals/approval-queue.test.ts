import type { SendReview } from "@draftyak/protocol/device-api";
import { OutboxItem } from "@draftyak/protocol/entities/outbox";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../../src/approvals/ApprovalQueue.tsx";

const ITEM = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ACCOUNT = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const DRAFT = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const USER = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";

function item(): OutboxItem {
	return OutboxItem.parse({
		id: ITEM,
		accountId: ACCOUNT,
		draftId: DRAFT,
		rev: 2,
		proposedBy: { kind: "owner", id: USER },
		contentHash: "a".repeat(64),
		flagsHash: "b".repeat(64),
		notBefore: 100,
		deliverBy: 200,
		requiredApprovals: 2,
		createdAt: 1,
		updatedAt: 2,
		state: "PENDING_APPROVAL",
		stateReason: null,
	});
}

function review(): SendReview {
	return {
		id: ITEM,
		snapshot: {
			v: 1,
			hub: "c".repeat(64),
			epoch: 1,
			outbox: ITEM,
			account: ACCOUNT,
			conversation: null,
			kind: "email",
			email: {
				from: "owner@example.invalid",
				to: ["recipient@example.invalid"],
				cc: [],
				bcc: [],
				subject: "Frozen subject",
				references: [],
			},
			body: { text: "Frozen proposal body", footer: "Frozen footer" },
			attachments: [
				{ filename: "note.txt", contentType: "text/plain", size: 4, sha256: "d".repeat(64) },
			],
			schedule: { kind: "now" },
			source: { draft: DRAFT, rev: 2, authors: [{ kind: "owner", id: USER }] },
		},
		contentHash: "a".repeat(64),
		flags: [{ code: "NEW_RECIPIENT", severity: "ack" }],
		flagsHash: "b".repeat(64),
		state: "PENDING_APPROVAL",
		stateReason: null,
		requiredUsers: [USER],
		expiresAt: 200,
	};
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("ApprovalQueue", () => {
	it("displays actual pending snapshot DATA and has no approval or send action", () => {
		const input = review();
		const original = structuredClone(input);
		const forbiddenNetwork = vi.fn(() => {
			throw new Error("Unexpected network operation");
		});
		vi.stubGlobal("fetch", forbiddenNetwork);
		vi.stubGlobal("XMLHttpRequest", forbiddenNetwork);
		vi.stubGlobal("WebSocket", forbiddenNetwork);
		const { container } = render(
			createElement(ApprovalQueue, { items: [item()], reviews: [input] }),
		);
		expect(
			screen.getByText("Approval is unavailable in this browser. Use the trusted approval window."),
		).toBeDefined();
		expect(screen.getByLabelText("Proposal body").textContent).toBe("Frozen proposal body");
		expect(screen.getByLabelText("Proposal footer").textContent).toBe("Frozen footer");
		expect(screen.getByText("Frozen subject")).toBeDefined();
		expect(screen.getByText("New recipient", { exact: true })).toBeDefined();
		expect(
			within(screen.getByRole("list", { name: "Proposal attachments" })).getByRole("listitem")
				.textContent,
		).toBe("note.txt, text/plain, 4 bytes");
		expect(container.querySelector("button,input,textarea,form,a,select")).toBeNull();
		expect(input).toEqual(original);
		expect(forbiddenNetwork).not.toHaveBeenCalled();
	});

	it.each([
		[
			"account",
			(input: SendReview): SendReview => ({
				...input,
				snapshot: { ...input.snapshot, account: OTHER },
			}),
		],
		[
			"draft",
			(input: SendReview): SendReview => ({
				...input,
				snapshot: { ...input.snapshot, source: { ...input.snapshot.source, draft: OTHER } },
			}),
		],
		[
			"revision",
			(input: SendReview): SendReview => ({
				...input,
				snapshot: { ...input.snapshot, source: { ...input.snapshot.source, rev: 1 } },
			}),
		],
		[
			"proposal",
			(input: SendReview): SendReview => ({
				...input,
				snapshot: { ...input.snapshot, outbox: OTHER },
			}),
		],
		[
			"content hash",
			(input: SendReview): SendReview => ({ ...input, contentHash: "e".repeat(64) }),
		],
		["flags hash", (input: SendReview): SendReview => ({ ...input, flagsHash: "e".repeat(64) })],
		["state", (input: SendReview): SendReview => ({ ...input, state: "APPROVED" })],
		["state reason", (input: SendReview): SendReview => ({ ...input, stateReason: "policy" })],
	] as const)("does not display a snapshot with a mismatched %s binding", (_name, alter) => {
		render(createElement(ApprovalQueue, { items: [item()], reviews: [alter(review())] }));
		expect(screen.getByText("Proposal details unavailable")).toBeDefined();
		expect(screen.queryByLabelText("Proposal body")).toBeNull();
		expect(screen.queryByText("Frozen subject")).toBeNull();
	});

	it("does not choose between duplicate reviews for the same proposal", () => {
		render(createElement(ApprovalQueue, { items: [item()], reviews: [review(), review()] }));
		expect(screen.getByText("Proposal details unavailable")).toBeDefined();
		expect(screen.queryByLabelText("Proposal body")).toBeNull();
	});

	it.each([
		["null attachments", { attachments: null }],
		["null attachment row", { attachments: [null] }],
		[
			"non-string attachment filename",
			{ attachments: [{ filename: 42, contentType: "text/plain", size: 1 }] },
		],
		[
			"invalid attachment size",
			{ attachments: [{ filename: "note.txt", contentType: "text/plain", size: -1 }] },
		],
		["null body", { body: null }],
		["null email fields", { email: null }],
		[
			"null recipient list",
			{ email: { from: "owner@example.invalid", to: null, cc: [], bcc: [], subject: "Subject" } },
		],
	] as const)(
		"falls back for matching bindings with %s instead of crashing the queue",
		(_name, fields) => {
			const input = review();
			const partial = {
				...input,
				snapshot: { ...input.snapshot, ...fields },
			} as unknown as SendReview;
			render(createElement(ApprovalQueue, { items: [item()], reviews: [partial] }));
			expect(screen.getByRole("heading", { name: "Pending approval queue" })).toBeDefined();
			expect(screen.getByText("Proposal details unavailable")).toBeDefined();
			expect(screen.queryByLabelText("Proposal body")).toBeNull();
			expect(screen.queryByRole("alert")).toBeNull();
		},
	);

	it("shows reapproval reason DATA and excludes completed proposals", () => {
		const pending = OutboxItem.parse({
			...item(),
			state: "NEEDS_REAPPROVAL",
			stateReason: "new_reply",
		});
		const completed = OutboxItem.parse({ ...item(), id: OTHER, state: "SENT", stateReason: null });
		render(createElement(ApprovalQueue, { items: [pending, completed] }));
		expect(screen.getByText("Needs approval again")).toBeDefined();
		expect(screen.getByText("New reply received")).toBeDefined();
		expect(screen.getAllByRole("article")).toHaveLength(1);
		expect(screen.queryByText(OTHER)).toBeNull();
	});

	it("distinguishes an empty queue from invalid duplicate item DATA", () => {
		const rendered = render(createElement(ApprovalQueue, { items: [] }));
		expect(screen.getByText("No proposals awaiting approval")).toBeDefined();
		rendered.rerender(createElement(ApprovalQueue, { items: [item(), item()] }));
		expect(screen.getByRole("alert").textContent).toBe("Approval queue unavailable");
		expect(screen.queryByText("No proposals awaiting approval")).toBeNull();
	});

	it("keeps body, subject, filenames and URLs inert", () => {
		const input = review();
		const hostile = '<img src=x onerror="alert(1)"><a href="https://example.invalid">open</a>';
		const snapshot = input.snapshot;
		if (snapshot.kind !== "email") throw new Error("Expected an email snapshot");
		const malicious: SendReview = {
			...input,
			snapshot: {
				...snapshot,
				email: { ...snapshot.email, subject: hostile },
				body: { text: hostile, footer: hostile },
				attachments: [
					{ filename: hostile, contentType: "text/plain", size: 1, sha256: "d".repeat(64) },
				],
			},
		};
		const { container } = render(
			createElement(ApprovalQueue, { items: [item()], reviews: [malicious] }),
		);
		expect(screen.getByLabelText("Proposal body").textContent).toBe(hostile);
		expect(container.querySelector("img,a,script,svg,iframe,object")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("preserves a legacy absent sharing fact without inventing false", () => {
		const input = review();
		const { snapshot } = input;
		const chat: SendReview = {
			...input,
			snapshot: {
				v: snapshot.v,
				hub: snapshot.hub,
				epoch: snapshot.epoch,
				outbox: snapshot.outbox,
				account: snapshot.account,
				conversation: OTHER,
				kind: "chat",
				chat: {
					channelId: "C123",
					channelName: "general",
					channelType: "public",
					external: false,
					memberCount: 4,
					broadcast: false,
				},
				body: snapshot.body,
				attachments: [],
				schedule: snapshot.schedule,
				source: snapshot.source,
			},
		};
		render(createElement(ApprovalQueue, { items: [item()], reviews: [chat] }));
		expect(screen.getByText("Chat: general; public; sharing fact unavailable")).toBeDefined();
		expect(screen.queryByText(/not shared/)).toBeNull();
	});

	it("removes a previously displayed snapshot when its binding changes", () => {
		const input = review();
		const rendered = render(createElement(ApprovalQueue, { items: [item()], reviews: [input] }));
		expect(screen.getByLabelText("Proposal body")).toBeDefined();
		rendered.rerender(
			createElement(ApprovalQueue, {
				items: [item()],
				reviews: [{ ...input, snapshot: { ...input.snapshot, account: OTHER } }],
			}),
		);
		expect(screen.queryByLabelText("Proposal body")).toBeNull();
		expect(screen.getByText("Proposal details unavailable")).toBeDefined();
	});
});
