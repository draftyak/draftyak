import assert from "node:assert/strict";
import native, { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type TestContext, test, vi } from "vitest";
import { loadRun, readJson } from "./artifacts.ts";
import { CONFORMANCE_VERSION, ERAS } from "./policy.ts";

function fixture(ctx: TestContext, base = tmpdir()): { directory: string; file: string } {
	const directory = mkdtempSync(path.join(realpathSync.native(base), "draftyak-conformance-path-"));
	ctx.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	mkdirSync(path.join(directory, "child"));
	const file = path.join(directory, "valid.json");
	writeFileSync(file, "{}");
	writeFileSync(
		path.join(directory, "run.json"),
		JSON.stringify({
			era: ERAS[1],
			conformanceVersion: CONFORMANCE_VERSION,
			exitCode: 0,
			args: [
				"server",
				"--url",
				"http://127.0.0.1:47613/mcp",
				"--suite",
				"all",
				"--spec-version",
				ERAS[1],
				"--output-dir",
				directory,
				"--expected-failures",
				"expected.json",
			],
		}),
	);
	const scenario = path.join(directory, "server-tools-list-2026-10-18T00-00-00-000Z");
	mkdirSync(scenario);
	writeFileSync(path.join(scenario, "checks.json"), "[]");
	return { directory, file };
}
function restore(): void {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
}

test("canonical file paths, native file URLs and a single directory separator remain valid", async (ctx) => {
	const { directory, file } = fixture(ctx);
	assert.deepEqual(await readJson(file), {});
	assert.deepEqual(await readJson(pathToFileURL(file)), {});
	assert.equal((await loadRun(directory, ERAS[1])).era, ERAS[1]);
	assert.equal((await loadRun(directory + path.sep, ERAS[1])).era, ERAS[1]);
});

test("relative and dot file spellings refuse before a file open can normalize them", async (ctx) => {
	const { directory, file } = fixture(ctx, process.cwd());
	const relative = path.relative(process.cwd(), file);
	assert.equal(path.isAbsolute(relative), false);
	assert.deepEqual(await readJson(file), {});
	let opens = 0;
	vi.spyOn(native, "openSync").mockImplementation(() => {
		opens++;
		throw new Error("Synthetic forbidden file open");
	});
	syncBuiltinESMExports();
	try {
		for (const selected of [
			relative,
			`${directory}${path.sep}.${path.sep}valid.json`,
			`${directory}${path.sep}child${path.sep}..${path.sep}valid.json`,
			`${file}\ud800`,
		])
			await assert.rejects(readJson(selected), { message: "Invalid conformance artifact file" });
		assert.equal(opens, 0);
	} finally {
		restore();
	}
});

test("invalid run directory spellings refuse before parent or child filesystem I/O", async (ctx) => {
	const { directory } = fixture(ctx, process.cwd());
	const relative = path.relative(process.cwd(), directory);
	assert.equal(path.isAbsolute(relative), false);
	assert.equal((await loadRun(directory, ERAS[1])).era, ERAS[1]);
	let calls = 0;
	const refused = (): never => {
		calls++;
		throw new Error("Synthetic forbidden filesystem I/O");
	};
	vi.spyOn(fs, "lstat").mockImplementation(refused);
	vi.spyOn(fs, "opendir").mockImplementation(refused);
	vi.spyOn(native, "lstatSync").mockImplementation(refused);
	vi.spyOn(native, "openSync").mockImplementation(refused);
	syncBuiltinESMExports();
	try {
		for (const selected of [
			relative,
			`${directory}${path.sep}.`,
			`${directory}${path.sep}child${path.sep}..`,
			directory + path.sep + path.sep,
			path.parse(directory).root + path.sep,
			`${directory}\ud800`,
			"//synthetic.invalid/share",
			"\\\\synthetic.invalid\\share",
			"\\\\synthetic.invalid\\share\\",
			"\\\\?\\C:\\synthetic",
			"C:\\synthetic:stream",
		])
			await assert.rejects(loadRun(selected, ERAS[1]), {
				message: "Invalid conformance artifact directory",
			});
		assert.equal(calls, 0);
	} finally {
		restore();
	}
});

test("non-file and network file URLs refuse before any file allocation", async (ctx) => {
	fixture(ctx);
	let calls = 0;
	vi.spyOn(native, "openSync").mockImplementation(() => {
		calls++;
		throw new Error("Synthetic forbidden URL open");
	});
	syncBuiltinESMExports();
	try {
		for (const selected of [
			new URL("https://synthetic.invalid/artifact.json"),
			new URL("file://synthetic.invalid/share/artifact.json"),
		])
			await assert.rejects(readJson(selected), { message: "Invalid conformance artifact file" });
		assert.equal(calls, 0);
	} finally {
		restore();
	}
});
