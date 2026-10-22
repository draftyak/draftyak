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

const publicModules = [
	"ai-provider-v1",
	"channel-v1",
	"data-class",
	"date-pattern",
	"digests",
	"draft-output",
	"draft-output-text",
	"entities",
	"entities/account",
	"entities/account/channels",
	"entities/account/chat",
	"entities/account/email",
	"entities/audit",
	"entities/common",
	"entities/contact",
	"entities/conversation",
	"entities/conversation/channels",
	"entities/conversation/chat",
	"entities/conversation/email",
	"entities/device",
	"entities/draft",
	"entities/draft/channels",
	"entities/draft/chat",
	"entities/draft/email",
	"entities/fields",
	"entities/message",
	"entities/message/channels",
	"entities/message/chat",
	"entities/message/email",
	"entities/outbox",
	"entities/routing",
	"entities/settings",
	"entities/tool",
	"errors",
	"extension",
	"flags",
	"hash",
	"host-channel",
	"index",
	"jcs",
	"json-template",
	"manifest",
	"manifest/ai-http",
	"manifest/auth",
	"manifest/auth-fields",
	"manifest/egress",
	"manifest/json",
	"manifest/runtime",
	"manifest/text",
	"manifest/tool",
	"mcp",
	"mcp/completion",
	"mcp/errors",
	"mcp/prompts",
	"mcp/request-state",
	"mcp/resources",
	"mcp/results",
	"mcp/scopes",
	"mcp/tools",
	"mcp/views",
	"normalized-change",
	"pairing",
	"scalars",
	"schedule",
	"send-ticket",
	"sign",
	"snapshot",
	"statements",
	"statements/admin",
	"statements/agent-session",
	"statements/common",
	"statements/hub-key-rotate",
	"statements/login",
	"statements/pair-confirm",
	"statements/registry",
	"statements/send",
	"tool-v1",
	"tool-v1/bindings",
	"tool-v1/declaration",
	"tool-v1/egress",
	"tool-v1/kinds",
	"tool-v1/results",
];

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
		expect(manifest.exports).toEqual({
			".": "./src/index.ts",
			...Object.fromEntries(publicModules.map((name) => [`./${name}`, `./src/${name}.ts`])),
			"./plugin-argv": { node: "./src/plugin-argv.ts" },
			"./plugin-stdio": { node: "./src/plugin-stdio.ts" },
		});
		expect(manifest.publishConfig.exports).toEqual({
			".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" },
			...Object.fromEntries(
				publicModules.map((name) => [
					`./${name}`,
					{
						types: `./dist/${name}.d.mts`,
						default: `./dist/${name}.mjs`,
					},
				]),
			),
			"./plugin-argv": {
				node: { types: "./dist/plugin-argv.d.mts", default: "./dist/plugin-argv.mjs" },
			},
			"./plugin-stdio": {
				node: { types: "./dist/plugin-stdio.d.mts", default: "./dist/plugin-stdio.mjs" },
			},
		});
		const keys = [
			".",
			...[...publicModules, "plugin-argv", "plugin-stdio"].sort().map((name) => `./${name}`),
		];
		expect(Object.keys(manifest.exports)).toEqual(keys);
		expect(Object.keys(manifest.publishConfig.exports)).toEqual(keys);
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

	it("keeps registered definition IDs owned and identical across schema files", async () => {
		const seen = new Map<string, { file: string; definition: unknown }>();
		const visit = (value: unknown, file: string): void => {
			if (value === null || typeof value !== "object") return;
			if (Array.isArray(value)) {
				for (const child of value) visit(child, file);
				return;
			}
			const object = value as Record<string, unknown>;
			if (object.$defs !== undefined) {
				expect(object.$defs, file).not.toBeNull();
				expect(typeof object.$defs, file).toBe("object");
				expect(Array.isArray(object.$defs), file).toBe(false);
				for (const [id, definition] of Object.entries(object.$defs as Record<string, unknown>)) {
					expect(id, file).toMatch(/^draftyak\.[a-z0-9-]+\.[A-Z][A-Za-z0-9]*$/);
					const previous = seen.get(id);
					if (previous) {
						expect(definition, `${id}: ${previous.file} and ${file}`).toStrictEqual(
							previous.definition,
						);
					} else seen.set(id, { file, definition });
				}
			}
			for (const child of Object.values(object)) visit(child, file);
		};
		for (const { path: file, text } of await exportSpec()) {
			if (file !== "schemas/tool-v1.schema.json") visit(JSON.parse(text), file);
		}
		expect(seen.has("draftyak.normalized-change.ProviderId")).toBe(true);
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
