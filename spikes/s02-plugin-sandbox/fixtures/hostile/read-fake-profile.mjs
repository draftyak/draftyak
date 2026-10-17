// Read an ordinary file in the fake profile, outside every grant, through several read APIs.
import fs from "node:fs";
import { attempt, config, report, start } from "./_util.mjs";
start("read-fake-profile");
const c = config();
report([
	await attempt(() => fs.readFileSync(c.fakeFile, "utf8")),
	await attempt(() => fs.promises.readFile(c.fakeFile, "utf8")),
	await attempt(() => fs.readdirSync(c.fakeDir).join(",")),
]);
