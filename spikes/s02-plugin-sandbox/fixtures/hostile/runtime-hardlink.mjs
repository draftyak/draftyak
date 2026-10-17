// Make a hard link in the writable data dir to the MK stand-in and to a prefix sibling, then read.
// Creating a hard link needs read on its (out-of-grant) source, so it is denied at creation.
import fs from "node:fs";
import path from "node:path";
import { attempt, config, report, start } from "./_util.mjs";
start("runtime-hardlink");
const c = config();
function linkAndRead(name, target) {
	const link = path.join(c.dataDir, name);
	try { fs.rmSync(link, { force: true }); } catch {}
	fs.linkSync(target, link);
	return fs.readFileSync(link, "utf8");
}
report([
	await attempt(() => linkAndRead("hard_mk", c.mk)),
	await attempt(() => linkAndRead("hard_sibling", c.sibling)),
]);
