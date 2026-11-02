import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assembleNpm } from "../src/npm.ts";
import {
	type NpmFixture,
	npmFixture,
	put,
	refreshInventory,
	removeNpmFixture,
} from "./npm-fixture.ts";

const fixtures: NpmFixture[] = [];
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
function fixture(python = false) {
	const value = npmFixture(python);
	fixtures.push(value);
	return value;
}
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const value of fixtures.splice(0)) removeNpmFixture(value);
});
function refusesWithoutOutput(value: NpmFixture) {
	const denied = (): never => {
		throw new Error("Unexpected archive output");
	};
	const spies = [
		vi.spyOn(fs, "mkdirSync").mockImplementation(denied),
		vi.spyOn(fs, "mkdtempSync").mockImplementation(denied),
		vi.spyOn(fs, "writeFileSync").mockImplementation(denied),
		vi.spyOn(fs, "linkSync").mockImplementation(denied),
	];
	syncBuiltinESMExports();
	expect(() => assembleNpm(value)).toThrow(refusal);
	for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	expect(fs.readdirSync(value.out)).toEqual([]);
}

it.each([null, false, {}, { root: "runtime-python", inventory: "runtime-python.inventory.json" }])(
	"refuses a staged Python declaration %j without fabricating a dependency",
	(python) => {
		const f = fixture();
		const metadata = JSON.parse(fs.readFileSync(path.join(f.bundle, "bundle.json"), "utf8"));
		put(f.bundle, "bundle.json", JSON.stringify({ ...metadata, python }));
		refreshInventory(f.bundle);
		refusesWithoutOutput(f);
	},
);

it("refuses caller-generated runtime bytes and matching inventory", () => {
	refusesWithoutOutput(fixture(true));
});

it.each([
	"runtime-python/shim.mjs",
	"runtime-python.inventory.json",
	"hub/node_modules/@draftyak/runtime-python/package.json",
	"hub/plugins/fixture/RUNTIME-PYTHON/shim.mjs",
])("refuses freshly inventoried recognized runtime path %s without a declaration", (file) => {
	const f = fixture();
	put(f.bundle, file, "synthetic unsupported input; never executed");
	refreshInventory(f.bundle);
	refusesWithoutOutput(f);
});

it.each([
	{ name: "@draftyak/runtime-python" },
	...["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"].map(
		(name) => ({ [name]: { "@draftyak/runtime-python": "0.1.0" } }),
	),
	{ bundledDependencies: ["@draftyak/runtime-python"] },
	{ bundleDependencies: ["@draftyak/runtime-python"] },
])("refuses a recognized staged package claim %j without output", (claim) => {
	const f = fixture();
	put(f.bundle, "hub/plugins/fixture/package.json", JSON.stringify(claim));
	refreshInventory(f.bundle);
	refusesWithoutOutput(f);
});

it.each(dependencySections.flatMap((section) => aliases.map((alias) => ({ section, alias }))))(
	"refuses explicit staged $section alias $alias without output",
	({ section, alias }) => {
		const f = fixture();
		put(f.bundle, "hub/plugins/fixture/package.json", JSON.stringify({ [section]: { alias } }));
		refreshInventory(f.bundle);
		refusesWithoutOutput(f);
	},
);

it.each(["bundledDependencies", "bundleDependencies"])(
	"refuses an explicit runtime alias in a staged %s array without output",
	(section) => {
		const f = fixture();
		put(f.bundle, "hub/plugins/fixture/package.json", JSON.stringify({ [section]: [aliases[0]] }));
		refreshInventory(f.bundle);
		refusesWithoutOutput(f);
	},
);

it.each([
	{ dependencies: { alias: "npm:@draftyak/runtime-python-helper@0.1.0" } },
	{ optionalDependencies: { alias: "workspace:@draftyak/runtime-python-helper@*" } },
	{ peerDependencies: { alias: "^0.1.0" } },
	{ devDependencies: { alias: "https://example.invalid/@draftyak/runtime-python/archive.tgz" } },
	{ bundledDependencies: ["other-runtime"] },
	{ bundleDependencies: ["other-runtime"] },
])("retains unrelated staged dependency specs in Node-only output %j", (claim) => {
	const f = fixture();
	put(f.bundle, "hub/plugins/fixture/package.json", JSON.stringify(claim));
	refreshInventory(f.bundle);
	const artifact = assembleNpm(f);
	expect(artifact.bytes).toBeGreaterThan(0);
	expect(fs.existsSync(artifact.file)).toBe(true);
});
