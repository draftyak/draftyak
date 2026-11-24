import { beforeAll, expect, it } from "vitest";
import type { ParsedMail } from "../src/mail.ts";
import { buildDraftRequest } from "../src/prompt.ts";
import { parseMailInWorker } from "../src/worker.ts";

const conversationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const firstId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const secondId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const canary = "DYTEST-CANARY";
const evidence = { provider: "gmail", ownerAddresses: ["Owner@example.test"] } as const;

function mail(body: string, html: boolean, ownerFrom: boolean): Buffer {
	return Buffer.from(
		[
			`From: ${ownerFrom ? "Owner" : "Sender"}@example.test`,
			"To: Receiver@example.test",
			"Subject: Synthetic comment and font range",
			`Authentication-Results: mx.google.com; dmarc=${ownerFrom ? "pass" : "fail"} header.from=example.test`,
			"MIME-Version: 1.0",
			`Content-Type: ${html ? "text/html" : "text/plain"}; charset=utf-8`,
			"Content-Transfer-Encoding: 8bit",
			"",
			body,
		].join("\r\n"),
	);
}

let previous: ParsedMail;
beforeAll(async () => {
	previous = await parseMailInWorker(mail("Earlier synthetic message.", false, false), evidence);
	expect(previous.body.text).toBe("Earlier synthetic message.");
	expect(previous.auth).toEqual({ dmarc: "fail", reason: "dmarc-fail" });
	expect(previous.direction).toBe("inbound");
});

interface Case {
	readonly label: string;
	readonly parent: string;
	readonly child: string;
	readonly hidden: boolean;
}

async function assertThread({ parent, child, hidden }: Case): Promise<void> {
	const source = `<span style='${parent}'><a style='${child}' href='https://hidden.example/DYTEST-private?discard=1'>${canary}</a></span> <a href='https://visible.example/DYTEST-private?discard=1'>Visible</a>`;
	const parsed = await parseMailInWorker(mail(source, true, true), evidence);
	const prepared = buildDraftRequest({
		model: "synthetic-model",
		conversationId,
		messages: [
			{
				id: firstId,
				conversationId,
				body: previous.body,
				direction: previous.direction,
				dmarc: previous.auth.dmarc,
			},
			{
				id: secondId,
				conversationId,
				body: parsed.body,
				direction: parsed.direction,
				dmarc: parsed.auth.dmarc,
			},
		],
	});
	const expected = hidden
		? "Visible [link 1: visible.example]"
		: `${canary} [link 1: hidden.example] Visible [link 2: visible.example]`;
	expect(parsed.bodyRefusal).toBeUndefined();
	expect(parsed.body.text).toBe(expected);
	expect(parsed.body.links).toEqual(
		hidden
			? [{ index: 1, host: "visible.example" }]
			: [
					{ index: 1, host: "hidden.example" },
					{ index: 2, host: "visible.example" },
				],
	);
	expect(parsed.body.removals.hidden).toBe(hidden ? canary.length : 0);
	expect(parsed.auth).toEqual({
		dmarc: "pass",
		verifiedSender: "Owner@example.test",
		reason: "verified",
	});
	// An owner-looking From and successful DMARC are not observed send evidence.
	expect(parsed.direction).toBe("inbound");
	expect(JSON.parse(prepared.request.prompt.split("\n")[2] ?? "null")).toEqual([
		{ id: firstId, direction: "inbound", dmarc: "fail", text: "Earlier synthetic message." },
		{ id: secondId, direction: "inbound", dmarc: "pass", text: expected },
	]);
	expect(prepared.request.prompt.includes(canary)).toBe(!hidden);
	expect(prepared.request.prompt.includes("hidden.example")).toBe(!hidden);
	expect(prepared.request.prompt).toContain("visible.example");
	expect(prepared.request.prompt).not.toMatch(/https?:|DYTEST-private|discard=1/);
	expect(prepared.includedMessages).toBe(2);
	expect(prepared.omittedMessages).toBe(0);
	expect(prepared.truncatedCharacters).toBe(0);
}

const hidden: readonly Case[] = [
	{
		label: "negative percentage with a zero parent",
		parent: "font-size:0",
		child: "font-size:calc(100% - 2px)",
		hidden: true,
	},
	{
		label: "negative em with a zero parent",
		parent: "font-size:0",
		child: "font-size:calc(2em - 1px)",
		hidden: true,
	},
	{
		label: "negative calculated font shorthand",
		parent: "font-size:0",
		child: "font:italic calc(1em - 1px)/1 serif",
		hidden: true,
	},
	{
		label: "negative absolute calculated length",
		parent: "font-size:16px",
		child: "font-size:calc(0px - 3px)",
		hidden: true,
	},
	{
		label: "nested negative percentage calculation",
		parent: "font-size:0",
		child: "font-size:calc((25% + 75%) - 1px)",
		hidden: true,
	},
	{
		label: "negative substituted calculation",
		parent: "font-size:0",
		child: "--size:calc(100% - 1px);font-size:var(--size)",
		hidden: true,
	},
	{
		label: "negative calculated quotient",
		parent: "font-size:16px",
		child: "font-size:calc(1px / -1)",
		hidden: true,
	},
	{
		label: "comment-only empty value preserves inherited hiding",
		parent: "visibility:hidden",
		child: "--gate:/*var(--gate)*/;visibility:var(--gate,visible)",
		hidden: true,
	},
	{
		label: "commented self reference before hidden",
		parent: "",
		child: "--gate:/*var(--gate)*/hidden;visibility:var(--gate,visible)",
		hidden: true,
	},
	{
		label: "commented cross dependency does not create a cycle",
		parent: "",
		child: "--gate:/*var(--other)*/hidden;--other:var(--gate);visibility:var(--other,visible)",
		hidden: true,
	},
	{
		label: "commented self edge in an unused fallback",
		parent: "",
		child: "--base:hidden;--gate:var(--base,/*var(--gate)*/visible);visibility:var(--gate,visible)",
		hidden: true,
	},
	{
		label: "comment punctuation cannot close a real fallback",
		parent: "",
		child: "--gate:var(--missing,/* ) , var(--gate) */hidden);visibility:var(--gate,visible)",
		hidden: true,
	},
	{
		label: "real self cycle selects hidden fallback",
		parent: "",
		child: "--gate:var(--gate);visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "unused fallback self reference keeps the known value",
		parent: "",
		child: "--base:hidden;--gate:var(--base,var(--gate));visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "valid empty value does not choose visible fallback",
		parent: "visibility:hidden",
		child: "--gate:;visibility:var(--gate,visible)",
		hidden: true,
	},
	{
		label: "invalid negative literal retains a zero parent",
		parent: "font-size:0",
		child: "font-size:-1px",
		hidden: true,
	},
	{
		label: "valid zero arithmetic remains hidden",
		parent: "font-size:16px",
		child: "font-size:calc(1px - 1px)",
		hidden: true,
	},
	{
		label: "ordinary comment before a hidden value",
		parent: "",
		child: "--gate:/*DYTEST*/hidden;visibility:var(--gate,visible)",
		hidden: true,
	},
];

const visible: readonly Case[] = [
	{
		label: "positive percentage calculation",
		parent: "font-size:0",
		child: "font-size:calc(100% + 1px)",
		hidden: false,
	},
	{
		label: "positive em shorthand calculation",
		parent: "font-size:0",
		child: "font:calc(1em + 1px)/1 serif",
		hidden: false,
	},
	{
		label: "negative literal is not a clamped calculation",
		parent: "font-size:16px",
		child: "font-size:-1px",
		hidden: false,
	},
	{
		label: "negative literal font shorthand is invalid",
		parent: "font-size:16px",
		child: "font:-1px/1 serif",
		hidden: false,
	},
	{
		label: "dimensionless negative calculation is invalid",
		parent: "font-size:16px",
		child: "font-size:calc(0 - 1)",
		hidden: false,
	},
	{
		label: "root-relative calculation recovers a zero parent",
		parent: "font-size:0",
		child: "font-size:calc(1rem + 0px)",
		hidden: false,
	},
	{
		label: "positive parent-relative calculation",
		parent: "font-size:16px",
		child: "font-size:calc(100% + 0px)",
		hidden: false,
	},
	{
		label: "zero line height is not zero font size",
		parent: "font-size:16px",
		child: "font:16px/0 serif",
		hidden: false,
	},
	{
		label: "comment before visible is not a self cycle",
		parent: "visibility:hidden",
		child: "--gate:/*var(--gate)*/visible;visibility:var(--gate,hidden)",
		hidden: false,
	},
	{
		label: "valid empty value does not choose hidden fallback",
		parent: "visibility:visible",
		child: "--gate:;visibility:var(--gate,hidden)",
		hidden: false,
	},
	{
		label: "real indirect cycle selects visible fallback",
		parent: "visibility:hidden",
		child: "--one:var(--two);--two:var(--one);visibility:var(--one,visible)",
		hidden: false,
	},
	{
		label: "comment separates identifier tokens",
		parent: "visibility:visible",
		child: "--gate:hid/**/den;visibility:var(--gate,hidden)",
		hidden: false,
	},
	{
		label: "comment cannot manufacture a var function",
		parent: "visibility:visible",
		child: "--gate:var/**/(--missing,hidden);visibility:var(--gate,hidden)",
		hidden: false,
	},
];

it.each([...hidden, ...visible])("preserves worker and thread boundaries for $label", assertThread);

const calculationTokens: readonly Case[] = [
	{
		label: "a comment is not whitespace before binary minus",
		parent: "font-size:16px",
		child: "--size:calc(0px/**/- 1px);font-size:var(--size)",
		hidden: false,
	},
	{
		label: "comments are not whitespace on either side of binary minus",
		parent: "font-size:16px",
		child: "--size:calc(0px/**/-/**/1px);font-size:var(--size)",
		hidden: false,
	},
	{
		label: "an escaped initial digit remains an identifier",
		parent: "font-size:16px",
		child: "--size:calc(\\30 px - 1px);font-size:var(--size)",
		hidden: false,
	},
	{
		label: "actual whitespace survives comments in a valid negative calculation",
		parent: "font-size:16px",
		child: "--size:calc(0px /*DYTEST*/ - /*DYTEST*/ 1px);font-size:var(--size)",
		hidden: true,
	},
	{
		label: "actual whitespace survives comments in a positive calculation",
		parent: "font-size:16px",
		child: "--size:calc(0px /*DYTEST*/ + /*DYTEST*/ 1px);font-size:var(--size)",
		hidden: false,
	},
	{
		label: "an escaped unit remains a dimension",
		parent: "font-size:16px",
		child: "--size:calc(0p\\x - 1px);font-size:var(--size)",
		hidden: true,
	},
	{
		label: "a substituted negative literal remains invalid",
		parent: "font-size:16px",
		child: "--size:-1px;font-size:var(--size)",
		hidden: false,
	},
];

it.each(calculationTokens)("preserves CSS calculation token boundaries for $label", assertThread);

const dimensionTokens: readonly Case[] = [
	{
		label: "an escaped percent unit is not a percentage in a difference",
		parent: "font-size:16px",
		child: "--size:calc(0\\% - 1px);font-size:var(--size)",
		hidden: false,
	},
	{
		label: "an escaped percent unit is not a negative percentage",
		parent: "font-size:16px",
		child: "--size:calc(-1\\%);font-size:var(--size)",
		hidden: false,
	},
];

it.each(dimensionTokens)("preserves CSS dimension token identity for $label", assertThread);
