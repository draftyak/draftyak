import { readFileSync } from "node:fs";
import path from "node:path";
import { type Schema, Validator } from "@cfworker/json-schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { jsonSchemaOf } from "../scripts/export-spec.ts";
import { DataClass, HubDataClass, PluginDataClass } from "../src/data-class.ts";
import { HubErrorCode, PluginErrorCode, PluginErrorResult } from "../src/errors.ts";
import {
	Alias,
	Base64Url,
	boundedText,
	fromBase64Url,
	Iso8601Utc,
	Sha256Hex,
	toBase64Url,
	Ulid,
	UtcMs,
} from "../src/scalars.ts";
import { ENGINE_DEPENDENT, patterns } from "./vectors.ts";

// zod and the JSON Schema exported from it must agree on every sample.
function agree(schema: z.ZodType, json: Schema, accepted: unknown[], refused: unknown[]): void {
	for (const pattern of patterns(json)) expect(pattern).not.toMatch(ENGINE_DEPENDENT);
	const validator = new Validator(json, "2020-12", false);
	for (const sample of [...accepted, ...refused]) {
		const expected = accepted.includes(sample);
		expect(schema.safeParse(sample).success, `zod: ${JSON.stringify(sample)}`).toBe(expected);
		expect(validator.validate(sample).valid, `schema: ${JSON.stringify(sample)}`).toBe(expected);
	}
}
const exported = (schema: z.ZodType): Schema => jsonSchemaOf(schema) as Schema;

describe("the exported JSON Schema", () => {
	it("accepts what zod accepts as input: a defaulted field may be left out", () => {
		const defaulted = z.strictObject({ id: z.string(), runtime: z.enum(["node"]).default("node") });
		agree(
			defaulted,
			exported(defaulted),
			[{ id: "x" }, { id: "x", runtime: "node" }],
			[{ runtime: "node" }, { id: "x", runtime: "python" }, { id: "x", extra: 1 }],
		);
		const stripping = z.object({ a: z.string() });
		agree(stripping, exported(stripping), [{ a: "x" }, { a: "x", extra: 1 }], [{}, { a: 1 }]);
	});
});

describe("scalars", () => {
	it("Ulid: 26 upper-case Crockford characters, at most 7ZZ…", () => {
		agree(
			Ulid,
			exported(Ulid),
			["01JAZ3W3B6Q8M2V0G5T9K4X7RC", "7ZZZZZZZZZZZZZZZZZZZZZZZZZ", "00000000000000000000000000"],
			[
				"01jaz3w3b6q8m2v0g5t9k4x7rc",
				"8ZZZZZZZZZZZZZZZZZZZZZZZZZ",
				"01JAZ3W3B6Q8M2V0G5T9K4X7R",
				"01JAZ3W3B6Q8M2V0G5T9K4X7RI",
				"01JAZ3W3B6Q8M2V0G5T9K4X7RC\n",
				1,
			],
		);
		expect(exported(Ulid)).toMatchObject({ minLength: 26, maxLength: 26 });
	});

	it("Alias", () => {
		agree(
			Alias,
			exported(Alias),
			["gmail-1", "a", "9", `a${"b".repeat(31)}`],
			["", "-a", "Gmail-1", "a_b", `a${"b".repeat(32)}`, "a b", "gmail-1\n"],
		);
	});

	it("Sha256Hex: lower-case only", () => {
		const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
		agree(
			Sha256Hex,
			exported(Sha256Hex),
			[digest],
			[digest.toUpperCase(), digest.slice(1), `${digest}0`, `${digest}\n`],
		);
		expect(exported(Sha256Hex)).toMatchObject({ minLength: 64, maxLength: 64 });
	});

	it("Base64Url: unpadded and canonical, and fromBase64Url agrees (1,000 runs)", () => {
		agree(
			Base64Url,
			exported(Base64Url),
			["", "AA", "AAA", "AAAA", "_-8", "AQ", "AAE"],
			["A", "AB", "AAB", "AA==", "AA=", "A+/A", "AA A", "AA\n"],
		);
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 40 }), (bytes) => {
				const text = toBase64Url(bytes);
				expect(Base64Url.safeParse(text).success).toBe(true);
				expect(fromBase64Url(text)).toEqual(bytes);
			}),
			{ numRuns: 1000 },
		);
		for (const loose of ["AB", "AA==", "A", "!!!!"]) expect(fromBase64Url(loose)).toBeUndefined();
	});

	it("UtcMs: a non-negative safe integer", () => {
		agree(
			UtcMs,
			exported(UtcMs),
			[0, 1792000000000, Number.MAX_SAFE_INTEGER],
			[-1, 1.5, 2 ** 53, "1"],
		);
	});

	it("Iso8601Utc: milliseconds and Z in ASCII digits, as zod's datetime reads it (1,000 runs)", () => {
		agree(
			Iso8601Utc,
			exported(Iso8601Utc),
			[
				"2026-10-17T12:34:56.789Z",
				"2028-02-29T00:00:00.000Z",
				"2000-02-29T23:59:59.999Z",
				"0000-02-29T00:00:00.000Z",
			],
			[
				"2026-10-17T12:34:56Z",
				"2026-10-17T12:34:56.789+00:00",
				"2026-02-29T00:00:00.000Z",
				"1900-02-29T00:00:00.000Z",
				"2026-10-17T24:00:00.000Z",
				"2026-10-17t12:34:56.789z",
				"2026-10-17T12:34:56.789Z\n",
				"\u{662}\u{660}\u{662}\u{666}-10-17T12:34:56.789Z",
			],
		);
		expect(exported(Iso8601Utc)).toMatchObject({ minLength: 24, maxLength: 24 });
		const datetime = z.iso.datetime({ precision: 3 });
		const shaped = fc.stringMatching(
			/^[0-9]{4}-[01][0-9]-[0-3][0-9]T[0-2][0-9]:[0-6][0-9]:[0-6][0-9]\.[0-9]{3}Z$/,
		);
		const instant = fc.date({
			min: new Date("0000-01-01T00:00:00.000Z"),
			max: new Date("9999-12-31T23:59:59.999Z"),
			noInvalidDate: true,
		});
		fc.assert(
			fc.property(shaped, instant, (text, date) => {
				expect(Iso8601Utc.safeParse(text).success).toBe(datetime.safeParse(text).success);
				expect(Iso8601Utc.safeParse(date.toISOString()).success).toBe(true);
			}),
			{ numRuns: 1000 },
		);
	});

	it("boundedText counts code points, as JSON Schema's maxLength does", () => {
		const text = boundedText(3);
		agree(
			text,
			exported(text),
			["", "abc", "\u{1f600}\u{1f600}\u{1f600}"],
			["abcd", "\u{1f600}\u{1f600}ab"],
		);
	});
});

describe("errors", () => {
	it("PluginErrorCode holds the twelve codes, HubErrorCode the six", () => {
		expect(PluginErrorCode.options).toEqual([
			"AUTH_EXPIRED",
			"AUTH_REVOKED",
			"RATE_LIMITED",
			"QUOTA_EXCEEDED",
			"CURSOR_EXPIRED",
			"NOT_FOUND",
			"PERMISSION_DENIED",
			"TRANSIENT",
			"INVALID_INPUT",
			"UNSUPPORTED",
			"SEND_REJECTED",
			"SEND_UNCERTAIN",
		]);
		expect(HubErrorCode.options).toEqual([
			"DRAFT_LOCKED",
			"SCHEDULE_LIMIT",
			"SCHEDULING_UNAVAILABLE",
			"NONEXISTENT_LOCAL_TIME",
			"AMBIGUOUS_LOCAL_TIME",
			"RATE_LIMITED",
		]);
	});

	it("PluginErrorResult agrees with spec/schemas/plugin-error-v1.schema.json", () => {
		const file = path.resolve(
			import.meta.dirname,
			"../../../spec/schemas/plugin-error-v1.schema.json",
		);
		const json = JSON.parse(readFileSync(file, "utf8")) as Schema;
		agree(
			PluginErrorResult,
			json,
			[
				{ code: "TRANSIENT" },
				{ code: "RATE_LIMITED", retryAfterMs: 1500, detail: "slow down" },
				{ code: "SEND_UNCERTAIN", detail: "\u{1f600}".repeat(1000) },
			],
			[
				{},
				{ code: "OOPS" },
				{ code: "TRANSIENT", extra: 1 },
				{ code: "TRANSIENT", retryAfterMs: -1 },
				{ code: "TRANSIENT", retryAfterMs: 1.5 },
				{ code: "TRANSIENT", detail: "x".repeat(1001) },
				{ code: "TRANSIENT", detail: 7 },
			],
		);
	});
});

describe("DataClass", () => {
	// The SMS contract adds sms.* to the hub's classes by one line; a plugin never gets them.
	const sms = ["sms.metadata", "sms.content"];
	const smsIsHub = HubDataClass.safeParse("sms.content").success;

	it("holds the hub's classes from §3, sms.* aside", () => {
		expect(HubDataClass.options.filter((name) => !sms.includes(name))).toEqual([
			"gmail.metadata",
			"gmail.content",
			"slack.metadata",
			"slack.content",
			"tool.calendar.freebusy",
			"tool.contact.notes",
			"tool.kb.lookup",
			"credentials",
			"hub.state",
		]);
		expect(HubDataClass.safeParse("sms.metadata").success).toBe(smsIsHub);
	});

	it("takes plugins' own classes, never a name the hub uses", () => {
		for (const name of sms) expect(PluginDataClass.safeParse(name).success).toBe(false);
		agree(
			DataClass,
			exported(DataClass),
			[
				...HubDataClass.options,
				"hello.metadata",
				"hello-2.content",
				"acme.content",
				`${"a".repeat(32)}.content`,
			],
			[
				...(smsIsHub ? [] : sms),
				"tool.order.status",
				"tool.metadata",
				"hub.content",
				"credentials.metadata",
				"gmail.state",
				"Hello.metadata",
				"9hello.metadata",
				"a.b.metadata",
				`${"a".repeat(33)}.content`,
				"hello.",
				"",
			],
		);
	});
});
