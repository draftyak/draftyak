// Not an escape attempt: the plugin reports its own exec argv, whether NODE_OPTIONS reached it, and
// whether it can still spawn a child. The harness runs it with a parent env that carries
// NODE_OPTIONS and asserts the child's argv equals the §4 allowlist exactly and NODE_OPTIONS is
// absent (plan §15 S2: "NODE_OPTIONS is not inherited, and the spawned argv equals the allowlist").
import cp from "node:child_process";
import { config, send, start } from "./_util.mjs";
start("argv-report");
config();
let childSpawned = false;
try {
	const r = cp.spawnSync(process.execPath, ["-e", "0"]);
	childSpawned = !r.error && r.status === 0;
} catch {
	childSpawned = false;
}
send({
	name: "argv-report",
	outcome: "report",
	execArgv: process.execArgv,
	nodeOptions: process.env.NODE_OPTIONS ?? null,
	childSpawned,
});
