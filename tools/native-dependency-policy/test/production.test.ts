import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativePolicyCollector } from "../src/runner.ts";

const injected = vi.hoisted(() => ({
	wrap: vi.fn(),
	manual: vi.fn(),
	audit: vi.fn(),
	c2: vi.fn(),
	github: vi.fn(),
}));
vi.mock("../src/runner.ts", async (original) => ({
	...(await original<typeof import("../src/runner.ts")>()),
	createNativePolicyProducer: injected.wrap,
}));
vi.mock("../src/protected-manual-assessment-source.ts", async (original) => ({
	...(await original<typeof import("../src/protected-manual-assessment-source.ts")>()),
	createNativeProtectedManualAssessmentSource: injected.manual,
}));
vi.mock("../src/native-audit-source.ts", async (original) => ({
	...(await original<typeof import("../src/native-audit-source.ts")>()),
	createNativeAuditSource: injected.audit,
}));
vi.mock("../src/release-c2-source.ts", async (original) => ({
	...(await original<typeof import("../src/release-c2-source.ts")>()),
	createNativeC2Collector: injected.c2,
}));
vi.mock("../src/github-security-source.ts", async (original) => ({
	...(await original<typeof import("../src/github-security-source.ts")>()),
	createGitHubSecuritySource: injected.github,
}));

import { createProductionProducer, type ProductionProducerOptions } from "../src/production.ts";

const root = path.resolve("synthetic-checkout");
const invalidEnvironments: readonly Readonly<Record<string, string>>[] = [
	{ HTTPS_PROXY: "https://invalid.example" },
	{ NODE_OPTIONS: "--inspect" },
	{ CARGO_NET_OFFLINE: "false" },
	{ CARGO_TERM_COLOR: "always" },
	{ NO_COLOR: "0" },
	{ PATH: "safe", Path: "different" },
	{ PATH: "safe\nunsafe" },
];
beforeEach(() => {
	for (const fn of Object.values(injected)) fn.mockReset();
});
function callbacks(): NativePolicyCollector {
	const value = injected.wrap.mock.calls[0]?.[0] as NativePolicyCollector | undefined;
	expect(value).toBeDefined();
	return value!;
}
function noSource() {
	for (const fn of [injected.manual, injected.audit, injected.c2, injected.github])
		expect(fn).not.toHaveBeenCalled();
}
describe("production placement boundary", () => {
	it("constructs without creating any source or touching placement", () => {
		createProductionProducer({ repositoryRoot: root });
		noSource();
		expect(callbacks().finalize).toBeTypeOf("function");
	});
	it("rejects a copied context before constructing any source", async () => {
		createProductionProducer({ repositoryRoot: root });
		await expect(
			callbacks().collect({ phase: "item", startedAt: 1 } as never),
		).rejects.toMatchObject({ code: "EVIDENCE_INVALID" });
		await callbacks().finalize?.();
		noSource();
	});
	it.each([
		"transport",
		"authority",
		"verified",
		"sources",
		"completionClock",
		"maxAgeMs",
		"capture",
	])("rejects a caller supplied capability: %s", (key) => {
		expect(() =>
			createProductionProducer({ repositoryRoot: root, [key]: {} } as ProductionProducerOptions),
		).toThrow();
		noSource();
	});
	it("refuses accessors without evaluating them", () => {
		const getter = vi.fn(() => root);
		const input = Object.defineProperty({}, "repositoryRoot", { get: getter, enumerable: true });
		expect(() => createProductionProducer(input as ProductionProducerOptions)).toThrow();
		expect(getter).not.toHaveBeenCalled();
		noSource();
	});
	it("refuses proxy placement without invoking its traps", () => {
		const trap = vi.fn(() => {
			throw Error("unexpected proxy trap");
		});
		const input = new Proxy({ repositoryRoot: root }, { ownKeys: trap, getPrototypeOf: trap });
		expect(() => createProductionProducer(input)).toThrow();
		expect(trap).not.toHaveBeenCalled();
	});
	it.each(invalidEnvironments)(
		"rejects environment overrides outside the controlled map",
		(environment) => {
			expect(() => createProductionProducer({ repositoryRoot: root, environment })).toThrow();
			noSource();
		},
	);
	it("refuses an environment getter before authority or native operations", () => {
		const getter = vi.fn(() => "safe");
		const environment = Object.defineProperty({}, "PATH", { get: getter, enumerable: true });
		expect(() => createProductionProducer({ repositoryRoot: root, environment })).toThrow();
		expect(getter).not.toHaveBeenCalled();
	});
	it("refuses conflicting cargo home placement", () => {
		expect(() =>
			createProductionProducer({
				repositoryRoot: root,
				cargoHome: path.resolve("home-a"),
				environment: { CARGO_HOME: path.resolve("home-b") },
			}),
		).toThrow();
		noSource();
	});
});
