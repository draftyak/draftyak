import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { assertContentFree } from "@draftyak/spike-kit";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	ADB_ARGS,
	checkReport,
	compileSchema,
	describeFields,
	findAdb,
	type Io,
	MAX_REPORT_BYTES,
	main,
	type Problem,
	type Rule,
	readFromAdb,
	receive,
	reportRule,
	validate,
} from "../src/receive-report.ts";

vi.mock("node:child_process", { spy: true });

type Json = Record<string, unknown>;
type At = (string | number)[];

const fixture = (name: string): string =>
	fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const full = JSON.parse(readFileSync(fixture("report-full.json"), "utf8")) as Json;
const corpus = JSON.parse(readFileSync(fixture("other-person-corpus.json"), "utf8")) as Record<
	string,
	unknown[]
>;
const textCategories = [
	"names",
	"numbers",
	"senders",
	"messages",
	"threadIds",
	"otp",
	"identifiers",
];
const corpusStrings = [...textCategories, "emails", "addresses"].flatMap(
	(key) => corpus[key] as string[],
);
const corpusIntegers = corpus.numbersAsIntegers as number[];
// e-acute, euro sign, thumbs up: one character each from Latin-1, the BMP and the astral planes.
const CANARY = String.fromCodePoint(0xe9, 0x20ac, 0x1f44d);
const minimal = {
	schema: "draftyak.s12.probe-report.v1",
	encodingCheck: CANARY,
	probeVersion: "0.1.0",
	createdAt: "2026-10-24T15:04:05Z",
	device: { manufacturer: "samsung", androidVersion: "16", sdkLevel: 36 },
};
const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const temp = mkdtempSync(path.join(tmpdir(), "draftyak-s12-report-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function walk(value: unknown, at: At = []): { at: At; value: unknown }[] {
	const here = { at, value };
	if (Array.isArray(value)) return [here, ...value.flatMap((item, i) => walk(item, [...at, i]))];
	if (value !== null && typeof value === "object") {
		return [here, ...Object.entries(value).flatMap(([key, item]) => walk(item, [...at, key]))];
	}
	return [here];
}

function edit(at: At, change: (node: Json | unknown[], key: string | number) => void): Json {
	const copy = structuredClone(full);
	let node: Json | unknown[] = copy;
	for (const key of at.slice(0, -1)) node = (node as Json)[key as string] as Json;
	change(node, at.at(-1) ?? "");
	return copy;
}

// The full report with one more field in the object at `at`.
function withKey(at: At, key: string, value: unknown): Json {
	const copy = structuredClone(full);
	let node = copy;
	for (const step of at) node = node[step as string] as Json;
	node[key] = value;
	return copy;
}

const refusals = (value: unknown): readonly Problem[] => {
	const result = checkReport(bytes(value));
	return result.ok ? [] : result.problems;
};

// Synthetic rule input assembled without placing a configuration filename in the source.
const vendorText = ["DYTEST- ", ".", "co", "dex", "/", "auth", ".json"].join("");
const bodyReport = (body: string): Json =>
	edit(["testMessages", 1, "body"], (node, key) => ((node as Json)[key] = body));
const vendorReport = () => bodyReport(vendorText);

describe("the probe report schema", () => {
	it("compiles, and lists every allowed field with its type, enum or pattern", () => {
		expect(() => reportRule()).not.toThrow();
		expect(describeFields()).toMatchSnapshot();
	});

	it("names exactly the vector ids of vectors/segments.v1.json", () => {
		const schemaFile = new URL("../schema/probe-report.v1.json", import.meta.url);
		const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
		const vectorsFile = new URL("../vectors/segments.v1.json", import.meta.url);
		const { vectors } = JSON.parse(readFileSync(vectorsFile, "utf8")) as { vectors: Json[] };
		expect(schema.$defs.vectorId.enum).toEqual(vectors.map(({ id }) => id));
	});

	it.each([
		["an open object", { type: "object", properties: {} }],
		["additionalProperties true", { type: "object", additionalProperties: true }],
		["patternProperties", { type: "object", additionalProperties: false, patternProperties: {} }],
		["oneOf", { oneOf: [{ type: "boolean" }] }],
		["a free string", { type: "string", maxLength: 10 }],
		["an unanchored pattern", { type: "string", pattern: "^a", maxLength: 10 }],
		["a long string", { type: "string", pattern: "^a*$", maxLength: 1000 }],
		["an unbounded integer", { type: "integer", minimum: 0 }],
		["a number", { type: "number", minimum: 0, maximum: 1 }],
		["an unbounded array", { type: "array", items: { type: "boolean" } }],
		["a union type", { type: ["string", "null"], enum: ["a"] }],
		["a non-string enum", { type: "string", enum: [1] }],
		["a missing $ref", { $ref: "#/$defs/nothing" }],
		[
			"a $ref with siblings",
			{ $ref: "#/$defs/flag", maxLength: 1, $defs: { flag: { type: "boolean" } } },
		],
		["a cyclic $ref", { $ref: "#/$defs/a", $defs: { a: { $ref: "#/$defs/a" } } }],
		[
			"an undeclared required field",
			{ type: "object", additionalProperties: false, properties: {}, required: ["x"] },
		],
	])("refuses a schema with %s", (_, schema) => {
		expect(() => compileSchema(schema)).toThrow(/^schema /);
	});

	it("matches a pattern against the whole string, top-level alternation included, within maxLength", () => {
		const field = (pattern: string, maxLength: number): Rule =>
			compileSchema({
				type: "object",
				additionalProperties: false,
				properties: { v: { type: "string", pattern, maxLength } },
			});
		const outside = [{ path: "$.v", rule: "outside the allowed pattern" }];
		const either = field("^\\d\\.\\d|x$", 64);
		for (const v of ["1.2", "x"]) expect(validate({ v }, either), v).toEqual([]);
		for (const v of ["Call Maria at 555 0100 x", "1.2 and more", "x y"]) {
			expect(validate({ v }, either), v).toEqual(outside);
		}
		const short = field("^a*$", 3);
		expect(validate({ v: "aaa" }, short)).toEqual([]);
		expect(validate({ v: "aaaa" }, short)).toEqual(outside);
	});

	it("pins the encodingCheck canary the probe writes", () => {
		const schema = JSON.parse(
			readFileSync(new URL("../schema/probe-report.v1.json", import.meta.url), "utf8"),
		);
		expect(schema.properties.encodingCheck.const).toBe(CANARY);
		expect(full.encodingCheck).toBe(CANARY);
	});
});

describe("the report validator", () => {
	it("accepts the full synthetic report and a minimal one", () => {
		expect(refusals(full)).toEqual([]);
		expect(refusals(minimal)).toEqual([]);
	});

	it("rejects 100% of the seeded other-person corpus wherever it is placed, never echoing it", () => {
		const nodes = walk(full);
		const leaves = nodes.filter(({ value }) => value === null || typeof value !== "object");
		const objects = nodes.filter(
			({ value }) => value && typeof value === "object" && !Array.isArray(value),
		);
		const arrays = nodes.filter(({ value }) => Array.isArray(value));
		const attempts: { label: string; report: unknown; content: string }[] = [];
		const add = (label: string, report: unknown, content: unknown): void => {
			attempts.push({ label, report, content: String(content) });
		};
		const keys = [
			"threadId",
			"thread_id",
			"address",
			"person",
			"name",
			"body",
			"contact",
			"number",
		];
		for (const content of corpusStrings) {
			add("as the report", content, content);
			add("in an array report", [content], content);
			for (const { at } of leaves) {
				add(
					`at ${at.join(".")}`,
					edit(at, (node, key) => ((node as Json)[key] = content)),
					content,
				);
			}
			for (const { at } of objects) {
				add(`key in ${at.join(".")}`, withKey(at, content, 1), content);
				for (const key of keys)
					add(`${key} in ${at.join(".")}`, withKey(at, key, content), content);
			}
			for (const { at } of arrays) {
				add(
					`pushed into ${at.join(".")}`,
					edit(at, (node, key) => ((node as Json)[key] as unknown[]).push(content)),
					content,
				);
			}
		}
		for (const number of corpusIntegers) {
			for (const { at, value } of leaves.filter(({ value }) => typeof value === "number")) {
				add(
					`integer at ${at.join(".")} (was ${value})`,
					edit(at, (node, key) => ((node as Json)[key] = number)),
					number,
				);
			}
		}
		let refused = 0;
		for (const { label, report, content } of attempts) {
			const problems = refusals(report);
			expect(problems.length, label).toBeGreaterThan(0);
			expect(JSON.stringify(problems), label).not.toContain(content);
			refused += 1;
		}
		expect(refused).toBe(attempts.length);
		expect(attempts.length).toBeGreaterThan(20_000);
	}, 120_000);

	it("refuses other-person shapes inside DYTEST- bodies: numbers, codes, e-mail addresses and links", () => {
		const digits = (text: string): number => text.match(/\p{Nd}/gu)?.length ?? 0;
		const shaped = corpusStrings.filter(
			(text) => digits(text) >= 4 || /[@\uff20]|:\/\/|www\./i.test(text),
		);
		for (const key of ["numbers", "otp", "emails"]) {
			const missing = (corpus[key] as string[]).filter((text) => !shaped.includes(text));
			expect(missing, key).toEqual([]);
		}
		const body = (text: string): Json =>
			edit(["testMessages", 0, "body"], (node, key) => ((node as Json)[key] = text));
		for (const text of shaped) expect(refusals(body(`DYTEST-${text}`)), text).not.toEqual([]);
		const refused = [
			"dytest-lowercase",
			"DYTEST-1234",
			"DYTEST-\u0661\u0662\u0663\u0664",
			"DYTEST-tab\there",
			"DYTEST-cr\r\nlf",
			"DYTEST-\u202eright-to-left",
			"DYTEST-zero\u200bwidth",
			"DYTEST-tag\u{E0041}",
			`DYTEST-${"x".repeat(114)}`,
			"DYTEST-see example.com://x",
			"DYTEST-www.example.org",
			// Numerals of any script count toward the 3, and @ look-alikes are refused too.
			"DYTEST-\u{2460}\u{2461}\u{2462}\u{2463}",
			"DYTEST-x\u{b9}\u{b2}\u{b3}\u{2074}",
			"DYTEST-123\u{bd}",
			"DYTEST-maria\u{fe6b}example.com",
			"DYTEST-maria\u{ff20}example.com",
		];
		for (const text of refused) expect(refusals(body(text)), JSON.stringify(text)).not.toEqual([]);
		for (const text of [
			"DYTEST-123 ok",
			"DYTEST-\u{1F468}\u200d\u{1F469}",
			`DYTEST-${"x".repeat(113)}`,
		]) {
			expect(refusals(body(text)), text).toEqual([]);
		}
		const unconfirmed = edit(["testMessages", 0, "addressIsSecondNumber"], (node, key) => {
			(node as Json)[key] = false;
		});
		expect(refusals(unconfirmed)).toEqual([
			{ path: "$.testMessages[0].addressIsSecondNumber", rule: "must be true" },
		]);
		const unchecked = edit(["testMessages", 0, "addressIsSecondNumber"], (node, key) => {
			delete (node as Json)[key];
		});
		expect(refusals(unchecked)).toEqual([
			{ path: "$.testMessages[0].addressIsSecondNumber", rule: "missing" },
		]);
	});

	it("refuses per-thread data: thread ids as fields, keys or items, and their hashes", () => {
		const hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
		const attempts: unknown[] = [
			{ ...full, threads: [{ id: 42, sms: 3 }] },
			edit(["threadMix"], (node, key) => ((node as Json)[key] = { 42: { sms: 3 } })),
			edit(["threadMix", "threadIds"], (node, key) => ((node as Json)[key] = [42, 87])),
			edit(["testMessages", 0, "threadId"], (node, key) => ((node as Json)[key] = 42)),
			edit(
				["inventory", "providers", 0, "columns", 0],
				(node, key) => ((node as Json)[key] = hash),
			),
			edit(
				["inventory", "rcs", "idColumns", 0],
				(node, key) => ((node as Json)[key] = hash.slice(0, 16)),
			),
			edit(["device", "buildVersion"], (node, key) => ((node as Json)[key] = hash.slice(0, 24))),
			// A hash fragment with no run of 4 digits still looks like a lowercase identifier.
			edit(
				["testMessages", 1, "rcsMarkerColumns", 0],
				(node, key) => ((node as Json)[key] = "deadbeefcafe"),
			),
		];
		for (const report of attempts) expect(refusals(report)).not.toEqual([]);
		const columns = [
			"_id",
			"thread_id",
			"date_sent",
			"deleted",
			"added",
			"ct_t",
			"tr_id",
			"sub_id",
		];
		const named = edit(
			["inventory", "providers", 0, "columns"],
			(node, key) => ((node as Json)[key] = columns),
		);
		expect(refusals(named)).toEqual([]);
	});

	// Shapes the schema can't tell from real values. The serializer's typed allowlist (M0.37a) keeps
	// them out, and m0-gate.md section 3 lists them for the owner; a change here changes that list.
	it("still accepts the known residual shapes: lowercase words, two digits, counts, owner text", () => {
		const column: At = ["inventory", "providers", 0, "columns", 0];
		const residuals: [At, unknown][] = [
			[column, "maria"],
			[column, "mom"],
			[column, "maria_garcia"],
			[column, "grandma_rose"],
			[column, "thread_42"],
			[["inventory", "providers", 0, "rows"], 482_913],
			[["threadMix", "threads"], 42],
			[["device", "androidVersion"], "48.29.13"],
			[["testMessages", 1, "body"], "DYTEST-hi maria, 482"],
			[["testMessages", 1, "body"], "DYTEST-maria at example dot com"],
		];
		for (const [at, value] of residuals) {
			const report = edit(at, (node, key) => ((node as Json)[key] = value));
			expect(refusals(report), `${at.join(".")} = ${value}`).toEqual([]);
		}
	});

	it("refuses unknown fields at every level, prototype keys included, naming none of them", () => {
		for (const { at, value } of walk(full)) {
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
				const json = JSON.stringify(value).replace(/^\{/, `{${JSON.stringify(key)}:1,`);
				const report =
					at.length === 0
						? JSON.parse(json)
						: edit(at, (node, last) => ((node as Json)[last] = JSON.parse(json)));
				const problems = refusals(report);
				expect(
					problems.map(({ rule }) => rule),
					`${key} in ${at.join(".")}`,
				).toContain("unknown field");
				expect(JSON.stringify(problems)).not.toContain(key === "__proto__" ? key : `.${key}`);
			}
		}
	});

	it("refuses wrong types, out-of-range numbers, oversized and duplicated lists", () => {
		const cases: [At, unknown][] = [
			[["device", "sdkLevel"], 36.5],
			[["device", "sdkLevel"], -1],
			[["device", "sdkLevel"], "36"],
			[["device", "messagesIsDefault"], "true"],
			[["sends", "attempted"], 21],
			[
				["vectors", "results", 0, "calculateLength"],
				[2, 164, 142],
			],
			[
				["inventory", "providers", 0, "columns"],
				["_id", "_id"],
			],
			[["inventory", "providers", 0, "columns"], Array.from({ length: 257 }, (_, i) => `c_${i}`)],
			[["vectors", "results", 0, "id"], "made-up-vector"],
			[["device", "manufacturer"], "Samsung"],
			[["createdAt"], "2026-10-24 15:04:05"],
			// Version fields leave no room for a word or a number.
			[["device", "messagesVersion"], "messages.android_20261001_00_RC02.maria_garcia"],
			[["device", "buildVersion"], "BP3A.251005.004.MARIA"],
			[["probeVersion"], "555.555.012"],
			[["device", "androidVersion"], "555.0123"],
			// A whole phone number fits neither the build date nor the Messages date.
			[["device", "buildVersion"], "B155.501001.990.00"],
			[["device", "buildVersion"], "BP3A.555501.234"],
			[["device", "messagesVersion"], "messages.android_15555550_12_RC30"],
			[["device", "smsFormat"], "cdma"],
			[["tls", "attempts", 0, "result"], "fallback"],
			[["vectors", "results", 0, "match"], "3gpp"],
		];
		for (const [at, value] of cases) {
			expect(
				refusals(edit(at, (node, key) => ((node as Json)[key] = value))),
				at.join("."),
			).not.toEqual([]);
		}
		for (const id of [
			"BP3A.251005.004",
			"BP31.250502.008",
			"UKQ1.230924.001",
			"BP2A.250605.031.A3",
		]) {
			const report = edit(["device", "buildVersion"], (node, key) => ((node as Json)[key] = id));
			expect(refusals(report), id).toEqual([]);
		}
		const { device: _, ...headless } = minimal;
		expect(refusals(headless)).toEqual([{ path: "$.device", rule: "missing" }]);
	});

	it("refuses bytes that aren't one UTF-8 JSON report, without quoting them", () => {
		const valid = bytes(full);
		// Inside a DYTEST- body, where a lenient decoder's U+FFFD would pass the schema.
		const at = valid.indexOf("DYTEST-2 ") + 9;
		// The valid report, padded to `size` bytes with whitespace between tokens.
		const padded = (size: number): Buffer =>
			Buffer.concat([Buffer.from("{"), Buffer.alloc(size - valid.length, 0x20), valid.subarray(1)]);
		const cases: [string, Uint8Array, string][] = [
			["empty", new Uint8Array(), "empty"],
			[
				"a byte order mark",
				Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]),
				"byte order mark",
			],
			["UTF-16", Buffer.from(JSON.stringify(full), "utf16le"), "not UTF-8 JSON"],
			[
				"invalid UTF-8",
				Buffer.concat([valid.subarray(0, at), Buffer.from([0xc3, 0x28]), valid.subarray(at)]),
				"not UTF-8 JSON",
			],
			["a text message", Buffer.from("Running late, see you at 7?"), "not UTF-8 JSON"],
			["truncated", valid.subarray(0, valid.length - 5), "not UTF-8 JSON"],
			["two reports", Buffer.concat([valid, valid]), "not UTF-8 JSON"],
			["too large", padded(MAX_REPORT_BYTES + 1), `larger than ${MAX_REPORT_BYTES} bytes`],
		];
		for (const [label, input, rule] of cases) {
			expect(checkReport(input), label).toEqual({ ok: false, problems: [{ path: "$", rule }] });
		}
		expect(checkReport(padded(MAX_REPORT_BYTES)).ok).toBe(true);
	});

	it("refuses a report a lossy pipe or a mojibake round trip re-encoded, through encodingCheck", () => {
		const text = JSON.stringify(full);
		// Windows PowerShell 5.1 piping through an ASCII or OEM code page: "?" for each unit it lacks.
		const lossy = Buffer.from(text.replace(/[^\x20-\x7e]/g, "?"));
		// UTF-8 read as Latin-1 or Windows-1252, then written back as UTF-8.
		const mojibake = Buffer.from(Buffer.from(text).toString("latin1"));
		const canary = { path: "$.encodingCheck", rule: "not an allowed value" };
		expect(checkReport(lossy)).toEqual({ ok: false, problems: [canary] });
		const garbled = checkReport(mojibake);
		expect(garbled.ok ? [] : garbled.problems).toContainEqual(canary);
		const { encodingCheck: _, ...unmarked } = full;
		expect(refusals(unmarked)).toEqual([{ path: "$.encodingCheck", rule: "missing" }]);
	});

	it("applies the kit's content rules after the schema, as a second gate", () => {
		const user = os.userInfo().username;
		const report = edit(
			["testMessages", 1, "body"],
			(node, key) => ((node as Json)[key] = `DYTEST-in /${user}`),
		);
		const result = checkReport(bytes(report));
		expect(result.ok).toBe(user.length < 2);
		if (!result.ok)
			expect(JSON.stringify(result.problems)).toContain(
				"content-shaped values ($.testMessages[1].body (user))",
			);
	});

	it.each([
		["vendor configuration path", [".", "clau", "de", "/settings"].join(""), "anthropic-config"],
		["vendor authentication path", [".", "co", "dex", "/auth.json"].join(""), "openai-codex-auth"],
		["vendor configuration", ["CLAU", "DE_CONFIG_DIR"].join(""), "anthropic-config"],
		["vendor token setting", ["CLAU", "DE_CODE_OAUTH_TOKEN"].join(""), "anthropic-token"],
		["vendor package", ["clau", "de-code-sdk"].join(""), "anthropic-agent-sdk"],
		["vendor endpoint", ["mcp", ".slack", ".com"].join(""), "slack-mcp"],
		[
			"synthetic client id",
			["1-", "a".repeat(20), ".apps", ".googleusercontent", ".com"].join(""),
			"google-client-id",
		],
		[
			"synthetic webhook",
			["hooks", ".slack", ".com/services/Tsynthetic/", "a".repeat(20)].join(""),
			"secret-slack",
		],
	])("refuses %s after spaces and decoded line breaks without quoting it", (_, text, rule) => {
		for (const separator of [" ", "\n", "\r", "\t"]) {
			const report = bodyReport(`DYTEST-${separator}${text}`);
			const checked = checkReport(bytes(report));
			if (separator === " " || separator === "\n") {
				expect(validate(report), JSON.stringify(separator)).toEqual([]);
				expect(() => assertContentFree(report, "report")).not.toThrow();
				expect(checked, JSON.stringify(separator)).toEqual({
					ok: false,
					problems: [{ path: "$", rule: `vendor-file rule ${rule}` }],
				});
			} else {
				expect(checked, JSON.stringify(separator)).toEqual({
					ok: false,
					problems: [{ path: "$.testMessages[1].body", rule: "outside the allowed pattern" }],
				});
			}
			expect(JSON.stringify(checked)).not.toContain(text);
		}
		const newlineReport = bodyReport(`DYTEST-\n${text}`);
		const unicodeEscaped = Buffer.from(JSON.stringify(newlineReport).replaceAll("\\n", "\\u000a"));
		expect(checkReport(unicodeEscaped)).toEqual({
			ok: false,
			problems: [{ path: "$", rule: `vendor-file rule ${rule}` }],
		});
		for (const literal of ["\\n", "\\r", "\\t"]) {
			const report = bodyReport(`DYTEST-${literal}${text}`);
			expect(checkReport(bytes(report)), literal).toEqual({ ok: true, report });
		}
	});
});

describe("receive", () => {
	it("refuses vendor-file data in checks before any private destination write or replacement", async () => {
		const report = vendorReport();
		expect(validate(report)).toEqual([]);
		expect(() => assertContentFree(report, "report")).not.toThrow();
		const expected = {
			ok: false,
			problems: [{ path: "$", rule: "vendor-file rule openai-codex-auth" }],
		};
		const evidenceDir = path.join(temp, "vendor-private", "evidence");
		const refused = await receive(bytes(report), { name: "refused", evidenceDir });
		expect(refused).toEqual(expected);
		expect(checkReport(bytes(report))).toEqual(expected);
		expect(() => readdirSync(path.dirname(evidenceDir))).toThrow();
		mkdirSync(evidenceDir, { recursive: true });
		const file = path.join(evidenceDir, "refused.json");
		const original = Buffer.from("synthetic earlier evidence\n");
		writeFileSync(file, original);
		expect(await receive(bytes(report), { name: "refused", evidenceDir, replace: true })).toEqual(
			expected,
		);
		expect(readFileSync(file)).toEqual(original);
		expect(readdirSync(evidenceDir)).toEqual(["refused.json"]);
		expect(JSON.stringify(refused)).not.toContain(vendorText);
	});

	it("refuses a vendor basename before creating or replacing private evidence", async () => {
		const name = ["clau", "de", "-code", "-sdk"].join("");
		const evidenceDir = path.join(temp, "named-vendor-private", "evidence");
		const expected = {
			ok: false,
			problems: [{ path: "$", rule: "vendor-file rule anthropic-agent-sdk" }],
		};
		expect(checkReport(bytes(full))).toEqual({ ok: true, report: full });
		expect(await receive(bytes(full), { name, evidenceDir })).toEqual(expected);
		expect(() => readdirSync(path.dirname(evidenceDir))).toThrow();
		mkdirSync(evidenceDir, { recursive: true });
		const file = path.join(evidenceDir, `${name}.json`);
		const original = Buffer.from("synthetic earlier evidence\n");
		writeFileSync(file, original);
		expect(await receive(bytes(full), { name, evidenceDir, replace: true })).toEqual(expected);
		expect(readFileSync(file)).toEqual(original);
		expect(readdirSync(evidenceDir)).toEqual([`${name}.json`]);
	});

	it("applies the evidence-only tailnet rule to checks and private writes", async () => {
		const report = bodyReport(["DYTEST- -", ".ts", ".net"].join(""));
		const evidenceDir = path.join(temp, "canonical-private", "evidence");
		const expected = {
			ok: false,
			problems: [{ path: "$", rule: "vendor-file rule evidence-tailnet" }],
		};
		expect(validate(report)).toEqual([]);
		expect(() => assertContentFree(report, "report")).not.toThrow();
		expect(checkReport(bytes(report))).toEqual(expected);
		expect(await receive(bytes(report), { name: "tailnet-refused", evidenceDir })).toEqual(
			expected,
		);
		expect(() => readdirSync(path.dirname(evidenceDir))).toThrow();
	});

	it("captures an evidence name getter once for validation, file rules and destination", async () => {
		const evidenceDir = path.join(temp, "name-getter", "evidence");
		let reads = 0;
		const options = {
			get name(): string {
				reads++;
				return reads === 1 ? "first-report" : "../escaped-report";
			},
			evidenceDir,
		};
		expect(await receive(bytes(full), options)).toEqual({
			ok: true,
			written: path.join(evidenceDir, "first-report.json"),
		});
		expect(reads).toBe(1);
		expect(readdirSync(evidenceDir)).toEqual(["first-report.json"]);
		expect(readdirSync(path.dirname(evidenceDir))).toEqual(["evidence"]);
		expect(
			JSON.parse(readFileSync(path.join(evidenceDir, "first-report.json"), "utf8")).data,
		).toEqual(full);
	}, 60_000);

	it("rejects a non-string evidence name before coercion or writing", async () => {
		const evidenceDir = path.join(temp, "name-coercion", "evidence");
		let coercions = 0;
		const name = {
			toString(): string {
				coercions++;
				return coercions === 1 ? "safe-report" : "../escaped-report";
			},
		};
		await expect(
			receive(bytes(full), { name: name as unknown as string, evidenceDir }),
		).rejects.toThrow("bad evidence name");
		expect(coercions).toBe(0);
		expect(() => readdirSync(path.dirname(evidenceDir))).toThrow();
	});

	it("writes evidence only once the report passes, and only what passed", async () => {
		const evidence = path.join(temp, "write", "evidence");
		const refused = await receive(bytes({ ...full, extra: corpusStrings[0] }), {
			name: "bad",
			evidenceDir: evidence,
		});
		expect(refused.ok).toBe(false);
		const check = await receive(bytes(full), { evidenceDir: evidence });
		expect(check).toEqual({ ok: true, written: null });
		expect(() => readdirSync(evidence)).toThrow();
		const written = await receive(bytes(full), { name: "session-test", evidenceDir: evidence });
		expect(written.ok && written.written).toBe(path.join(evidence, "session-test.json"));
		expect(readdirSync(evidence)).toEqual(["session-test.json"]);
		const document = JSON.parse(readFileSync(path.join(evidence, "session-test.json"), "utf8"));
		expect(Object.keys(document)).toEqual(["recordedAt", "fingerprint", "data"]);
		expect(document.data).toEqual(full);
		await expect(
			receive(bytes(full), { name: "../escape", evidenceDir: evidence }),
		).rejects.toThrow("bad evidence name");
	}, 60_000);

	it("never writes over earlier evidence unless asked to, even from two writers at once", async () => {
		const evidenceDir = path.join(temp, "again", "evidence");
		const file = path.join(evidenceDir, "again.json");
		expect((await receive(bytes(full), { name: "again", evidenceDir })).ok).toBe(true);
		const before = readFileSync(file, "utf8");
		await expect(receive(bytes(minimal), { name: "again", evidenceDir })).rejects.toThrow(
			"evidence/again.json exists; --replace overwrites it",
		);
		expect(readFileSync(file, "utf8")).toBe(before);
		const replaced = await receive(bytes(minimal), { name: "again", evidenceDir, replace: true });
		expect(replaced.ok).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8")).data).toEqual(minimal);
		const race = await Promise.allSettled(
			[full, minimal].map((report) => receive(bytes(report), { name: "race", evidenceDir })),
		);
		expect(race.map(({ status }) => status).toSorted()).toEqual(["fulfilled", "rejected"]);
	}, 60_000);
});

describe("adb", () => {
	const fakeAdb = fixture("fake-adb.mjs");
	const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ ...process.env, ...extra });

	it("passes the private native selector as one argument before the fixed report command", async () => {
		const serial = "synthetic-\u00e9 device;$(literal)";
		const args = path.join(temp, "selected-args.json");
		const capturedEnv = path.join(temp, "selected-env.json");
		const inherited = env({
			FAKE_ADB_OUT: fixture("report-full.json"),
			FAKE_ADB_ARGS: args,
			FAKE_ADB_ENV: capturedEnv,
			ANDROID_SERIAL: "inherited-uppercase",
		});
		const before = { ...inherited };
		const read = await readFromAdb([process.execPath, fakeAdb], { serial, env: inherited });
		expect(JSON.parse(readFileSync(args, "utf8"))).toEqual(["-s", serial, ...ADB_ARGS]);
		expect(JSON.parse(readFileSync(capturedEnv, "utf8"))).toEqual({ androidSerial: serial });
		expect(inherited).toEqual(before);
		expect(Buffer.from(read)).toEqual(readFileSync(fixture("report-full.json")));
	});

	it("removes every inherited selector case variant from the spawn environment", async () => {
		const inherited = env({
			FAKE_ADB_OUT: fixture("report-full.json"),
			ANDROID_SERIAL: "synthetic-uppercase",
			android_serial: "synthetic-lowercase",
			Android_Serial: "synthetic-mixed-case",
		});
		const before = { ...inherited };
		const serial = "synthetic-selected-selector";
		const calls = vi.spyOn(childProcess, "spawn").mockClear();
		try {
			const read = await readFromAdb([process.execPath, fakeAdb], { serial, env: inherited });
			expect(calls).toHaveBeenCalledExactlyOnceWith(
				process.execPath,
				[fakeAdb, "-s", serial, ...ADB_ARGS],
				expect.objectContaining({ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }),
			);
			const selectedEnv = calls.mock.calls[0]?.[2]?.env;
			expect(
				Object.keys(selectedEnv ?? {}).filter((key) => key.toUpperCase() === "ANDROID_SERIAL"),
			).toEqual(["ANDROID_SERIAL"]);
			expect(selectedEnv).toEqual({
				...Object.fromEntries(
					Object.entries(before).filter(([key]) => key.toUpperCase() !== "ANDROID_SERIAL"),
				),
				ANDROID_SERIAL: serial,
			});
			expect(inherited).toEqual(before);
			expect(Buffer.from(read)).toEqual(readFileSync(fixture("report-full.json")));
		} finally {
			calls.mockRestore();
		}
	});

	it("keeps inherited selection and original argv when no explicit selector is supplied", async () => {
		const args = path.join(temp, "inherited-args.json");
		const capturedEnv = path.join(temp, "inherited-env.json");
		await readFromAdb([process.execPath, fakeAdb], {
			env: env({
				FAKE_ADB_OUT: fixture("report-full.json"),
				FAKE_ADB_ARGS: args,
				FAKE_ADB_ENV: capturedEnv,
				ANDROID_SERIAL: "synthetic-inherited",
			}),
		});
		expect(JSON.parse(readFileSync(args, "utf8"))).toEqual([...ADB_ARGS]);
		expect(JSON.parse(readFileSync(capturedEnv, "utf8"))).toEqual({
			androidSerial: "synthetic-inherited",
		});
	});

	it("omits native error diagnostics with an explicit private selector", async () => {
		const serial = "synthetic-private-serial";
		const failed = readFromAdb([process.execPath, fakeAdb], {
			serial,
			env: env({ FAKE_ADB_MODE: "serial-error" }),
		});
		await expect(failed).rejects.toThrow(/^adb exited with 1$/);
		await expect(failed).rejects.not.toThrow(serial);
	});

	it("keeps explicit selection private after the caller clears its options", async () => {
		const serial = "synthetic-cleared-private-serial";
		const args = path.join(temp, "cleared-options-args.json");
		const capturedEnv = path.join(temp, "cleared-options-env.json");
		const options: { serial?: string; env: NodeJS.ProcessEnv } = {
			serial,
			env: env({ FAKE_ADB_MODE: "serial-error", FAKE_ADB_ARGS: args, FAKE_ADB_ENV: capturedEnv }),
		};
		const failed = readFromAdb([process.execPath, fakeAdb], options);
		delete options.serial;
		await expect(failed).rejects.toThrow(/^adb exited with 1$/);
		expect(JSON.parse(readFileSync(args, "utf8"))).toEqual(["-s", serial, ...ADB_ARGS]);
		expect(JSON.parse(readFileSync(capturedEnv, "utf8"))).toEqual({ androidSerial: serial });
	});

	it("captures an explicit serial getter once for validation, argv, environment and diagnostics", async () => {
		const serial = "synthetic-first-selector";
		const args = path.join(temp, "getter-options-args.json");
		const capturedEnv = path.join(temp, "getter-options-env.json");
		let reads = 0;
		const options = {
			get serial(): string {
				reads++;
				return reads === 1 ? serial : "synthetic-later-selector";
			},
			env: env({ FAKE_ADB_MODE: "serial-error", FAKE_ADB_ARGS: args, FAKE_ADB_ENV: capturedEnv }),
		};
		await expect(readFromAdb([process.execPath, fakeAdb], options)).rejects.toThrow(
			/^adb exited with 1$/,
		);
		expect(reads).toBe(1);
		expect(JSON.parse(readFileSync(args, "utf8"))).toEqual(["-s", serial, ...ADB_ARGS]);
		expect(JSON.parse(readFileSync(capturedEnv, "utf8"))).toEqual({ androidSerial: serial });
	});

	it.each(["serial-fragment-error", "serial-encoded-error"])(
		"omits transformed native selector diagnostics (%s)",
		async (mode) => {
			const failed = readFromAdb([process.execPath, fakeAdb], {
				serial: "synthetic-private-\u00e9-device-selector",
				env: env({ FAKE_ADB_MODE: mode }),
			});
			await expect(failed).rejects.toThrow(/^adb exited with 1$/);
		},
	);

	it("omits truncated native diagnostics that could contain only part of the private selector", async () => {
		const serial = "synthetic-".repeat(250);
		const failed = readFromAdb([process.execPath, fakeAdb], {
			serial,
			env: env({ FAKE_ADB_MODE: "serial-error" }),
		});
		await expect(failed).rejects.toThrow(/^adb exited with 1$/);
		await expect(failed).rejects.not.toThrow("synthetic-");
	});

	it("retains native size and timeout limits with an explicit selector", async () => {
		const serial = "synthetic-bounded-serial";
		await expect(
			readFromAdb([process.execPath, fakeAdb], {
				serial,
				env: env({ FAKE_ADB_MODE: "huge" }),
			}),
		).rejects.toThrow(`larger than ${MAX_REPORT_BYTES} bytes`);
		await expect(
			readFromAdb([process.execPath, fakeAdb], {
				serial,
				timeoutMs: 300,
				env: env({ FAKE_ADB_MODE: "hang" }),
			}),
		).rejects.toThrow("adb timed out");
	});

	it.each(["", " ", "-d", "--all", "x\nprivate", "x\rprivate", "x\0private"])(
		"refuses an invalid direct selector before spawning (%j)",
		(serial) => {
			expect(() => readFromAdb([process.execPath, fakeAdb], { serial })).toThrow("bad adb serial");
		},
	);

	it.each([
		{ label: "null", serial: null },
		{ label: "boolean", serial: true },
		{ label: "number", serial: 123 },
		{ label: "array", serial: ["synthetic-array-selector"] },
		{ label: "boxed string", serial: Object("synthetic-boxed-selector") },
		{ label: "string-like object", serial: { trim: () => "synthetic-object-selector" } },
	])("refuses a non-string direct selector before spawning ($label)", ({ serial }) => {
		const calls = vi
			.spyOn(childProcess, "spawn")
			.mockClear()
			.mockImplementation(() => {
				throw new Error("unexpected fake spawn");
			});
		try {
			expect(() => readFromAdb([process.execPath, fakeAdb], { serial: serial as string })).toThrow(
				"bad adb serial",
			);
			expect(calls).not.toHaveBeenCalled();
		} finally {
			calls.mockRestore();
		}
	});

	it("spawns adb itself, with exec-out run-as ... cat files/report.json, and keeps the bytes", async () => {
		// Multibyte UTF-8 and CRLF between tokens, which a PowerShell pipe would re-encode.
		const raw = Buffer.from(JSON.stringify(full, null, 1).replaceAll("\n", "\r\n"));
		const out = path.join(temp, "adb-out.json");
		const args = path.join(temp, "adb-args.json");
		writeFileSync(out, raw);
		const read = await readFromAdb([process.execPath, fakeAdb], {
			env: env({ FAKE_ADB_OUT: out, FAKE_ADB_ARGS: args }),
		});
		expect(Buffer.compare(Buffer.from(read), raw)).toBe(0);
		expect(JSON.parse(readFileSync(args, "utf8"))).toEqual([...ADB_ARGS]);
		expect(ADB_ARGS).toEqual([
			"exec-out",
			"run-as",
			"com.draftyak.smsprobe",
			"cat",
			"files/report.json",
		]);
		expect(checkReport(read).ok).toBe(true);
	});

	it("reports adb's own errors with device addresses redacted", async () => {
		const failing = readFromAdb([process.execPath, fakeAdb], {
			env: env({ FAKE_ADB_MODE: "unauthorized" }),
		});
		await expect(failing).rejects.toThrow(/adb exited with 1: .*\[redacted:ipv4\].*unauthorized/);
		await expect(failing).rejects.not.toThrow("192.0.2.10");
	});

	it("stops past 1 MiB or a timeout, refuses script shims and reports a missing adb", async () => {
		const huge = readFromAdb([process.execPath, fakeAdb], { env: env({ FAKE_ADB_MODE: "huge" }) });
		await expect(huge).rejects.toThrow(`larger than ${MAX_REPORT_BYTES} bytes`);
		const hang = readFromAdb([process.execPath, fakeAdb], {
			env: env({ FAKE_ADB_MODE: "hang" }),
			timeoutMs: 300,
		});
		await expect(hang).rejects.toThrow("adb timed out");
		expect(() => readFromAdb(["C:/sdk/platform-tools/adb.cmd"])).toThrow("refusing to spawn");
		await expect(readFromAdb([path.join(temp, "no-adb-here.exe")])).rejects.toThrow(
			"adb could not start: ENOENT",
		);
	});

	it("finds adb on PATH, then in the SDK's platform-tools", () => {
		const exe = process.platform === "win32" ? "adb.exe" : "adb";
		const onPath = path.join(temp, "path-bin");
		const sdk = path.join(temp, "sdk");
		mkdirSync(onPath, { recursive: true });
		mkdirSync(path.join(sdk, "platform-tools"), { recursive: true });
		writeFileSync(path.join(sdk, "platform-tools", exe), "");
		expect(findAdb({ PATH: onPath, ANDROID_HOME: sdk })).toBe(
			path.join(sdk, "platform-tools", exe),
		);
		writeFileSync(path.join(onPath, exe), "");
		expect(findAdb({ PATH: onPath, ANDROID_HOME: sdk })).toBe(path.join(onPath, exe));
		expect(findAdb({ PATH: path.join(temp, "nothing") })).toBeUndefined();
	});
});

describe("the receive-report CLI", () => {
	const run = async (argv: string[], input: unknown = full, extra: Partial<Io> = {}) => {
		const out: string[] = [];
		const err: string[] = [];
		const stdin = Readable.from([typeof input === "string" ? Buffer.from(input) : bytes(input)]);
		const code = await main(argv, {
			stdin,
			out: (l) => out.push(l),
			err: (l) => err.push(l),
			...extra,
		});
		return { code, out: out.join("\n"), err: err.join("\n") };
	};

	it("refuses vendor-file data in stdin check and named CLI modes without quoting it", async () => {
		for (const target of [["--check"], ["--name", "vendor-refused"]]) {
			const evidenceDir = path.join(temp, `cli-vendor-${target[0]?.slice(2)}`, "evidence");
			const result = await run(["--stdin", ...target], vendorReport(), { evidenceDir });
			expect(result).toEqual({
				code: 1,
				out: "",
				err: "receive-report: refused (1 problems); nothing written\n  $: vendor-file rule openai-codex-auth",
			});
			expect(result.err).not.toContain(vendorText);
			expect(() => readdirSync(path.dirname(evidenceDir))).toThrow();
		}
	});

	it.each([
		{
			label: "vendor basename",
			name: ["clau", "de", "-code", "-sdk"].join(""),
			report: full,
			rule: "anthropic-agent-sdk",
		},
		{
			label: "canonical evidence rule",
			name: "tailnet-refused",
			report: bodyReport(["DYTEST- -", ".ts", ".net"].join("")),
			rule: "evidence-tailnet",
		},
	])(
		"refuses a $label through stdin named CLI mode before writing",
		async ({ name, report, rule }) => {
			const evidenceDir = path.join(temp, `cli-semantic-${name}`, "evidence");
			expect(await run(["--stdin", "--name", name], report, { evidenceDir })).toEqual({
				code: 1,
				out: "",
				err: `receive-report: refused (1 problems); nothing written\n  $: vendor-file rule ${rule}`,
			});
			expect(() => readdirSync(path.dirname(evidenceDir))).toThrow();
		},
	);

	it("routes explicit selection through the CLI for checks and named writes", async () => {
		const args = path.join(temp, "cli-selected-args.json");
		const selectedEnv = path.join(temp, "cli-selected-env.json");
		const evidenceDir = path.join(temp, "cli-selected", "evidence");
		const serial = "synthetic-cli-serial";
		const extra = {
			evidenceDir,
			adb: [process.execPath, fixture("fake-adb.mjs")] as const,
			env: {
				...process.env,
				FAKE_ADB_OUT: fixture("report-full.json"),
				FAKE_ADB_ARGS: args,
				FAKE_ADB_ENV: selectedEnv,
				ANDROID_SERIAL: "other-synthetic-serial",
			},
		};
		for (const target of [["--check"], ["--name", "selected-cli"]]) {
			const result = await run(["--from-adb", "--serial", serial, ...target], full, extra);
			expect(result).toMatchObject({ code: 0, err: "" });
			expect(result.out).not.toContain(serial);
			expect(JSON.parse(readFileSync(args, "utf8"))).toEqual(["-s", serial, ...ADB_ARGS]);
			expect(JSON.parse(readFileSync(selectedEnv, "utf8"))).toEqual({ androidSerial: serial });
		}
		expect(
			JSON.parse(readFileSync(path.join(evidenceDir, "selected-cli.json"), "utf8")).data,
		).toEqual(full);
	}, 60_000);

	it("refuses invalid selector usage with zero fake child calls and no value in errors", async () => {
		const args = path.join(temp, "invalid-selector-never-called.json");
		const invalid = [
			["--from-adb", "--check", "--serial"],
			...["", " ", "-d", "--check", "x\nprivate", "x\rprivate", "x\0private"].map((serial) => [
				"--from-adb",
				"--check",
				"--serial",
				serial,
			]),
			["--from-adb", "--check", "--serial", "private-value", "--serial", "second-value"],
			["--stdin", "--check", "--serial", "private-value"],
			["--fields", "--serial", "private-value"],
		];
		for (const argv of invalid) {
			const result = await run(argv, full, {
				adb: [process.execPath, fixture("fake-adb.mjs")],
				env: { ...process.env, FAKE_ADB_ARGS: args },
			});
			expect(result.code).toBe(2);
			expect(result.out).toBe("");
			expect(result.err).not.toMatch(/private-value|second-value|x[\r\n]/);
			expect(() => readFileSync(args)).toThrow();
		}
	});

	it("checks a report from stdin and writes nothing with --check, with or without a leading --", async () => {
		for (const argv of [
			["--stdin", "--check"],
			["--", "--stdin", "--check"],
		]) {
			const result = await run(argv);
			expect(result).toMatchObject({ code: 0, err: "" });
			expect(result.out).toMatch(/^receive-report: valid \(\d+ bytes\); --check, nothing written$/);
		}
	});

	it("refuses other-person content with paths and rules only, exit code 1", async () => {
		const report = {
			...full,
			device: { ...(full.device as Json), buildVersion: "Maria Garcia" },
			note: "+15555550123",
		};
		const result = await run(["--stdin", "--name", "session1"], report, {
			evidenceDir: path.join(temp, "cli", "evidence"),
		});
		expect(result.code).toBe(1);
		expect(result.err).toBe(
			[
				"receive-report: refused (2 problems); nothing written",
				"  $.device.buildVersion: outside the allowed pattern",
				"  $.<unknown>: unknown field",
			].join("\n"),
		);
		expect(() => readdirSync(path.join(temp, "cli", "evidence"))).toThrow();
	});

	it("exits 2 on usage errors", async () => {
		const usage = [
			[],
			["--stdin"],
			["--stdin", "--from-adb", "--check"],
			["--stdin", "--check", "--name", "x"],
			["--stdin", "--name", "../x"],
			["--stdin", "--name", ""],
			["--stdin", "--adb", "adb.exe", "--check"],
			["--stdin", "--check", "--force"],
			// A flag's value missing, empty or another flag, as with an unset variable.
			["--stdin", "--name"],
			["--stdin", "--name", "--check"],
			["--from-adb", "--check", "--adb"],
			["--from-adb", "--adb", "", "--check"],
			["--stdin", "--check", "--replace"],
		];
		for (const argv of usage) expect((await run(argv)).code, argv.join(" ")).toBe(2);
	});

	it("prints one line, with no stack, when a name is taken or the evidence can't be written", async () => {
		const evidenceDir = path.join(temp, "cli-again", "evidence");
		expect((await run(["--stdin", "--name", "again"], full, { evidenceDir })).code).toBe(0);
		expect(await run(["--stdin", "--name", "again"], minimal, { evidenceDir })).toEqual({
			code: 1,
			out: "",
			err: "receive-report: evidence/again.json exists; --replace overwrites it; nothing written",
		});
		const replace = await run(["--stdin", "--name", "again", "--replace"], minimal, {
			evidenceDir,
		});
		expect([replace.code, replace.err]).toEqual([0, ""]);
		// A file where the evidence folder should be.
		const blocked = path.join(temp, "cli-blocked");
		mkdirSync(blocked, { recursive: true });
		writeFileSync(path.join(blocked, "evidence"), "");
		const failed = await run(["--stdin", "--name", "x"], full, {
			evidenceDir: path.join(blocked, "evidence"),
		});
		expect(failed).toMatchObject({ code: 1, out: "" });
		expect(failed.err).toMatch(/^receive-report: E[A-Z]+; nothing written$/);
	}, 60_000);

	it("says when adb is missing, writing nothing", async () => {
		const result = await run(["--from-adb", "--check"], full, {
			env: { PATH: path.join(temp, "nothing") },
		});
		expect(result).toMatchObject({
			code: 1,
			err: "receive-report: adb not found on PATH or in the Android SDK; nothing written",
		});
	});

	it("receives from adb end to end: writes the validated report, explains run-as output", async () => {
		const adb = [process.execPath, fixture("fake-adb.mjs")] as const;
		const out = path.join(temp, "cli-adb-out.json");
		const evidenceDir = path.join(temp, "cli-adb", "evidence");
		const env = { ...process.env, FAKE_ADB_OUT: out };
		writeFileSync(out, bytes(full));
		const written = await run(["--from-adb", "--name", "session-adb"], full, {
			adb,
			env,
			evidenceDir,
		});
		expect([written.code, written.err]).toEqual([0, ""]);
		expect(written.out).toMatch(/^receive-report: valid \(\d+ bytes\); wrote .*session-adb\.json$/);
		expect(readdirSync(evidenceDir)).toEqual(["session-adb.json"]);
		// exec-out merges the device's stderr into stdout and exits 0.
		writeFileSync(out, "run-as: package not debuggable: com.draftyak.smsprobe\n");
		const runAs = await run(["--from-adb", "--check"], full, { adb, env });
		expect(runAs.code).toBe(1);
		expect(runAs.err).toContain("$: not UTF-8 JSON");
		expect(runAs.err).toContain("is the debug probe installed, with a report?");
		expect(runAs.err).not.toContain("debuggable");
		const offline = await run(["--from-adb", "--check"], full, {
			adb,
			env: { ...env, FAKE_ADB_MODE: "unauthorized" },
		});
		expect(offline.code).toBe(1);
		expect(offline.err).toMatch(/^receive-report: adb exited with 1: .*; nothing written$/);
	}, 60_000);

	it("prints the allowed fields with --fields", async () => {
		const result = await run(["--fields"]);
		expect(result.code).toBe(0);
		expect(result.out.split("\n")).toEqual(describeFields());
		expect(result.out).toContain("testMessages[].addressIsSecondNumber: always true");
	});

	it("runs as a process from any folder, reading stdin bytes", async () => {
		const script = fileURLToPath(new URL("../src/receive-report.ts", import.meta.url));
		const runProcess = (input: Buffer) =>
			new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
				const child = childProcess.spawn(process.execPath, [script, "--stdin", "--check"], {
					cwd: temp,
					windowsHide: true,
				});
				let out = "";
				let err = "";
				child.stdout.setEncoding("utf8").on("data", (text: string) => (out += text));
				child.stderr.setEncoding("utf8").on("data", (text: string) => (err += text));
				child.once("error", reject).once("close", (code) => resolve({ code, out, err }));
				child.stdin.end(input);
			});
		const valid = await runProcess(bytes(full));
		expect([valid.code, valid.err]).toEqual([0, ""]);
		expect(valid.out).toContain("receive-report: valid");
		const invalid = await runProcess(bytes({ ...full, probeVersion: "Your code is 482913" }));
		expect(invalid.code).toBe(1);
		expect(invalid.err).toContain("$.probeVersion: outside the allowed pattern");
		expect(invalid.err + invalid.out).not.toContain("482913");
	}, 30_000);
});
