// node scripts/record.ts [vitest args]: the heavy suite with strict skips, recording
// evidence/boot-<target>.json for every target this machine runs. Other local heavy runs
// (verify:m0, plain test:heavy) leave the evidence alone.
import { spawn } from "node:child_process";
import path from "node:path";

// Vitest gets Ctrl+C from the console itself; stay alive until it has shut down.
process.on("SIGINT", () => {});
const run = path.join(import.meta.dirname, "..", "..", "kit", "run.ts");
const args = process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--");
spawn(process.execPath, [run, "--heavy", "--strict", ...args], {
	cwd: path.join(import.meta.dirname, ".."),
	env: { ...process.env, DRAFTYAK_RECORD_EVIDENCE: "1" },
	stdio: "inherit",
})
	.once("error", (error) => {
		console.error(`record: ${error.message}`);
		process.exitCode = 2;
	})
	.once("close", (code) => {
		process.exitCode ??= code ?? 1;
	});
