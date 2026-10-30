import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultExclude } from "vitest/config";
import { tierFromMode, vitestConfig } from "../../../vitest.shared.ts";

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
	{ mode: "test", tier: "unit", pattern: "**/*.test.ts", empty: false },
	{ mode: "heavy", tier: "heavy", pattern: "**/*.heavy.test.ts", empty: true },
	{ mode: "live", tier: "live", pattern: "**/*.live.test.ts", empty: true },
	{ mode: "device", tier: "device", pattern: "**/*.device.test.ts", empty: true },
];

describe("consumed Vitest configuration", () => {
	it.each(cases)(
		"bounds timeouts for $platform CI=$ci mode=$mode",
		({ platform, ci, mode, timeout }) => {
			const config = configured(platform, ci, mode);
			expect(config.test?.testTimeout).toBe(timeout);
			expect(config.test?.hookTimeout).toBe(timeout);
		},
	);

	it.each(tiers)(
		"preserves selection and empty-suite rules for $mode",
		({ mode, tier, pattern, empty }) => {
			const config = configured("win32", "true", mode);
			expect(tierFromMode(mode)).toBe(tier);
			expect(config.envDir).toBe(false);
			expect(config.test?.include).toEqual([pattern]);
			expect(config.test?.exclude).toEqual(
				mode === "test"
					? [...defaultExclude, "**/*.heavy.test.ts", "**/*.live.test.ts", "**/*.device.test.ts"]
					: defaultExclude,
			);
			expect(config.test?.passWithNoTests).toBe(empty);
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
