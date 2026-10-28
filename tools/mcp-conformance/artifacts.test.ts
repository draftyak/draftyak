import assert from "node:assert/strict";
import native, {
	appendFileSync,
	closeSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test, vi } from "vitest";
import {
	loadRun,
	MAX_CHECK_BYTES,
	MAX_DIRECTORY_ENTRIES,
	MAX_METADATA_BYTES,
	MAX_RUN_BYTES,
	readJson,
} from "./artifacts.ts";
import { CONFORMANCE_VERSION, ERAS, SCENARIOS } from "./policy.ts";

function fixture(ctx: TestContext): string {
	const directory = mkdtempSync(
		path.join(realpathSync.native(tmpdir()), "draftyak-conformance-bounds-"),
	);
	ctx.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(
		path.join(directory, "run.json"),
		JSON.stringify({
			era: ERAS[1],
			conformanceVersion: CONFORMANCE_VERSION,
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
			exitCode: 0,
		}),
	);
	return directory;
}
function scenario(directory: string, name: string): string {
	const target = path.join(directory, `server-${name}-2026-10-18T00-00-00-000Z`);
	mkdirSync(target);
	return path.join(target, "checks.json");
}

test("JSON caps reject excess bytes and unsafe budgets before allocating file-sized data", async (ctx) => {
	const directory = fixture(ctx),
		file = path.join(directory, "small.json");
	writeFileSync(file, "{}   ");
	assert.deepEqual(await readJson(file, 5), {});
	for (const limit of [4, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_CHECK_BYTES + 1])
		await assert.rejects(readJson(file, limit), { message: "Invalid conformance artifact file" });
	truncateSync(file, MAX_CHECK_BYTES + 1);
	await assert.rejects(readJson(file), { message: "Invalid conformance artifact file" });
});

test("receipt and checks files have separate fixed byte limits", async (ctx) => {
	const directory = fixture(ctx),
		file = scenario(directory, "tools-list");
	writeFileSync(file, "[]");
	assert.equal((await loadRun(directory, ERAS[1])).checks["tools-list"]?.length, 0);
	truncateSync(file, MAX_CHECK_BYTES + 1);
	await assert.rejects(loadRun(directory, ERAS[1]));
	rmSync(file);
	truncateSync(path.join(directory, "run.json"), MAX_METADATA_BYTES + 1);
	await assert.rejects(loadRun(directory, ERAS[1]));
});

test("directory iteration stops at its fixed count, including ignored names", async (ctx) => {
	const directory = fixture(ctx);
	for (let index = 0; index < MAX_DIRECTORY_ENTRIES; index++)
		writeFileSync(path.join(directory, `ignored-${index}`), "");
	await assert.rejects(loadRun(directory, ERAS[1]), {
		message: "Invalid conformance artifact directory",
	});
});

test("the aggregate era cap includes receipt bytes and all scenario artifacts", async (ctx) => {
	const directory = fixture(ctx),
		padding = Buffer.alloc(65_536, 0x20);
	const count = MAX_RUN_BYTES / MAX_CHECK_BYTES;
	for (const name of SCENARIOS[ERAS[1]].slice(0, count)) {
		const fd = openSync(scenario(directory, name), "w");
		try {
			writeSync(fd, "[]");
			for (let remaining = MAX_CHECK_BYTES - 2; remaining > 0; ) {
				const size = Math.min(remaining, padding.length);
				writeSync(fd, padding, 0, size);
				remaining -= size;
			}
		} finally {
			closeSync(fd);
		}
	}
	await assert.rejects(loadRun(directory, ERAS[1]), {
		message: "Invalid conformance artifact directory",
	});
});

test("growth during a same-fd read is refused without diagnostic contents", async (ctx) => {
	const directory = fixture(ctx),
		file = path.join(directory, "growing.json");
	writeFileSync(file, "{}");
	const original = native.readSync;
	let grew = false;
	vi.spyOn(native, "readSync").mockImplementation((...args: Parameters<typeof native.readSync>) => {
		const count = Reflect.apply(original, native, args) as number;
		if (!grew) {
			grew = true;
			appendFileSync(file, " CANARY_PRIVATE_CONTENT");
		}
		return count;
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(readJson(file, 32), { message: "Invalid conformance artifact file" });
		assert.equal(grew, true);
	} finally {
		vi.restoreAllMocks();
		syncBuiltinESMExports();
	}
});

test("artifact roots and scenario directories refuse symbolic links and junctions", async (ctx) => {
	const directory = fixture(ctx),
		target = path.join(directory, "target"),
		link = path.join(directory, "linked");
	mkdirSync(target);
	const metadata = JSON.parse(readFileSync(path.join(directory, "run.json"), "utf8"));
	metadata.args[8] = link;
	writeFileSync(path.join(target, "run.json"), JSON.stringify(metadata));
	writeFileSync(path.join(target, "checks.json"), "[]");
	symlinkSync(target, link, "junction");
	await assert.rejects(loadRun(link, ERAS[1]));
	const entry = path.join(directory, "server-tools-list-2026-10-18T00-00-00-000Z");
	symlinkSync(target, entry, "junction");
	await assert.rejects(loadRun(directory, ERAS[1]));
});

test("linked receipt and checks files refuse otherwise valid artifact trees", async (ctx) => {
	const directory = fixture(ctx);
	const receipt = path.join(directory, "run.json");
	const originalReceipt = path.join(directory, "original-receipt.json");
	writeFileSync(originalReceipt, readFileSync(receipt));
	rmSync(receipt);
	try {
		symlinkSync(originalReceipt, receipt, "file");
	} catch (error) {
		if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
			ctx.skip("file symlink creation is unavailable");
			return;
		}
		throw error;
	}
	await assert.rejects(loadRun(directory, ERAS[1]));
	rmSync(receipt);
	writeFileSync(receipt, readFileSync(originalReceipt));
	const checks = scenario(directory, "tools-list");
	const originalChecks = path.join(directory, "original-checks.json");
	writeFileSync(originalChecks, "[]");
	symlinkSync(originalChecks, checks, "file");
	await assert.rejects(loadRun(directory, ERAS[1]));
});

test("nonregular files, malformed JSON and malformed UTF-8 produce fixed safe errors", async (ctx) => {
	const directory = fixture(ctx),
		file = path.join(directory, "bad.json");
	await assert.rejects(readJson(directory), { message: "Invalid conformance artifact file" });
	for (const bytes of [Buffer.from("CANARY_PRIVATE_CONTENT"), Buffer.from([0x22, 0xff, 0x22])]) {
		writeFileSync(file, bytes);
		await assert.rejects(readJson(file), { message: "Invalid conformance artifact file" });
	}
});

test("untrusted hardlinked artifacts refuse even when their JSON contents are valid", async (ctx) => {
	const directory = fixture(ctx),
		file = path.join(directory, "original.json"),
		alias = path.join(directory, "alias.json");
	writeFileSync(file, "{}");
	assert.deepEqual(await readJson(file), {});
	linkSync(file, alias);
	await assert.rejects(readJson(file), { message: "Invalid conformance artifact file" });
	await assert.rejects(readJson(alias), { message: "Invalid conformance artifact file" });
	rmSync(alias);
	assert.deepEqual(await readJson(file), {});
});
