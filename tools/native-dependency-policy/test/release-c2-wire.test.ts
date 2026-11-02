import { describe, expect, it } from "vitest";
import { C2Error } from "../src/release-c2-data.ts";
import { parseC2Api, parseC2Dependencies, parseC2Index } from "../src/release-c2-wire.ts";
import {
	apiDependency,
	apiVersion,
	encode,
	indexDependency,
	indexVersion,
} from "./fixtures/release-c2.ts";

describe("bounded C2 wire projection", () => {
	it("selects literal API facts and separately attributed index feature tables/alias states", () => {
		const a = parseC2Api(
			encode({ crate: { id: "glib", name: "glib" }, versions: [apiVersion("glib", "1.0.0")] }),
			"glib",
		);
		const row = {
			...indexVersion("glib", "1.0.0"),
			v: 2,
			features2: { extra: ["dep:synthetic_dep"] },
		};
		const b = parseC2Index(new TextEncoder().encode(`${JSON.stringify(row)}\n`), "glib");
		expect(a[0]?.publication.epochNanoseconds).toBe("1735689600123456789");
		expect(a[0]?.license).toBe("MIT");
		expect(b[0]?.featureEncoding.features2.state).toBe("value");
		expect(b[0]?.dependencies[0]?.package).toEqual({ state: "value", value: "synthetic_dep" });
	});
	it.each(["1", "9007199254740991"])("retains actual supported row id %s", (token) => {
		const raw = JSON.stringify({ dependencies: [apiDependency()] }).replace(
			'"id":1',
			`"id":${token}`,
		);
		expect(parseC2Dependencies(new TextEncoder().encode(raw), "glib", "1.0.0")[0]?.rowId).toBe(
			Number(token),
		);
	});
	it.each([
		"9007199254740991.1",
		"9007199254740990.9",
		"1.0",
		"1e0",
		"0",
		"-0",
		"-1",
		"9007199254740992",
		'"1"',
		"null",
	])("refuses unsupported exact wire id %s", (token) => {
		const raw = JSON.stringify({ dependencies: [apiDependency()] }).replace(
			'"id":1',
			`"id":${token}`,
		);
		expect(() => parseC2Dependencies(new TextEncoder().encode(raw), "glib", "1.0.0")).toThrow(
			C2Error,
		);
	});
	it("refuses missing/repeated identities even when tuple counts could match", () => {
		const missing: Record<string, unknown> = { ...apiDependency() };
		delete missing.id;
		for (const dependencies of [[missing], [apiDependency(), apiDependency()]])
			expect(() => parseC2Dependencies(encode({ dependencies }), "glib", "1.0.0")).toThrow(C2Error);
		const r = indexVersion("glib", "1.0.0");
		r.deps.push({ ...indexDependency(), req: "^2.0" });
		expect(() => parseC2Index(encode(r), "glib")).toThrow(C2Error);
	});
	it.each(["registry", "name", "rename", "package", "explicit_name", "explicit_name_in_toml"])(
		"refuses changed API attribution schema %s",
		(key) => {
			expect(() =>
				parseC2Dependencies(
					encode({ dependencies: [{ ...apiDependency(), [key]: null }] }),
					"glib",
					"1.0.0",
				),
			).toThrow(C2Error);
		},
	);
	it("refuses duplicate inventories, mismatched names, missing licences and pagination", () => {
		const row = apiVersion("glib", "1.0.0");
		for (const root of [
			{ crate: { id: "glib", name: "glib" }, versions: [row, row] },
			{ crate: { id: "glib", name: "other" }, versions: [row] },
			{ crate: { id: "glib", name: "glib" }, versions: [row], meta: {} },
			{ crate: { id: "glib", name: "glib" }, versions: [{ ...row, license: undefined }] },
		])
			expect(() => parseC2Api(encode(root), "glib")).toThrow(C2Error);
	});
	it("refuses unsupported index encodings, source identities, registry and malformed bytes", () => {
		const r = indexVersion("glib", "1.0.0");
		for (const row of [
			{ ...r, v: 3 },
			{ ...r, features2: {} },
			{ ...r, deps: [{ ...indexDependency(), kind: null }] },
			{ ...r, deps: [{ ...indexDependency(), target: undefined }] },
			{ ...r, deps: [{ ...indexDependency(), registry: "https://example.invalid/index" }] },
		])
			expect(() => parseC2Index(encode(row), "glib")).toThrow(C2Error);
		for (const bytes of [
			new Uint8Array([255]),
			new TextEncoder().encode('{"name":"glib","name":"glib"}'),
			new TextEncoder().encode(`${JSON.stringify(r)}\n\n`),
		])
			expect(() => parseC2Index(bytes, "glib")).toThrow(C2Error);
	});
});
