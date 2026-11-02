import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	type BigIntStats,
	existsSync,
	lstatSync,
	mkdtempSync,
	realpathSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const source = fileURLToPath(new URL("../src/manifest.ts", import.meta.url));
const packageRoot = path.dirname(path.dirname(source));
const temporary = realpathSync.native(tmpdir());
const prefix = "draftyak-manifest-entry-";
const fixtures: { root: string; stat: BigIntStats; link: string | undefined }[] = [];

function fixture(): { root: string; linkedEntry: string } {
	const root = realpathSync.native(mkdtempSync(path.join(temporary, prefix)));
	const record = {
		root,
		stat: lstatSync(root, { bigint: true }),
		link: undefined as string | undefined,
	};
	fixtures.push(record);
	const link = path.join(root, "packaging");
	symlinkSync(packageRoot, link, process.platform === "win32" ? "junction" : "dir");
	record.link = link;
	assert.equal(realpathSync.native(link), packageRoot);
	return { root, linkedEntry: path.join(link, "src", "manifest.ts") };
}

afterEach(() => {
	for (const { root, stat, link } of fixtures.splice(0)) {
		const current = lstatSync(root, { bigint: true });
		assert.equal(path.dirname(root), temporary);
		assert(path.basename(root).startsWith(prefix));
		assert.equal(realpathSync.native(root), root);
		assert(current.isDirectory() && !current.isSymbolicLink());
		for (const field of ["dev", "ino", "birthtimeNs"] as const)
			assert.equal(current[field], stat[field]);
		if (link !== undefined) {
			assert(lstatSync(link).isSymbolicLink());
			assert.equal(realpathSync.native(link), packageRoot);
			if (process.platform === "win32") rmdirSync(link);
			else unlinkSync(link);
			assert.equal(existsSync(link), false);
			assert(lstatSync(packageRoot).isDirectory());
		}
		rmSync(root, { recursive: true, force: false });
		assert.equal(existsSync(root), false);
	}
});

function run(cwd: string, args: readonly string[]) {
	const environment: NodeJS.ProcessEnv = { DO_NOT_TRACK: "1", TURBO_TELEMETRY_DISABLED: "1" };
	for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"])
		if (process.env[name] !== undefined) environment[name] = process.env[name];
	const result = spawnSync(process.execPath, ["--disable-sigusr1", ...args], {
		cwd,
		env: environment,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
		windowsHide: true,
		shell: false,
	});
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	return result;
}

for (const linked of [false, true]) {
	const name = linked ? "linked" : "direct";
	it(`runs manifest --help from its ${name} entry`, () => {
		const f = fixture();
		const result = run(f.root, [linked ? f.linkedEntry : source, "--help"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/^usage: node tools\/packaging\/src\/manifest\.ts /);
		expect(result.stderr).toBe("");
	});
	it(`refuses missing manifest arguments from its ${name} entry`, () => {
		const f = fixture();
		const result = run(f.root, [linked ? f.linkedEntry : source]);
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/^usage: node tools\/packaging\/src\/manifest\.ts /);
	});
}

it("imports the manifest module without running the command", () => {
	const f = fixture();
	const result = run(f.root, [
		"--input-type=module",
		"--eval",
		`await import(${JSON.stringify(pathToFileURL(source).href)});`,
	]);
	expect(result.status).toBe(0);
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe("");
});
