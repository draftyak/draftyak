import { expect, it } from "vitest";
import { buildDraftRequest } from "../src/prompt.ts";
import { parseMailInWorker } from "../src/worker.ts";

interface CascadeCase {
	label: string;
	parent: string;
	child: string;
	hidden: boolean;
	stylesheet?: string;
	parentClass?: string;
	token?: string;
}

async function mailBoundary({
	parent,
	child,
	hidden,
	stylesheet = "",
	parentClass = "wrapper",
	token = "CANARY",
}: CascadeCase): Promise<void> {
	const source = `${stylesheet ? `<style>${stylesheet}</style>` : ""}<span class='${parentClass}' style='${parent}'><a class='target' style='${child}' href='https://hidden.example/private?discard=1'>${token}</a></span> <a href='https://visible.example/private?discard=1'>Visible</a>`;
	const parsed = await parseMailInWorker(
		Buffer.from(
			[
				"From: Sender@example.test",
				"To: Owner@example.test",
				"Subject: Synthetic cascade boundary",
				"Authentication-Results: mx.google.com; dmarc=fail header.from=example.test",
				"MIME-Version: 1.0",
				"Content-Type: text/html; charset=utf-8",
				"Content-Transfer-Encoding: 8bit",
				"",
				source,
			].join("\r\n"),
		),
		{ provider: "gmail", ownerAddresses: ["Owner@example.test"] },
	);
	const conversationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
	const prepared = buildDraftRequest({
		model: "synthetic-model",
		conversationId,
		messages: [
			{
				id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
				conversationId,
				body: parsed.body,
				direction: parsed.direction,
				dmarc: parsed.auth.dmarc,
			},
		],
	});
	const text = hidden
		? "Visible [link 1: visible.example]"
		: `${token} [link 1: hidden.example] Visible [link 2: visible.example]`;
	const links = hidden
		? [{ index: 1, host: "visible.example" }]
		: [
				{ index: 1, host: "hidden.example" },
				{ index: 2, host: "visible.example" },
			];
	const thread = JSON.parse(prepared.request.prompt.split("\n")[2] ?? "null");
	expect({
		text: parsed.body.text,
		links: parsed.body.links,
		hidden: parsed.body.removals.hidden,
		direction: parsed.direction,
		auth: parsed.auth,
		thread,
		promptHasCanary: prepared.request.prompt.includes(token),
		promptHasHiddenHost: prepared.request.prompt.includes("hidden.example"),
	}).toEqual({
		text,
		links,
		hidden: stylesheet.length + (hidden ? token.length : 0),
		direction: "inbound",
		auth: { dmarc: "fail", reason: "dmarc-fail" },
		thread: [
			{
				id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
				direction: "inbound",
				dmarc: "fail",
				text,
			},
		],
		promptHasCanary: !hidden,
		promptHasHiddenHost: !hidden,
	});
	expect(prepared.request.prompt).not.toMatch(/https?:|\/private|discard=1/);
	expect(prepared.includedMessages).toBe(1);
}

const rollbacks = ["revert", "revert-layer"] as const;
const inheritedRollback: CascadeCase[] = rollbacks.flatMap((value) => [
	{
		label: `visibility ${value}`,
		parent: "visibility:hidden",
		child: `visibility:${value}`,
		hidden: true,
	},
	{ label: `font-size ${value}`, parent: "font-size:0", child: `font-size:${value}`, hidden: true },
	{ label: `font ${value}`, parent: "font-size:0", child: `font:${value}`, hidden: true },
]);

it.each([
	...inheritedRollback,
	{
		label: "mixed percent zero",
		parent: "font-size:0",
		child: "font-size:calc(100% + 0px)",
		hidden: true,
	},
	{
		label: "mixed em zero",
		parent: "font-size:0",
		child: "font-size:calc(1em + 0px)",
		hidden: true,
	},
])("removes inherited hidden mail text, links and prompt data for $label", mailBoundary);

it.each([
	...rollbacks.flatMap((value) => [
		{
			label: `visible visibility ${value}`,
			parent: "visibility:visible",
			child: `visibility:${value}`,
			hidden: false,
		},
		{
			label: `visible font-size ${value}`,
			parent: "font-size:16px",
			child: `font-size:${value}`,
			hidden: false,
		},
		{
			label: `visible font ${value}`,
			parent: "font-size:16px",
			child: `font:${value}`,
			hidden: false,
		},
	]),
	{
		label: "explicit visibility reset",
		parent: "visibility:hidden",
		child: "visibility:visible",
		hidden: false,
	},
	{
		label: "explicit font-size reset",
		parent: "font-size:0",
		child: "font-size:16px",
		hidden: false,
	},
	{ label: "explicit font reset", parent: "font-size:0", child: "font:16px serif", hidden: false },
	{
		label: "rem remains root-relative",
		parent: "font-size:0",
		child: "font-size:1rem",
		hidden: false,
	},
	{
		label: "mixed rem remains root-relative",
		parent: "font-size:0",
		child: "font-size:calc(1rem + 0px)",
		hidden: false,
	},
	{
		label: "mixed percentage positive",
		parent: "font-size:0",
		child: "font-size:calc(100% + 1px)",
		hidden: false,
	},
	{
		label: "mixed em positive",
		parent: "font-size:0",
		child: "font-size:calc(1em + 1px)",
		hidden: false,
	},
	{
		label: "mixed percentage visible parent",
		parent: "font-size:16px",
		child: "font-size:calc(100% + 0px)",
		hidden: false,
	},
	{
		label: "later visible visibility",
		parent: "visibility:hidden",
		child: "visibility:revert;visibility:visible",
		hidden: false,
	},
	{
		label: "later visible font-size",
		parent: "font-size:0",
		child: "font-size:revert;font-size:16px",
		hidden: false,
	},
])("retains visible mail text and link identity for $label", mailBoundary);

it.each([
	{
		label: "revert removes earlier same-origin sheet declaration",
		parent: "visibility:hidden",
		child: "visibility:revert",
		stylesheet: ".target{visibility:visible}",
		hidden: true,
	},
	{
		label: "revert-layer does not revive an earlier inline declaration",
		parent: "font-size:0",
		child: "font-size:16px;font-size:revert-layer",
		hidden: true,
	},
	{
		label: "lower layer hidden visibility",
		parent: "visibility:visible",
		child: "",
		stylesheet:
			"@layer base,top;@layer base{.target{visibility:hidden}}@layer top{.target{visibility:visible;visibility:revert-layer}}",
		hidden: true,
	},
	{
		label: "lower layer zero font size",
		parent: "font-size:16px",
		child: "",
		stylesheet:
			"@layer base,top;@layer base{.target{font-size:0}}@layer top{.target{font-size:16px;font-size:revert-layer}}",
		hidden: true,
	},
	{
		label: "lower layer visible visibility",
		parent: "visibility:hidden",
		child: "",
		stylesheet:
			"@layer base,top;@layer base{.target{visibility:visible}}@layer top{.target{visibility:hidden;visibility:revert-layer}}",
		hidden: false,
	},
	{
		label: "lower layer visible font size",
		parent: "font-size:0",
		child: "",
		stylesheet:
			"@layer base,top;@layer base{.target{font-size:16px}}@layer top{.target{font-size:0;font-size:revert-layer}}",
		hidden: false,
	},
	{
		label: "normal inline rollback discards hidden unlayered rule",
		parent: "visibility:visible",
		child: "visibility:revert-layer",
		stylesheet: ".target{visibility:hidden}",
		hidden: false,
	},
	{
		label: "normal inline rollback discards visible unlayered rule",
		parent: "visibility:hidden",
		child: "visibility:revert-layer",
		stylesheet: ".target{visibility:visible}",
		hidden: true,
	},
	{
		label: "important layers reverse precedence",
		parent: "visibility:visible",
		child: "",
		stylesheet:
			"@layer first,last;@layer first{.target{visibility:hidden!important}}@layer last{.target{visibility:visible!important}}",
		hidden: true,
	},
	{
		label: "important inline rollback retains important sheet hiding",
		parent: "visibility:visible",
		child: "visibility:revert-layer!important",
		stylesheet: ".target{visibility:hidden!important}",
		hidden: true,
	},
	{
		label: "important inline rollback retains important sheet visibility",
		parent: "visibility:hidden",
		child: "visibility:revert-layer!important",
		stylesheet: ".target{visibility:visible!important}",
		hidden: false,
	},
])("resolves the actual cascade before processing mail for $label", mailBoundary);

it.each([
	{
		label: "all-hidden conditional first-layer order",
		stylesheet:
			"@media (max-width:600px){@layer early;.x{visibility:hidden!important}} @layer other{.x{visibility:visible}} @layer early{.x{visibility:hidden}}",
		hidden: true,
	},
	{
		label: "visible-branch conditional first-layer order",
		stylesheet:
			"@media (max-width:600px){@layer early;} @layer other{.x{visibility:visible}} @layer early{.x{visibility:hidden}}",
		hidden: false,
	},
])("preserves conditional layer semantics for $label", async (testCase) => {
	await mailBoundary({
		...testCase,
		parent: "",
		child: "",
		parentClass: "x",
		token: "DYTEST-CANARY",
	});
});

it.each([
	{
		label: "initial uses hidden fallback",
		parent: "",
		child: "--gate:initial;visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "initial masks an inherited visible value",
		parent: "--gate:visible",
		child: "--gate:initial;visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "inherited computed hidden snapshot",
		parent: "--base:hidden;--gate:var(--base)",
		child: "--base:visible;visibility:var(--gate)",
		hidden: true,
	},
	{
		label: "missing property uses hidden fallback",
		parent: "",
		child: "visibility:var(--missing,hidden)",
		hidden: true,
	},
	{
		label: "missing property uses visible fallback",
		parent: "visibility:hidden",
		child: "visibility:var(--missing,visible)",
		hidden: false,
	},
	{
		label: "initial uses genuine visible fallback",
		parent: "visibility:hidden;--gate:hidden",
		child: "--gate:initial;visibility:var(--gate,visible)",
		hidden: false,
	},
	{
		label: "defined visible value does not use hidden fallback",
		parent: "visibility:hidden",
		child: "--gate:visible;visibility:var(--gate,hidden)",
		hidden: false,
	},
	{
		label: "inherited computed visible snapshot",
		parent: "--base:visible;--gate:var(--base)",
		child: "--base:hidden;visibility:var(--gate)",
		hidden: false,
	},
	{
		label: "explicit child value replaces inherited computed value",
		parent: "--base:hidden;--gate:var(--base)",
		child: "--base:visible;--gate:visible;visibility:var(--gate)",
		hidden: false,
	},
	{
		label: "local alias resolves after collecting all declarations",
		parent: "--base:hidden",
		child: "--gate:var(--base);--base:visible;visibility:var(--gate)",
		hidden: false,
	},
])("preserves custom property mail boundary for $label", mailBoundary);

it.each([
	{
		label: "generated initial uses hidden fallback",
		parent: "",
		child: "--gate:var(--missing,initial);visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "generated initial masks an inherited visible value",
		parent: "--gate:visible",
		child: "--gate:var(--missing,initial);visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "consuming initial fallback resets inherited hidden visibility",
		parent: "visibility:hidden",
		child: "visibility:var(--missing,initial)",
		hidden: false,
	},
])("preserves generated custom property mail boundary for $label", mailBoundary);
