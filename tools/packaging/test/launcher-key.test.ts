import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { canonicalLauncher } from "../../bundle-hub/src/launcher.ts";
import { removeFixture } from "./temp.ts";

const parent = realpathSync.native(path.resolve(import.meta.dirname, ".."));
const temporary: string[] = [];
const spawned = "DYTEST-unprotected-spawn";

afterEach(() => {
	for (const dir of temporary.splice(0)) removeFixture(dir, parent, ".launcher-key-");
});

function run(key?: readonly [string, string], protectedAlready = false) {
	const dir = mkdtempSync(path.join(parent, ".launcher-key-"));
	temporary.push(dir);
	const launcher = path.join(dir, "draftyak.mjs");
	const harness = path.join(dir, "harness.mjs");
	writeFileSync(launcher, canonicalLauncher().bytes);
	// Select the Windows branch without starting a replacement process. The no-key control proves
	// that the original spawn binding really reaches the sentinel after module synchronization.
	writeFileSync(
		harness,
		`import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
Object.defineProperty(process, "platform", { value: "win32" });
cp.spawn = () => { process.stderr.write(${JSON.stringify(spawned)}); process.exit(73); };
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(launcher).href)});
`,
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) =>
				!["NODE_OPTIONS", "NODE_PATH", "DRAFTYAK_MASTER_KEY"].includes(name.toUpperCase()),
		),
	);
	if (key) env[key[0]] = key[1];
	return spawnSync(
		process.execPath,
		[...(protectedAlready ? ["--disable-sigusr1"] : []), harness],
		{ env, encoding: "utf8", timeout: 10_000, maxBuffer: 4096, windowsHide: true, shell: false },
	);
}

it.each([
	["DRAFTYAK_MASTER_KEY", "DYTEST-inherited-key"],
	["DRAFTYAK_MASTER_KEY", ""],
	["draftyak_master_key", "DYTEST-inherited-key"],
	["draftyak_master_key", ""],
] as const)("refuses inherited %s before an unprotected Windows relaunch", (name, value) => {
	const child = run([name, value]);
	expect(child.status, child.stderr).toBe(1);
	expect(child.stdout).toBe("");
	expect(child.stderr).toContain("inherited DRAFTYAK_MASTER_KEY requires direct");
	expect(child.stderr).not.toContain(spawned);
	expect(child.stderr).not.toContain("DYTEST-inherited-key");
});

it("allows a key-free unprotected Windows launch to reach process creation", () => {
	const child = run();
	expect(child.status, child.stderr).toBe(73);
	expect(child.stderr).toBe(spawned);
});

it("keeps direct protected launch outside the inherited-key refusal", () => {
	const child = run(["DRAFTYAK_MASTER_KEY", "DYTEST-inherited-key"], true);
	expect(child.status, child.stderr).toBe(1);
	expect(child.stderr).toContain("built CLI payload is missing");
	expect(child.stderr).not.toContain("inherited DRAFTYAK_MASTER_KEY requires direct");
	expect(child.stderr).not.toContain(spawned);
	expect(child.stderr).not.toContain("DYTEST-inherited-key");
});
