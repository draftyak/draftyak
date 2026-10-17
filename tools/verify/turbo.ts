import path from "node:path";
import { run } from "./lib/spawn.ts";
import { resolveTurbo, telemetryOff } from "./lib/tools.ts";

// The root typecheck, test and build scripts run turbo through here, so telemetry is always off.
const root = path.resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
// pnpm passes the `--` of `pnpm test -- <flags>` through from bash and cmd, but not from PowerShell.
if (args[0] === "run" && args[2] === "--") args.splice(2, 1);
// turbo gets Ctrl+C from the console itself; stay alive until it has shut its tasks down.
process.on("SIGINT", () => {});
try {
	const turbo = { command: resolveTurbo(root), args };
	process.exitCode = await run(turbo, { env: { ...process.env, ...telemetryOff } });
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 2;
}
