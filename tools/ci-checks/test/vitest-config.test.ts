import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultExclude } from "vitest/config";
import { RESERVED_TESTS, reservedGlobs } from "../../../reserved-tests.ts";
import { PLUGIN_MISSING, tierFiles, tierFromMode, vitestConfig } from "../../../vitest.shared.ts";

function configured(platform: string, ci: string | undefined, mode: string) {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	if (!descriptor) throw new Error("Missing platform descriptor");
	const previousCi = process.env.CI;
	try {
		Object.defineProperty(process, "platform", { ...descriptor, value: platform });
		if (ci === undefined) delete process.env.CI;
		else process.env.CI = ci;
		return vitestConfig({ mode, command: "serve" });
	} finally {
		Object.defineProperty(process, "platform", descriptor);
		if (previousCi === undefined) delete process.env.CI;
		else process.env.CI = previousCi;
	}
}

const modes = ["test", "heavy", "live", "device"] as const;
const contexts = [
	{ platform: "win32", ci: "true", timeouts: [90_000, 30_000, 30_000, 30_000] },
	{ platform: "win32", ci: undefined, timeouts: [30_000, 30_000, 30_000, 30_000] },
	{ platform: "win32", ci: "", timeouts: [30_000, 30_000, 30_000, 30_000] },
	{ platform: "win32", ci: "false", timeouts: [30_000, 30_000, 30_000, 30_000] },
	{ platform: "win32", ci: "1", timeouts: [30_000, 30_000, 30_000, 30_000] },
	{ platform: "linux", ci: "true", timeouts: [30_000, 30_000, 30_000, 30_000] },
	{ platform: "linux", ci: undefined, timeouts: [30_000, 30_000, 30_000, 30_000] },
	{ platform: "linux", ci: "", timeouts: [30_000, 30_000, 30_000, 30_000] },
	{ platform: "linux", ci: "false", timeouts: [30_000, 30_000, 30_000, 30_000] },
	{ platform: "linux", ci: "1", timeouts: [30_000, 30_000, 30_000, 30_000] },
	{ platform: "darwin", ci: "true", timeouts: [30_000, 30_000, 30_000, 30_000] },
	{ platform: "darwin", ci: undefined, timeouts: [30_000, 30_000, 30_000, 30_000] },
	{ platform: "darwin", ci: "", timeouts: [30_000, 30_000, 30_000, 30_000] },
	{ platform: "darwin", ci: "false", timeouts: [30_000, 30_000, 30_000, 30_000] },
	{ platform: "darwin", ci: "1", timeouts: [30_000, 30_000, 30_000, 30_000] },
];
const cases = contexts.flatMap(({ platform, ci, timeouts }) =>
	modes.map((mode, index) => ({ platform, ci, mode, timeout: timeouts[index] })),
);
const tiers = [
	{ mode: "test", tier: "unit", pattern: "**/*.test.ts" },
	{ mode: "heavy", tier: "heavy", pattern: "**/*.heavy.test.ts" },
	{ mode: "live", tier: "live", pattern: "**/*.live.test.ts" },
	{ mode: "device", tier: "device", pattern: "**/*.device.test.ts" },
];

describe("consumed Vitest configuration", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each(cases)(
		"bounds timeouts for $platform CI=$ci mode=$mode",
		({ platform, ci, mode, timeout }) => {
			const config = configured(platform, ci, mode);
			expect(config.test?.testTimeout).toBe(timeout);
			expect(config.test?.hookTimeout).toBe(timeout);
		},
	);

	// The tier's glob and passWithNoTests arrive at run time through draftyak:reserved-tests; the
	// real Vitest runs in tools/verify/test/reserved-tests.test.ts prove them.
	it.each(tiers)(
		"leaves selection and empty-suite rules to the reserved-tests plugin for $mode",
		({ mode, tier, pattern }) => {
			vi.stubEnv(RESERVED_TESTS, undefined);
			const config = configured("win32", "true", mode);
			expect(tierFromMode(mode)).toBe(tier);
			expect(tierFiles[tierFromMode(mode)]).toBe(pattern);
			expect(config.envDir).toBe(false);
			expect(config.plugins?.map((plugin) => (plugin as { name?: string }).name)).toEqual([
				"draftyak:reserved-tests",
			]);
			expect(config.test?.include).toEqual([PLUGIN_MISSING]);
			expect(config.test?.exclude).toEqual([
				...(mode === "test"
					? [...defaultExclude, "**/*.heavy.test.ts", "**/*.live.test.ts", "**/*.device.test.ts"]
					: defaultExclude),
				...reservedGlobs,
			]);
			expect(config.test?.passWithNoTests).toBe(false);
			expect(config.test?.fsModuleCachePath).toBe(
				path.join(process.cwd(), "node_modules", ".vitest-cache"),
			);
		},
	);

	it.each(["unit", "production", "", "HEAVY"])("still refuses unknown mode %s", (mode) => {
		expect(() => configured("win32", "true", mode)).toThrow("unknown test tier");
	});

	it("restores the platform and CI environment after configuration and refusal", () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		const ci = process.env.CI;
		configured("linux", "true", "test");
		expect(Object.getOwnPropertyDescriptor(process, "platform")).toEqual(platform);
		expect(process.env.CI).toBe(ci);
		expect(() => configured("darwin", undefined, "unknown")).toThrow();
		expect(Object.getOwnPropertyDescriptor(process, "platform")).toEqual(platform);
		expect(process.env.CI).toBe(ci);
	});
});
