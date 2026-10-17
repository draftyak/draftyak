// node:sqlite is off (--no-experimental-sqlite), so it cannot be loaded at all (production code:
// ERR_UNKNOWN_BUILTIN_MODULE). The ATTACH target is a REAL SQLite database holding a canary row and
// sitting outside every grant, so if node:sqlite were ever enabled and ATTACH ignored the permission
// model this fixture would read the row and report "escaped". The control-sqlite run proves exactly
// that bypass on both Nodes, which is why --no-experimental-sqlite, not an fs check, is the defense.
import { attempt, config, report, start } from "./_util.mjs";
start("sqlite-attach");
const c = config();
report([
	await attempt(async () => {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(":memory:");
		db.exec(`ATTACH DATABASE '${c.vaultDb}' AS evil`);
		const row = db.prepare("SELECT v FROM evil.s").get();
		return row?.v === c.sqliteCanary ? "attach+read" : "attach";
	}),
]);
