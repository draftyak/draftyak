// A prefix sibling of the DATA grant: "<dataDir>-evil". In variant B the data dir is granted read and
// write, and the CVE-2026-58043 fix (Node >=26.5.1) means those grants must not cover a path that
// merely shares the data dir's string prefix. Both reading <dataDir>-evil.txt and writing into
// <dataDir>-evil/ are refused.
import fs from "node:fs";
import path from "node:path";
import { attempt, config, report, start } from "./_util.mjs";
start("data-sibling");
const c = config();
report([
	await attempt(() => fs.readFileSync(c.dataSibling, "utf8")),
	await attempt(() => {
		fs.writeFileSync(path.join(c.dataSiblingDir, "owned.txt"), "owned\n");
		return "wrote";
	}),
]);
