import { expect, it } from "vitest";
import { cleanHtml } from "../src/html.ts";
import { buildDraftRequest } from "../src/prompt.ts";
import { cleanInWorker } from "../src/worker.ts";

const recovered = [
	["visibility", "visibility:hidden", "visibility:visible"],
	["initial visibility", "visibility:hidden", "visibility:initial"],
	["font size", "font-size:0", "font-size:16px"],
	["initial font size", "font-size:0", "font-size:initial"],
	["font shorthand", "font:0/1 serif", "font:16px/1 serif"],
] as const;

it.each(recovered)(
	"retains worker-visible child text after %s recovery",
	async (_label, parent, child) => {
		const source = `<span style='${parent}'>CANARY<span style='${child}'>Visible child</span>TAIL</span>`;
		const result = await cleanInWorker("html", source);
		expect(result).toEqual(cleanHtml(source));
		expect(result.text).toBe("Visible child");
		expect(result.removals.hidden).toBe(10);
		const prepared = buildDraftRequest({
			model: "synthetic-model",
			conversationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
			messages: [
				{
					id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
					conversationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
					body: result,
					direction: "inbound",
					dmarc: "pass",
				},
			],
		});
		expect(JSON.parse(prepared.request.prompt.split("\n")[2] ?? "")[0].text).toBe("Visible child");
		expect(prepared.request.prompt).not.toMatch(/CANARY|TAIL/);
	},
);

it.each([
	["visibility:hidden", "visibility:inherit"],
	["visibility:hidden", "visibility:unset"],
	["visibility:hidden", "color:black"],
	["font-size:0", "font-size:inherit"],
	["font-size:0", "font-size:unset"],
	["font-size:0", "font-size:100%"],
	["font-size:0", "font-size:2em"],
	["font-size:0", "font-size:calc(50% + 50%)"],
	["font-size:0", "color:black"],
])("retains zero/invisible inherited %s through %s", async (parent, child) => {
	const result = await cleanInWorker(
		"html",
		`<span style='${parent}'><span style='${child}'>CANARY</span></span>Visible`,
	);
	expect(result.text).toBe("Visible");
	expect(result.removals.hidden).toBe(6);
});

it.each(["display:none", "opacity:0", "content-visibility:hidden", "transform:scale(0)"])(
	"does not recover a subtree suppressed by %s",
	async (parent) => {
		const result = await cleanInWorker(
			"html",
			`<span style='${parent}'><a style='visibility:visible;font-size:16px' href='https://hidden.example'>CANARY</a></span>Visible`,
		);
		expect(result.text).toBe("Visible");
		expect(result.links).toEqual([]);
		expect(result.removals.hidden).toBe(6);
	},
);

it.each([
	"<span hidden><a style='visibility:visible;font-size:16px' href='https://hidden.example'>CANARY</a></span>Visible",
	"<details><summary>Visible</summary><a style='visibility:visible;font-size:16px' href='https://hidden.example'>CANARY</a></details>",
])("keeps intrinsic and closed-details suppression in a worker: %s", async (source) => {
	const result = await cleanInWorker("html", source);
	expect(result.text).toBe("Visible");
	expect(result.links).toEqual([]);
	expect(result.removals.hidden).toBe(6);
});

it.each(["visibility:hidden", "font-size:0"])(
	"aligns anchor annotation with inherited %s",
	async (parent) => {
		const source = `<span style='${parent}'><a href='https://hidden.example'>CANARY</a><a style='visibility:visible;font-size:16px' href='https://visible.example'>Visible</a></span>`;
		const result = await cleanInWorker("html", source);
		expect(result.text).toBe("Visible [link 1: visible.example]");
		expect(result.links).toEqual([{ index: 1, host: "visible.example" }]);
		expect(result.removals.hidden).toBe(6);
	},
);

it.each([
	"font:calc(0px)/1 sans-serif",
	"font:calc(1px - 1px)/1 serif",
	"font:italic calc(0px * 2)/1 serif",
	"--size:calc(1px - 1px);font:var(--size)/1 serif",
	"font-size:16px;font:0/1 serif",
	"font:0/1 serif!important;font-size:16px",
])("removes worker text for the actual zero font size in %s", async (style) => {
	const result = await cleanInWorker("html", `<span style='${style}'>CANARY</span>Visible`);
	expect(result.text).toBe("Visible");
	expect(result.removals.hidden).toBe(6);
});

it.each([
	"font:oblique 0deg 16px serif",
	"font:oblique calc(0deg) 16px serif",
	"font:16px/0 serif",
	"font:16px 'zero 0',serif",
	"font:calc(1px + 1px)/1 serif",
	"font:0/1 serif;font-size:16px",
	"font-size:16px!important;font:0/1 serif",
])("keeps worker text when the actual font size is visible in %s", async (style) => {
	const result = await cleanInWorker("html", `<span style="${style}">Visible</span>`);
	expect(result.text).toBe("Visible");
	expect(result.removals.hidden).toBe(0);
});

it.each([
	["visibility:hidden", "--v:bogus;visibility:var(--v)"],
	["visibility:hidden", "visibility:visible;--v:bogus;visibility:var(--v)"],
	["font-size:0", "--s:bogus;font-size:var(--s)"],
	["font-size:0", "font-size:16px;--s:bogus;font-size:var(--s)"],
	["font-size:0", "--s:bogus;font:var(--s)"],
	["font-size:0", "font:16px serif;--s:bogus;font:var(--s)"],
	["font-size:0", "--s:16deg;font-size:var(--s)"],
	["font-size:0", "font:16px serif;--s:16px;font:var(--s)"],
])("inherits %s when substituted child CSS is invalid: %s", async (parent, child) => {
	const result = await cleanInWorker(
		"html",
		`<span style='${parent}'><a style='${child}' href='https://hidden.example'>CANARY</a></span>Visible`,
	);
	expect(result.text).toBe("Visible");
	expect(result.links).toEqual([]);
	expect(result.removals.hidden).toBe(6);
	const prepared = buildDraftRequest({
		model: "synthetic-model",
		conversationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		messages: [
			{
				id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
				conversationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
				body: result,
				direction: "inbound",
				dmarc: "pass",
			},
		],
	});
	expect(JSON.parse(prepared.request.prompt.split("\n")[2] ?? "")[0].text).toBe("Visible");
	expect(prepared.request.prompt).not.toContain("CANARY");
});

it.each([
	["visibility:hidden", "visibility:hidden;--v:visible;visibility:var(--v)"],
	["font-size:0", "font-size:0;--s:16px;font-size:var(--s)"],
	["font-size:0", "font:0 serif;--s:16px/1 serif;font:var(--s)"],
	["visibility:visible", "visibility:hidden;--v:bogus;visibility:var(--v)"],
	["font-size:16px", "font-size:0;--s:bogus;font-size:var(--s)"],
	["font-size:16px", "font:0 serif;--s:bogus;font:var(--s)"],
])("keeps visible child text for computed %s and %s", async (parent, child) => {
	const result = await cleanInWorker(
		"html",
		`<span style='${parent}'><span style='${child}'>Visible</span></span>`,
	);
	expect(result.text).toBe("Visible");
	expect(result.removals.hidden).toBe(0);
});
