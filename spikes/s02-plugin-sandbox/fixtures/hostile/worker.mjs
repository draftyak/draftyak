// A Worker created with execArgv: [] would run outside the permission model, so --allow-worker is on
// the never-list and new Worker throws ERR_ACCESS_DENIED.
import { Worker } from "node:worker_threads";
import { attempt, config, report, start } from "./_util.mjs";
start("worker");
config();
report([await attempt(() => new Promise((res, rej) => {
	const w = new Worker("process.exit(0)", { eval: true, execArgv: [] });
	w.once("online", () => res("online"));
	w.once("error", rej);
	w.once("exit", (code) => res(`exit:${code}`));
}))]);
