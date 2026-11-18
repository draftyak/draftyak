import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigEnv } from "vitest/config";
import type { Reporter, VitestPluginContext } from "vitest/node";
import type { Admission } from "../src/admission.ts";
import { admitNative } from "../src/admission.ts";
import { selectStore } from "../src/capabilities.ts";
import { nativeConfig } from "../src/config.ts";
import packageConfig from "../vitest.config.ts";

vi.mock("../src/admission.ts", () => ({ admitNative: vi.fn() }));

const environment = (mode: string): ConfigEnv => ({ mode, command: "serve" });
const admitted = (): Admission => ({
	selection: selectStore(process.platform, {}),
	context: {
		root: path.resolve("repo"),
		cargo: path.resolve("cargo"),
		node: process.execPath,
		platform: process.platform,
		environment: {},
		runner: async () => {
			throw Error("no native run");
		},
	},
});
const originalExit = process.exitCode;
afterEach(() => {
	process.exitCode = originalExit;
	vi.restoreAllMocks();
});

describe("native-store heavy configuration admission", () => {
	it("wires the package entry to admission and required completion without native test operations", async () => {
		const admission = vi.mocked(admitNative);
		admission.mockReset().mockResolvedValue(admitted());
		const config = await packageConfig(environment("heavy"));
		expect(admission).toHaveBeenCalledOnce();
		expect(config.test?.passWithNoTests).toBe(false);
		expect(
			config.plugins?.some(
				(plugin) =>
					plugin &&
					typeof plugin === "object" &&
					!Array.isArray(plugin) &&
					"name" in plugin &&
					plugin.name === "draftyak:required-native-store",
			),
		).toBe(true);
		admission.mockRejectedValue(new Error("Required native-store resource missing"));
		await expect(packageConfig(environment("heavy"))).rejects.toThrow(
			"Required native-store resource missing",
		);
	});
	it("leaves ordinary unit discovery free of native capability probes", async () => {
		const config = await nativeConfig(
			environment("test"),
			async () => {
				throw Error("unexpected admission");
			},
			() => {
				throw Error("unexpected case selection");
			},
		);
		expect(config.test?.include).toEqual(["**/*.test.ts"]);
	});
	it("fails admission before configuring filtered or empty heavy results", async () => {
		const names = vi.fn(() => ["required native result"]);
		await expect(
			nativeConfig(
				environment("heavy"),
				async () => {
					throw Error("missing store resource");
				},
				names,
			),
		).rejects.toThrow("missing store resource");
		expect(names).not.toHaveBeenCalled();
	});
	it("registers a completion refusal that a passing partial selection cannot hide", async () => {
		const config = await nativeConfig(
			environment("heavy"),
			async () => admitted(),
			() => ["required native first", "required native second"],
		);
		expect(config.test?.passWithNoTests).toBe(false);
		expect(config.test?.maxWorkers).toBe(1);
		const reporters: Reporter[] = [];
		const plugin = (config.plugins ?? []).find(
			(value) =>
				value &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				"name" in value &&
				value.name === "draftyak:required-native-store",
		);
		if (
			!plugin ||
			typeof plugin !== "object" ||
			!("configureVitest" in plugin) ||
			typeof plugin.configureVitest !== "function"
		)
			throw Error("completion reporter missing");
		plugin.configureVitest({ vitest: { config: { reporters } } } as unknown as VitestPluginContext);
		const reporter = reporters[0];
		if (!reporter?.onTestRunEnd) throw Error("completion hook missing");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const complete = [
			{
				children: {
					allTests: () => [
						{ fullName: "required native first" },
						{ fullName: "required native second" },
					],
				},
			},
		];
		await reporter.onTestRunEnd(complete as never, [], "passed");
		expect(stderr).not.toHaveBeenCalled();
		await reporter.onTestRunEnd(
			[{ children: { allTests: () => [{ fullName: "required native first" }] } }] as never,
			[],
			"passed",
		);
		expect(process.exitCode).toBe(1);
		expect(stderr).toHaveBeenCalledWith("Required native-store acceptance did not complete\n");
	});
});
