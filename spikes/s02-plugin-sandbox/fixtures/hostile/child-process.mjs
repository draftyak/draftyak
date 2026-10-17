// child_process has no grant (--allow-child-process is on the never-list).
import cp from "node:child_process";
import { attempt, config, report, start } from "./_util.mjs";
start("child-process");
config();
report([
	await attempt(() => { const r = cp.spawnSync(process.execPath, ["-e", "0"]); if (r.error) throw r.error; return `status=${r.status}`; }),
	await attempt(() => cp.execSync("echo dy", { encoding: "utf8" })),
	await attempt(() => new Promise((res, rej) => { const child = cp.fork(process.execPath, ["-e", "0"]); child.once("spawn", () => res("forked")); child.once("error", rej); })),
]);
