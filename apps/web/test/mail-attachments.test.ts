import type { ParsedMail } from "@draftyak/content/mail";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailAttachments } from "../src/conversation/MailAttachments.tsx";

type Attachment = ParsedMail["attachments"][number];
function attachment(overrides: Partial<Attachment> = {}): Attachment {
	return {
		filename: "DYTEST-report.txt",
		mimeType: "text/plain",
		size: 23,
		sha256: "a".repeat(64),
		...overrides,
	};
}
function deferred() {
	let resolve!: () => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const buttons = () =>
	screen.getAllByRole<HTMLButtonElement>("button", { name: /^Download attachment/ });
function button(index: number): HTMLButtonElement {
	const element = buttons()[index];
	if (element === undefined) throw new Error("Expected attachment download button");
	return element;
}
afterEach(cleanup);

describe("MailAttachments", () => {
	it("renders hostile filenames and MIME labels as literal text without active content", () => {
		const filename = '<img src="https://example.invalid/DYTEST" onerror="alert(1)">';
		const mimeType = '<iframe src="https://example.invalid/DYTEST">';
		const { container } = render(
			createElement(MailAttachments, {
				attachments: [attachment({ filename, mimeType })],
			}),
		);
		expect(screen.getByText(filename).tagName).toBe("BDI");
		expect(container.textContent).toContain(mimeType);
		expect(
			container.querySelector("img,iframe,a,script,object,embed,form,input,[src],[href],[onerror]"),
		).toBeNull();
		expect(container.textContent).not.toContain("a".repeat(64));
		expect(buttons()[0]?.disabled).toBe(true);
	});

	it("passes only the zero-based attachment index after an explicit user action", async () => {
		const request = vi.fn<(index: number) => void>();
		render(
			createElement(MailAttachments, {
				attachments: [attachment(), attachment({ filename: "DYTEST-second.txt" })],
				requestDownload: request,
			}),
		);
		expect(request).not.toHaveBeenCalled();
		fireEvent.click(button(1));
		await act(async () => {});
		expect(request.mock.calls).toEqual([[1]]);
		fireEvent.click(button(0));
		await act(async () => {});
		expect(request.mock.calls).toEqual([[1], [0]]);
	});

	it("keeps downloads unavailable when the host supplies no download intent", () => {
		render(createElement(MailAttachments, { attachments: [attachment()] }));
		expect(screen.getByText("Attachment downloads are unavailable.")).toBeDefined();
		expect(buttons()[0]?.disabled).toBe(true);
	});

	it("renders nothing for an empty attachment list", () => {
		const { container } = render(createElement(MailAttachments, { attachments: [] }));
		expect(container.childElementCount).toBe(0);
	});

	it("retains unnamed, empty and maximum-size metadata without inventing a file URL", () => {
		const { filename: _filename, ...unnamed } = attachment({ size: 0 });
		const { container } = render(
			createElement(MailAttachments, {
				attachments: [unnamed, attachment({ filename: "", size: 35 * 1_048_576 })],
			}),
		);
		expect(screen.getByText("Attachment 1")).toBeDefined();
		expect(screen.getByText("Attachment 2")).toBeDefined();
		expect(container.textContent).toContain("0 bytes");
		expect(container.textContent).toContain("36700160 bytes");
		expect(container.querySelector("a,[download],[href],[src]")).toBeNull();
	});

	it.each([
		["non-array", null],
		["too many rows", Array.from({ length: 101 }, () => attachment())],
		["invalid filename type", [{ ...attachment(), filename: 7 }]],
		["oversized filename", [attachment({ filename: "x".repeat(2049) })]],
		["malformed filename", [attachment({ filename: "\ud800" })]],
		["invalid MIME type", [{ ...attachment(), mimeType: null }]],
		["oversized MIME type", [attachment({ mimeType: "x".repeat(256) })]],
		["malformed MIME type", [attachment({ mimeType: "\ud800" })]],
		["negative size", [attachment({ size: -1 })]],
		["fractional size", [attachment({ size: 1.5 })]],
		["infinite size", [attachment({ size: Number.POSITIVE_INFINITY })]],
		["oversized file", [attachment({ size: 35 * 1_048_576 + 1 })]],
		["short digest", [attachment({ sha256: "a".repeat(63) })]],
		["non-hex digest", [attachment({ sha256: "z".repeat(64) })]],
	] as const)("withholds the complete list for %s", (_name, value) => {
		const request = vi.fn();
		render(
			createElement(MailAttachments, {
				attachments: value as unknown as ParsedMail["attachments"],
				requestDownload: request,
			}),
		);
		expect(screen.getByRole("alert").textContent).toBe("Attachment metadata unavailable");
		expect(screen.queryByRole("button")).toBeNull();
		expect(request).not.toHaveBeenCalled();
	});

	it("withholds the list when metadata access throws without exposing the exception", () => {
		const row = attachment();
		Object.defineProperty(row, "filename", {
			get() {
				throw new Error("DYTEST-private-error");
			},
		});
		render(createElement(MailAttachments, { attachments: [row] }));
		expect(screen.getByRole("alert").textContent).toBe("Attachment metadata unavailable");
		expect(document.body.textContent).not.toContain("DYTEST-private-error");
	});

	it("blocks a synchronous reentrant second download", async () => {
		const pending = deferred();
		let reentered = false;
		const request = vi.fn((_index: number) => {
			if (!reentered) {
				reentered = true;
				button(1).click();
			}
			return pending.promise;
		});
		render(
			createElement(MailAttachments, {
				attachments: [attachment(), attachment({ filename: "DYTEST-second.txt" })],
				requestDownload: request,
			}),
		);
		fireEvent.click(button(0));
		expect(request.mock.calls).toEqual([[0]]);
		expect(buttons().every((button) => button.disabled)).toBe(true);
		await act(async () => {
			pending.resolve();
		});
		expect(buttons().every((button) => !button.disabled)).toBe(true);
	});

	it("keeps every download disabled until the outstanding request settles", async () => {
		const pending = deferred();
		const request = vi.fn(() => pending.promise);
		render(
			createElement(MailAttachments, {
				attachments: [attachment(), attachment()],
				requestDownload: request,
			}),
		);
		fireEvent.click(button(0));
		fireEvent.click(button(1));
		expect(request.mock.calls).toEqual([[0]]);
		expect(screen.getByRole("status").textContent).toBe("Requesting attachment download");
		await act(async () => {
			pending.reject(new Error("DYTEST-private-failure"));
		});
		expect(screen.getByRole("alert").textContent).toBe(
			"The attachment download could not be requested.",
		);
		expect(document.body.textContent).not.toContain("DYTEST-private-failure");
		expect(buttons().every((button) => !button.disabled)).toBe(true);
	});

	it("handles a synchronous host refusal with fixed text and permits a later attempt", async () => {
		const request = vi.fn((_index: number) => {
			throw new Error("DYTEST-private-refusal");
		});
		render(
			createElement(MailAttachments, { attachments: [attachment()], requestDownload: request }),
		);
		fireEvent.click(button(0));
		expect(screen.getByRole("alert").textContent).toBe(
			"The attachment download could not be requested.",
		);
		expect(document.body.textContent).not.toContain("DYTEST-private-refusal");
		expect(buttons()[0]?.disabled).toBe(false);
		fireEvent.click(button(0));
		await act(async () => {});
		expect(request.mock.calls).toEqual([[0], [0]]);
	});

	it("ignores an old callback rejection after the host binding changes", async () => {
		const old = deferred(),
			fresh = deferred();
		const rows = [attachment()];
		const first = vi.fn(() => old.promise),
			second = vi.fn(() => fresh.promise);
		const view = render(
			createElement(MailAttachments, { attachments: rows, requestDownload: first }),
		);
		fireEvent.click(button(0));
		view.rerender(createElement(MailAttachments, { attachments: rows, requestDownload: second }));
		fireEvent.click(button(0));
		await act(async () => {
			old.reject(new Error("DYTEST-old-refusal"));
		});
		expect(screen.queryByRole("alert")).toBeNull();
		expect(buttons()[0]?.disabled).toBe(true);
		expect(first.mock.calls).toEqual([[0]]);
		expect(second.mock.calls).toEqual([[0]]);
		await act(async () => {
			fresh.resolve();
		});
		expect(buttons()[0]?.disabled).toBe(false);
	});

	it("discards old request feedback when a different message attachment list arrives", async () => {
		const old = deferred();
		const request = vi.fn(() => old.promise);
		const view = render(
			createElement(MailAttachments, { attachments: [attachment()], requestDownload: request }),
		);
		fireEvent.click(button(0));
		view.rerender(
			createElement(MailAttachments, {
				attachments: [attachment({ filename: "DYTEST-next-message.txt" })],
				requestDownload: request,
			}),
		);
		await act(async () => {
			old.reject(new Error("DYTEST-old-refusal"));
		});
		expect(screen.getByText("DYTEST-next-message.txt")).toBeDefined();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(buttons()[0]?.disabled).toBe(false);
	});

	it("keeps the displayed metadata snapshot stable when its source objects mutate", () => {
		const row = attachment(),
			rows = [row];
		const view = render(createElement(MailAttachments, { attachments: rows }));
		Object.defineProperty(row, "filename", { value: "DYTEST-mutated.txt" });
		rows.push(attachment({ filename: "DYTEST-inserted.txt" }));
		view.rerender(createElement(MailAttachments, { attachments: rows }));
		expect(screen.getByText("DYTEST-report.txt")).toBeDefined();
		expect(screen.queryByText("DYTEST-mutated.txt")).toBeNull();
		expect(screen.queryByText("DYTEST-inserted.txt")).toBeNull();
		expect(buttons()).toHaveLength(1);
	});
});
