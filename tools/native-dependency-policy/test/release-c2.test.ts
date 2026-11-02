import { describe, expect, it } from "vitest";
import { normalizeCurrentBasis } from "../src/current-basis.ts";
import { preflightDecision } from "../src/decision.ts";
import {
	apiInventory,
	apiVersion,
	type C2Basis,
	type C2Crate,
	c2TechnicalDigest,
	canonicalC2,
	indexInventory,
	indexVersion,
	normalizeC2ReleaseBasis,
	projectC2Delivery,
	publicationFromLiteral,
} from "../src/release-c2.ts";
import { C2Error } from "../src/release-c2-data.ts";
import { basis, clone } from "./fixtures/release-c2.ts";

type Mutable<T> = T extends readonly (infer U)[]
	? Mutable<U>[]
	: T extends object
		? { -readonly [K in keyof T]: Mutable<T[K]> }
		: T;
type Draft = Mutable<C2Basis>;
type DraftVersion = Mutable<C2Crate["versions"][number]>;
function at<T>(rows: readonly T[], index = 0): T {
	const v = rows[index];
	if (v === undefined) throw new Error("fixture row missing");
	return v;
}
function firstVersion(b: Draft): DraftVersion {
	return at(at(b.crates).versions);
}
function mutable(b: C2Basis): Draft {
	return clone(b) as Draft;
}
function rebind(b: Draft): void {
	for (const o of b.observations) {
		let c: C2Crate | undefined = b.crates.find((c) => c.name === o.crate);
		if (!c) throw new Error("fixture crate missing");
		try {
			c = {
				...c,
				versions: c.versions
					.map((v) => ({
						api: apiVersion(v.api),
						index: indexVersion(v.index),
					}))
					.sort((a, b) => Buffer.compare(Buffer.from(a.api.version), Buffer.from(b.api.version))),
			};
		} catch {
			/* Invalid test data is refused by the subject, before receipt comparison. */
		}
		const matched = c.versions.find((v) => v.api.version === o.version);
		const data =
			o.source === "crate-api"
				? apiInventory(c)
				: o.source === "sparse-index"
					? indexInventory(c)
					: matched?.api.dependencies;
		const digest = c2TechnicalDigest(o.source, o.crate, o.version, data);
		o.initial.technicalProjectionSha256 = digest;
		o.recheck.technicalProjectionSha256 = digest;
	}
}
const normalized = (b: unknown) => normalizeC2ReleaseBasis(b).semanticDigest;
function escapedPayload(encodedBytes: number): string[] {
	const count = 256,
		overhead = count * 3 + 1;
	let slashes = Math.floor((encodedBytes - overhead) / 2);
	const result = Array.from({ length: count }, () => {
		const n = Math.min(slashes, 65536);
		slashes -= n;
		return "\\".repeat(n);
	});
	if ((encodedBytes - overhead) % 2) result[count - 1] += "x";
	return result;
}
describe("source-aware C2 semantic and delivery identity", () => {
	it("bounds encoded UTF8 after escaping at exactly 32MiB and one byte above", () => {
		const cap = 32 * 1024 * 1024;
		const exact = escapedPayload(cap);
		expect(exact.every((s) => Buffer.byteLength(s) <= 65536)).toBe(true);
		expect(Buffer.byteLength(canonicalC2(exact))).toBe(cap);
		expect(() => canonicalC2(escapedPayload(cap + 1))).toThrow(C2Error);
		expect(() => c2TechnicalDigest("crate-api", "glib", null, exact)).toThrow(C2Error);
	}, 30_000);
	it("refuses whole release and delivery projections whose accepted strings escape past the encoded cap", async () => {
		const b = mutable(await basis());
		b.observations = b.observations.filter((o) => o.source !== "version-dependencies-api");
		for (const c of b.crates) {
			const original = clone(at(c.versions));
			c.versions = Array.from({ length: 52 }, (_, i) => {
				const v = clone(original),
					release = i === 0 ? v.api.version : `99.0.${i}`;
				v.api.version = release;
				v.index.version = release;
				v.api.license = "";
				b.observations.push({
					source: "version-dependencies-api",
					crate: c.name,
					version: release,
					initial: {
						observedAtMs: 1001,
						bodySha256: "a".repeat(64),
						technicalProjectionSha256: "b".repeat(64),
					},
					recheck: {
						observedAtMs: 1020,
						bodySha256: "a".repeat(64),
						technicalProjectionSha256: "b".repeat(64),
					},
				});
				return v;
			});
		}
		rebind(b);
		expect(normalizeC2ReleaseBasis(b).basis.crates.every((c) => c.versions.length === 52)).toBe(
			true,
		);
		const semantic = {
			schemaVersion: b.schemaVersion,
			kind: b.kind,
			registry: b.registry,
			coverage: b.coverage,
			scopeBinding: b.scopeBinding,
			crates: b.crates,
		};
		const semanticBytes = 32 * 1024 * 1024 - 1024;
		let remaining = semanticBytes - Buffer.byteLength(JSON.stringify(semantic));
		for (const c of b.crates)
			for (const v of c.versions) {
				const count = Math.min(65536, Math.floor(remaining / 2));
				v.api.license = "\\".repeat(count);
				remaining -= count * 2;
				if (remaining === 1 && count < 65536) {
					v.api.license += "x";
					remaining--;
				}
			}
		expect(remaining).toBe(0);
		expect(Buffer.byteLength(canonicalC2(semantic))).toBe(semanticBytes);
		rebind(b);
		expect(() => normalizeC2ReleaseBasis(b)).toThrow(C2Error);
		expect(() =>
			projectC2Delivery(b, {
				deliveryCommit: "a".repeat(40),
				currentAuthority: { revision: "b".repeat(40), recordDigest: "c".repeat(64) },
			}),
		).toThrow(C2Error);
	}, 30_000);
	it("joins complete attributed facts, detaches/freezes and pins canonical bytes", async () => {
		const b = mutable(await basis()),
			n = normalizeC2ReleaseBasis(b);
		expect(n.basis.crates).toHaveLength(5);
		expect(n.basis.observations).toHaveLength(15);
		expect(n.basis.crates[0]?.versions[0]?.api.publication.fractionDigits).toBe(9);
		firstVersion(b).api.license = "Apache-2.0";
		expect(n.basis.crates[0]?.versions[0]?.api.license).toBe("MIT");
		expect(Object.isFrozen(n.basis.crates[0]?.versions)).toBe(true);
		expect(n.semanticDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(n.semanticDigest).toBe(
			"c70d50f4e307fb3b41b02d6580b77d008db7d9047c9ffa7f0c34cc77938e5e29",
		);
	});
	it("pins canonical scalar bytes and refuses effectful encoder inputs", () => {
		expect(canonicalC2({ b: "é", a: ["\b", "\0", "😀", 1, true, null] })).toBe(
			'{"a":["\\b","\\u0000","😀",1,true,null],"b":"é"}',
		);
		let calls = 0;
		expect(() =>
			canonicalC2(
				Object.defineProperty({}, "x", {
					enumerable: true,
					get() {
						calls++;
						return 1;
					},
				}),
			),
		).toThrow(C2Error);
		expect(calls).toBe(0);
	});
	it("preserves two real source rows with repeated shared tuples, without inventing id/alias pairing", async () => {
		const b = mutable(await basis()),
			v = firstVersion(b);
		v.api.dependencies.push({ ...clone(at(v.api.dependencies)), rowId: 2 });
		v.index.dependencies.push({ ...clone(at(v.index.dependencies)), name: "second_alias" });
		rebind(b);
		const h = normalized(b);
		v.api.dependencies.reverse();
		v.index.dependencies.reverse();
		at(v.api.dependencies).features.reverse();
		rebind(b);
		expect(normalized(b)).toBe(h);
		at(v.api.dependencies).rowId = 3;
		rebind(b);
		expect(normalized(b)).not.toBe(h);
	});
	it.each(["api", "index"] as const)("refuses missing %s multiplicity", async (source) => {
		const b = mutable(await basis()),
			v = firstVersion(b);
		v[source].dependencies = [];
		rebind(b);
		expect(() => normalized(b)).toThrow(C2Error);
	});
	it.each(["api", "index"] as const)(
		"refuses duplicate %s source identities despite equal shared counts",
		async (source) => {
			const b = mutable(await basis()),
				v = firstVersion(b);
			v.api.dependencies.push({ ...clone(at(v.api.dependencies)), rowId: 2 });
			v.index.dependencies.push({ ...clone(at(v.index.dependencies)), name: "second_alias" });
			if (source === "api") at(v.api.dependencies, 1).rowId = 1;
			else at(v.index.dependencies, 1).name = at(v.index.dependencies).name;
			rebind(b);
			expect(() => normalized(b)).toThrow(C2Error);
		},
	);
	it("allows same alias with distinct explicit kind or target", async () => {
		const b = mutable(await basis()),
			v = firstVersion(b);
		v.api.dependencies.push(
			{ ...clone(at(v.api.dependencies)), rowId: 2, kind: "build" },
			{ ...clone(at(v.api.dependencies)), rowId: 3, target: "cfg(unix)" },
		);
		v.index.dependencies.push(
			{ ...clone(at(v.index.dependencies)), kind: "build" },
			{ ...clone(at(v.index.dependencies)), target: "cfg(unix)" },
		);
		rebind(b);
		expect(normalizeC2ReleaseBasis(b).basis.crates[0]?.versions[0]?.api.dependencies).toHaveLength(
			3,
		);
	});
	it.each(["alias", "registry", "license", "time", "id", "featureEncoding"])(
		"hash-binds source-attributed %s",
		async (field) => {
			const b = mutable(await basis()),
				h = normalized(b),
				v = firstVersion(b);
			if (field === "alias") at(v.index.dependencies).name = "different_alias";
			if (field === "registry") at(v.index.dependencies).registry = { state: "null" };
			if (field === "license") v.api.license = null;
			if (field === "time")
				v.api.publication = publicationFromLiteral("2025-01-01T00:00:00.123456789+00:00");
			if (field === "id") at(v.api.dependencies).rowId = 2;
			if (field === "featureEncoding")
				v.index.featureEncoding.features2 = { state: "value", value: {} };
			rebind(b);
			expect(normalized(b)).not.toBe(h);
		},
	);
	it.each(["requirement", "target", "optional", "defaultFeatures", "features", "kind"])(
		"requires exact shared %s",
		async (key) => {
			const b = mutable(await basis()),
				d = at(firstVersion(b).api.dependencies);
			const changes: Record<string, unknown> = {
				requirement: "^2.0",
				target: "cfg(unix)",
				optional: true,
				defaultFeatures: false,
				features: [],
				kind: "build",
			};
			Object.assign(d, { [key]: changes[key] });
			rebind(b);
			expect(() => normalized(b)).toThrow(C2Error);
		},
	);
	it.each([
		["2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", true],
		["2025-01-01T00:00:00.999999999Z", "2025-01-01T00:00:00Z", true],
		["2025-01-01T00:00:01Z", "2025-01-01T00:00:00Z", false],
		["2024-12-31T23:59:59.999999999Z", "2025-01-01T00:00:00Z", false],
		["2025-01-01T00:00:00.123999999Z", "2025-01-01T00:00:00.123Z", true],
		["2025-01-01T00:00:00.124Z", "2025-01-01T00:00:00.123Z", false],
		["2025-01-01T00:00:00.120000001Z", "2025-01-01T00:00:00.120000000Z", false],
		["1969-12-31T23:59:59.999999999Z", "1969-12-31T23:59:59Z", true],
	])("enforces precision interval %s / %s", async (api, index, accept) => {
		const b = mutable(await basis()),
			v = firstVersion(b);
		v.api.publication = publicationFromLiteral(api);
		v.index.publication = publicationFromLiteral(index);
		rebind(b);
		if (accept) expect(normalized(b)).toMatch(/^[a-f0-9]{64}$/);
		else expect(() => normalized(b)).toThrow(C2Error);
	});
	it.each([
		"2025-02-30T00:00:00Z",
		"2025-01-01T00:00:60Z",
		"2025-01-01T24:00:00Z",
		"2025-01-01T00:00:00-00:00",
		"2025-01-01T00:00:00.1234567890Z",
		"2025-01-01T00:00:00+24:00",
		"2025-01-01T00:00:00Z\n",
	])("refuses unsupported publication %j", (s) =>
		expect(() => publicationFromLiteral(s)).toThrow(C2Error),
	);
	it("recomputes supplied publication and feature merge derivatives", async () => {
		for (const mutate of [
			(v: DraftVersion) => (v.api.publication.epochNanoseconds = "0"),
			(v: DraftVersion) => (v.api.publication.fractionDigits = 6),
			(v: DraftVersion) => (v.index.features.extra = []),
		]) {
			const b = mutable(await basis());
			mutate(firstVersion(b));
			rebind(b);
			expect(() => normalized(b)).toThrow(C2Error);
		}
	});
	it("refuses missing resources, unsupported flags, stale/future/backward and phase-invalid clocks", async () => {
		for (const change of [
			(b: Draft) => b.observations.pop(),
			(b: Draft) => Object.assign(b, { approved: true }),
			(b: Draft) => (b.completedAtMs = at(b.observations).initial.observedAtMs + 3_600_000),
			(b: Draft) => (at(b.observations).recheck.observedAtMs = b.completedAtMs + 1),
			(b: Draft) => (b.completedAtMs = b.startedAtMs - 1),
			(b: Draft) => (at(b.observations).recheck.observedAtMs = b.startedAtMs),
		]) {
			const b = mutable(await basis());
			change(b);
			expect(() => normalized(b)).toThrow(C2Error);
		}
	});
	it("separates semantic identity from actual receipt and full-delivery facts", async () => {
		const b = mutable(await basis()),
			facts = {
				deliveryCommit: "a".repeat(40),
				currentAuthority: { revision: "b".repeat(40), recordDigest: "c".repeat(64) },
			},
			a = projectC2Delivery(b, facts);
		at(b.observations).initial.bodySha256 = "d".repeat(64);
		const next = projectC2Delivery(b, facts);
		expect(next.semanticDigest).toBe(a.semanticDigest);
		expect(next.deliveryDigest).not.toBe(a.deliveryDigest);
		expect(a.deliveryDigest).toBe(
			"41009d8833a20c0cba7a1c159635c3fa496f2fd972a4e4777d93b126a940beb2",
		);
		expect(
			projectC2Delivery(b, { ...facts, deliveryCommit: "e".repeat(40) }).deliveryDigest,
		).not.toBe(next.deliveryDigest);
		expect(() => projectC2Delivery(b, { ...facts, approved: true })).toThrow(C2Error);
		expect(
			projectC2Delivery(b, {
				...facts,
				currentAuthority: { ...facts.currentAuthority, recordDigest: "e".repeat(64) },
			}).deliveryDigest,
		).not.toBe(next.deliveryDigest);
		b.completedAtMs++;
		expect(projectC2Delivery(b, facts).deliveryDigest).not.toBe(next.deliveryDigest);
	});
	it("does not bridge C2 into v1 or mistake the old authority version2 for a C2 selector", async () => {
		const b = await basis();
		expect(() => normalizeCurrentBasis(b as never)).toThrow();
		expect(() => normalizeC2ReleaseBasis({ ...b, schemaVersion: 1 })).toThrow(C2Error);
		const legacy = {
			version: 2,
			state: "active",
			termination: "release-or-validated-fix",
			evidenceKind: "actual-source",
			confirmation: "unchanged-scope",
			binding: {
				graph: "1".repeat(64),
				lock: "2".repeat(64),
				inputs: "3".repeat(64),
				basis: "4".repeat(64),
				releases: "5".repeat(64),
				security: "6".repeat(64),
				policy: "7".repeat(64),
			},
			review: { at: "2026-10-27T13:15:04Z", due: "2026-11-03T13:15:04Z" },
			exceptions: [],
		};
		expect(preflightDecision(legacy)).toBeNull();
		expect(preflightDecision({ ...legacy, releaseBasisSchemaVersion: 2 })).toEqual({
			verdict: "refuse",
			reason: "AUTHORITY_INVALID",
		});
		// A future separately reviewed authority selector/mount is required; neither data hash grants one.
	});
});
