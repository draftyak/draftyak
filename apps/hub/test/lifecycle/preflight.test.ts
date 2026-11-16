import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { inspect } from "node:util";
import { SNAPSHOT_UNICODE_VERSION } from "@draftyak/protocol/snapshot";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	checkLaunch,
	type LaunchInput,
	StartupRefusal,
	type StartupRefusalCode,
} from "../../src/lifecycle/preflight.ts";

const flagVariables = [
	"NODE_OPTIONS",
	"NODE_PATH",
	"NODE_PRESERVE_SYMLINKS",
	"NODE_COMPILE_CACHE",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	"NODE_EXTRA_CA_CERTS",
	"NODE_USE_SYSTEM_CA",
	"OPENSSL_CONF",
	"NODE_USE_ENV_PROXY",
	"NODE_ICU_DATA",
	"NODE_V8_COVERAGE",
	"NODE_REDIRECT_WARNINGS",
] as const;
const keyVariables = ["DRAFTYAK_MASTER_KEY", "CREDENTIALS_DIRECTORY"] as const;

const launch = (overrides: Partial<LaunchInput> = {}): LaunchInput => ({
	argv: [],
	execArgv: ["--disable-sigusr1"],
	unicodeVersion: SNAPSHOT_UNICODE_VERSION,
	temporal: Reflect.get(globalThis, "Temporal"),
	...overrides,
});

function refusal(input: LaunchInput): StartupRefusal {
	try {
		checkLaunch(input);
	} catch (error) {
		expect(error).toBeInstanceOf(StartupRefusal);
		return error as StartupRefusal;
	}
	return expect.unreachable("launch admitted");
}

function contentFree(error: StartupRefusal, canary: string): void {
	expect(error.message).toBe(error.code);
	expect(error.cause).toBeUndefined();
	for (const text of [
		error.message,
		String(error),
		String(error.stack),
		inspect(error, { showHidden: true, depth: null }),
		JSON.stringify(error),
	])
		expect(text).not.toContain(canary);
	expect(JSON.parse(JSON.stringify(error))).toEqual({
		name: "StartupRefusal",
		code: error.code,
	});
}

beforeEach(() => {
	for (const name of [...flagVariables, ...keyVariables]) vi.stubEnv(name, undefined);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it("admits the sidecar launch with Temporal and writes nothing", () => {
	const stdout = vi.spyOn(process.stdout, "write");
	const result = checkLaunch(launch({ unicodeVersion: process.versions.unicode }));
	expect(result).toEqual({ temporal: true });
	expect(Object.isFrozen(result)).toBe(true);
	expect(stdout).not.toHaveBeenCalled();
});

it.each([
	["a key-file flag", ["--key-file", "/run/secrets/master-key"]],
	["an inline key-file flag", ["--key-file=/run/secrets/master-key"]],
	["a command", ["serve"]],
	["an empty argument", [""]],
])("refuses %s with LAUNCH_ARGUMENTS", (_, argv) => {
	expect(refusal(launch({ argv })).code).toBe("LAUNCH_ARGUMENTS");
});

it.each([
	["no flags", []],
	["another flag alone", ["--inspect"]],
	["an extra flag after", ["--disable-sigusr1", "--inspect"]],
	["an extra flag before", ["--inspect-brk", "--disable-sigusr1"]],
	["a repeated flag", ["--disable-sigusr1", "--disable-sigusr1"]],
	["a valued spelling", ["--disable-sigusr1=true"]],
])("refuses %s with LAUNCH_FLAGS", (_, execArgv) => {
	expect(refusal(launch({ execArgv })).code).toBe("LAUNCH_FLAGS");
});

it.each(flagVariables)("refuses launch-affecting %s by its presence alone", (name) => {
	for (const value of ["", "DYTEST-synthetic"]) {
		vi.stubEnv(name, value);
		expect(refusal(launch()).code).toBe("LAUNCH_FLAGS");
	}
});

it.each(keyVariables)("refuses the postponed key source %s by its presence alone", (name) => {
	for (const value of ["", "DYTEST-synthetic"]) {
		vi.stubEnv(name, value);
		expect(refusal(launch()).code).toBe("KEY_SOURCE_POSTPONED");
	}
});

it("checks the live environment on every call, ignoring a supplied environment copy", () => {
	const input = { ...launch(), env: {} };
	expect(checkLaunch(input)).toEqual({ temporal: true });
	vi.stubEnv("NODE_OPTIONS", "");
	expect(refusal(input).code).toBe("LAUNCH_FLAGS");
	vi.stubEnv("NODE_OPTIONS", undefined);
	vi.stubEnv("DRAFTYAK_MASTER_KEY", "");
	expect(refusal(input).code).toBe("KEY_SOURCE_POSTPONED");
	vi.stubEnv("DRAFTYAK_MASTER_KEY", undefined);
	expect(checkLaunch(input)).toEqual({ temporal: true });
});

it.each([...flagVariables, ...keyVariables])(
	"never reads, keeps or echoes the value of %s",
	(name) => {
		const canary = `DYTEST-CANARY-${randomUUID()}`;
		const touched: PropertyKey[] = [];
		const env = new Proxy(
			{ [name]: canary },
			{
				get: (target, key, receiver) => {
					touched.push(key);
					return Reflect.get(target, key, receiver);
				},
				getOwnPropertyDescriptor: (target, key) => {
					touched.push(key);
					return Reflect.getOwnPropertyDescriptor(target, key);
				},
				ownKeys: (target) => {
					touched.push("ownKeys");
					return Reflect.ownKeys(target);
				},
			},
		);
		const original = process.env;
		const stdout = vi.spyOn(process.stdout, "write");
		const stderr = vi.spyOn(process.stderr, "write");
		let failure: unknown;
		try {
			process.env = env;
			try {
				checkLaunch(launch());
			} catch (error) {
				failure = error;
			}
		} finally {
			process.env = original;
		}
		expect(failure).toBeInstanceOf(StartupRefusal);
		const error = failure as StartupRefusal;
		expect(error.code).toBe(
			keyVariables.some((key) => key === name) ? "KEY_SOURCE_POSTPONED" : "LAUNCH_FLAGS",
		);
		expect(touched).toEqual([]);
		contentFree(error, canary);
		expect(stdout).not.toHaveBeenCalled();
		expect(stderr).not.toHaveBeenCalled();
	},
);

it.each<StartupRefusalCode>(["LAUNCH_ARGUMENTS", "LAUNCH_FLAGS", "UNICODE_VERSION"])(
	"keeps %s content-free for hostile launch values",
	(code) => {
		const canary = `DYTEST-CANARY-${randomUUID()}`;
		const input =
			code === "LAUNCH_ARGUMENTS"
				? launch({ argv: [canary] })
				: code === "LAUNCH_FLAGS"
					? launch({ execArgv: [canary] })
					: launch({ unicodeVersion: canary });
		const stdout = vi.spyOn(process.stdout, "write");
		const stderr = vi.spyOn(process.stderr, "write");
		const error = refusal(input);
		expect(error.code).toBe(code);
		contentFree(error, canary);
		expect(stdout).not.toHaveBeenCalled();
		expect(stderr).not.toHaveBeenCalled();
	},
);

it.each(["16.0", "17.1", "17", "", undefined])(
	"refuses Unicode version %j with UNICODE_VERSION",
	(unicodeVersion) => {
		expect(unicodeVersion).not.toBe(SNAPSHOT_UNICODE_VERSION);
		expect(refusal(launch({ unicodeVersion })).code).toBe("UNICODE_VERSION");
	},
);

it("admits ordinary environment inputs without treating them as launch flags", () => {
	vi.stubEnv("DRAFTYAK_DATA_DIR", "DYTEST-data");
	vi.stubEnv("LANG", "C.UTF-8");
	vi.stubEnv("TZ", "UTC");
	expect(checkLaunch(launch())).toEqual({ temporal: true });
});

it("only warns when Temporal is missing", () => {
	const result = checkLaunch(launch({ temporal: undefined }));
	expect(result).toEqual({ temporal: false, warning: "TEMPORAL_MISSING" });
	expect(Object.isFrozen(result)).toBe(true);
	expect(checkLaunch(launch({ temporal: {} }))).toEqual({ temporal: true });
});

it.each([
	["node_options", "LAUNCH_FLAGS"],
	["nOdE_oPtIoNs", "LAUNCH_FLAGS"],
	["node_path", "LAUNCH_FLAGS"],
	["NoDe_ExTrA_cA_cErTs", "LAUNCH_FLAGS"],
	["draftyak_master_key", "KEY_SOURCE_POSTPONED"],
	["dRaFtYaK_mAsTeR_kEy", "KEY_SOURCE_POSTPONED"],
	["credentials_directory", "KEY_SOURCE_POSTPONED"],
	["CrEdEnTiAlS_dIrEcToRy", "KEY_SOURCE_POSTPONED"],
])("refuses Windows live environment spelling %s", { tags: ["requires:windows"] }, (name, code) => {
	const env: NodeJS.ProcessEnv = {};
	for (const inherited of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
		if (process.env[inherited] !== undefined) env[inherited] = process.env[inherited];
	env[name] = "";
	const child = spawnSync(
		process.execPath,
		["--disable-sigusr1", path.join(import.meta.dirname, "fixtures", "preflight-child.ts")],
		{ env, encoding: "utf8", timeout: 30_000, windowsHide: true, shell: false },
	);
	expect(child.error).toBeUndefined();
	expect(child.status, child.stderr).toBe(0);
	expect(JSON.parse(child.stdout)).toEqual({ code });
});
