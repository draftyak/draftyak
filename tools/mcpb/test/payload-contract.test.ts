import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, test, vi } from "vitest";
import { McpbError, planMcpbBundle } from "../index.mjs";

// Rebind only the producer's exported contract to distinguish consumption from literals.
vi.mock("@draftyak/cli/payload-contract", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@draftyak/cli/payload-contract")>();
	return {
		...actual,
		CLI_PAYLOAD: Object.freeze({
			...actual.CLI_PAYLOAD,
			entry: "synthetic.mjs",
			exportName: "runSynthetic",
			minimumExit: 4,
			maximumExit: 9,
		}),
	};
});

const roots: string[] = [];
function directory() {
	const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-mcpb-contract-")));
	roots.push(root);
	return root;
}
afterAll(() => {
	for (const root of roots) {
		assert.equal(path.dirname(root), realpathSync.native(tmpdir()));
		assert.ok(path.basename(root).startsWith("draftyak-mcpb-contract-"));
		assert.equal(realpathSync.native(root), root);
		assert.equal(lstatSync(root).isSymbolicLink(), false);
		rmSync(root, { recursive: true, force: true });
	}
});
function plan(entry: string, result = "7") {
	const sourceRoot = directory();
	const bytes = Buffer.from(
		`export async function runSynthetic(args){ console.log(JSON.stringify(args)); return ${result}; }\n`,
	);
	const file = path.join(sourceRoot, ...entry.split("/"));
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, bytes);
	return planMcpbBundle({
		sourceRoot,
		entryPoint: entry,
		version: "0.0.1",
		artifacts: [
			{ path: entry, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
		],
	});
}
function launch(bundle: ReturnType<typeof plan>) {
	const root = directory(),
		bytes = bundle.bytes();
	for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50; ) {
		const size = bytes.readUInt32LE(at + 18),
			length = bytes.readUInt16LE(at + 26);
		const extra = bytes.readUInt16LE(at + 28),
			start = at + 30 + length + extra;
		const file = path.join(root, bytes.subarray(at + 30, at + 30 + length).toString("utf8"));
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, bytes.subarray(start, start + size));
		at = start + size;
	}
	const child = spawnSync(
		process.execPath,
		[
			"--disable-sigusr1",
			path.join(root, "server/launch.mjs"),
			"mcp",
			"--client",
			"claude-desktop",
		],
		{
			env: { SystemRoot: process.env.SystemRoot, NODE_OPTIONS: "", NODE_PATH: "" },
			encoding: "utf8",
			timeout: 5000,
			windowsHide: true,
		},
	);
	assert.equal(child.error, undefined);
	assert.equal(child.stderr, "");
	assert.deepEqual(JSON.parse(child.stdout), ["mcp", "--client", "claude-desktop"]);
	return child.status;
}

test("consumer takes the entry basename and export from the producer contract with explicit stage prefixes", () => {
	for (const entry of ["synthetic.mjs", "compiled/synthetic.mjs"])
		assert.equal(launch(plan(entry)), 7);
	for (const entry of ["main.mjs", "compiled/main.mjs"])
		assert.throws(
			() => plan(entry),
			(error) => error instanceof McpbError,
		);
});

test("consumer generates both inclusive exit bounds from the producer contract", () => {
	for (const code of [4, 9]) assert.equal(launch(plan("synthetic.mjs", String(code))), code);
	for (const code of [3, 10, 4.5, '"4"', "NaN", "undefined"])
		assert.equal(launch(plan("synthetic.mjs", String(code))), 1);
});
