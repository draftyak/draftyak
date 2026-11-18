import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlagList } from "../../src/composer/FlagList.tsx";

const CATALOGUE = [
	["NEW_RECIPIENT", "ack", "New recipient"],
	["RECIPIENT_ADDED_BY_AGENT", "ack", "Recipient added by automation"],
	["REPLY_TO_REDIRECT", "ack", "Reply-To redirects the reply"],
	["AGENT_AUTHORED", "ack", "Draft created by automation"],
	["DMARC_FAIL", "ack", "DMARC check failed"],
	["EXTERNAL_LINK", "ack", "External link"],
	["AGENT_INSERTED_CONTACT", "ack", "Contact added by automation"],
	["ATTACHMENT_ADDED_BY_AGENT", "ack", "Attachment added by automation"],
	["INVISIBLE_CHARS", "ack", "Invisible characters"],
	["MASS_MENTION", "ack", "Mass mention"],
	["CROSS_THREAD_DATA", "ack", "Data from another conversation"],
	["SECRET_PATTERN", "ack", "Potential secret"],
	["SUSPECTED_INSTRUCTIONS", "advisory", "Suspected instructions"],
	["TOOL_DATA_IN_BODY", "ack", "Tool data in draft"],
	["TOOL_CONTEXT_USED", "info", "Tool context used"],
	["TOOL_INSTRUCTIONS", "advisory", "Instructions in tool data"],
] as const;

const SEVERITY_TEXT = {
	ack: "Acknowledgement required",
	info: "Information",
	advisory: "Advisory warning",
} as const;
const VALID = { code: "NEW_RECIPIENT", severity: "ack" };
const view = (flags: unknown) => createElement(FlagList, { flags });

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("FlagList", () => {
	it("shows an empty state distinct from invalid data", () => {
		render(view([]));
		expect(screen.getByText("No flags").textContent).toBe("No flags");
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("listitem")).toBeNull();
	});

	it.each(CATALOGUE)("shows %s with its fixed label and severity", (code, severity, label) => {
		render(view([{ code, severity }]));
		const list = screen.getByRole("list", { name: "Flags" });
		expect(list.tagName).toBe("UL");
		const rows = within(list).getAllByRole("listitem");
		expect(rows).toHaveLength(1);
		const row = rows[0];
		if (!row) throw new Error("Expected a flag row");
		expect(within(row).getByText(code, { exact: true })).toBeDefined();
		expect(within(row).getByText(label, { exact: true })).toBeDefined();
		expect(within(row).getByText(SEVERITY_TEXT[severity], { exact: true })).toBeDefined();
	});

	it("shows the complete catalogue including both lower severities", () => {
		render(view(CATALOGUE.map(([code, severity]) => ({ code, severity }))));
		const list = screen.getByRole("list", { name: "Flags" });
		expect(within(list).getAllByRole("listitem")).toHaveLength(16);
		expect(within(list).getAllByText("Acknowledgement required")).toHaveLength(13);
		expect(within(list).getAllByText("Information")).toHaveLength(1);
		expect(within(list).getAllByText("Advisory warning")).toHaveLength(2);
	});

	const invalidInputs: ReadonlyArray<readonly [string, unknown]> = [
		["null", null],
		["undefined", undefined],
		["an object instead of a list", { flags: [] }],
		["a non-object row", [VALID, "NEW_RECIPIENT"]],
		["an unknown code", [VALID, { code: "FUTURE_FLAG", severity: "ack" }]],
		["a wrong severity", [VALID, { code: "DMARC_FAIL", severity: "info" }]],
		["a missing severity", [VALID, { code: "EXTERNAL_LINK" }]],
		["an extra member", [VALID, { ...VALID, unexpectedMember: true }]],
		["duplicate flags without detail", [VALID, { ...VALID }]],
		[
			"duplicate flags with detail",
			[
				{ ...VALID, detail: "same" },
				{ ...VALID, detail: "same" },
			],
		],
		["empty detail", [VALID, { ...VALID, detail: "" }]],
		["non-string detail", [VALID, { ...VALID, detail: 123 }]],
		["a lone high surrogate", [VALID, { ...VALID, detail: "\uD800" }]],
		["a lone low surrogate", [VALID, { ...VALID, detail: "\uDC00" }]],
		["over 1000 Unicode scalars", [VALID, { ...VALID, detail: "😀".repeat(1001) }]],
	];

	it.each(invalidInputs)("refuses the whole list for %s", (_name, flags) => {
		render(view(flags));
		expect(screen.getByRole("alert").textContent).toBe("Flags unavailable");
		expect(screen.queryByRole("list")).toBeNull();
		expect(screen.queryByRole("listitem")).toBeNull();
		expect(screen.queryByText("No flags")).toBeNull();
		expect(screen.queryByText("New recipient", { exact: true })).toBeNull();
	});

	it("accepts the same code with genuinely different details", () => {
		render(
			view([VALID, { ...VALID, detail: "first detail" }, { ...VALID, detail: "second detail" }]),
		);
		expect(
			within(screen.getByRole("list", { name: "Flags" })).getAllByRole("listitem"),
		).toHaveLength(3);
		expect(screen.getByText("first detail")).toBeDefined();
		expect(screen.getByText("second detail")).toBeDefined();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("preserves 1000 astral Unicode scalars", () => {
		const detail = "😀".repeat(1000);
		render(view([{ ...VALID, detail }]));
		expect(screen.getByText(detail, { exact: true }).textContent).toBe(detail);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("renders hostile markup and URLs only as text", () => {
		const detail = '<img src=x onerror="alert(1)"><a href="https://example.invalid">open</a>';
		const { container } = render(view([{ ...VALID, detail }]));
		expect(screen.getByText(detail, { exact: true }).textContent).toBe(detail);
		expect(container.querySelector("img,a,script,svg,iframe,object")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
	});

	const invisibleCases = [
		["bidi override", "\u202E", "\\u{202E}"],
		["format character", "\u2060", "\\u{2060}"],
		["zero-width joiner", "\u200D", "\\u{200D}"],
		["default ignorable", "\u034F", "\\u{034F}"],
		["variation selector", "\uFE0F", "\\u{FE0F}"],
		["supplementary variation selector", "\u{E0100}", "\\u{E0100}"],
		["non-breaking space", "\u00A0", "\\u{00A0}"],
		["narrow non-breaking space", "\u202F", "\\u{202F}"],
		["line separator", "\u2028", "\\u{2028}"],
		["control character", "\u0000", "\\u{0000}"],
	] as const;

	it.each(invisibleCases)("makes %s visible", (_name, character, escaped) => {
		render(view([{ ...VALID, detail: `left${character}right` }]));
		const text = screen.getByRole("list", { name: "Flags" }).textContent ?? "";
		expect(text).toContain(`left${escaped}right`);
		expect(text).not.toContain(character);
	});

	it("distinguishes actual invisible characters from escape-looking text", () => {
		render(
			view([
				{ ...VALID, detail: "\u202E" },
				{ ...VALID, detail: "\\u{202E}" },
			]),
		);
		expect(screen.getByText("\\u{202E}", { exact: true }).textContent).toBe("\\u{202E}");
		expect(screen.getByText("\\\\u{202E}", { exact: true }).textContent).toBe("\\\\u{202E}");
	});

	it("does not mutate frozen input", () => {
		const flag = Object.freeze({ ...VALID, detail: "unchanged detail" });
		const flags = Object.freeze([flag]);
		render(view(flags));
		expect(screen.getByText("unchanged detail")).toBeDefined();
		expect(flags).toEqual([{ ...VALID, detail: "unchanged detail" }]);
	});

	it("removes accepted rows when rerendered with invalid data", () => {
		const rendered = render(view([{ ...VALID, detail: "previous detail" }]));
		expect(screen.getByText("previous detail")).toBeDefined();
		rendered.rerender(view([{ code: "FUTURE_FLAG", severity: "ack" }]));
		expect(screen.getByRole("alert").textContent).toBe("Flags unavailable");
		expect(screen.queryByRole("list")).toBeNull();
		expect(screen.queryByText("previous detail")).toBeNull();
	});

	it("has no editing, acknowledgement, approval, link or network controls", () => {
		const forbiddenNetwork = vi.fn(() => {
			throw new Error("Unexpected network operation");
		});
		vi.stubGlobal("fetch", forbiddenNetwork);
		vi.stubGlobal("XMLHttpRequest", forbiddenNetwork);
		vi.stubGlobal("WebSocket", forbiddenNetwork);
		const { container, rerender } = render(
			view(CATALOGUE.map(([code, severity]) => ({ code, severity }))),
		);
		expect(container.querySelector("input,button,a,form,textarea,select")).toBeNull();
		expect(screen.queryByRole("checkbox")).toBeNull();
		rerender(view([]));
		expect(forbiddenNetwork).not.toHaveBeenCalled();
	});
});
