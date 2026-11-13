import { execFile } from "node:child_process";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { promisify } from "node:util";
import type { SendReview } from "@draftyak/protocol/device-api";
import { Account } from "@draftyak/protocol/entities/account";
import { OutboxItem } from "@draftyak/protocol/entities/outbox";
import { SchedulingStatus } from "@draftyak/protocol/hub-runtime";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type ComponentProps, createElement, type FormEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewWorkspace } from "../../src/approvals/ReviewWorkspace.tsx";

type Props = ComponentProps<typeof ReviewWorkspace>;
type TestProps = { -readonly [Key in keyof Props]: Props[Key] };
const id = (sequence: number): string => String(sequence).padStart(26, "0");
const ACCOUNT_A = id(100);
const ACCOUNT_B = id(200);
const USER = id(300);
const NOT_BEFORE = Date.UTC(2030, 0, 15, 17, 45);
const RUNNING = SchedulingStatus.parse({
	mode: "service",
	scheduler: "running",
	syncPaused: false,
});

function account(overrides: Readonly<Record<string, unknown>> = {}): Account {
	return Account.parse({
		id: ACCOUNT_A,
		userId: USER,
		alias: "dytest-work",
		channel: "email",
		mode: "full",
		status: "active",
		deletionDeadline: null,
		historyLimitDays: 30,
		disclosureVersion: 1,
		createdAt: 1,
		pluginInstanceId: id(400),
		address: "owner@example.invalid",
		...overrides,
	});
}

function item(sequence: number, overrides: Readonly<Record<string, unknown>> = {}): OutboxItem {
	return OutboxItem.parse({
		id: id(sequence),
		accountId: ACCOUNT_A,
		draftId: id(1000 + sequence),
		rev: 2,
		proposedBy: { kind: "owner", id: USER },
		contentHash: "a".repeat(64),
		flagsHash: "b".repeat(64),
		notBefore: null,
		deliverBy: null,
		requiredApprovals: 2,
		createdAt: 1,
		updatedAt: 2,
		state: "PENDING_APPROVAL",
		stateReason: null,
		...overrides,
	});
}

function review(input: OutboxItem): SendReview {
	return {
		id: input.id,
		snapshot: {
			v: 1,
			hub: "c".repeat(64),
			epoch: 1,
			outbox: input.id,
			account: input.accountId,
			conversation: null,
			kind: "email",
			email: {
				from: "owner@example.invalid",
				to: ["recipient@example.invalid"],
				cc: [],
				bcc: [],
				subject: `Frozen subject ${input.id}`,
				references: [],
			},
			body: { text: `Frozen body ${input.id}`, footer: "Frozen footer" },
			attachments: [
				{ filename: "note.txt", contentType: "text/plain", size: 4, sha256: "d".repeat(64) },
			],
			schedule: { kind: "now" },
			source: { draft: input.draftId, rev: input.rev, authors: [{ kind: "owner", id: USER }] },
		},
		contentHash: input.contentHash,
		flags: [{ code: "NEW_RECIPIENT", severity: "ack" }],
		flagsHash: input.flagsHash,
		state: input.state,
		stateReason: input.stateReason,
		requiredUsers: [USER],
		expiresAt: NOT_BEFORE,
	};
}

function props(overrides: Partial<Props> = {}): TestProps {
	const pending = item(1);
	return {
		account: account(),
		queue: {
			accountId: ACCOUNT_A,
			status: "ready",
			items: [pending],
			reviews: [review(pending)],
		},
		scheduled: {
			accountId: ACCOUNT_A,
			items: [item(11, { state: "SCHEDULED", notBefore: NOT_BEFORE })],
			ownerZone: "UTC",
			scheduling: RUNNING,
		},
		...overrides,
	};
}

function queue(): HTMLElement {
	return screen.getByRole("region", { name: "Pending approval queue" });
}

function scheduled(): HTMLElement {
	return screen.getByRole("region", { name: "Scheduled sends" });
}

function scheduledRow(outboxId: string): HTMLElement {
	const row = within(scheduled()).getByRole("rowheader", { name: outboxId }).closest("tr");
	if (!(row instanceof HTMLElement)) throw new Error("DYTEST expected a scheduled row");
	return row;
}

function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

beforeEach(() => {
	vi.stubGlobal("Temporal", undefined);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("ReviewWorkspace composition", () => {
	it("preserves queue order and frozen snapshots beside the selected account's schedule", () => {
		const second = item(2, { state: "NEEDS_REAPPROVAL", stateReason: "new_reply", rev: 3 });
		const first = item(1);
		const inspect = vi.fn();
		const input = props({
			queue: {
				accountId: ACCOUNT_A,
				status: "ready",
				items: [second, first],
				reviews: [review(first), review(second)],
			},
		});
		input.scheduled = { ...input.scheduled, onInspect: inspect };
		render(createElement(ReviewWorkspace, input));
		expect(screen.getByRole("heading", { name: "Review workspace", level: 1 })).toBeTruthy();
		expect(
			within(queue())
				.getAllByRole("article")
				.map((article) => article.querySelector("code")?.textContent),
		).toEqual([second.id, first.id]);
		expect(
			within(queue())
				.getAllByLabelText("Proposal body")
				.map((body) => body.textContent),
		).toEqual([`Frozen body ${second.id}`, `Frozen body ${first.id}`]);
		expect(within(queue()).getByText("New reply received")).toBeTruthy();
		expect(within(queue()).getAllByText("Frozen footer")).toHaveLength(2);
		expect(within(queue()).getAllByText("New recipient", { exact: true })).toHaveLength(2);
		expect(within(queue()).getAllByRole("list", { name: "Proposal attachments" })).toHaveLength(2);
		expect(
			within(scheduled()).getByRole("table", { name: "Scheduled sends for dytest-work" }),
		).toBeTruthy();
		expect(within(scheduledRow(id(11))).getByText("Scheduled", { exact: true })).toBeTruthy();
		expect(inspect).not.toHaveBeenCalled();
	});

	it("keeps the browser approval boundary and exposes no send or editing controls", () => {
		const network = vi.fn(() => {
			throw new Error("DYTEST unexpected network");
		});
		vi.stubGlobal("fetch", network);
		vi.stubGlobal("WebSocket", network);
		const { container } = render(createElement(ReviewWorkspace, props()));
		expect(
			within(queue()).getByText(
				"Approval is unavailable in this browser. Use the trusted approval window.",
			),
		).toBeTruthy();
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		expect(container.querySelector("input,textarea,select,form,a")).toBeNull();
		expect(network).not.toHaveBeenCalled();
	});

	it("delegates an unmatched review snapshot without repairing its binding", () => {
		const pending = item(1);
		const original = review(pending);
		const mismatched = { ...original, contentHash: "e".repeat(64) };
		render(
			createElement(
				ReviewWorkspace,
				props({
					queue: {
						accountId: ACCOUNT_A,
						status: "ready",
						items: [pending],
						reviews: [mismatched],
					},
				}),
			),
		);
		expect(within(queue()).getByText(pending.id, { exact: true })).toBeTruthy();
		expect(within(queue()).getByText("Proposal details unavailable")).toBeTruthy();
		expect(screen.queryByLabelText("Proposal body")).toBeNull();
		expect(scheduledRow(id(11))).toBeTruthy();
		expect(mismatched.contentHash).toBe("e".repeat(64));
	});

	it("accepts valid read-only paused accounts as display DATA", () => {
		render(
			createElement(
				ReviewWorkspace,
				props({ account: account({ mode: "read_only", status: "paused" }) }),
			),
		);
		expect(queue()).toBeTruthy();
		expect(scheduledRow(id(11))).toBeTruthy();
		expect(screen.queryByText("Review workspace unavailable.")).toBeNull();
	});

	it("preserves every canonical state and permits the same proposal in both feeds", () => {
		const states = [
			"PENDING_APPROVAL",
			"APPROVED",
			"SCHEDULED",
			"SENDING",
			"RETRY_WAIT",
			"UNKNOWN",
			"SENT",
			"FAILED",
			"NEEDS_REAPPROVAL",
			"CANCELLED",
			"REJECTED",
			"SUPERSEDED",
			"EXPIRED",
		] as const;
		const items = states.map((state, index) =>
			item(index + 1, {
				state,
				stateReason: state === "NEEDS_REAPPROVAL" ? "policy" : null,
				notBefore: NOT_BEFORE,
			}),
		);
		const input = props({ queue: { accountId: ACCOUNT_A, status: "ready", items } });
		input.scheduled = { ...input.scheduled, items };
		render(createElement(ReviewWorkspace, input));
		expect(within(queue()).getAllByRole("article")).toHaveLength(2);
		expect(within(queue()).getByText(id(1), { exact: true })).toBeTruthy();
		expect(within(queue()).getByText(id(9), { exact: true })).toBeTruthy();
		expect(within(queue()).queryByText(id(7), { exact: true })).toBeNull();
		expect(
			within(scheduled())
				.getAllByRole("rowheader")
				.map((row) => row.textContent),
		).toEqual(items.map((entry) => entry.id));
		expect(within(scheduledRow(id(6))).getByText("Send outcome unknown")).toBeTruthy();
		expect(within(scheduledRow(id(13))).getByText("Expired")).toBeTruthy();
		expect(screen.queryAllByRole("alert")).toHaveLength(0);
	});

	it("uses the canonical alias rather than a caller's stale schedule label", () => {
		const input = props();
		input.scheduled = { ...input.scheduled, accountLabels: { [ACCOUNT_A]: "DYTEST stale label" } };
		render(createElement(ReviewWorkspace, input));
		expect(
			within(scheduled()).getByRole("table", { name: "Scheduled sends for dytest-work" }),
		).toBeTruthy();
		expect(screen.queryByText("DYTEST stale label")).toBeNull();
	});

	it("renders frozen hostile text as text while keeping snapshot fields intact", () => {
		const pending = item(1);
		const original = review(pending);
		const hostile = '<img src=x onerror="DYTEST_EXECUTE()">';
		const snapshot = {
			...original,
			snapshot: { ...original.snapshot, body: { ...original.snapshot.body, text: hostile } },
		};
		const { container } = render(
			createElement(
				ReviewWorkspace,
				props({
					queue: {
						accountId: ACCOUNT_A,
						status: "ready",
						items: [pending],
						reviews: [snapshot],
					},
				}),
			),
		);
		expect(screen.getByLabelText("Proposal body").textContent).toBe(hostile);
		expect(container.querySelector("img,script")).toBeNull();
		expect(screen.queryByText("a".repeat(64), { exact: true })).toBeNull();
		expect(screen.queryByText("b".repeat(64), { exact: true })).toBeNull();
	});

	it("does not mutate deeply frozen account, feeds, snapshots, or caller labels", () => {
		const input = props();
		input.scheduled = { ...input.scheduled, accountLabels: { [ACCOUNT_A]: "DYTEST old label" } };
		const original = structuredClone(input);
		freeze(input);
		render(createElement(ReviewWorkspace, input));
		expect(queue()).toBeTruthy();
		expect(scheduledRow(id(11))).toBeTruthy();
		expect(input).toEqual(original);
	});
});

describe("ReviewWorkspace account isolation", () => {
	it("asks for an account without leaking supplied rows or actions", () => {
		const retry = vi.fn();
		const inspect = vi.fn();
		const input = props({
			account: null,
			queue: { accountId: ACCOUNT_A, status: "error", onRetry: retry },
		});
		input.scheduled = { ...input.scheduled, onInspect: inspect };
		render(createElement(ReviewWorkspace, input));
		expect(
			screen.getByText("Choose an account to review proposals and scheduled sends."),
		).toBeTruthy();
		expect(screen.queryByRole("region", { name: "Scheduled sends" })).toBeNull();
		expect(screen.queryByRole("region", { name: "Pending approval queue" })).toBeNull();
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		expect(screen.queryByText(id(11), { exact: true })).toBeNull();
		expect(retry).not.toHaveBeenCalled();
		expect(inspect).not.toHaveBeenCalled();
	});

	it("refuses a malformed account before displaying either valid feed", () => {
		const invalid = { ...account(), alias: "DYTEST invalid alias" } as Account;
		render(createElement(ReviewWorkspace, props({ account: invalid })));
		expect(screen.getByRole("alert").textContent).toBe("Review workspace unavailable.");
		expect(screen.queryByRole("region", { name: "Pending approval queue" })).toBeNull();
		expect(screen.queryByRole("region", { name: "Scheduled sends" })).toBeNull();
		expect(screen.queryByText(id(1), { exact: true })).toBeNull();
		expect(screen.queryByText(id(11), { exact: true })).toBeNull();
	});

	it.each(["malformed", "duplicate", "foreign"] as const)(
		"withholds the whole %s queue while preserving a valid schedule",
		(kind) => {
			const first = item(1);
			const second =
				kind === "duplicate"
					? first
					: item(2, { accountId: kind === "foreign" ? ACCOUNT_B : ACCOUNT_A });
			const invalid = kind === "malformed" ? ({ ...second, rev: 0 } as OutboxItem) : second;
			render(
				createElement(
					ReviewWorkspace,
					props({
						queue: {
							accountId: ACCOUNT_A,
							status: "ready",
							items: [first, invalid],
							reviews: [review(first)],
						},
					}),
				),
			);
			expect(screen.getByRole("alert").textContent).toBe(
				"Approval queue unavailable for this account.",
			);
			expect(within(queue()).queryAllByRole("article")).toHaveLength(0);
			expect(screen.queryByText(first.id, { exact: true })).toBeNull();
			expect(screen.queryByLabelText("Proposal body")).toBeNull();
			expect(screen.queryByText("No proposals awaiting approval")).toBeNull();
			expect(scheduledRow(id(11))).toBeTruthy();
		},
	);

	it.each(["malformed", "duplicate", "foreign"] as const)(
		"withholds the whole %s schedule while preserving the valid queue",
		(kind) => {
			const inspect = vi.fn();
			const input = props();
			const first = item(11, { state: "SCHEDULED", notBefore: NOT_BEFORE });
			const second =
				kind === "duplicate"
					? first
					: item(12, {
							state: "SCHEDULED",
							notBefore: NOT_BEFORE,
							accountId: kind === "foreign" ? ACCOUNT_B : ACCOUNT_A,
						});
			const invalid =
				kind === "malformed" ? ({ ...second, flagsHash: "invalid" } as OutboxItem) : second;
			input.scheduled = { ...input.scheduled, items: [first, invalid], onInspect: inspect };
			render(createElement(ReviewWorkspace, input));
			expect(screen.getByRole("alert").textContent).toBe(
				"Scheduled sends unavailable for this account.",
			);
			expect(within(scheduled()).queryAllByRole("table")).toHaveLength(0);
			expect(screen.queryByText(first.id, { exact: true })).toBeNull();
			expect(screen.queryByText("No scheduled sends for this account.")).toBeNull();
			expect(screen.queryByRole("button", { name: "Inspect scheduled send" })).toBeNull();
			expect(within(queue()).getByText(id(1), { exact: true })).toBeTruthy();
			expect(inspect).not.toHaveBeenCalled();
		},
	);

	it("does not relabel old nonempty feeds when the selected account changes", () => {
		const inspect = vi.fn();
		const old = props();
		old.scheduled = { ...old.scheduled, onInspect: inspect };
		const rendered = render(createElement(ReviewWorkspace, old));
		expect(screen.getByLabelText("Proposal body")).toBeTruthy();
		rendered.rerender(
			createElement(ReviewWorkspace, {
				...old,
				account: account({ id: ACCOUNT_B, alias: "dytest-personal" }),
			}),
		);
		expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
			"Approval queue unavailable for this account.",
			"Scheduled sends unavailable for this account.",
		]);
		expect(screen.queryByLabelText("Proposal body")).toBeNull();
		expect(screen.queryByText(id(1), { exact: true })).toBeNull();
		expect(screen.queryByText(id(11), { exact: true })).toBeNull();
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		expect(inspect).not.toHaveBeenCalled();
	});

	it("checks foreign queue rows even when the lower queue would hide their state", () => {
		const pending = item(1);
		const foreignSent = item(2, { accountId: ACCOUNT_B, state: "SENT" });
		render(
			createElement(
				ReviewWorkspace,
				props({
					queue: {
						accountId: ACCOUNT_A,
						status: "ready",
						items: [pending, foreignSent],
						reviews: [review(pending)],
					},
				}),
			),
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"Approval queue unavailable for this account.",
		);
		expect(within(queue()).queryAllByRole("article")).toHaveLength(0);
		expect(screen.queryByLabelText("Proposal body")).toBeNull();
		expect(scheduledRow(id(11))).toBeTruthy();
	});

	it("checks foreign unscheduled rows before the lower schedule filters them out", () => {
		const input = props();
		input.scheduled = {
			...input.scheduled,
			items: [
				item(11, { state: "SCHEDULED", notBefore: NOT_BEFORE }),
				item(12, { accountId: ACCOUNT_B, notBefore: null }),
			],
		};
		render(createElement(ReviewWorkspace, input));
		expect(screen.getByRole("alert").textContent).toBe(
			"Scheduled sends unavailable for this account.",
		);
		expect(within(scheduled()).queryAllByRole("table")).toHaveLength(0);
		expect(screen.queryByText(id(11), { exact: true })).toBeNull();
		expect(screen.getByLabelText("Proposal body")).toBeTruthy();
	});

	it("withholds old empty feeds after a switch rather than claiming the new account is empty", () => {
		const old = props({ queue: { accountId: ACCOUNT_A, status: "ready", items: [], reviews: [] } });
		old.scheduled = { ...old.scheduled, items: [] };
		const rendered = render(createElement(ReviewWorkspace, old));
		expect(screen.getByText("No proposals awaiting approval")).toBeTruthy();
		expect(screen.getByText("No scheduled sends for this account.")).toBeTruthy();
		rendered.rerender(
			createElement(ReviewWorkspace, {
				...old,
				account: account({ id: ACCOUNT_B, alias: "dytest-personal" }),
			}),
		);
		expect(screen.getAllByRole("alert")).toHaveLength(2);
		expect(screen.queryByText("No proposals awaiting approval")).toBeNull();
		expect(screen.queryByText("No scheduled sends for this account.")).toBeNull();
		expect(within(queue()).queryAllByRole("article")).toHaveLength(0);
		expect(within(scheduled()).queryAllByRole("table")).toHaveLength(0);
	});

	it("accepts fresh matching feeds on rerender without retaining the old body or IDs", () => {
		const rendered = render(createElement(ReviewWorkspace, props()));
		const pending = item(2, { accountId: ACCOUNT_B });
		const next = props({
			account: account({ id: ACCOUNT_B, alias: "dytest-personal" }),
			queue: {
				accountId: ACCOUNT_B,
				status: "ready",
				items: [pending],
				reviews: [review(pending)],
			},
		});
		next.scheduled = {
			...next.scheduled,
			accountId: ACCOUNT_B,
			items: [
				item(12, {
					accountId: ACCOUNT_B,
					state: "SCHEDULED",
					notBefore: NOT_BEFORE,
				}),
			],
		};
		rendered.rerender(createElement(ReviewWorkspace, next));
		expect(screen.getByLabelText("Proposal body").textContent).toBe(`Frozen body ${pending.id}`);
		expect(screen.queryByText(id(1), { exact: true })).toBeNull();
		expect(screen.queryByText(id(11), { exact: true })).toBeNull();
		expect(scheduledRow(id(12))).toBeTruthy();
		expect(screen.getByRole("table", { name: "Scheduled sends for dytest-personal" })).toBeTruthy();
	});
});

describe("ReviewWorkspace feed states and intent controls", () => {
	it("keeps queue loading distinct from empty while the schedule remains visible", () => {
		render(
			createElement(ReviewWorkspace, props({ queue: { accountId: ACCOUNT_A, status: "loading" } })),
		);
		expect(screen.getByText("Loading approval queue.").getAttribute("role")).toBe("status");
		expect(screen.queryByText("No proposals awaiting approval")).toBeNull();
		expect(within(queue()).queryAllByRole("article")).toHaveLength(0);
		expect(scheduledRow(id(11))).toBeTruthy();
	});

	it("offers only a native retry button for the matching queue error", () => {
		const retry = vi.fn();
		const submit = vi.fn((event: FormEvent) => event.preventDefault());
		const input = props({ queue: { accountId: ACCOUNT_A, status: "error", onRetry: retry } });
		render(createElement("form", { onSubmit: submit }, createElement(ReviewWorkspace, input)));
		expect(screen.getByRole("alert").textContent).toBe("Approval queue could not be loaded.");
		const button = screen.getByRole("button", { name: "Retry approval queue" });
		expect(button.getAttribute("type")).toBe("button");
		button.focus();
		expect(document.activeElement).toBe(button);
		fireEvent.click(button, { detail: 0 });
		expect(retry).toHaveBeenCalledTimes(1);
		expect(submit).not.toHaveBeenCalled();
		expect(scheduledRow(id(11))).toBeTruthy();
	});

	it("suppresses an old account's retry action after selection changes", () => {
		const retry = vi.fn();
		render(
			createElement(
				ReviewWorkspace,
				props({ queue: { accountId: ACCOUNT_B, status: "error", onRetry: retry } }),
			),
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"Approval queue unavailable for this account.",
		);
		expect(screen.queryByRole("button", { name: "Retry approval queue" })).toBeNull();
		expect(scheduledRow(id(11))).toBeTruthy();
		expect(retry).not.toHaveBeenCalled();
	});

	it.each([
		["loading", "Loading scheduled sends."],
		["unavailable", "Scheduled sends are unavailable."],
	] as const)(
		"keeps a %s schedule distinct from empty without hiding the queue",
		(status, message) => {
			const inspect = vi.fn();
			const input = props();
			input.scheduled = { ...input.scheduled, status, onInspect: inspect };
			render(createElement(ReviewWorkspace, input));
			expect(within(scheduled()).getByText(message)).toBeTruthy();
			expect(screen.queryByText(id(11), { exact: true })).toBeNull();
			expect(screen.queryByText("No scheduled sends for this account.")).toBeNull();
			expect(screen.queryByRole("button", { name: "Inspect scheduled send" })).toBeNull();
			expect(screen.getByLabelText("Proposal body")).toBeTruthy();
			expect(inspect).not.toHaveBeenCalled();
		},
	);

	it("shows genuine ready-empty states only for matching feed scopes", () => {
		const input = props({ queue: { accountId: ACCOUNT_A, status: "ready", items: [] } });
		input.scheduled = { ...input.scheduled, items: [] };
		render(createElement(ReviewWorkspace, input));
		expect(within(queue()).getByText("No proposals awaiting approval")).toBeTruthy();
		expect(within(scheduled()).getByText("No scheduled sends for this account.")).toBeTruthy();
		expect(screen.queryAllByRole("alert")).toHaveLength(0);
	});

	it("forwards stale status, owner zone, persisted missed state, and scheduling limits", () => {
		const input = props();
		input.scheduled = {
			...input.scheduled,
			ownerZone: "America/Chicago",
			stale: true,
			scheduling: SchedulingStatus.parse({
				mode: "sidecar",
				scheduler: "unavailable",
				syncPaused: true,
			}),
			items: [
				item(11, { state: "NEEDS_REAPPROVAL", stateReason: "missed", notBefore: NOT_BEFORE }),
			],
		};
		render(createElement(ReviewWorkspace, input));
		expect(within(scheduled()).getByText("America/Chicago", { exact: true })).toBeTruthy();
		expect(within(scheduled()).getByText("Saved schedule data may be out of date.")).toBeTruthy();
		expect(within(scheduledRow(id(11))).getByText("Missed", { exact: true })).toBeTruthy();
		expect(
			within(scheduledRow(id(11))).getByText("Needs new approval", { exact: true }),
		).toBeTruthy();
		expect(
			within(scheduled()).getByText("Sidecar mode requires the app to remain open."),
		).toBeTruthy();
		expect(
			within(scheduled()).getByText("Sync is paused. This does not pause scheduled sends."),
		).toBeTruthy();
		expect(
			within(scheduled()).getByText(/Scheduling is unavailable; scheduled messages cannot be sent/),
		).toBeTruthy();
		expect(
			within(scheduled()).getByText("Changing a scheduled time requires fresh owner approval."),
		).toBeTruthy();
		expect(
			within(scheduledRow(id(11))).getByText(`${new Date(NOT_BEFORE).toISOString()} (UTC)`),
		).toBeTruthy();
	});

	it("emits exactly the original scheduled IDs for one mouse or keyboard-style activation", () => {
		const inspect = vi.fn();
		const submit = vi.fn((event: FormEvent) => event.preventDefault());
		const input = props();
		input.scheduled = { ...input.scheduled, stale: true, onInspect: inspect };
		render(createElement("form", { onSubmit: submit }, createElement(ReviewWorkspace, input)));
		const button = within(scheduledRow(id(11))).getByRole("button", {
			name: "Inspect scheduled send",
		});
		expect(button.getAttribute("type")).toBe("button");
		expect(inspect).not.toHaveBeenCalled();
		fireEvent.click(button);
		expect(inspect.mock.calls).toEqual([[{ outboxId: id(11), draftId: id(1011) }]]);
		button.focus();
		expect(document.activeElement).toBe(button);
		fireEvent.click(button, { detail: 0 });
		expect(inspect.mock.calls).toEqual([
			[{ outboxId: id(11), draftId: id(1011) }],
			[{ outboxId: id(11), draftId: id(1011) }],
		]);
		expect(submit).not.toHaveBeenCalled();
	});

	it("refuses unknown queue state without changing a valid schedule", () => {
		const invalid = { accountId: ACCOUNT_A, status: "invented" } as unknown as Props["queue"];
		render(createElement(ReviewWorkspace, props({ queue: invalid })));
		expect(screen.getByRole("alert").textContent).toBe(
			"Approval queue unavailable for this account.",
		);
		expect(scheduledRow(id(11))).toBeTruthy();
	});

	it("refuses malformed scheduling DATA without changing the valid queue", () => {
		const input = props();
		input.scheduled = {
			...input.scheduled,
			scheduling: { ...RUNNING, scheduler: "invented" } as unknown as SchedulingStatus,
		};
		render(createElement(ReviewWorkspace, input));
		expect(screen.getByRole("alert").textContent).toBe(
			"Scheduled sends unavailable for this account.",
		);
		expect(screen.getByLabelText("Proposal body")).toBeTruthy();
		expect(screen.queryByText(id(11), { exact: true })).toBeNull();
	});

	it("validates supplied schedule rows even while its loading state hides them", () => {
		const input = props();
		input.scheduled = {
			...input.scheduled,
			status: "loading",
			items: [{ ...item(11, { notBefore: NOT_BEFORE }), rev: 0 } as OutboxItem],
		};
		render(createElement(ReviewWorkspace, input));
		expect(screen.getByRole("alert").textContent).toBe(
			"Scheduled sends unavailable for this account.",
		);
		expect(screen.queryByText("Loading scheduled sends.")).toBeNull();
		expect(screen.getByLabelText("Proposal body")).toBeTruthy();
	});

	it("refuses a malformed retry callback instead of rendering a broken action", () => {
		const invalid = {
			accountId: ACCOUNT_A,
			status: "error",
			onRetry: "not-a-function",
		} as unknown as Props["queue"];
		render(createElement(ReviewWorkspace, props({ queue: invalid })));
		expect(screen.getByRole("alert").textContent).toBe(
			"Approval queue unavailable for this account.",
		);
		expect(screen.queryByRole("button", { name: "Retry approval queue" })).toBeNull();
		expect(scheduledRow(id(11))).toBeTruthy();
	});

	it("refuses unknown schedule status before exposing the inspect callback", () => {
		const inspect = vi.fn();
		const input = props();
		input.scheduled = {
			...input.scheduled,
			status: "invented",
			onInspect: inspect,
		} as unknown as Props["scheduled"];
		render(createElement(ReviewWorkspace, input));
		expect(screen.getByRole("alert").textContent).toBe(
			"Scheduled sends unavailable for this account.",
		);
		expect(screen.queryByRole("button", { name: "Inspect scheduled send" })).toBeNull();
		expect(screen.getByLabelText("Proposal body")).toBeTruthy();
		expect(inspect).not.toHaveBeenCalled();
	});
});

const execFileAsync = promisify(execFile);
const WEB_ROOT = fileURLToPath(new NodeURL("../..", import.meta.url));
const BROWSER_BUILD_SCRIPT = String.raw`
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const entry = resolve(root, "src/approvals/ReviewWorkspace.tsx");
let stage = "vite";
let injected = false;
let report;
try {
	const { build, mergeConfig } = await import("vite");
	stage = "config";
	const { default: webConfig } = await import(pathToFileURL(resolve(root, "vite.config.ts")).href);
	const config = mergeConfig(webConfig, {
		configFile: false,
		mode: "production",
		root,
		envDir: false,
		logLevel: "silent",
		build: {
			write: false,
			emptyOutDir: false,
			lib: { entry, formats: ["es"], fileName: "review-workspace" },
		},
	});
	if (process.argv[1] === "forbidden") {
		const forbiddenImport = {
			name: "dytest-forbidden-review-import",
			enforce: "pre",
			resolveId(id) {
				return id === "DYTEST_FORBIDDEN_IMPORT" ? { id, external: true } : null;
			},
			transform: {
				order: "pre",
				handler(code, id) {
					if (relative(entry, id) !== "") return null;
					injected = true;
					return { code: 'import "DYTEST_FORBIDDEN_IMPORT";\n' + code, map: null };
				},
			},
		};
		config.plugins = [forbiddenImport, ...(config.plugins ?? [])];
	}
	stage = "build";
	const result = await build(config);
	const outputs = Array.isArray(result) ? result : [result];
	const chunks = outputs.flatMap((output) => {
		if (!("output" in output)) throw new Error("DYTEST expected a completed browser build");
		return output.output.filter((output) => output.type === "chunk");
	});
	const compiledEntry = chunks.find((chunk) => chunk.isEntry &&
		chunk.facadeModuleId !== null && relative(entry, chunk.facadeModuleId) === "");
	if (compiledEntry === undefined) throw new Error("DYTEST missing the actual component entry");
	stage = "completed";
	report = {
		stage,
		outcome: "built",
		injected,
		guardRefused: false,
		entryExports: compiledEntry.exports,
		imports: [...new Set(chunks.flatMap((chunk) => chunk.imports))].sort(),
		dynamicImports: chunks.flatMap((chunk) => chunk.dynamicImports),
	};
} catch (error) {
	report = {
		stage,
		outcome: "rejected",
		injected,
		guardRefused: stage === "build" && error instanceof Error &&
			error.message.includes("Browser bundle contains an unexpected external import"),
	};
}
process.stdout.write(JSON.stringify(report));
`;

interface BrowserBuildReport {
	readonly stage: "vite" | "config" | "build" | "completed";
	readonly outcome: "built" | "rejected";
	readonly injected: boolean;
	readonly guardRefused: boolean;
	readonly entryExports?: readonly string[];
	readonly imports?: readonly string[];
	readonly dynamicImports?: readonly string[];
}

async function browserBuild(mode: "positive" | "forbidden"): Promise<BrowserBuildReport> {
	try {
		const { stdout } = await execFileAsync(
			process.execPath,
			["--input-type=module", "-e", BROWSER_BUILD_SCRIPT, mode],
			{
				cwd: WEB_ROOT,
				env: { ...process.env, NODE_ENV: "production" },
				encoding: "utf8",
				timeout: 25_000,
				maxBuffer: 64 * 1024,
				windowsHide: true,
				shell: false,
			},
		);
		return JSON.parse(stdout) as BrowserBuildReport;
	} catch {
		throw new Error("DYTEST browser build child did not complete");
	}
}

describe("ReviewWorkspace production browser graph", () => {
	it("compiles the actual component entry with the original React plugins and browser verifier", async () => {
		const result = await browserBuild("positive");
		expect(result.stage).toBe("completed");
		expect(result.outcome).toBe("built");
		expect(result.guardRefused).toBe(false);
		expect(result.injected).toBe(false);
		expect(result.entryExports).toContain("ReviewWorkspace");
		expect(result.imports).toEqual(["react", "react/compiler-runtime", "react/jsx-runtime"]);
		expect(result.dynamicImports).toEqual([]);
	}, 30_000);

	it("rejects a forbidden import injected into the actual entry through the unchanged verifier", async () => {
		const result = await browserBuild("forbidden");
		expect(result.stage).toBe("build");
		expect(result.outcome).toBe("rejected");
		expect(result.guardRefused).toBe(true);
		expect(result.injected).toBe(true);
	}, 30_000);
});
