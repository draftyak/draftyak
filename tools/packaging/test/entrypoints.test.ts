import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { removeFixture } from "./temp.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const fixtures: string[] = [];
function fixture(): string {
	const base = mkdtempSync(path.join(os.tmpdir(), "draftyak-entrypoints-"));
	fixtures.push(base);
	return base;
}
function linkedEntry(base: string, source: string): string {
	const linked = path.join(base, "linked-source");
	symlinkSync(path.dirname(source), linked, process.platform === "win32" ? "junction" : "dir");
	return path.join(linked, path.basename(source));
}
function child(args: readonly string[]): ReturnType<typeof spawnSync> {
	const env = { ...process.env };
	delete env.NODE_OPTIONS;
	delete env.NODE_PATH;
	return spawnSync(process.execPath, ["--disable-sigusr1", ...args], {
		env,
		encoding: "utf8",
		timeout: 5_000,
		maxBuffer: 4_096,
		windowsHide: true,
		shell: false,
	});
}
function healthPreload(base: string, event: "connect" | "error"): string {
	const file = path.join(base, "health-preload.mjs");
	// The child cannot connect to a real listener: replace the built-in before loading its entry.
	writeFileSync(
		file,
		`import {EventEmitter} from 'node:events';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
net.createConnection = (options) => {
  if (options.host !== '127.0.0.1' || options.port !== 47613) throw Error('Unexpected probe target');
  process.stdout.write('DYTEST-health-probe\\n');
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  queueMicrotask(() => socket.emit(${JSON.stringify(event)}, new Error('DYTEST-refusal')));
  return socket;
};
syncBuiltinESMExports();
`,
	);
	return pathToFileURL(file).href;
}
afterEach(() => {
	for (const base of fixtures.splice(0)) removeFixture(base, os.tmpdir(), "draftyak-entrypoints-");
});

describe("linked command entries", () => {
	it("runs the manifest entry through a linked directory instead of silently succeeding", () => {
		const base = fixture();
		const source = path.join(root, "tools/packaging/src/manifest.ts");
		const linked = linkedEntry(base, source);
		for (const [args, status] of [
			[["--help"], 0],
			[["--", "--help"], 0],
			[[], 2],
			[["--unknown"], 1],
		] as const) {
			const result = child([linked, ...args]);
			expect(result.status, String(result.stderr)).toBe(status);
			if (status === 0) {
				expect(result.stdout).toContain("usage: node tools/packaging/src/manifest.ts");
				expect(result.stderr).toBe("");
			} else {
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain(status === 2 ? "usage:" : "release-manifest:");
			}
		}
	});

	it.each([
		["connect", 0],
		["error", 1],
	] as const)("runs a linked health entry once and reports %s", (event, status) => {
		const base = fixture();
		const source = path.join(root, "docker/healthcheck.mjs");
		const linked = linkedEntry(base, source);
		const result = child(["--import", healthPreload(base, event), linked]);
		expect(result.status, String(result.stderr)).toBe(status);
		expect(result.stdout).toBe("DYTEST-health-probe\n");
		expect(result.stderr).toBe("");
	});

	it.each(["tools/packaging/src/manifest.ts", "docker/healthcheck.mjs"])(
		"keeps native and linked imports of %s inert",
		(file) => {
			const base = fixture();
			const source = path.join(root, file);
			const linked = linkedEntry(base, source);
			const preloadDirectory = path.join(base, "preload");
			mkdirSync(preloadDirectory);
			const preload = healthPreload(preloadDirectory, "error");
			for (const imported of [source, linked]) {
				const result = child([
					"--import",
					preload,
					"--input-type=module",
					"--eval",
					`await import(${JSON.stringify(pathToFileURL(imported).href)});`,
				]);
				expect(result.status, String(result.stderr)).toBe(0);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
			}
		},
	);
});
