import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type BundleSpec, bundle, NATIVE_REQUIRED, parseSpec } from "../src/bundle.ts";
import * as inputs from "../src/inventory.ts";
import { hubMigrationFixture } from "./helpers/hub-migrations-fixture.ts";

const base = path.resolve(import.meta.dirname, "../.cache/python-input-not-created");
const refusal = "canonical Python runtime producer is unavailable";
const dependencySections = [
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
	"devDependencies",
	"bundledDependencies",
	"bundleDependencies",
];
const aliases = [
	"npm:@draftyak/runtime-python@0.1.0",
	"npm:@draftyak/runtime-python",
	"npm:@draftyak/runtime-python@>=0.1.0 <1.0.0",
	"workspace:@draftyak/runtime-python@*",
	" npm:@DraftYak/Runtime-Python@^0.1.0 ",
];
const record = (file: string, bytes = Buffer.from("synthetic inert input")) => ({
	path: file,
	bytes: bytes.length,
	sha256: inputs.digest(bytes),
});
function spec(): BundleSpec {
	return {
		schemaVersion: 1,
		version: "0.1.0",
		target: { platform: "linux", arch: "x64" },
		hub: {
			root: path.join(base, "hub"),
			files: [
				"hub.mjs",
				"spa/index.html",
				"plugins/fixture.mjs",
				...Object.keys(hubMigrationFixture()),
			].map((file) => record(file)),
		},
		native: {
			archive: path.join(base, "native.tgz"),
			files: NATIVE_REQUIRED.map((file) => record(file)),
		},
		node: { root: path.join(base, "node") },
	};
}
function noOutput() {
	const denied = (): never => {
		throw new Error("Unexpected lookup or output");
	};
	const spies = [
		vi.spyOn(fs, "lstatSync").mockImplementation(denied),
		vi.spyOn(fs, "openSync").mockImplementation(denied),
		vi.spyOn(fs, "mkdirSync").mockImplementation(denied),
		vi.spyOn(fs, "mkdtempSync").mockImplementation(denied),
		vi.spyOn(fs, "writeFileSync").mockImplementation(denied),
		vi.spyOn(fs, "renameSync").mockImplementation(denied),
	];
	syncBuiltinESMExports();
	return spies;
}
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
});

it.each([undefined, null, false, "runtime", {}, { root: base, files: [] }])(
	"refuses supplied Python declaration %j before lookup, copy or signature verification",
	async (python) => {
		const value = { ...spec(), python: python as BundleSpec["python"] };
		const signature = vi.fn(async () => "synthetic signer");
		const read = vi.spyOn(inputs, "regularBytes");
		const spies = noOutput();
		expect(() => parseSpec(value, base)).toThrow(refusal);
		await expect(bundle(value, path.join(base, "output"), { signature })).rejects.toThrow(refusal);
		expect(read).not.toHaveBeenCalled();
		expect(signature).not.toHaveBeenCalled();
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	},
);

it.each([
	"runtime-python/shim.mjs",
	"runtime-python.inventory.json",
	"node_modules/@draftyak/runtime-python/package.json",
	"plugins/fixture/RUNTIME-PYTHON/shim.mjs",
])("refuses recognized runtime payload %s without a declaration", async (file) => {
	const value = spec();
	const signature = vi.fn(async () => "synthetic signer");
	const spies = noOutput();
	await expect(
		bundle(
			{ ...value, hub: { ...value.hub, files: [...value.hub.files, record(file)] } },
			path.join(base, "output"),
			{ signature },
		),
	).rejects.toThrow(refusal);
	expect(signature).not.toHaveBeenCalled();
	for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

it.each([
	"runtime-python/shim.mjs",
	"runtime-python.inventory.json",
	"node_modules/@draftyak/runtime-python/package.json",
	"lib/RUNTIME-PYTHON/shim.mjs",
])(
	"refuses native runtime inventory %s before lookup, copy or signature verification",
	async (file) => {
		const value = spec();
		const altered = {
			...value,
			native: { ...value.native, files: [...value.native.files, record(file)] },
		};
		const signature = vi.fn(async () => "synthetic signer");
		const read = vi.spyOn(inputs, "regularBytes");
		const spies = noOutput();
		await expect(bundle(altered, path.join(base, "output"), { signature })).rejects.toThrow(
			refusal,
		);
		expect(() => parseSpec(altered, base)).toThrow(refusal);
		expect(read).not.toHaveBeenCalled();
		expect(signature).not.toHaveBeenCalled();
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	},
);

it.each(dependencySections.flatMap((section) => aliases.map((alias) => ({ section, alias }))))(
	"refuses explicit $section alias $alias before copying or signature verification",
	async ({ section, alias }) => {
		const value = spec();
		const bytes = Buffer.from(JSON.stringify({ [section]: { alias } }));
		const file = "plugins/fixture/package.json";
		const read = vi.spyOn(inputs, "regularBytes").mockReturnValue(bytes);
		const signature = vi.fn(async () => "synthetic signer");
		const spies = noOutput();
		await expect(
			bundle(
				{ ...value, hub: { ...value.hub, files: [...value.hub.files, record(file, bytes)] } },
				path.join(base, "output"),
				{ signature },
			),
		).rejects.toThrow(refusal);
		expect(read).toHaveBeenCalledExactlyOnceWith(path.join(value.hub.root, file));
		expect(signature).not.toHaveBeenCalled();
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	},
);

it.each(["bundledDependencies", "bundleDependencies"])(
	"refuses an explicit runtime alias in a %s array before copying",
	async (section) => {
		const value = spec();
		const bytes = Buffer.from(JSON.stringify({ [section]: [aliases[0]] }));
		const file = "plugins/fixture/package.json";
		vi.spyOn(inputs, "regularBytes").mockReturnValue(bytes);
		const signature = vi.fn(async () => "synthetic signer");
		const spies = noOutput();
		await expect(
			bundle(
				{ ...value, hub: { ...value.hub, files: [...value.hub.files, record(file, bytes)] } },
				path.join(base, "output"),
				{ signature },
			),
		).rejects.toThrow(refusal);
		expect(signature).not.toHaveBeenCalled();
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	},
);

it.each([
	{ dependencies: { alias: "npm:@draftyak/runtime-python-helper@0.1.0" } },
	{ optionalDependencies: { alias: "workspace:@draftyak/runtime-python-helper@*" } },
	{ peerDependencies: { alias: "^0.1.0" } },
	{ devDependencies: { alias: "https://example.invalid/@draftyak/runtime-python/archive.tgz" } },
	{ bundledDependencies: ["other-runtime"] },
	{ bundleDependencies: ["other-runtime"] },
])("retains unrelated package specs through Python admission %j", async (claim) => {
	const value = spec();
	const bytes = Buffer.from(JSON.stringify(claim));
	const file = "plugins/fixture/package.json";
	const read = vi.spyOn(inputs, "regularBytes").mockReturnValue(bytes);
	const signature = vi.fn(async () => "synthetic signer");
	const spies = noOutput();
	await expect(
		bundle(
			{ ...value, hub: { ...value.hub, files: [...value.hub.files, record(file, bytes)] } },
			path.join(base, "output"),
			{ signature },
		),
	).rejects.toThrow("Unexpected lookup or output");
	expect(read).toHaveBeenCalledExactlyOnceWith(path.join(value.hub.root, file));
	expect(spies[0]).toHaveBeenCalled();
	expect(signature).not.toHaveBeenCalled();
});

it.each([
	{ name: "@draftyak/runtime-python" },
	...["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"].map(
		(name) => ({ [name]: { "@draftyak/runtime-python": "0.1.0" } }),
	),
	{ bundledDependencies: ["@draftyak/runtime-python"] },
	{ bundleDependencies: ["@draftyak/runtime-python"] },
])("refuses recognized package claim %j before copying", async (claim) => {
	const value = spec();
	const bytes = Buffer.from(JSON.stringify(claim));
	const file = "plugins/fixture/package.json";
	const read = vi.spyOn(inputs, "regularBytes").mockReturnValue(bytes);
	const signature = vi.fn(async () => "synthetic signer");
	const spies = noOutput();
	await expect(
		bundle(
			{ ...value, hub: { ...value.hub, files: [...value.hub.files, record(file, bytes)] } },
			path.join(base, "output"),
			{ signature },
		),
	).rejects.toThrow(refusal);
	expect(read).toHaveBeenCalledExactlyOnceWith(path.join(value.hub.root, file));
	expect(signature).not.toHaveBeenCalled();
	for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});
