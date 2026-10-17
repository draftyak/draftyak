// The inspector has no grant (--allow-inspector is on the never-list); the hub also runs
// --disable-sigusr1. Opening the inspector is refused.
import { attempt, config, report, start } from "./_util.mjs";
start("inspector");
config();
report([await attempt(async () => {
	const inspector = await import("node:inspector");
	inspector.open(0, "127.0.0.1", false);
	return `url=${inspector.url()}`;
})]);
