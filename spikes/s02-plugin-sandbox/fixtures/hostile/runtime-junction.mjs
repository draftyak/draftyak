// Windows only. Make a junction in the writable data dir to the directory holding the MK stand-in
// and to the pluginDir prefix-sibling dir (both outside every grant), then read a file through each.
// Creating the junction and/or the read through it is refused, because the permission model resolves
// the junction to its out-of-grant target.
import fs from "node:fs";
import path from "node:path";
import { attempt, config, report, start } from "./_util.mjs";
start("runtime-junction");
const c = config();
function junctionAndRead(name, targetDir, inner) {
	const link = path.join(c.dataDir, name);
	try {
		fs.rmSync(link, { recursive: true, force: true });
	} catch {}
	fs.symlinkSync(targetDir, link, "junction");
	return fs.readFileSync(path.join(link, inner), "utf8");
}
report([
	await attempt(() => junctionAndRead("jx_fake", c.fakeDir, path.basename(c.mk))),
	await attempt(() => junctionAndRead("jx_sibling", c.siblingDir, "secret.txt")),
]);
