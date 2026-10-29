import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "..");
const workspace = path.resolve(packageRoot, "../..");

it("builds an inert public package root and real consumer declarations without packaged source", () => {
	const temporary = realpathSync.native(tmpdir());
	const root = mkdtempSync(path.join(temporary, "draftyak-bounded-public-"));
	const identity = lstatSync(root);
	const consumer = path.join(root, "published artifact");
	const installed = path.join(consumer, "node_modules/@draftyak/bounded-files");
	const output = path.join(installed, "dist");
	const environment: NodeJS.ProcessEnv = {
		SystemRoot: process.env.SystemRoot,
		TEMP: root,
		TMP: root,
		NO_COLOR: "1",
		DO_NOT_TRACK: "1",
		TURBO_TELEMETRY_DISABLED: "1",
	};
	const run = (args: readonly string[], cwd: string) =>
		spawnSync(process.execPath, [...args], {
			cwd,
			env: environment,
			encoding: "utf8",
			windowsHide: true,
			shell: false,
			timeout: 20_000,
			maxBuffer: 1024 * 1024,
		});
	const cleanup = (): void => {
		const current = lstatSync(root);
		if (
			path.dirname(root) !== temporary ||
			!path.basename(root).startsWith("draftyak-bounded-public-") ||
			current.isSymbolicLink() ||
			current.dev !== identity.dev ||
			current.ino !== identity.ino ||
			realpathSync.native(root) !== root
		)
			throw new Error("Unsafe public package fixture cleanup");
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	};
	try {
		mkdirSync(installed, { recursive: true });
		const build = run(
			[
				"--input-type=module",
				"--eval",
				`const { build } = await import("tsdown");
const { default: config } = await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, "tsdown.config.ts")).href)});
await build({ ...config, outDir: ${JSON.stringify(output)} });`,
			],
			packageRoot,
		);
		expect(build.error).toBeUndefined();
		expect(build.status, build.stderr).toBe(0);
		for (const file of ["index.mjs", "index.d.mts"])
			expect(lstatSync(path.join(output, file)).size).toBeGreaterThan(0);
		const metadata = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
		// Use the declared publication mapping over genuine isolated build output.
		writeFileSync(
			path.join(installed, "package.json"),
			JSON.stringify({ ...metadata, ...metadata.publishConfig }),
		);
		writeFileSync(path.join(consumer, "package.json"), '{"type":"commonjs"}');
		expect(existsSync(path.join(installed, "src"))).toBe(false);
		const runtime = run(
			[
				"--disable-sigusr1",
				"--permission",
				`--allow-fs-read=${consumer}`,
				"--input-type=module",
				"--eval",
				`import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
assert.equal(import.meta.resolve("@draftyak/bounded-files"), ${JSON.stringify(pathToFileURL(path.join(output, "index.mjs")).href)});
assert.throws(() => fs.readFileSync(${JSON.stringify(path.join(packageRoot, "src/index.ts"))}), { code: "ERR_ACCESS_DENIED" });
const denied = () => { throw Error("public import or predicate attempted filesystem, native or network activity"); };
for (const module of [net, tls, http, https])
 for (const name of Object.keys(module))
  if (typeof module[name] === "function") {
   const descriptor = Object.getOwnPropertyDescriptor(module, name);
   if (descriptor.configurable) Object.defineProperty(module, name, { value: denied, configurable: true, writable: true, enumerable: descriptor.enumerable });
   else { assert.equal(descriptor.writable, true, "runtime denial must cover the builtin method"); module[name] = denied; }
  }
process.dlopen = denied;
globalThis.fetch = denied;
syncBuiltinESMExports();
const api = await import("@draftyak/bounded-files");
assert.equal(typeof api.isKnownSyncedPath, "function", "compiled public root must export the canonical predicate");
assert.equal(typeof api.readBoundedRegularFile, "function");
assert.equal(api.isKnownSyncedPath("/dytest/OneDrive/account"), true);
assert.equal(api.isKnownSyncedPath("Library/CloudStorage/provider"), true);
assert.equal(api.isKnownSyncedPath("/dytest/local"), false);
assert.equal(api.isKnownSyncedPath("/dytest/OneDrive notes/account"), false);
assert.throws(() => api.isKnownSyncedPath({ toString: denied }), { message: "Path classification refused" });`,
			],
			consumer,
		);
		expect(runtime.error).toBeUndefined();
		expect(runtime.status, runtime.stderr).toBe(0);
		expect(runtime.stdout).toBe("");
		expect(runtime.stderr).toBe("");
		mkdirSync(path.join(consumer, "src"));
		writeFileSync(
			path.join(consumer, "src/main.mts"),
			`import { isKnownSyncedPath, readBoundedRegularFile, type BoundedReadOptions } from "@draftyak/bounded-files";
export const classify: (value: unknown) => boolean = isKnownSyncedPath;
export const read: (path: unknown, bounds: BoundedReadOptions) => Buffer = readBoundedRegularFile;
`,
		);
		writeFileSync(
			path.join(consumer, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ESNext",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					rootDir: "src",
					outDir: "out",
					declaration: true,
					types: ["node"],
					typeRoots: [path.join(workspace, "node_modules/@types")],
				},
				include: ["src/*.mts"],
			}),
		);
		const types = run(
			[path.join(workspace, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
			consumer,
		);
		expect(types.error).toBeUndefined();
		expect(types.status, `${types.stdout}${types.stderr}`).toBe(0);
		expect(existsSync(path.join(consumer, "out/main.d.mts"))).toBe(true);
	} finally {
		cleanup();
	}
});
