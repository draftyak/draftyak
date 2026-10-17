import { describe, expect, it } from "vitest";
import {
	ALLOWED_FLAGS,
	assertExecArgvAllowed,
	buildArgv,
	buildExecArgv,
	checkExecArgv,
	flagName,
	NEVER_FLAGS,
} from "../src/argv.ts";
import { scrubEnv } from "../src/spawn.ts";

describe("argv allowlist (snapshot)", () => {
	it("builds the node base exec argv (variant A) from §4's allowlist", () => {
		expect(buildExecArgv({ pluginDir: "/plugin" })).toMatchInlineSnapshot(`
			[
			  "--permission",
			  "--allow-fs-read=/plugin",
			  "--no-experimental-sqlite",
			  "--disable-sigusr1",
			  "--disallow-code-generation-from-strings",
			  "--max-old-space-size=256",
			]
		`);
	});

	it("adds only the data-dir grants for variant B", () => {
		expect(buildExecArgv({ pluginDir: "/plugin", dataDir: "/data" })).toMatchInlineSnapshot(`
			[
			  "--permission",
			  "--allow-fs-read=/plugin",
			  "--allow-fs-read=/data",
			  "--allow-fs-write=/data",
			  "--no-experimental-sqlite",
			  "--disable-sigusr1",
			  "--disallow-code-generation-from-strings",
			  "--max-old-space-size=256",
			]
		`);
	});

	it("builds the python exec argv with a second read grant and the wasm page cap", () => {
		expect(
			buildExecArgv({ runtime: "python", pluginDir: "/plugin", runtimeDir: "/runtime" }),
		).toMatchInlineSnapshot(`
			[
			  "--permission",
			  "--allow-fs-read=/plugin",
			  "--allow-fs-read=/runtime",
			  "--no-experimental-sqlite",
			  "--disable-sigusr1",
			  "--disallow-code-generation-from-strings",
			  "--max-old-space-size=256",
			  "--wasm-max-mem-pages=8192",
			]
		`);
	});

	it("appends the entry and its args after the flags", () => {
		expect(buildArgv({ pluginDir: "/plugin" }, "/plugin/entry.mjs", ["--conf", "x"])).toEqual([
			...buildExecArgv({ pluginDir: "/plugin" }),
			"/plugin/entry.mjs",
			"--conf",
			"x",
		]);
	});
});

describe("never-list", () => {
	it("includes --allow-worker and the whole VFS trio", () => {
		for (const flag of ["--allow-worker", "--allow-fs-vfs", "--experimental-vfs", "--vfs-load"]) {
			expect(NEVER_FLAGS).toContain(flag);
		}
	});

	it("includes every §4 never-list flag", () => {
		for (const flag of [
			"--allow-net",
			"--allow-child-process",
			"--allow-addons",
			"--allow-wasi",
			"--allow-inspector",
			"--allow-ffi",
			"--allow-openssl-store",
		]) {
			expect(NEVER_FLAGS).toContain(flag);
		}
	});

	it("keeps the allowlist and never-list disjoint", () => {
		const allowed = new Set(ALLOWED_FLAGS);
		expect(NEVER_FLAGS.filter((flag) => allowed.has(flag))).toEqual([]);
	});

	it("passes the three built argvs and rejects never-list, inspector and unknown flags", () => {
		expect(() => assertExecArgvAllowed(buildExecArgv({ pluginDir: "/p" }))).not.toThrow();
		expect(() =>
			assertExecArgvAllowed(buildExecArgv({ pluginDir: "/p", dataDir: "/d" })),
		).not.toThrow();
		expect(() =>
			assertExecArgvAllowed(
				buildExecArgv({ runtime: "python", pluginDir: "/p", runtimeDir: "/r" }),
			),
		).not.toThrow();
		expect(checkExecArgv(["--permission", "--allow-worker"])).toEqual([
			{ token: "--allow-worker", reason: "on-never-list" },
		]);
		expect(checkExecArgv(["--permission", "--allow-fs-vfs=/x"])).toEqual([
			{ token: "--allow-fs-vfs=/x", reason: "on-never-list" },
		]);
		expect(checkExecArgv(["--permission", "--inspect=9229"])).toEqual([
			{ token: "--inspect=9229", reason: "on-never-list" },
		]);
		expect(checkExecArgv(["--permission", "--experimental-wasm-everything"])).toEqual([
			{ token: "--experimental-wasm-everything", reason: "not-allowed" },
		]);
		expect(checkExecArgv(["--permission", "pluginDir"])).toEqual([
			{ token: "pluginDir", reason: "not-a-flag" },
		]);
	});

	it("names the flag by its part before =", () => {
		expect(flagName("--allow-fs-read=/plugin")).toBe("--allow-fs-read");
		expect(flagName("--permission")).toBe("--permission");
	});
});

describe("argv input validation", () => {
	it("rejects a non-absolute, wildcard, flag-shaped or separator-laden pluginDir", () => {
		for (const bad of ["*", "", "plugin", "./p", "../p", "-rf", "/p,/q", "/p=/q", "/p/*"]) {
			expect(() => buildExecArgv({ pluginDir: bad }), bad).toThrow(/absolute path/);
		}
		expect(() => buildExecArgv({ pluginDir: "/p", dataDir: "*" })).toThrow(/absolute path/);
		expect(() => buildArgv({ pluginDir: "/p" }, "--allow-child-process")).toThrow(/absolute path/);
		expect(() => buildArgv({ pluginDir: "/p" }, "relative/entry.mjs")).toThrow(/absolute path/);
	});

	it("rejects a data or runtime dir equal to or nested in pluginDir", () => {
		expect(() => buildExecArgv({ pluginDir: "/p", dataDir: "/p" })).toThrow(/disjoint/);
		expect(() => buildExecArgv({ pluginDir: "/p", dataDir: "/p/data" })).toThrow(/disjoint/);
		expect(() => buildExecArgv({ pluginDir: "/p/data", dataDir: "/p" })).toThrow(/disjoint/);
		expect(() =>
			buildExecArgv({ runtime: "python", pluginDir: "/p", runtimeDir: "/p/rt" }),
		).toThrow(/disjoint/);
		expect(() => buildExecArgv({ pluginDir: "/plugin", dataDir: "/plugin-data" })).not.toThrow();
	});

	it("flags a grant-everything value and a missing --permission", () => {
		expect(checkExecArgv(["--permission", "--allow-fs-read=*"])).toEqual([
			{ token: "--allow-fs-read=*", reason: "bad-grant-value" },
		]);
		expect(checkExecArgv(["--permission", "--allow-fs-read"])).toEqual([
			{ token: "--allow-fs-read", reason: "bad-grant-value" },
		]);
		expect(checkExecArgv(["--permission", "--allow-fs-write=/a,/b"])).toEqual([
			{ token: "--allow-fs-write=/a,/b", reason: "bad-grant-value" },
		]);
		expect(checkExecArgv(["--allow-fs-write=/d", "--allow-fs-read=/p"])).toContainEqual({
			token: "(exec argv)",
			reason: "missing-permission",
		});
	});
});

describe("scrubbed environment", () => {
	const parent = {
		LANG: "en_US.UTF-8",
		TZ: "UTC",
		SystemRoot: "C:\\Windows",
		NODE_OPTIONS: "--inspect",
		USERPROFILE: "C:\\Users\\owner",
		APPDATA: "C:\\Users\\owner\\AppData\\Roaming",
		USERNAME: "owner",
		PATH: "C:\\Users\\owner\\bin",
		SECRET_TOKEN: "xoxp-leak",
	} satisfies NodeJS.ProcessEnv;

	it("drops NODE_OPTIONS and every unlisted var, and points home and temp at the data dir (win)", () => {
		const env = scrubEnv({
			pluginId: "p",
			instanceId: "i",
			dataDir: "D:\\data",
			parentEnv: parent,
			platform: "win32",
		});
		expect(env.NODE_OPTIONS).toBeUndefined();
		expect(env.SECRET_TOKEN).toBeUndefined();
		expect([env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA, env.TEMP, env.TMP]).toEqual([
			"D:\\data",
			"D:\\data",
			"D:\\data",
			"D:\\data",
			"D:\\data",
		]);
		// libuv copies these from the parent unless set, so they are set empty, not omitted.
		expect([env.PATH, env.USERNAME, env.USERDOMAIN, env.LOGONSERVER]).toEqual(["", "", "", ""]);
		expect([env.SystemRoot, env.LANG, env.TZ]).toEqual(["C:\\Windows", "en_US.UTF-8", "UTC"]);
		expect([env.DRAFTYAK_PLUGIN_ID, env.DRAFTYAK_INSTANCE_ID]).toEqual(["p", "i"]);
		expect(Object.values(env).some((v) => v.includes("owner"))).toBe(false);
	});

	it("points HOME and TMPDIR at the data dir on posix and carries nothing else", () => {
		const env = scrubEnv({
			pluginId: "p",
			instanceId: "i",
			dataDir: "/srv/data",
			parentEnv: { HOME: "/home/owner", PATH: "/usr/bin" },
			platform: "linux",
		});
		expect([env.HOME, env.TMPDIR]).toEqual(["/srv/data", "/srv/data"]);
		expect(env.PATH).toBeUndefined();
		expect(Object.keys(env).toSorted()).toEqual([
			"DRAFTYAK_INSTANCE_ID",
			"DRAFTYAK_PLUGIN_ID",
			"HOME",
			"TMPDIR",
		]);
	});
});
