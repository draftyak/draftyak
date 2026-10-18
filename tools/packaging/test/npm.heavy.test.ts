import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { assembleNpm } from "../src/npm.ts";
import { npmFixture, removeNpmFixture } from "./npm-fixture.ts";

it("installs the synthetic npm artifact offline and runs its protected launcher (not product acceptance)", () => {
	const fixture = npmFixture(false);
	try {
		const nodeDir = path.dirname(process.execPath);
		const npm = [
			path.join(nodeDir, "node_modules/npm/bin/npm-cli.js"),
			path.resolve(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
		].find((file) => existsSync(file));
		expect(
			npm,
			"npm-cli.js must exist in this Node installation; no shell shim is used",
		).toBeDefined();
		if (!npm) throw new Error("npm-cli.js is unavailable beside the Node installation");
		const archive = assembleNpm(fixture);
		const cache = path.join(fixture.root, "npm-cache");
		const install = path.join(fixture.root, "installed");
		const temp = path.join(fixture.root, "temp");
		mkdirSync(temp);
		mkdirSync(install);
		const userConfig = path.join(fixture.root, "empty-user.npmrc");
		const globalConfig = path.join(fixture.root, "empty-global.npmrc");
		writeFileSync(userConfig, "");
		writeFileSync(globalConfig, "");
		const env: NodeJS.ProcessEnv = Object.fromEntries(
			Object.entries(process.env).filter(
				([name]) =>
					!/^npm_config_/i.test(name) &&
					!/^(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS)$/i.test(name),
			),
		);
		env.TEMP = temp;
		env.TMP = temp;
		env.DO_NOT_TRACK = "1";
		const installed = spawnSync(
			process.execPath,
			[
				npm,
				"install",
				"--offline",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--update-notifier=false",
				"--package-lock=false",
				"--cache",
				cache,
				"--userconfig",
				userConfig,
				"--globalconfig",
				globalConfig,
				"--prefix",
				install,
				archive.file,
			],
			{
				cwd: fixture.root,
				env,
				encoding: "utf8",
				timeout: 60_000,
				maxBuffer: 1024 * 1024,
				windowsHide: true,
				shell: false,
			},
		);
		expect(installed.error).toBeUndefined();
		expect(installed.status, installed.stderr || installed.stdout).toBe(0);
		const pkgRoot = path.join(install, "node_modules/draftyak");
		const metadata = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
		expect(metadata.name).toBe("draftyak");
		expect(metadata.version).toBe(fixture.version);
		expect(metadata.scripts).toBeUndefined();
		expect(metadata.bin).toEqual({ draftyak: "cli/draftyak.mjs" });
		const args = ["fixture-probe", "literal;$(fixture)&`text`", "two words"];
		const launched = spawnSync(
			process.execPath,
			[path.join(pkgRoot, "cli/draftyak.mjs"), ...args],
			{
				cwd: install,
				env,
				encoding: "utf8",
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
				windowsHide: true,
				shell: false,
			},
		);
		expect(launched.error).toBeUndefined();
		expect(launched.status, launched.stderr).toBe(0);
		expect(JSON.parse(launched.stdout)).toEqual({
			fixture: "synthetic npm packaging fixture; not product acceptance",
			flags: ["--disable-sigusr1"],
			args,
		});
		console.log(
			"Offline npm fixture passed: local tgz installed with scripts disabled and isolated cache/config; installed launcher retained --disable-sigusr1 and exact arguments. This is fixture packaging validation, not product acceptance.",
		);
	} finally {
		removeNpmFixture(fixture);
	}
}, 80_000);
