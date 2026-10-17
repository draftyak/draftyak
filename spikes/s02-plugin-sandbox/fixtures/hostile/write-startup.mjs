// Try to drop an autorun file in the fake Startup folder (outside every grant). The REAL Startup
// folder is only probed with permission.has('fs.write', p); it is never written.
import fs from "node:fs";
import process from "node:process";
import { attempt, config, report, start } from "./_util.mjs";
start("write-startup");
const c = config();
const wrote = await attempt(() => {
	fs.writeFileSync(`${c.fakeStartupDir}/dy-autorun.cmd`, "echo hi\n");
	return "wrote";
});
report([wrote], { realWriteAllowed: process.permission.has("fs.write", c.realStartup) });
