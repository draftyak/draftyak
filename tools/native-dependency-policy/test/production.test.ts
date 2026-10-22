import { beforeEach, describe, expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({ create: vi.fn(), wrap: vi.fn(), database: vi.fn() }));
vi.mock("../src/evidence.ts", () => ({ createEvidenceDirectory: injected.create }));
vi.mock("../src/runner.ts", () => ({ createNativePolicyProducer: injected.wrap }));
vi.mock("../src/current-basis.ts", async (original) => {
	const actual = await original<typeof import("../src/current-basis.ts")>();
	return {
		...actual,
		UnavailableCurrentBasisProducer: class {
			database = injected.database;
		},
	};
});

import { BasisError } from "../src/current-basis.ts";
import { createProductionProducer } from "../src/production.ts";

const runId = "2c7b1e7a-9398-4f14-8fbb-13cb96357927";
beforeEach(() => {
	injected.create.mockReset().mockResolvedValue({ runId });
	injected.wrap.mockReset().mockReturnValue({});
	injected.database.mockReset().mockRejectedValue(new BasisError("BASIS_UNAVAILABLE"));
});
function callbacks() {
	const value = injected.wrap.mock.calls[0]?.[0];
	expect(value).toBeDefined();
	return value;
}
describe("initial production refusal boundary", () => {
	it("constructs without starting a producer or touching files", () => {
		createProductionProducer({ repositoryRoot: "/synthetic-checkout" });
		expect(injected.create).not.toHaveBeenCalled();
		expect(injected.database).not.toHaveBeenCalled();
	});
	it("keeps unavailable evidence distinct from a successful empty audit", async () => {
		createProductionProducer({ repositoryRoot: "/synthetic-checkout" });
		expect(await callbacks().collect()).toEqual({
			runId,
			reportDigest: null,
			binding: null,
			audit: null,
			rawExits: { full: null, advisory: null },
			evidenceObservedAt: null,
			sourceRevisions: null,
			failure: "BASIS_UNAVAILABLE",
		});
		expect(await callbacks().revalidate()).toEqual({
			reportDigest: null,
			binding: null,
			sourceRevisions: null,
		});
	});
	it("snapshots the fixed output location before authority awaits", async () => {
		const options = {
			repositoryRoot: "/synthetic-checkout",
			evidenceDirectory: "/synthetic-evidence",
		};
		createProductionProducer(options);
		options.repositoryRoot = "/changed-checkout";
		options.evidenceDirectory = "/changed-evidence";
		await callbacks().collect();
		expect(injected.create).toHaveBeenCalledWith({
			checkoutRoot: "/synthetic-checkout",
			directory: "/synthetic-evidence",
		});
	});
	it("does not classify unexpected producer errors as verified unavailability", async () => {
		createProductionProducer({ repositoryRoot: "/synthetic-checkout" });
		injected.database.mockRejectedValue(new Error("synthetic private diagnostic"));
		await expect(callbacks().collect()).rejects.toThrow("synthetic private diagnostic");
	});
	it("cannot activate merely because one unavailable adapter gains a value", async () => {
		createProductionProducer({ repositoryRoot: "/synthetic-checkout" });
		injected.database.mockResolvedValue({});
		await expect(callbacks().collect()).rejects.toMatchObject({ code: "BASIS_UNAVAILABLE" });
	});
});
