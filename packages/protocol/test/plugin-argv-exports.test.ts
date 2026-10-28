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
import path from 'node:path';
const [specifier, load] = process.argv.slice(1);
try {
  import.meta.resolve(specifier);
  if (load === 'load') {
    const api = await import(specifier);
    const pluginDir = path.resolve('bundle');
    const spec = {pluginDir, entry:path.join(pluginDir,'main.mjs'), entryArgs:['--allow-net']};
    const argv = api.buildPluginArgv(spec);
    if (api.checkPluginArgv(argv, spec).length || argv.at(-1) !== '--allow-net') throw Error('Consumer mismatch');
    console.log(JSON.stringify({ok:true, floor:api.PLUGIN_NODE_MINIMUM_VERSION, below:api.isPluginNodeVersionSupported('26.5.0'), at:api.isPluginNodeVersionSupported('26.5.1')}));
  } else console.log(JSON.stringify({ok:true}));
} catch (error) {
  console.log(JSON.stringify({ok:false, code:error.code ?? error.message}));
}
`;

function consume(name: string, specifier: string, load = false): unknown {
	const cwd = directories.get(name);
	if (!cwd) throw new Error("Missing argv consumer fixture");
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
	temporary = mkdtempSync(path.join(tmpdir(), "draftyak-argv-exports-"));
	const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	for (const [name, exports] of [
		["source", manifest.exports],
		["packed", manifest.publishConfig.exports],
	] as const) {
		const directory = path.join(temporary, name);
		mkdirSync(path.join(directory, "src"), { recursive: true });
		writeFileSync(
			path.join(directory, "package.json"),
			JSON.stringify({ name: manifest.name, type: "module", exports }),
		);
		copyFileSync(path.join(root, "src/plugin-argv.ts"), path.join(directory, "src/plugin-argv.ts"));
		directories.set(name, directory);
	}
	const packed = directories.get("packed");
	if (!packed) throw new Error("Missing packed consumer");
	await build({
		config: false,
		entry: [path.join(root, "src/plugin-argv.ts")],
		outDir: path.join(packed, "dist"),
		unbundle: true,
		format: "esm",
		platform: "node",
		fixedExtension: true,
		dts: false,
	});
});

afterAll(() => {
	if (temporary) {
		rmSync(temporary, { recursive: true, force: true });
		expect(existsSync(temporary)).toBe(false);
	}
});

describe.each(["source", "packed"])("native Node %s argv consumer", (name) => {
	it("loads the canonical export and uses the actual builder/checker and version floor", () => {
		expect(consume(name, "@draftyak/protocol/plugin-argv", true)).toEqual({
			ok: true,
			floor: "26.5.1",
			below: false,
			at: true,
		});
	});

	it.each(["PLUGIN-ARGV", "Plugin-Argv", "plugin-argv/unknown", "plugin-argv\\unknown"])(
		"refuses unsupported subpath %s",
		(subpath) => {
			expect(consume(name, `@draftyak/protocol/${subpath}`)).toEqual({
				ok: false,
				code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
			});
		},
	);
});
