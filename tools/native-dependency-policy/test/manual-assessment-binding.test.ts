import { describe, expect, it } from "vitest";
import {
	createTestManualAssessmentBinder,
	type ManualAssessmentData,
	type ManualAssessmentDelivery,
	ManualAssessmentError,
} from "../src/manual-assessment-binding.ts";
import type { ManualReleaseObservation } from "../src/manual-release-source.ts";
import {
	BODY_CANARY,
	fixture,
	GTK_PAGE,
	githubRelease,
	putZbusPages,
	response,
} from "./fixtures/manual-release-source.ts";

const HOUR = 3_600_000;
function coordinates(): ManualAssessmentDelivery {
	return {
		deliveryCommit: "1".repeat(40),
		currentAuthority: { revision: "2".repeat(40), recordDigest: "3".repeat(64) },
	};
}
function declaration(
	observation: ManualReleaseObservation,
	assessedAt = 1000,
): ManualAssessmentData {
	return {
		state: "assessed",
		assessedAt,
		semanticRevision: observation.semanticRevision,
		observationRevision: observation.observationRevision,
		inventories: observation.inventories.map((source) => ({
			channel: source.channel,
			projectId: source.project.id,
			coverage: source.coverage,
			contentFields: source.contentFields,
			releases: source.releases.map((release) => ({
				id: release.id,
				name: { ...release.name },
				body: { ...release.body },
			})),
		})),
	};
}
async function setup() {
	const map = fixture();
	putZbusPages(map, [githubRelease(1000)]);
	let now = 1000,
		calls = 0;
	let onFetch: (() => void) | undefined;
	const binder = createTestManualAssessmentBinder({
		fetch: async (url) => {
			calls++;
			onFetch?.();
			const value = map.get(url);
			if (!value) throw new Error("Missing invented response");
			return value;
		},
		wall: () => now,
		monotonic: () => 0,
	});
	const observation = await binder.observe();
	return {
		binder,
		observation,
		map,
		calls: () => calls,
		time: (value: number) => {
			now = value;
		},
		hook: (value?: () => void) => {
			onFetch = value;
		},
	};
}

describe("manual assessment binding DATA", () => {
	it("joins every content binding and coverage without granting authority or exposing release prose", async () => {
		const f = await setup();
		const result = await f.binder.bind(f.observation, declaration(f.observation), coordinates());
		expect(result).toMatchObject({
			version: 1,
			kind: "MANUAL_ASSESSMENT_BINDING_DATA",
			origin: "TEST_ONLY",
			authority: false,
			reusableNativeSourceBasis: false,
		});
		expect(result.inventories.map((row) => row.channel)).toEqual(["M1", "M2", "M3"]);
		expect(result.inventories[0]?.releases[0]?.name).toEqual({ state: "missing" });
		expect(result.inventories[0]?.releases[0]?.body).toEqual({ state: "null" });
		expect(result.inventories[0]?.releases[2]?.body.state).toBe("string");
		expect(result.inventories[2]).toMatchObject({
			coverage: "qualified-empty-terminal-page1",
			releases: [],
			contentFields: ["name", "description"],
		});
		expect(JSON.stringify(result)).not.toContain(BODY_CANARY);
		expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.source)).toBe(true);
		expect(Object.isFrozen(result.inventories[0]?.releases[2]?.body)).toBe(true);
		expect(Object.isFrozen(result.delivery.currentAuthority)).toBe(true);
		await expect(f.binder.validate(result, coordinates())).resolves.toBeUndefined();
	});

	it("keeps original observation and assessment windows through repeated fresh validation", async () => {
		const f = await setup();
		const result = await f.binder.bind(f.observation, declaration(f.observation), coordinates());
		const before = JSON.stringify(result);
		f.time(2000);
		await f.binder.validate(result, coordinates());
		f.time(1000 + HOUR - 1);
		await f.binder.validate(result, coordinates());
		expect(JSON.stringify(result)).toBe(before);
		expect(result.assessment.assessedAt).toBe(1000);
		expect(result.source.completedAt).toBe(1000);
		f.time(1000 + HOUR);
		await expect(f.binder.validate(result, coordinates())).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_STALE",
		});
	});

	it.each([undefined, null, { state: "unassessed" }])(
		"refuses missing or unassessed manual data (%s)",
		async (input) => {
			const f = await setup();
			const before = f.calls();
			await expect(f.binder.bind(f.observation, input, coordinates())).rejects.toMatchObject({
				code: "MANUAL_ASSESSMENT_REQUIRED",
			});
			expect(f.calls()).toBe(before);
		},
	);

	it.each(["semanticRevision", "observationRevision"] as const)(
		"requires the exact original %s",
		async (field) => {
			const f = await setup();
			const input = declaration(f.observation);
			Reflect.set(input, field, "f".repeat(64));
			await expect(f.binder.bind(f.observation, input, coordinates())).rejects.toMatchObject({
				code: "MANUAL_ASSESSMENT_CHANGED",
			});
		},
	);

	it.each([
		"inventory",
		"release",
		"name",
		"body",
		"coverage",
		"project",
		"fields",
		"duplicate",
	] as const)("refuses incomplete or changed %s coverage", async (fault) => {
		const f = await setup();
		const input = structuredClone(declaration(f.observation));
		const inventory = input.inventories[0];
		if (!inventory) throw new Error("Expected invented inventory");
		const row = inventory.releases[2];
		if (!row) throw new Error("Expected invented release");
		if (fault === "inventory") Reflect.set(input, "inventories", input.inventories.slice(1));
		if (fault === "release") Reflect.set(inventory, "releases", inventory.releases.slice(1));
		if (fault === "name") Reflect.set(row, "name", { state: "missing" });
		if (fault === "body")
			Reflect.set(row, "body", { state: "string", bytes: 1, sha256: "a".repeat(64) });
		if (fault === "coverage")
			Reflect.set(inventory, "coverage", "bounded-pages-with-page1-recheck");
		if (fault === "project") Reflect.set(inventory, "projectId", 1);
		if (fault === "fields") Reflect.set(inventory, "contentFields", ["name", "description"]);
		if (fault === "duplicate")
			Reflect.set(input, "inventories", [inventory, inventory, input.inventories[2]]);
		await expect(f.binder.bind(f.observation, input, coordinates())).rejects.toBeInstanceOf(
			ManualAssessmentError,
		);
	});

	it("keeps missing, null and empty-string text states distinct", async () => {
		const f = await setup();
		const input = structuredClone(declaration(f.observation));
		const row = input.inventories[0]?.releases[0];
		if (!row) throw new Error("Expected invented release");
		Reflect.set(row, "name", { state: "null" });
		await expect(f.binder.bind(f.observation, input, coordinates())).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_CHANGED",
		});
		Reflect.set(row, "name", {
			state: "string",
			bytes: 0,
			sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		});
		await expect(f.binder.bind(f.observation, input, coordinates())).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_CHANGED",
		});
	});

	it("requires the genuine observation from this source owner instead of a serialized origin flag", async () => {
		const f = await setup(),
			other = await setup();
		await expect(
			f.binder.bind(structuredClone(f.observation), declaration(f.observation), coordinates()),
		).rejects.toMatchObject({ code: "MANUAL_ASSESSMENT_INVALID" });
		await expect(
			f.binder.bind(other.observation, declaration(other.observation), coordinates()),
		).rejects.toMatchObject({ code: "MANUAL_ASSESSMENT_INVALID" });
		const result = await f.binder.bind(f.observation, declaration(f.observation), coordinates());
		await expect(other.binder.validate(result, coordinates())).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_INVALID",
		});
		await expect(f.binder.validate(structuredClone(result), coordinates())).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_INVALID",
		});
	});

	it.each(["deliveryCommit", "revision", "recordDigest"] as const)(
		"refuses foreign %s without treating coordinates as delivery acceptance",
		async (field) => {
			const f = await setup();
			const result = await f.binder.bind(f.observation, declaration(f.observation), coordinates());
			const changed = coordinates();
			if (field === "deliveryCommit") Reflect.set(changed, field, "a".repeat(40));
			else Reflect.set(changed.currentAuthority, field, "b".repeat(field === "revision" ? 40 : 64));
			const before = f.calls();
			await expect(f.binder.validate(result, changed)).rejects.toMatchObject({
				code: "MANUAL_ASSESSMENT_CHANGED",
			});
			expect(f.calls()).toBe(before);
			await expect(f.binder.validate(result, coordinates())).resolves.toBeUndefined();
		},
	);

	it("captures assessment text, time and delivery DATA before source revalidation awaits", async () => {
		const f = await setup();
		const input = structuredClone(declaration(f.observation)),
			facts = coordinates();
		f.hook(() => {
			f.hook();
			Reflect.set(input, "assessedAt", 999);
			const release = input.inventories[0]?.releases[2];
			if (!release) throw new Error("Expected invented release");
			Reflect.set(release, "body", { state: "missing" });
			Reflect.set(facts, "deliveryCommit", "a".repeat(40));
		});
		const result = await f.binder.bind(f.observation, input, facts);
		expect(result.assessment.assessedAt).toBe(1000);
		expect(result.inventories[0]?.releases[2]?.body.state).toBe("string");
		expect(result.delivery.deliveryCommit).toBe("1".repeat(40));
		await expect(f.binder.validate(result, coordinates())).resolves.toBeUndefined();
	});

	it("refuses changed live source content even when original declared hashes remain unchanged", async () => {
		const f = await setup();
		const result = await f.binder.bind(f.observation, declaration(f.observation), coordinates());
		const changed = githubRelease(1);
		changed.body = "different invented release text";
		f.map.set(GTK_PAGE, response([changed]));
		await expect(f.binder.validate(result, coordinates())).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_CHANGED",
		});
	});

	it.each([999, 1001])(
		"refuses an assessment outside the original observed-to-entry interval (%s)",
		async (time) => {
			const f = await setup();
			await expect(
				f.binder.bind(f.observation, declaration(f.observation, time), coordinates()),
			).rejects.toMatchObject({ code: "MANUAL_ASSESSMENT_STALE" });
		},
	);

	it("refuses rollback below the last accepted validation without renewing any data", async () => {
		const f = await setup();
		const result = await f.binder.bind(f.observation, declaration(f.observation), coordinates());
		f.time(2000);
		await f.binder.validate(result, coordinates());
		f.time(1999);
		await expect(f.binder.validate(result, coordinates())).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_STALE",
		});
		expect(result.assessment.assessedAt).toBe(1000);
	});

	it("rejects accessors, proxies and serialized verification claims without evaluating caller getters", async () => {
		const f = await setup();
		const accessor = declaration(f.observation);
		let reads = 0;
		Object.defineProperty(accessor, "assessedAt", {
			enumerable: true,
			get: () => {
				reads++;
				return 1000;
			},
		});
		await expect(f.binder.bind(f.observation, accessor, coordinates())).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_INVALID",
		});
		expect(reads).toBe(0);
		const proxy = new Proxy(declaration(f.observation), {
			ownKeys: () => {
				throw new Error("Unexpected caller proxy trap");
			},
		});
		await expect(f.binder.bind(f.observation, proxy, coordinates())).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_INVALID",
		});
		const verified = { ...declaration(f.observation), verified: true };
		await expect(f.binder.bind(f.observation, verified, coordinates())).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_INVALID",
		});
	});

	it.each([
		["toJSON", 0],
		["toJSON", 1],
		["proxy", 0],
		["proxy", 1],
	] as const)("refuses nested %s at contentFields[%i] without coercion", async (kind, index) => {
		const f = await setup();
		const input = structuredClone(declaration(f.observation));
		const inventory = input.inventories[0];
		if (!inventory) throw new Error("Expected invented inventory");
		const expected = inventory.contentFields[index];
		let hooks = 0;
		const hostile =
			kind === "toJSON"
				? {
						toJSON: () => {
							hooks++;
							return expected;
						},
					}
				: new Proxy(
						{},
						{
							get: (_target, key) => {
								hooks++;
								return key === "toJSON"
									? () => {
											hooks++;
											return expected;
										}
									: undefined;
							},
						},
					);
		const fields: unknown[] = [...inventory.contentFields];
		fields[index] = hostile;
		Reflect.set(inventory, "contentFields", fields);
		const before = f.calls();
		await expect(f.binder.bind(f.observation, input, coordinates())).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_INVALID",
		});
		expect(hooks).toBe(0);
		expect(f.calls()).toBe(before);
	});

	it("retains both valid primitive content-field tuples", async () => {
		const f = await setup();
		const result = await f.binder.bind(f.observation, declaration(f.observation), coordinates());
		expect(result.inventories.map((inventory) => inventory.contentFields)).toEqual([
			["name", "body"],
			["name", "body"],
			["name", "description"],
		]);
	});
});
