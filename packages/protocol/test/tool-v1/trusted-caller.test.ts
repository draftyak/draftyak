import { describe, expect, it, vi } from "vitest";
import {
	checkToolResult,
	type PresetContext,
	parseToolFrame,
	TOOL_FRAME_MAX_BYTES,
	type ToolResultOptions,
	validatePresetItem,
	validatePresets,
} from "../../src/tool-v1.ts";

const instance = "01JAZ3W3B6Q8M2V0G5T9K4X7RC";
const contact = {
	toolInstance: instance,
	kind: "contact.notes",
	bindings: { participant: { source: "participant.verifiedSender" } },
	onDemand: true,
	autoDraft: false,
};
const kb = {
	toolInstance: instance,
	kind: "kb.lookup",
	bindings: { topic: { source: "const", value: "faq" } },
	onDemand: true,
	autoDraft: false,
};
const notes = () => ({ notes: [{ label: "Account", text: "DYTEST prefers mornings." }] });
const complete = (structuredContent: unknown, rest: object = {}) => ({
	resultType: "complete",
	content: [],
	structuredContent,
	...rest,
});

describe("trusted caller options and mutable results", () => {
	it("returns a fresh mutable schema value for hygiene filtering", () => {
		const input = notes();
		const checked = checkToolResult("contact.notes", complete(input));
		expect(checked.status).toBe("ok");
		if (checked.status !== "ok") throw new Error("Expected valid notes");
		const [sent] = input.notes;
		const [kept] = checked.value.notes;
		if (!sent || !kept) throw new Error("Expected one note");
		sent.text = "changed caller text";
		expect(checked.value.notes[0]?.text).toBe("DYTEST prefers mornings.");
		kept.text = "cleaned text";
		expect(checked.value.notes[0]?.text).toBe("cleaned text");
	});
	it("reads class and inherited result options by ordinary property access", () => {
		class Options implements ToolResultOptions {
			readonly maxBytes = 1;
		}
		for (const options of [new Options(), Object.create({ maxBytes: 1 }) as ToolResultOptions])
			expect(checkToolResult("contact.notes", complete(notes()), options)).toEqual({
				status: "refused",
				refusal: "TOOL_RESULT_TOO_LARGE",
			});
	});
	it("keeps ignored content/meta fields separate from the structured-content byte ceiling", () => {
		for (const extra of [
			{ content: [{ type: "text", text: "x".repeat(70_000) }] },
			{ _meta: { ignored: "x".repeat(70_000), date: new Date(0) } },
			{ ignored: "x".repeat(70_000) },
		])
			expect(checkToolResult("contact.notes", complete(notes(), extra)).status).toBe("ok");
	});
	it("preserves the structured-content oversize refusal beside large ignored text", () => {
		expect(
			checkToolResult(
				"contact.notes",
				complete(
					{ notes: [{ label: "Account", text: "x".repeat(5_000) }] },
					{ content: [{ type: "text", text: "x".repeat(70_000) }] },
				),
			),
		).toEqual({ status: "refused", refusal: "TOOL_RESULT_TOO_LARGE" });
	});
	it("accepts byte subclasses and shared-backed frame views", () => {
		const bytes = new TextEncoder().encode('{"value":1}\n');
		class Frame extends Uint8Array {}
		const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
		shared.set(bytes);
		for (const frame of [new Frame(bytes), shared])
			expect(parseToolFrame(frame)).toEqual({ status: "ok", message: { value: 1 } });
	});
	it("drops definitely oversized text before computing its UTF-8 length", () => {
		const byteLength = vi.spyOn(Buffer, "byteLength").mockImplementation(() => {
			throw new Error("UTF8 length must not run");
		});
		try {
			expect(parseToolFrame("x".repeat(TOOL_FRAME_MAX_BYTES + 3))).toEqual({
				status: "dropped",
				reason: "TOOL_FRAME_TOO_LARGE",
			});
			expect(byteLength).not.toHaveBeenCalled();
		} finally {
			byteLength.mockRestore();
		}
	});
	it("keeps exact legal LF and CRLF frame neighbors", () => {
		const text = JSON.stringify("x".repeat(TOOL_FRAME_MAX_BYTES - 2));
		for (const suffix of ["", "\n", "\r\n"])
			expect(parseToolFrame(text + suffix).status).toBe("ok");
		expect(parseToolFrame(`${text}x\r\n`)).toEqual({
			status: "dropped",
			reason: "TOOL_FRAME_TOO_LARGE",
		});
	});
	it("accepts class, inherited and getter account channels", () => {
		class Account implements PresetContext {
			readonly channel = "gmail";
		}
		for (const context of [
			new Account(),
			Object.create({ channel: "gmail" }) as PresetContext,
			{
				get channel() {
					return "gmail" as const;
				},
			},
		])
			expect(validatePresetItem(contact, context).ok).toBe(true);
	});
	it("reports structural, participant-channel and default problems across both presets", () => {
		const checked = validatePresets(
			[
				{ id: instance, name: "First", isDefault: true, items: [{ ...kb, extra: true }] },
				{ id: "01JAZ3W3B6Q8M2V0G5T9K4X7RD", name: "Second", isDefault: true, items: [contact] },
			],
			{ channel: "sms" },
		);
		expect(checked.ok).toBe(false);
		if (checked.ok) throw new Error("Expected preset problems");
		expect(checked.problems).toEqual(
			expect.arrayContaining([
				{ code: "PRESET_INVALID", path: "0/items/0" },
				{ code: "PRESET_PARTICIPANT_CHANNEL", path: "1/items/0/bindings/participant" },
				{ code: "PRESETS_DEFAULT", path: "" },
			]),
		);
	});
	it("reports the preset count when the batch exceeds five presets", () => {
		const presets = Array.from({ length: 400 }, (_, at) => ({
			id: instance,
			name: `Preset ${at}`,
			isDefault: at === 0,
			items: [kb, kb, kb],
		}));
		const checked = validatePresets(presets, { channel: "gmail" });
		expect(checked.ok).toBe(false);
		if (checked.ok) throw new Error("Expected preset count refusal");
		expect(checked.problems).toContainEqual({ code: "PRESETS_TOO_MANY", path: "" });
	});
	it("retains the binding-field code and path for a lone-surrogate binding name", () => {
		const checked = validatePresetItem(
			{ ...kb, bindings: { "\ud800": { source: "const", value: "faq" } } },
			{ channel: "gmail" },
		);
		expect(checked.ok).toBe(false);
		if (checked.ok) throw new Error("Expected binding-field refusal");
		expect(checked.problems).toContainEqual({
			code: "PRESET_BINDING_FIELD",
			path: "bindings/\ud800",
		});
	});
});
