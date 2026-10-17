// Native addons are disabled (--allow-addons is on the never-list): process.dlopen is refused.
import path from "node:path";
import { attempt, config, report, start } from "./_util.mjs";
start("addons");
const c = config();
report([await attempt(() => {
	const module = { exports: {} };
	process.dlopen(module, path.join(c.dataDir, "evil.node"));
	return "loaded";
})]);
