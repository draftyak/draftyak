import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	apiInventory,
	apiVersion,
	type C2Basis,
	type C2Crate,
	type C2Scope,
	c2TechnicalDigest,
	canonicalC2,
	indexInventory,
	indexVersion,
	normalizeC2ReleaseBasis,
	publicationFromLiteral,
} from "../src/release-c2.ts";
import { C2Error } from "../src/release-c2-data.ts";
import { type C2ReleaseProjection, projectC2ReleaseBasis } from "../src/release-c2-projection.ts";
import { basis, clone, scope } from "./fixtures/release-c2.ts";

type Mutable<T> = T extends readonly (infer U)[]
	? Mutable<U>[]
	: T extends object
		? { -readonly [K in keyof T]: Mutable<T[K]> }
		: T;
type Draft = Mutable<C2Basis>;

function first<T>(rows: readonly T[]): T {
	const result = rows[0];
	if (result === undefined) throw new Error("Synthetic fixture missing");
	return result;
}
const draft = async (): Promise<Draft> => clone(await basis()) as Draft;
const oldest = (b: C2Basis): number =>
	Math.min(...b.observations.flatMap((o) => [o.initial.observedAtMs, o.recheck.observedAtMs]));
function refusal(input: unknown, expectedScope: C2Scope = scope, checkedAtMs = 1_100): C2Error {
	let result: C2ReleaseProjection | undefined;
	let caught: unknown;
	try {
		result = projectC2ReleaseBasis(input, expectedScope, checkedAtMs);
	} catch (error) {
		caught = error;
	}
	expect(result).toBeUndefined();
	expect(caught).toBeInstanceOf(C2Error);
	return caught as C2Error;
}
/** Synthetic DATA variants only: recompute their technical and invented body receipts. */
function rebind(b: Draft): void {
	for (const observation of b.observations) {
		const sourceCrate = b.crates.find((c) => c.name === observation.crate);
		if (!sourceCrate) throw new Error("Synthetic fixture missing");
		const crate: C2Crate = {
			name: sourceCrate.name,
			versions: sourceCrate.versions
				.map((pair) => ({ api: apiVersion(pair.api), index: indexVersion(pair.index) }))
				.sort((a, b) => Buffer.compare(Buffer.from(a.api.version), Buffer.from(b.api.version))),
		};
		const pair = crate.versions.find((v) => v.api.version === observation.version);
		const data =
			observation.source === "crate-api"
				? apiInventory(crate)
				: observation.source === "sparse-index"
					? indexInventory(crate)
					: pair?.api.dependencies;
		if (data === undefined) throw new Error("Synthetic fixture missing");
		const technicalProjectionSha256 = c2TechnicalDigest(
			observation.source,
			observation.crate,
			observation.version,
			data,
		);
		const bodySha256 = createHash("sha256").update(canonicalC2(data)).digest("hex");
		Object.assign(observation.initial, { technicalProjectionSha256, bodySha256 });
		Object.assign(observation.recheck, { technicalProjectionSha256, bodySha256 });
	}
}

describe("source-aware C2 release DATA consumer", () => {
	it("retains the complete normalized basis and independent semantic/observation identities", async () => {
		const input = await basis();
		const projected = projectC2ReleaseBasis(input, scope, 1_100);
		expect(projected.basis).toEqual(normalizeC2ReleaseBasis(input).basis);
		expect(projected.basis).not.toBe(input);
		expect(projected.semanticDigest).toBe(normalizeC2ReleaseBasis(input).semanticDigest);
		expect(projected.observationDigest).toBe(
			createHash("sha256")
				.update("draftyak/native-dependency-policy/releases/observation/v2\0")
				.update(
					canonicalC2({
						schemaVersion: 2,
						semanticDigest: projected.semanticDigest,
						scopeBinding: input.scopeBinding,
						startedAtMs: input.startedAtMs,
						completedAtMs: input.completedAtMs,
						maxAgeMs: input.maxAgeMs,
						observations: projected.basis.observations,
					}),
				)
				.digest("hex"),
		);
		expect(projected).toMatchObject({
			schemaVersion: 2,
			kind: "source-aware-c2-release-projection",
			authority: false,
			reusableNativeSourceBasis: false,
			observedAtMs: oldest(input),
			checkedAtMs: 1_100,
		});
		expect(projected.basis.observations).toHaveLength(15);
	});

	it.each(["graph", "lock", "inputs", "coverage"] as const)(
		"refuses a foreign %s scope despite otherwise valid release evidence",
		async (field) => {
			const expected = { ...scope, [field]: "f".repeat(64) };
			expect(refusal(await basis(), expected).code).toBe("C2_INVALID");
		},
	);

	it("expires exactly at the original oldest-receipt age boundary", async () => {
		const input = await basis();
		const expiresAt = oldest(input) + input.maxAgeMs;
		expect(projectC2ReleaseBasis(input, scope, expiresAt - 1).observedAtMs).toBe(oldest(input));
		expect(refusal(input, scope, expiresAt).code).toBe("C2_EXPIRED");
		expect(refusal(input, scope, input.completedAtMs - 1).code).toBe("C2_EXPIRED");
	});

	it("uses validation time without renewing original timing or observation identity", async () => {
		const input = await basis();
		const early = projectC2ReleaseBasis(input, scope, 1_100);
		const later = projectC2ReleaseBasis(input, scope, 1_200);
		expect(later.checkedAtMs).toBe(1_200);
		expect(later.basis.completedAtMs).toBe(input.completedAtMs);
		expect(later.basis.startedAtMs).toBe(input.startedAtMs);
		expect(later.basis.maxAgeMs).toBe(input.maxAgeMs);
		expect(later.observedAtMs).toBe(early.observedAtMs);
		expect(later.observationDigest).toBe(early.observationDigest);
		expect(later.semanticDigest).toBe(early.semanticDigest);
	});

	it("binds both source body receipts even when technical release facts are unchanged", async () => {
		const input = await draft();
		const before = projectC2ReleaseBasis(input, scope, 1_100);
		first(input.observations).recheck.bodySha256 = "f".repeat(64);
		const after = projectC2ReleaseBasis(input, scope, 1_100);
		expect(after.semanticDigest).toBe(before.semanticDigest);
		expect(after.observationDigest).not.toBe(before.observationDigest);
		expect(first(after.basis.observations).recheck.bodySha256).toBe("f".repeat(64));
	});

	it("binds original observation times and maxAgeMs independently from semantics", async () => {
		const input = await draft();
		const before = projectC2ReleaseBasis(input, scope, 1_100);
		input.maxAgeMs -= 1;
		const after = projectC2ReleaseBasis(input, scope, 1_100);
		expect(after.semanticDigest).toBe(before.semanticDigest);
		expect(after.observationDigest).not.toBe(before.observationDigest);
	});

	it.each(["missing", "missing-receipt", "duplicate", "foreign", "mismatched"] as const)(
		"refuses %s observation evidence rather than projecting an incomplete subset",
		async (mutation) => {
			const input = await draft();
			const observation = first(input.observations);
			if (mutation === "missing") input.observations.pop();
			if (mutation === "missing-receipt") Reflect.deleteProperty(observation, "recheck");
			if (mutation === "duplicate") input.observations.push(clone(observation));
			if (mutation === "foreign") Object.assign(observation, { source: "foreign-source" });
			if (mutation === "mismatched") observation.initial.technicalProjectionSha256 = "f".repeat(64);
			refusal(input);
		},
	);

	it("refuses API/index disagreements instead of selecting one source", async () => {
		const input = await draft();
		first(first(input.crates).versions).index.checksum = "b".repeat(64);
		expect(refusal(input).code).toBe("C2_INVALID");
	});

	it.each(["2025-01-01T00:00:00.123456788Z", "2025-01-01T01:00:00.123456789+01:00"])(
		"preserves and binds independent API publication precision and literal %s",
		async (literal) => {
			const input = await draft();
			const before = projectC2ReleaseBasis(input, scope, 1_100);
			first(first(input.crates).versions).api.publication = publicationFromLiteral(literal);
			rebind(input);
			const after = projectC2ReleaseBasis(input, scope, 1_100);
			const pair = first(first(after.basis.crates).versions);
			expect(pair.api.publication.literal).toBe(literal);
			expect(pair.api.publication.fractionDigits).toBe(9);
			expect(pair.index.publication.literal).toBe("2025-01-01T00:00:00Z");
			expect(after.semanticDigest).not.toBe(before.semanticDigest);
			expect(after.observationDigest).not.toBe(before.observationDigest);
		},
	);

	it("refuses a rounded millisecond replacement for the nanosecond publication fact", async () => {
		const input = await draft();
		first(first(input.crates).versions).api.publication.epochNanoseconds = "1735689600123";
		expect(refusal(input).code).toBe("C2_INVALID");
	});

	it("retains API license text without inventing an index license or collapsing differences", async () => {
		const input = await draft();
		const before = projectC2ReleaseBasis(input, scope, 1_100);
		first(first(input.crates).versions).api.license = "MIT OR Apache-2.0";
		rebind(input);
		const after = projectC2ReleaseBasis(input, scope, 1_100);
		const pair = first(first(after.basis.crates).versions);
		expect(pair.api.license).toBe("MIT OR Apache-2.0");
		expect(Object.hasOwn(pair.index, "license")).toBe(false);
		expect(after.semanticDigest).not.toBe(before.semanticDigest);
	});

	it("refuses omitted API license evidence and inferred index license evidence", async () => {
		const missing = await draft();
		Reflect.deleteProperty(first(first(missing.crates).versions).api, "license");
		refusal(missing);
		const inferred = await draft();
		Object.assign(first(first(inferred.crates).versions).index, { license: "MIT" });
		refusal(inferred);
	});

	it("retains API dependency row identity and index absent/null field distinctions", async () => {
		const input = await draft();
		const before = projectC2ReleaseBasis(input, scope, 1_100);
		const pair = first(first(input.crates).versions);
		first(pair.api.dependencies).rowId = 2;
		first(pair.index.dependencies).registry = { state: "null" };
		rebind(input);
		const after = projectC2ReleaseBasis(input, scope, 1_100);
		const result = first(first(after.basis.crates).versions);
		expect(first(result.api.dependencies)).toMatchObject({
			rowId: 2,
			rename: { state: "not-supplied-by-this-api-method" },
			registry: { state: "not-supplied-by-this-api-method" },
		});
		expect(first(result.index.dependencies)).toMatchObject({
			package: { state: "value", value: "synthetic_dep" },
			registry: { state: "null" },
		});
		expect(after.semanticDigest).not.toBe(before.semanticDigest);
	});

	it("preserves index featureEncoding even when its merged feature set is unchanged", async () => {
		const input = await draft();
		const before = projectC2ReleaseBasis(input, scope, 1_100);
		const index = first(first(input.crates).versions).index;
		index.featureEncoding = { features: {}, features2: { state: "value", value: index.features } };
		rebind(input);
		const after = projectC2ReleaseBasis(input, scope, 1_100);
		expect(first(first(after.basis.crates).versions).index.features).toEqual(
			first(first(before.basis.crates).versions).index.features,
		);
		expect(after.semanticDigest).not.toBe(before.semanticDigest);
	});

	it("copies and deeply freezes source evidence before returning the projection", async () => {
		const input = await draft();
		const projected = projectC2ReleaseBasis(input, scope, 1_100);
		const encoded = canonicalC2(projected);
		first(input.observations).initial.bodySha256 = "f".repeat(64);
		first(first(input.crates).versions).api.license = null;
		expect(canonicalC2(projected)).toBe(encoded);
		const frozen = (value: unknown): boolean => {
			if (value === null || typeof value !== "object") return true;
			return Object.isFrozen(value) && Object.values(value).every(frozen);
		};
		expect(frozen(projected)).toBe(true);
	});

	it("refuses accessors without invoking them, including the expected scope", async () => {
		const input = await draft();
		let calls = 0;
		const get = (): never => {
			calls++;
			throw new Error("Synthetic getter must not run");
		};
		Object.defineProperty(input, "completedAtMs", { enumerable: true, get });
		refusal(input);
		const expected = { ...scope };
		Object.defineProperty(expected, "graph", { enumerable: true, get });
		refusal(await basis(), expected);
		expect(calls).toBe(0);
	});

	it("refuses the old schema rather than adapting it or issuing an authority receipt", async () => {
		const input = await draft();
		Object.assign(input, { schemaVersion: 1 });
		refusal(input);
	});
});
