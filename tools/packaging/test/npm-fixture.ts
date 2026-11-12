import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HUB_MIGRATION_FILES } from "../../bundle-hub/src/hub-migrations.ts";
import { inventoryOf } from "../../bundle-hub/src/inventory.ts";
import { canonicalLauncher } from "../../bundle-hub/src/launcher.ts";
import { removeFixture } from "./temp.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const cache = path.join(repo, "tools/packaging/.cache");
export const fixtureTargets: readonly string[] = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"linuxmusl-arm64",
	"linuxmusl-x64",
	"win32-arm64",
	"win32-x64",
];

export interface NpmFixture {
	readonly root: string;
	readonly bundle: string;
	readonly out: string;
	readonly repo: string;
	readonly version: string;
}

export function put(root: string, file: string, value: string): void {
	mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	writeFileSync(path.join(root, file), value);
}

export function refreshInventory(bundle: string, emptyDirectories: readonly string[] = []): void {
	const file = path.join(bundle, "inventory.json");
	if (existsSync(file)) rmSync(file);
	writeFileSync(file, JSON.stringify(inventoryOf(bundle, emptyDirectories)));
}

// These are synthetic structural fixtures; no hub, native addon or Python runtime is executed.
export function npmFixture(
	python = false,
	target: { platform: "win" | "linux" | "darwin"; arch: "x64" | "arm64" } = {
		platform: "linux",
		arch: "x64",
	},
): NpmFixture {
	mkdirSync(cache, { recursive: true });
	const root = mkdtempSync(path.join(cache, "npm-fixture-"));
	const bundle = path.join(root, "bundle");
	const source = path.join(root, "repo");
	const out = path.join(root, "artifacts");
	mkdirSync(out);
	const version = "0.1.0-rc.1";
	for (const file of ["LICENSE", "NOTICE"]) {
		mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
		copyFileSync(path.join(repo, file), path.join(source, file));
	}
	put(source, "apps/cli/package.json", JSON.stringify({ name: "@draftyak/cli", version }));
	put(bundle, "draftyak.mjs", "");
	writeFileSync(path.join(bundle, "draftyak.mjs"), canonicalLauncher().bytes);
	put(bundle, "cli/package.json", '{"type":"module"}\n');
	put(
		bundle,
		"cli/main.mjs",
		"export async function main(argv) { console.log(JSON.stringify({fixture:'synthetic npm packaging fixture; not product acceptance',flags:process.execArgv,args:argv})); return 0; }\n",
	);
	put(bundle, "hub/hub.mjs", "export const fixture = 'not a product hub';\n");
	put(bundle, "hub/spa/index.html", "<!doctype html><title>Fixture</title>");
	put(bundle, "hub/plugins/fixture/plugin.mjs", "export default {};\n");
	for (const file of HUB_MIGRATION_FILES)
		put(bundle, `hub/${file}`, "-- DYTEST structural SQL fixture\nSELECT 1;\n");
	put(
		bundle,
		"native/package.json",
		JSON.stringify({
			name: "better-sqlite3-multiple-ciphers",
			version: "13.0.3",
			main: "lib/index.js",
		}),
	);
	put(bundle, "native/LICENSE", "Synthetic native license fixture");
	put(bundle, "native/binding.gyp", '{"defines":["NAPI_VERSION=10"]}');
	for (const name of ["index", "database", "binding", "util", "sqlite-error", ...fixtureTargets])
		put(bundle, `native/lib/${name}.js`, "module.exports = {};\n");
	for (const name of [
		"aggregate",
		"backup",
		"explain",
		"function",
		"inspect",
		"pragma",
		"serialize",
		"table",
		"transaction",
		"wrappers",
	])
		put(bundle, `native/lib/methods/${name}.js`, "module.exports = {};\n");
	const selected = `${target.platform === "win" ? "win32" : target.platform}-${target.arch}`;
	put(bundle, `native/prebuilds/${selected}.node`, `synthetic ${selected}; never executed`);
	put(
		bundle,
		target.platform === "win" ? "node.exe" : "node",
		"synthetic staging Node provenance; never executed",
	);
	put(bundle, "LICENSE.node", "Synthetic Node license fixture");
	if (python) {
		put(
			bundle,
			"runtime-python/package.json",
			JSON.stringify({ name: "@draftyak/runtime-python", version }),
		);
		put(bundle, "runtime-python/shim.mjs", "// Synthetic shim, never executed.\n");
		put(bundle, "runtime-python/pyodide/fixture.wasm", "synthetic WASM, never executed");
		put(
			bundle,
			"runtime-python.inventory.json",
			JSON.stringify(inventoryOf(path.join(bundle, "runtime-python"))),
		);
	}
	put(
		bundle,
		"bundle.json",
		JSON.stringify({
			schemaVersion: 1,
			version,
			target,
			node: {
				version: "26.12.0",
				signer: "synthetic fixture signer",
				archiveSha256: "0".repeat(64),
				binary: target.platform === "win" ? "node.exe" : "node",
				license: "LICENSE.node",
			},
			hub: { entry: "hub/hub.mjs" },
			cli: { entry: "draftyak.mjs", main: "cli/main.mjs" },
			native: {
				name: "better-sqlite3-multiple-ciphers",
				version: "13.0.3",
				integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
				main: "native/lib/index.js",
				bindings: { [selected]: `native/prebuilds/${selected}.node` },
			},
			...(python
				? { python: { root: "runtime-python", inventory: "runtime-python.inventory.json" } }
				: {}),
		}),
	);
	refreshInventory(bundle);
	return { root, bundle, out, repo: source, version };
}

export function removeNpmFixture(fixture: NpmFixture): void {
	removeFixture(fixture.root, cache, "npm-fixture-");
}
