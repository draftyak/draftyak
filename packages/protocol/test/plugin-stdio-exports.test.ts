import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories = new Map<string, string>();
let temporary = "";
const probe = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [specifier, load] = process.argv.slice(1);
try {
  const resolved = import.meta.resolve(specifier);
  if (!existsSync(fileURLToPath(resolved))) throw new Error('Missing actual module');
  const exports = load === 'load' ? Object.keys(await import(specifier)).sort() : [];
  console.log(JSON.stringify({ ok: true, exports }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code ?? error.message }));
}
`;

function resolve(name: string, specifier: string, load = false): unknown {
	const cwd = directories.get(name);
	if (!cwd) throw new Error("Missing resolver fixture");
	return JSON.parse(
		execFileSync(
			process.execPath,
			["--input-type=module", "--eval", probe, specifier, load ? "load" : "resolve"],
			{
				cwd,
				encoding: "utf8",
				timeout: 10_000,
			},
		),
	);
}

beforeAll(async () => {
	temporary = mkdtempSync(path.join(tmpdir(), "draftyak-stdio-exports-"));
	const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	for (const [name, exports] of [
		["source", manifest.exports],
		["packed", manifest.publishConfig.exports],
	] as const) {
		const directory = path.join(temporary, name);
		mkdirSync(directory);
		writeFileSync(
			path.join(directory, "package.json"),
			JSON.stringify({ name: manifest.name, type: "module", exports }),
		);
		directories.set(name, directory);
	}
	const source = directories.get("source");
	const packed = directories.get("packed");
	if (!source || !packed) throw new Error("Missing resolver fixtures");
	// Copy only these ordinary modules; never traverse the protocol source tree.
	for (const file of [
		"index.ts",
		"hash.ts",
		"jcs.ts",
		"entities/audit.ts",
		"plugin-stdio.ts",
		"plugin-stdio/fifo.ts",
		"plugin-stdio/limits.ts",
	]) {
		const target = path.join(source, "src", file);
		mkdirSync(path.dirname(target), { recursive: true });
		copyFileSync(path.join(root, "src", file), target);
	}
	// Exercise the published map against real output from the package's pinned builder.
	await build({
		config: false,
		entry: ["index.ts", "hash.ts", "jcs.ts", "entities/audit.ts", "plugin-stdio.ts"].map((file) =>
			path.join(root, "src", file),
		),
		outDir: path.join(packed, "dist"),
		unbundle: true,
		format: "esm",
		platform: "node",
		fixedExtension: true,
		dts: false,
		deps: { neverBundle: ["zod"] },
	});
});

afterAll(() => {
	if (temporary) {
		rmSync(temporary, { recursive: true, force: true });
		expect(existsSync(temporary)).toBe(false);
	}
});

describe.each(["source", "packed"])("native Node %s export resolution", (name) => {
	it.each(
		["plugin-stdio", "PLUGIN-STDIO", "Plugin-Stdio"].flatMap((folder) =>
			["fifo", "limits"].map((module) => [folder, module] as const),
		),
	)("refuses private %s/%s with either separator", (folder, module) => {
		for (const separator of ["/", "\\"]) {
			expect(resolve(name, `@draftyak/protocol/${folder}${separator}${module}`, true)).toEqual({
				ok: false,
				code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
			});
		}
	});

	it("keeps the public Node entry loadable", () => {
		expect(resolve(name, "@draftyak/protocol/plugin-stdio", true)).toEqual({
			ok: true,
			exports: ["PLUGIN_STDIO_DRAIN_LIMIT", "PLUGIN_STDIO_PIPE_DRAIN_MS", "openPluginStdio"],
		});
	});

	it.each([
		"@draftyak/protocol",
		"@draftyak/protocol/hash",
		"@draftyak/protocol/jcs",
		"@draftyak/protocol/index",
		"@draftyak/protocol/entities/audit",
	])("preserves ordinary public module resolution: %s", (specifier) => {
		expect(resolve(name, specifier)).toEqual({ ok: true, exports: [] });
	});

	it.each(["plugin-stdio/unknown", "unknown/module"])(
		"refuses an unknown nested module: %s",
		(module) => {
			expect(resolve(name, `@draftyak/protocol/${module}`)).toEqual({
				ok: false,
				code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
			});
		},
	);
});
