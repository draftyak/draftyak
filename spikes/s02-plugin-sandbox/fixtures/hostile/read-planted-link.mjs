// Not a production case: the harness plants a link named config.linkName INSIDE a grant (the plugin
// bundle for the pre-spawn control, or the writable data dir for the data-dir control) and runs this
// to confirm the Node permission model alone follows the link out of the grant. It reports a boolean
// match against the MK canary, never the bytes. Production spawns refuse a bundle link before this
// ever runs; the data dir is not scanned (see escape-matrix runDataDirLink).
import fs from "node:fs";
import path from "node:path";
import { attempt, config, report, start } from "./_util.mjs";
start("read-planted-link");
const c = config();
const base = c.linkBase ?? c.pluginDir;
const target = c.linkInner ? path.join(base, c.linkName, c.linkInner) : path.join(base, c.linkName);
report([
	await attempt(() => {
		const read = fs.readFileSync(target, "utf8");
		return read === c.mkCanary ? "read-matched-canary" : "read-other";
	}),
]);
