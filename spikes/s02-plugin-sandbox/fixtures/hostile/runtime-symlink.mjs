// Make absolute and relative symlinks in the writable data dir, pointing at the MK stand-in and a
// pluginDir prefix sibling, then read through them. Creating the link needs the target's grant, and
// reading follows the link to its out-of-grant target, so both steps fail closed.
import fs from "node:fs";
import path from "node:path";
import { attempt, config, report, start } from "./_util.mjs";
start("runtime-symlink");
const c = config();
function makeAndRead(name, target, type) {
	const link = path.join(c.dataDir, name);
	try { fs.rmSync(link, { force: true }); } catch {}
	fs.symlinkSync(target, link, type);
	return fs.readFileSync(link, "utf8");
}
report([
	await attempt(() => makeAndRead("sym_abs_mk", c.mk, "file")),
	await attempt(() => makeAndRead("sym_rel_mk", path.relative(c.dataDir, c.mk), "file")),
	await attempt(() => makeAndRead("sym_abs_sibling", c.sibling, "file")),
]);
