// A prefix sibling of the read grant: "<pluginDir>-evil". The CVE-2026-58043 fix (Node >=26.5.1)
// means --allow-fs-read=<pluginDir> must not cover it.
import fs from "node:fs";
import { attempt, config, report, start } from "./_util.mjs";
start("prefix-sibling");
const c = config();
report([
	await attempt(() => fs.readFileSync(c.sibling, "utf8")),
	await attempt(() => fs.readdirSync(c.siblingDir)),
]);
