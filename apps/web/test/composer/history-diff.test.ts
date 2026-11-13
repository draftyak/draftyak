import { DraftContent, DraftRevision } from "@draftyak/protocol/entities/draft";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftHistory } from "../../src/composer/DraftHistory.tsx";
import { RevisionDiff } from "../../src/composer/RevisionDiff.tsx";

const DRAFT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const USER = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

function revision(rev: number, body: string): DraftRevision {
	return DraftRevision.parse({
		draftId: DRAFT,
		rev,
		author: { kind: "owner", id: USER },
		content: { channel: "chat", threadTs: null, broadcast: false, body },
		contentSha256: "a".repeat(64),
		flags: [],
		createdAt: rev,
	});
}

afterEach(() => cleanup());

describe("DraftHistory", () => {
	it("orders revisions without mutating the supplied list and emits only a revision selection", () => {
		const revisions = Object.freeze([
			revision(1, "Earlier"),
			revision(3, "Latest"),
			revision(2, "Middle"),
		]);
		const onSelectRevision = vi.fn();
		render(
			createElement(DraftHistory, { draftId: DRAFT, revisions, selectedRev: 3, onSelectRevision }),
		);
		const rows = within(screen.getByRole("list")).getAllByRole("button");
		expect(rows.map((row) => row.textContent)).toEqual(["Revision 3", "Revision 2", "Revision 1"]);
		expect(rows[0]?.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "Revision 1" }));
		expect(onSelectRevision).toHaveBeenCalledWith(1);
		expect(revisions.map((row) => row.rev)).toEqual([1, 3, 2]);
		expect(screen.queryByRole("button", { name: /approve|send/i })).toBeNull();
	});

	it.each([
		["another draft", [{ ...revision(1, "Wrong draft"), draftId: USER }]],
		["duplicate revision numbers", [revision(1, "First"), revision(1, "Second")]],
	] as const)("does not show a history for %s", (_name, revisions) => {
		render(
			createElement(DraftHistory, {
				draftId: DRAFT,
				revisions,
				selectedRev: 1,
				onSelectRevision: vi.fn(),
			}),
		);
		expect(screen.getByRole("alert").textContent).toBe("Revision history unavailable");
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("RevisionDiff", () => {
	it("marks exact removed and added Unicode scalars while preserving shared text", () => {
		render(
			createElement(RevisionDiff, {
				before: revision(1, "Start \u{1F600} old end"),
				after: revision(2, "Start \u{1F600} new end"),
			}),
		);
		const diff = screen.getByLabelText("Body changes");
		expect(diff.querySelector("del")?.textContent).toBe("old");
		expect(diff.querySelector("ins")?.textContent).toBe("new");
		expect(diff.textContent).toBe("Start \u{1F600} oldnew end");
	});

	it("renders markup and URLs as text in both sides of the diff", () => {
		const { container } = render(
			createElement(RevisionDiff, {
				before: revision(1, "<img src=x>"),
				after: revision(2, '<a href="https://example.invalid">open</a>'),
			}),
		);
		expect(container.querySelector("img,a,script,svg,iframe")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByLabelText("Body changes").textContent).toContain("https://example.invalid");
	});

	it("distinguishes non-body changes without treating object key order as a change", () => {
		const content = DraftContent.parse({
			channel: "email",
			to: ["first@example.invalid"],
			cc: [],
			bcc: [],
			subject: "Subject",
			body: "Same body",
			attachments: [],
		});
		const before = { ...revision(1, "Same body"), content };
		const after = {
			...revision(2, "Same body"),
			content: {
				attachments: content.channel === "email" ? content.attachments : [],
				body: "Same body",
				subject: "Subject",
				bcc: [],
				cc: [],
				to: ["first@example.invalid"],
				channel: "email" as const,
			},
		};
		const rendered = render(createElement(RevisionDiff, { before, after }));
		expect(screen.getByText("No body changes")).toBeDefined();
		expect(
			screen.queryByText("Recipients, subject, attachments or channel settings also changed."),
		).toBeNull();
		rendered.rerender(
			createElement(RevisionDiff, {
				before,
				after: { ...after, content: { ...after.content, to: ["second@example.invalid"] } },
			}),
		);
		expect(
			screen.getByText("Recipients, subject, attachments or channel settings also changed."),
		).toBeDefined();
	});

	it("does not compare content from different drafts", () => {
		render(
			createElement(RevisionDiff, {
				before: revision(1, "Before"),
				after: { ...revision(2, "After"), draftId: USER },
			}),
		);
		expect(screen.getByRole("alert").textContent).toBe("Revision comparison unavailable");
		expect(screen.queryByLabelText("Body changes")).toBeNull();
	});
});
