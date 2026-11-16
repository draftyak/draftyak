import type { ContentErrorCode } from "@draftyak/content/limits";
import type { ParsedMail } from "@draftyak/content/mail";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageBody } from "../src/conversation/MessageBody.tsx";

function content(text: string): Pick<ParsedMail, "body" | "bodyRefusal"> {
	return {
		body: {
			text,
			removals: { hidden: 0, invisible: 0, quoted: 0, truncated: 0, uris: 0 },
			links: [],
			suspectedInstructions: false,
		},
	};
}

afterEach(cleanup);

describe("MessageBody", () => {
	it("keeps hostile markup and link annotations as text without active elements", () => {
		const hostile =
			'<img src="https://example.invalid/pixel" onerror="window.open()"><script>fetch("/leak")</script>';
		const parsed = content(hostile);
		parsed.body.links = [{ index: 1, host: '<iframe src="https://example.invalid/"></iframe>' }];
		const { container } = render(createElement(MessageBody, { content: parsed }));
		expect(screen.getByText(hostile).tagName).toBe("PRE");
		expect(screen.getByText('[1] <iframe src="https://example.invalid/"></iframe>')).toBeDefined();
		expect(
			container.querySelector("img,script,iframe,a,object,embed,form,style,link,base"),
		).toBeNull();
		expect(container.querySelector("[src],[href],[onerror]")).toBeNull();
	});

	it.each<ContentErrorCode>([
		"INPUT_LIMIT",
		"OUTPUT_LIMIT",
		"STRUCTURE_LIMIT",
		"INVALID_INPUT",
		"TIMEOUT",
		"STARTUP_TIMEOUT",
		"ABORTED",
		"BUSY",
		"WORKER_FAILED",
	])("withholds all body data when the parser refuses it with %s", (bodyRefusal) => {
		const parsed = content("DYTEST_WITHHELD_BODY");
		parsed.body.links = [{ index: 1, host: "DYTEST_WITHHELD_HOST" }];
		render(createElement(MessageBody, { content: { ...parsed, bodyRefusal } }));
		expect(screen.getByRole("alert").textContent).toContain("The body has been withheld.");
		expect(document.body.textContent).not.toContain("DYTEST_WITHHELD_BODY");
		expect(document.body.textContent).not.toContain("DYTEST_WITHHELD_HOST");
	});

	it("uses a fixed refusal for an unrecognized runtime code", () => {
		const bodyRefusal = '<img src="https://example.invalid/">' as ContentErrorCode;
		render(createElement(MessageBody, { content: { ...content("DYTEST_WITHHELD"), bodyRefusal } }));
		expect(screen.getByRole("alert").textContent).toBe(
			"The message body is unavailable. The body has been withheld.",
		);
		expect(document.body.textContent).not.toContain(bodyRefusal);
		expect(document.querySelector("img")).toBeNull();
	});

	it("discloses every actual removal category and suspected instructions", () => {
		const parsed = content("DYTEST visible body");
		parsed.body.removals = { hidden: 1, invisible: 2, quoted: 3, truncated: 4, uris: 5 };
		parsed.body.suspectedInstructions = true;
		render(createElement(MessageBody, { content: parsed }));
		expect(screen.getByLabelText("Content warning")).toBeDefined();
		for (const label of [
			"Hidden content",
			"Invisible characters",
			"Quoted history",
			"Truncated content",
			"Embedded resources",
		]) {
			expect(screen.getByText(label)).toBeDefined();
		}
		expect(Array.from(document.querySelectorAll("dd"), (node) => node.textContent)).toEqual([
			"1",
			"2",
			"3",
			"4",
			"5",
		]);
		expect(screen.getByText("DYTEST visible body")).toBeDefined();
	});

	it("shows an explicit empty body without claiming that content was removed", () => {
		render(createElement(MessageBody, { content: content("") }));
		expect(screen.getByText("This message has no displayable body.")).toBeDefined();
		expect(screen.queryByText("Removed content")).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("clears the previous body and annotations when the selected content becomes refused", () => {
		const parsed = content("DYTEST previous message");
		parsed.body.links = [{ index: 1, host: "previous.example.invalid" }];
		const view = render(createElement(MessageBody, { content: parsed }));
		view.rerender(
			createElement(MessageBody, {
				content: { ...content("DYTEST withheld next"), bodyRefusal: "OUTPUT_LIMIT" },
			}),
		);
		expect(screen.getByRole("alert")).toBeDefined();
		expect(document.body.textContent).not.toContain("DYTEST previous message");
		expect(document.body.textContent).not.toContain("previous.example.invalid");
		expect(document.body.textContent).not.toContain("DYTEST withheld next");
		expect(document.querySelector("pre")).toBeNull();
	});
});
