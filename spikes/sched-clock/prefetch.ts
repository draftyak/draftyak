// Run by `pnpm m0:prefetch` from this folder: jiff-check's locked crates into Cargo's cache, so
// the heavy tests can build it offline at the gate.
import { spawnSync } from "node:child_process";

const fetched = spawnSync("cargo", ["fetch", "--locked"], {
	cwd: new URL("./jiff-check/", import.meta.url),
	stdio: "inherit",
	windowsHide: true,
});
if (fetched.error) console.error(`prefetch: cargo: ${fetched.error.message}`);
process.exitCode = fetched.status ?? 1;
