import { generateKeyPairSync } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportSpec, syncSpec } from "../scripts/export-spec.ts";
import { keptSignature, sync, testKey } from "../scripts/lib.ts";
import { syncVectors } from "../scripts/vectors.ts";
import * as index from "../src/index.ts";
import { toBase64Url } from "../src/scalars.ts";
import { ENGINE_DEPENDENT, patterns, utf8 } from "./vectors.ts";

const modules = ["data-class", "errors", "hash", "jcs", "scalars", "sign"];

describe("the package", () => {
	it("re-exports exactly its modules from the index", async () => {
		const names = new Set<string>();
		for (const name of modules) {
			for (const key of Object.keys(await import(`../src/${name}.ts`))) names.add(key);
		}
		expect(Object.keys(index).toSorted()).toEqual([...names].toSorted());
	});

	it("exports TypeScript to the workspace and dist/ when packed", () => {
		const file = path.resolve(import.meta.dirname, "../package.json");
		const manifest = JSON.parse(readFileSync(file, "utf8"));
		expect(manifest.private).toBe(true);
		expect(manifest.exports).toEqual({ ".": "./src/index.ts", "./*": "./src/*.ts" });
		expect(manifest.publishConfig.exports).toEqual({
			".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" },
			"./*": { types: "./dist/*.d.mts", default: "./dist/*.mjs" },
		});
		expect(manifest.files).toEqual(["dist"]);
		expect(manifest.scripts).toMatchObject({ build: "tsdown", prepack: "tsdown" });
	});
});

describe("spec/", () => {
	it("holds every exported schema as generated", async () => {
		expect(await syncSpec(true)).toEqual([]);
		const outputs = await exportSpec();
		for (const { path: file, text } of outputs) {
			const schema = JSON.parse(text);
			expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
			expect(schema.$id).toBe(`https://draftyak.com/spec/${file}`);
			for (const pattern of patterns(schema)) expect(pattern, file).not.toMatch(ENGINE_DEPENDENT);
		}
	});

	it("holds every vector file as generated, recorded signatures included", async () => {
		expect(await syncVectors(true)).toEqual([]);
	});

	// .gitattributes stores everything under a vectors/ folder as is, generators included.
	it("keeps the vector generators in LF line endings", () => {
		const scripts = path.resolve(import.meta.dirname, "../scripts/vectors");
		for (const file of globSync("**/*.ts", { cwd: scripts })) {
			expect(readFileSync(path.join(scripts, file), "utf8"), file).not.toContain("\r");
		}
	});

	it("reports a changed, missing or orphaned file without writing", () => {
		const file = "schemas/plugin-error-v1.schema.json";
		expect(sync([{ path: file, text: "{}\n" }], [file], true)).toEqual([file]);
		expect(sync([], [file], true)).toEqual([file]);
		expect(sync([{ path: "schemas/none-v1.schema.json", text: "{}\n" }], [], true)).toEqual([
			"schemas/none-v1.schema.json",
		]);
		expect(() =>
			sync(
				[
					{ path: file, text: "" },
					{ path: file, text: "" },
				],
				[],
				true,
			),
		).toThrow();
	});
});

describe("the vector helpers", () => {
	it("keep a recorded P-256 test key and replace anything else", () => {
		const key = testKey(undefined);
		expect(key.record.testOnly).toBe(true);
		expect(testKey(key.record).record).toEqual(key.record);
		const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey;
		const others = [
			{ privateKeyPkcs8: toBase64Url(p384.export({ type: "pkcs8", format: "der" })) },
			{ privateKeyPkcs8: "AAAA" },
			{ privateKeyPkcs8: 1 },
			null,
		];
		for (const recorded of others) {
			const replaced = testKey(recorded).record;
			expect(replaced.publicKeySpki).not.toBe(key.record.publicKeySpki);
			expect(testKey(replaced).record).toEqual(replaced);
		}
	});

	it("keep a recorded signature only while it verifies", () => {
		const key = testKey(undefined);
		const input = utf8('draftyak/v1/login.v1\n{"v":1}');
		const signature = keptSignature(undefined, input, key);
		expect(keptSignature(signature, input, key)).toBe(signature);
		expect(keptSignature(signature, utf8('draftyak/v1/login.v1\n{"v":2}'), key)).not.toBe(
			signature,
		);
		expect(keptSignature(signature, input, testKey(undefined))).not.toBe(signature);
		const changed = `${signature.slice(0, -1)}${signature.endsWith("A") ? "Q" : "A"}`;
		expect(keptSignature(changed, input, key)).not.toBe(changed);
	});
});
