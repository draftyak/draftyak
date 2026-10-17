// Try to append to the fake .bashrc (outside every grant). The REAL rc file is only probed.
import fs from "node:fs";
import process from "node:process";
import { attempt, config, report, start } from "./_util.mjs";
start("write-bashrc");
const c = config();
const wrote = await attempt(() => {
	fs.appendFileSync(c.fakeRc, "\nexport DY=owned\n");
	return "wrote";
});
report([wrote], { realWriteAllowed: process.permission.has("fs.write", c.realRc) });
