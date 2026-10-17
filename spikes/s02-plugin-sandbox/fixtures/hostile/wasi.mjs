// WASI has no grant (--allow-wasi is on the never-list): constructing a WASI instance is refused.
import { attempt, config, report, start } from "./_util.mjs";
start("wasi");
config();
report([await attempt(async () => {
	const { WASI } = await import("node:wasi");
	return new WASI({ version: "preview1" }) ? "constructed" : "null";
})]);
