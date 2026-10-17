import { execFile } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Harness, harness } from "./harness.ts";

let open: Harness | undefined;
afterEach(async () => {
	await open?.close();
	open = undefined;
});

// Plugins run with --disallow-code-generation-from-strings (§4): the SDK and zod must not need eval.
// The child lives as long as the test: its signal ends it on a timeout.
it("drafts in a process that can't generate code from strings", async ({ signal }) => {
	open = await harness();
	const child = path.join(import.meta.dirname, "draft-child.ts");
	const flags = ["--disallow-code-generation-from-strings", child, open.fake.url];
	const output = await new Promise<string>((resolve, reject) => {
		const run = execFile(process.execPath, flags, { signal }, (error, stdout, stderr) =>
			error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout),
		);
		run.stdin?.end(open?.key);
	});
	expect(JSON.parse(output)).toEqual({ kind: "draft", verdicts: [{ ok: true }] });
	expect(open.fake.received).toHaveLength(1);
});
