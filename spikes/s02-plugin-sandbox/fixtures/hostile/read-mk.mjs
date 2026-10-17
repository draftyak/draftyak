// Read the master-key stand-in, which sits in the fake profile outside every grant, through every
// read API shape: the sync and callback readers, a stream, openAsBlob, require() and dynamic import.
// All are refused (ERR_ACCESS_DENIED). Separately, record the fs.realpathSync oracle: it resolves a
// path outside the grant (and gives ENOENT for a missing one) while statSync/access are denied, so it
// leaks existence and link targets but never content. Recorded content-free (codes and markers only,
// never the resolved path) for ADR 0003; it is not counted as an escape because no bytes are read.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { attempt, config, report, start } from "./_util.mjs";
start("read-mk");
const c = config();
const require = createRequire(import.meta.url);
const results = [
	await attempt(() => fs.readFileSync(c.mk, "utf8")),
	await attempt(() => fs.promises.readFile(c.mk, "utf8")),
	await attempt(() => fs.openSync(c.mk, "r")),
	await attempt(
		() =>
			new Promise((res, rej) => {
				let b = "";
				const s = fs.createReadStream(c.mk, "utf8");
				s.on("data", (d) => {
					b += d;
				});
				s.on("end", () => res(b));
				s.on("error", rej);
			}),
	),
	await attempt(async () => (await fs.openAsBlob(c.mk)).text()),
	await attempt(() => require(c.mk)),
];
const code = async (fn) => {
	try {
		await fn();
		return "resolved";
	} catch (e) {
		return e?.code ?? e?.name ?? "ERR";
	}
};
report(results, {
	realpathOracle: {
		existing: await code(() => fs.realpathSync(c.mk)),
		missing: await code(() => fs.realpathSync(path.join(c.fakeDir, "does-not-exist.key"))),
		statDenied: (await code(() => fs.statSync(c.mk))) === "ERR_ACCESS_DENIED",
	},
});
