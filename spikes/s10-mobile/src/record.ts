// node src/record.ts [vitest args]: the heavy suite with strict skips that also writes this host's
// evidence/host-<platform>-<arch>.json. Other runs (verify:m0, CI) write no evidence.
import { spawn } from "node:child_process";
import path from "node:path";
import { spikeDir } from "./cargo.ts";

// Vitest gets Ctrl+C from the console itself; stay alive until it has shut down.
process.on("SIGINT", () => {});
const env = { ...process.env, DRAFTYAK_RECORD_EVIDENCE: "1" };
spawn(
	process.execPath,
	[path.join(spikeDir, "..", "kit", "run.ts"), "--heavy", "--strict", ...process.argv.slice(2)],
	{
		env,
		stdio: "inherit",
	},
)
	.once("error", (error) => {
		console.error(`record: ${error.message}`);
		process.exitCode = 2;
	})
	.once("close", (code) => {
		process.exitCode ??= code ?? 1;
	});
