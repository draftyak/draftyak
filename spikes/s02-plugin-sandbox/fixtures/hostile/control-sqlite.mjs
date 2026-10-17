// Control, not a production case: the harness adds --experimental-sqlite to the §4 argv and runs this
// to show that node:sqlite's ATTACH opens a real database OUTSIDE every fs grant and reads a canary
// row, i.e. ATTACH is not gated by the permission model. That is why the production defense is
// --no-experimental-sqlite (module disable), not an fs check. Reports a boolean only, never the row.
import { config, send, start } from "./_util.mjs";
start("control-sqlite");
const c = config();
let moduleLoaded = false;
let attachRead = false;
let code = null;
try {
	const { DatabaseSync } = await import("node:sqlite");
	moduleLoaded = true;
	const db = new DatabaseSync(":memory:");
	db.exec(`ATTACH DATABASE '${c.vaultDb}' AS evil`);
	attachRead = db.prepare("SELECT v FROM evil.s").get()?.v === c.sqliteCanary;
} catch (error) {
	code = error?.code ?? error?.name ?? "ERR";
}
send({ name: "control-sqlite", outcome: "control", moduleLoaded, attachRead, code });
