import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuditFinding } from "../src/cargo-deny.ts";
import type {
	CurrentBasisInput,
	CurrentBasisProducer,
	CurrentBasisV2Input,
} from "../src/current-basis.ts";
import { BOUNDED_TUPLES } from "../src/decision.ts";
import { createTestManualReleaseObserver } from "../src/manual-release-source.ts";
import type { NativeAuditData } from "../src/native-audit-source.ts";
import { createTestProtectedManualAssessmentSource } from "../src/protected-manual-assessment-source.ts";
import { canonicalC2 } from "../src/release-c2.ts";
import { fixture as manualFixture } from "./fixtures/manual-release-source.ts";
import {
	basis as c2FixtureBasis,
	syntheticBasis as syntheticC2Basis,
} from "./fixtures/release-c2.ts";

const network = vi.hoisted(() => ({
	request: vi.fn(() => {
		throw Error("network is forbidden in this fixture");
	}),
}));
vi.mock("node:https", () => ({ request: network.request }));
const {
	BasisError,
	normalizeCurrentBasis,
	loadCurrentBasis,
	UnavailableCurrentBasisProducer,
	normalizeCurrentBasisV2,
	currentBasisV2Scope,
	CURRENT_BASIS_V2_COVERAGE_DIGEST,
} = await import("../src/current-basis.ts");
const SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const NOW = 1_800_000_000_000;
function fixture(): CurrentBasisInput {
	const findings: AuditFinding[] = BOUNDED_TUPLES.map(([name, version, id]) => ({
		source: SOURCE,
		name,
		version,
		classification: "unsound",
		advisory: {
			id,
			package: name,
			informational: "unsound",
			categories: ["thread-safety"],
			collection: "crates",
			source: null,
			date: "2026-01-01",
			withdrawn: null,
			cvss: null,
		},
		affected: {
			arch: ["x86_64"],
			os: ["linux"],
			functions: [[`${name}::method`, [">=0.1.0, <9.0.0"]]],
		},
		patched: [">=9.0.0"],
		unaffected: ["<0.1.0"],
	}));
	return {
		findings,
		database: {
			delivery: "independent-current-head",
			commit: "a".repeat(40),
			currentCommit: "a".repeat(40),
			revision: "b".repeat(64),
			observedAt: NOW - 1000,
		},
		releases: {
			source: "crates.io",
			revision: "c".repeat(64),
			observedAt: NOW - 2000,
			crates: BOUNDED_TUPLES.map(([name, version]) => ({
				source: SOURCE,
				name,
				versions: [
					{
						version,
						createdAt: NOW - 86_400_000,
						yanked: false,
						checksum: "d".repeat(64),
						license: "MIT OR Apache-2.0",
						features: { default: ["std", "dep:invented-dependency"], std: [] },
						dependencies: [
							{
								name: "invented-dependency",
								requirement: "^1.0.0",
								kind: "normal",
								target: null,
								optional: false,
								defaultFeatures: true,
								features: ["default"],
								registry: null,
								rename: null,
							},
						],
					},
				],
			})),
		},
		security: {
			source: "verified-security-event-feed",
			revision: "e".repeat(64),
			observedAt: NOW - 3000,
			events: [
				{
					source: SOURCE,
					name: "glib",
					version: "0.18.5",
					id: "RUSTSEC-2024-0429",
					kind: "advisory",
					publishedAt: NOW - 86_400_000,
					revision: "f".repeat(64),
				},
			],
		},
		startedAt: NOW,
		completedAt: NOW + 100,
		maxAgeMs: 3_600_000,
	};
}
function change(
	input: CurrentBasisInput,
	path: readonly (string | number)[],
	value: unknown,
): CurrentBasisInput {
	const copy = structuredClone(input);
	let target: unknown = copy;
	for (const key of path.slice(0, -1)) target = (target as Record<string, unknown>)[String(key)];
	(target as Record<string, unknown>)[String(path.at(-1))] = value;
	return copy;
}
function refuses(input: CurrentBasisInput, code = "BASIS_INVALID"): void {
	expect(() => normalizeCurrentBasis(input)).toThrow(BasisError);
	try {
		normalizeCurrentBasis(input);
	} catch (error) {
		expect((error as InstanceType<typeof BasisError>).code).toBe(code);
	}
}
function producer(input: CurrentBasisInput): CurrentBasisProducer {
	return {
		database: async () => input.database,
		releases: async () => input.releases,
		security: async () => input.security,
	};
}

describe("semantic basis and separate observation bindings", () => {
	it("includes complete package feature maps in the release semantic identity", () => {
		const input = fixture();
		const original = normalizeCurrentBasis(input);
		for (const features of [
			{},
			{ default: ["std"], std: [] },
			{ default: ["std", "dep:invented-dependency"], std: [], added: [] },
		]) {
			const next = normalizeCurrentBasis(
				change(input, ["releases", "crates", 0, "versions", 0, "features"], features),
			);
			expect(next.releasesDigest).not.toBe(original.releasesDigest);
			expect(next.basisDigest).toBe(original.basisDigest);
			expect(next.observationDigest).toBe(original.observationDigest);
		}
		const reordered = change(input, ["releases", "crates", 0, "versions", 0, "features"], {
			std: [],
			default: ["dep:invented-dependency", "std"],
		});
		expect(normalizeCurrentBasis(reordered)).toEqual(original);
	});
	it("refuses malformed, oversized and effectful package feature maps without reading them", () => {
		const path = ["releases", "crates", 0, "versions", 0, "features"] as const;
		for (const map of [
			undefined,
			null,
			[],
			{ "": [] },
			{ default: [""] },
			{ default: ["std", "std"] },
			{ default: ["std\r"] },
			{ default: ["\ud800"] },
			{ default: {} },
			{ default: ["a".repeat(65_537)] },
			Object.fromEntries(Array.from({ length: 100_001 }, (_, i) => [`feature${i}`, []])),
			Object.create({ inherited: [] }),
		])
			refuses(change(fixture(), path, map));
		let reads = 0;
		const accessor = Object.defineProperty({}, "default", {
			get() {
				reads++;
				return [];
			},
		});
		refuses(change(fixture(), path, accessor));
		const proxy = new Proxy(
			{},
			{
				ownKeys() {
					reads++;
					return [];
				},
			},
		);
		refuses(change(fixture(), path, proxy));
		expect(reads).toBe(0);
	});
	it("binds three complete field-only sources and independently domain-separated payloads", () => {
		const result = normalizeCurrentBasis(fixture());
		expect(result.observedAt).toBe(NOW - 3000);
		for (const kind of ["basis", "releases", "security", "observation"] as const) {
			const expected = createHash("sha256")
				.update(`draftyak/native-dependency-policy/${kind}/v1\0`)
				.update(JSON.stringify(result.tuplePayloads[kind]), "utf8")
				.digest("hex");
			expect(result[`${kind}Digest`]).toBe(expected);
			expect(result.tuplePayloads[kind][0]).toBe(kind);
			expect(result.tuplePayloads[kind][1]).toBe(1);
		}
		expect(
			new Set([
				result.basisDigest,
				result.releasesDigest,
				result.securityDigest,
				result.observationDigest,
			]).size,
		).toBe(4);
	});
	it("keeps semantic digests stable across fresh observations but changes observation digest", () => {
		const f = fixture(),
			a = normalizeCurrentBasis(f);
		const b = normalizeCurrentBasis({
			...f,
			database: { ...f.database, observedAt: NOW - 500 },
			releases: { ...f.releases, observedAt: NOW - 1000 },
			security: { ...f.security, observedAt: NOW - 1500 },
			startedAt: NOW + 1000,
			completedAt: NOW + 1100,
		});
		expect([b.basisDigest, b.releasesDigest, b.securityDigest]).toEqual([
			a.basisDigest,
			a.releasesDigest,
			a.securityDigest,
		]);
		expect(b.observationDigest).not.toBe(a.observationDigest);
		expect(b.observedAt).toBe(NOW - 1500);
	});
	it("is stable across unordered top-level rows", () => {
		const f = fixture(),
			c = structuredClone(f);
		(c.findings as AuditFinding[]).reverse();
		(c.releases.crates as unknown[]).reverse();
		expect(normalizeCurrentBasis(c)).toEqual(normalizeCurrentBasis(f));
	});
	it("is stable across multi-element nested sets and dependency rows", () => {
		let f = fixture();
		const dependency = f.releases.crates[0]?.versions[0]?.dependencies[0];
		if (!dependency) throw Error("fixture");
		const arrays: readonly [readonly (string | number)[], readonly unknown[]][] = [
			[
				["findings", 0, "advisory", "categories"],
				["thread-safety", "memory-corruption"],
			],
			[
				["findings", 0, "patched"],
				[">=9.0.0", ">=10.0.0"],
			],
			[
				["findings", 0, "unaffected"],
				["<0.1.0", "=0.2.0"],
			],
			[
				["findings", 0, "affected", "arch"],
				["x86_64", "aarch64"],
			],
			[
				["findings", 0, "affected", "os"],
				["linux", "windows"],
			],
			[
				["findings", 0, "affected", "functions"],
				[
					["glib::a", [">=0.1.0"]],
					["glib::b", ["<2.0.0"]],
				],
			],
			[
				["releases", "crates", 0, "versions", 0, "dependencies"],
				[dependency, { ...dependency, name: "other-dependency" }],
			],
		];
		for (const [path, value] of arrays) f = change(f, path, value);
		let reordered = f;
		for (const [path, value] of arrays) reordered = change(reordered, path, [...value].reverse());
		expect(normalizeCurrentBasis(reordered)).toEqual(normalizeCurrentBasis(f));
	});
	it("binds a changed current database commit even with unchanged findings", () => {
		const f = fixture(),
			c = {
				...f,
				database: { ...f.database, commit: "1".repeat(40), currentCommit: "1".repeat(40) },
			};
		expect(normalizeCurrentBasis(c).basisDigest).not.toBe(normalizeCurrentBasis(f).basisDigest);
	});
	it("permits empty findings only as data, without an operational verdict", () => {
		const result = normalizeCurrentBasis({ ...fixture(), findings: [] });
		expect(result).not.toHaveProperty("verdict");
		expect(result).not.toHaveProperty("approved");
	});
	it("accepts all closed event kinds as distinct semantic data", () => {
		const f = fixture(),
			original = normalizeCurrentBasis(f);
		for (const kind of ["release", "security-notice"])
			expect(
				normalizeCurrentBasis(change(f, ["security", "events", 0, "kind"], kind)).securityDigest,
			).not.toBe(original.securityDigest);
	});
	it("includes new version release data rather than silently dropping it", () => {
		const f = fixture(),
			first = f.releases.crates[0];
		if (!first) throw Error("fixture");
		const v = first.versions[0];
		if (!v) throw Error("fixture");
		const changed = change(
			f,
			["releases", "crates", 0, "versions"],
			[...first.versions, { ...v, version: "99.0.0" }],
		);
		expect(normalizeCurrentBasis(changed).releasesDigest).not.toBe(
			normalizeCurrentBasis(f).releasesDigest,
		);
	});
	for (const [field, path, value] of [
		["database revision", ["database", "revision"], "1".repeat(64)],
		["advisory classification", ["findings", 0, "advisory", "categories"], ["memory-corruption"]],
		["advisory date", ["findings", 0, "advisory", "date"], "2026-02-01"],
		["CVSS", ["findings", 0, "advisory", "cvss"], "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"],
		[
			"affected function",
			["findings", 0, "affected", "functions"],
			[["glib::other", [">=0.1.0, <9.0.0"]]],
		],
		["affected architecture", ["findings", 0, "affected", "arch"], ["aarch64"]],
		["affected OS", ["findings", 0, "affected", "os"], ["windows"]],
		["patched range", ["findings", 0, "patched"], [">=8.0.0"]],
		["unaffected range", ["findings", 0, "unaffected"], ["<0.2.0"]],
	] as const)
		it(`changes basis digest for independent ${field}`, () => {
			const f = fixture();
			expect(normalizeCurrentBasis(change(f, path, value)).basisDigest).not.toBe(
				normalizeCurrentBasis(f).basisDigest,
			);
		});
	for (const [field, path, value] of [
		["release revision", ["releases", "revision"], "1".repeat(64)],
		[
			"publication instant",
			["releases", "crates", 0, "versions", 0, "createdAt"],
			NOW - 86_400_001,
		],
		["yanked", ["releases", "crates", 0, "versions", 0, "yanked"], true],
		["checksum", ["releases", "crates", 0, "versions", 0, "checksum"], "1".repeat(64)],
		["licence", ["releases", "crates", 0, "versions", 0, "license"], "MIT"],
		[
			"dependency name",
			["releases", "crates", 0, "versions", 0, "dependencies", 0, "name"],
			"other-dependency",
		],
		[
			"dependency requirement",
			["releases", "crates", 0, "versions", 0, "dependencies", 0, "requirement"],
			"^2.0.0",
		],
		[
			"dependency kind",
			["releases", "crates", 0, "versions", 0, "dependencies", 0, "kind"],
			"build",
		],
		[
			"dependency target",
			["releases", "crates", 0, "versions", 0, "dependencies", 0, "target"],
			"cfg(windows)",
		],
		["optional", ["releases", "crates", 0, "versions", 0, "dependencies", 0, "optional"], true],
		[
			"defaults",
			["releases", "crates", 0, "versions", 0, "dependencies", 0, "defaultFeatures"],
			false,
		],
		[
			"features",
			["releases", "crates", 0, "versions", 0, "dependencies", 0, "features"],
			["other"],
		],
		[
			"registry",
			["releases", "crates", 0, "versions", 0, "dependencies", 0, "registry"],
			"https://example.invalid/index",
		],
		["rename", ["releases", "crates", 0, "versions", 0, "dependencies", 0, "rename"], "renamed"],
	] as const)
		it(`changes release digest for independent ${field}`, () => {
			const f = fixture();
			expect(normalizeCurrentBasis(change(f, path, value)).releasesDigest).not.toBe(
				normalizeCurrentBasis(f).releasesDigest,
			);
		});
	for (const [field, path, value] of [
		["source revision", ["security", "revision"], "1".repeat(64)],
		["event id", ["security", "events", 0, "id"], "SECURITY-2"],
		["event publication", ["security", "events", 0, "publishedAt"], NOW - 86_400_001],
		["event revision", ["security", "events", 0, "revision"], "1".repeat(64)],
	] as const)
		it(`changes security digest for independent ${field}`, () => {
			const f = fixture();
			expect(normalizeCurrentBasis(change(f, path, value)).securityDigest).not.toBe(
				normalizeCurrentBasis(f).securityDigest,
			);
		});
});

describe("strict freshness and data refusal", () => {
	for (const source of ["database", "releases", "security"] as const) {
		it(`requires delivered ${source}`, () => refuses(change(fixture(), [source], null)));
		it(`requires immutable ${source} revision`, () =>
			refuses(change(fixture(), [source, "revision"], "current")));
		it(`accepts fresh ${source} observations collected during the run`, () => {
			const f = { ...fixture(), completedAt: NOW + 1000 };
			expect(() => normalizeCurrentBasis(change(f, [source, "observedAt"], NOW + 1))).not.toThrow();
			expect(normalizeCurrentBasis(change(f, [source, "observedAt"], NOW + 1000))).toHaveProperty(
				"version",
				1,
			);
		});
		it(`refuses ${source} observations after completion`, () =>
			refuses(
				change({ ...fixture(), completedAt: NOW + 1000 }, [source, "observedAt"], NOW + 1001),
			));
		it(`accepts cached ${source} observations only while fresh through completion`, () => {
			expect(
				normalizeCurrentBasis(change(fixture(), [source, "observedAt"], NOW - 60_000)),
			).toHaveProperty("version", 1);
			refuses(change(fixture(), [source, "observedAt"], NOW - 3_600_000), "BASIS_STALE");
		});
		it(`refuses exact stale ${source} observations at completion`, () =>
			refuses(change(fixture(), [source, "observedAt"], NOW + 100 - 3_600_000), "BASIS_STALE"));
	}
	it("accepts one millisecond before the strict age boundary", () => {
		const f = change(fixture(), ["security", "observedAt"], NOW + 100 - 3_600_000 + 1);
		expect(normalizeCurrentBasis(f).observedAt).toBe(NOW + 100 - 3_600_000 + 1);
	});
	for (const [title, path, value] of [
		["backward clock", ["completedAt"], NOW - 1],
		["zero maximum age", ["maxAgeMs"], 0],
		["excess maximum age", ["maxAgeMs"], 3_600_001],
		["fractional age", ["maxAgeMs"], 1.5],
		["unsafe time", ["startedAt"], Number.MAX_SAFE_INTEGER + 1],
		["local ref as independent delivery", ["database", "delivery"], "local-ref"],
		["cached DB mismatches current head", ["database", "currentCommit"], "1".repeat(40)],
		["unknown release source", ["releases", "source"], "mirror"],
		["unverified security feed", ["security", "source"], "unverified"],
		["unknown event kind", ["security", "events", 0, "kind"], "all-safe"],
		["future event", ["security", "events", 0, "publishedAt"], NOW + 1],
		["future release", ["releases", "crates", 0, "versions", 0, "createdAt"], NOW + 1],
		["wrong scoped source", ["findings", 0, "source"], "registry+https://example.invalid/index"],
		["wrong advisory id", ["findings", 0, "advisory", "id"], "RUSTSEC-2026-9999"],
		["wrong scoped version", ["findings", 0, "version"], "0.18.6"],
		["classification inconsistency", ["findings", 0, "classification"], "unmaintained"],
		["withdrawn advisory", ["findings", 0, "advisory", "withdrawn"], "2026-02-01"],
		["prose in range", ["findings", 0, "patched"], ["arbitrary prose"]],
		["prose in CVSS", ["findings", 0, "advisory", "cvss"], "arbitrary prose"],
		[
			"lone surrogate",
			["releases", "crates", 0, "versions", 0, "dependencies", 0, "target"],
			"\ud800",
		],
		[
			"credentials",
			["releases", "crates", 0, "versions", 0, "dependencies", 0, "registry"],
			"https://invented:placeholder@example.invalid/index",
		],
		["invalid checksum", ["releases", "crates", 0, "versions", 0, "checksum"], "d".repeat(63)],
		["wrong boolean", ["releases", "crates", 0, "versions", 0, "yanked"], "false"],
		[
			"unknown dependency kind",
			["releases", "crates", 0, "versions", 0, "dependencies", 0, "kind"],
			"future",
		],
	] as const)
		it(title, () => refuses(change(fixture(), path, value)));
	for (const suffix of ["\r", "\n", "\u2028", "\u2029"])
		it(`requires complete scalar identifier ${JSON.stringify(suffix)}`, () =>
			refuses(change(fixture(), ["security", "events", 0, "id"], `EVENT${suffix}`)));
	it("refuses a missing scoped release crate", () => {
		const f = fixture();
		refuses(change(f, ["releases", "crates"], f.releases.crates.slice(1)));
	});
	it("refuses duplicate scoped release crates", () => {
		const f = fixture();
		refuses(change(f, ["releases", "crates"], [...f.releases.crates, f.releases.crates[0]]));
	});
	it("refuses a missing exact scoped version", () =>
		refuses(change(fixture(), ["releases", "crates", 0, "versions", 0, "version"], "99.0.0")));
	it("refuses duplicate version identities with changed metadata", () => {
		const f = fixture(),
			v = f.releases.crates[0]?.versions[0];
		if (!v) throw Error("fixture");
		refuses(change(f, ["releases", "crates", 0, "versions"], [v, { ...v, yanked: true }]));
	});
	it("refuses duplicate findings", () => {
		const f = fixture();
		refuses({ ...f, findings: [...f.findings, f.findings[0]!] });
	});
	it("refuses duplicate event identities", () => {
		const f = fixture();
		refuses(change(f, ["security", "events"], [...f.security.events, ...f.security.events]));
	});
	it("refuses contact/prose fields without evaluating their accessors", () => {
		const f = fixture(),
			version = f.releases.crates[0]?.versions[0];
		if (!version) throw Error("fixture");
		let read = false;
		Object.defineProperty(version, "contact", {
			enumerable: true,
			get() {
				read = true;
				throw Error("must remain unread");
			},
		});
		refuses(f);
		expect(read).toBe(false);
	});
	it("captures data descriptors without executing a getter for a required field", () => {
		const f = fixture();
		let read = false;
		Object.defineProperty(f.database, "commit", {
			get() {
				read = true;
				return "a".repeat(40);
			},
		});
		refuses(f);
		expect(read).toBe(false);
	});
	it("refuses unknown data fields", () => {
		const f = fixture();
		Object.assign(f.database, { approved: true });
		refuses(f);
	});
	it("refuses sparse arrays and extra array fields", () => {
		const f = fixture(),
			a = [...f.findings];
		delete a[0];
		refuses({ ...f, findings: a });
		Object.assign(a, { extra: 1 });
		refuses({ ...f, findings: a });
	});
	it("refuses cycles before unbounded recursion", () => {
		const f = fixture();
		Object.assign(f.database, { loop: f });
		refuses(f);
	});
	it("refuses excessive string extent", () =>
		refuses(
			change(
				fixture(),
				["releases", "crates", 0, "versions", 0, "dependencies", 0, "target"],
				"x".repeat(65_537),
			),
		));
	it("refuses excessive depth", () => {
		let value: unknown = null;
		for (let i = 0; i < 65; i++) value = [value];
		refuses(change(fixture(), ["security", "events"], value));
	});
});

describe("verified producer boundary", () => {
	it("obtains all three sources without HTTPS or an operational allowance", async () => {
		const f = fixture(),
			result = await loadCurrentBasis(
				producer(f),
				f.findings,
				{
					startedAt: f.startedAt,
					maxAgeMs: f.maxAgeMs,
				},
				() => f.completedAt,
			);
		expect(result).toEqual(normalizeCurrentBasis(f));
		expect(network.request).not.toHaveBeenCalled();
	});
	for (const field of ["database", "releases", "security"] as const)
		it(`refuses unavailable ${field} rather than falling back to cached evidence`, async () => {
			const f = fixture(),
				p = producer(f);
			p[field] = async () => {
				throw Error("invented producer failure must not escape");
			};
			await expect(
				loadCurrentBasis(p, f.findings, { startedAt: f.startedAt, maxAgeMs: f.maxAgeMs }),
			).rejects.toMatchObject({
				code: "BASIS_UNAVAILABLE",
				message: "current dependency basis refused",
			});
			expect(network.request).not.toHaveBeenCalled();
		});
	it("keeps default production unavailable for every source", async () => {
		const p = new UnavailableCurrentBasisProducer();
		for (const method of ["database", "releases", "security"] as const)
			await expect(p[method]()).rejects.toMatchObject({ code: "BASIS_UNAVAILABLE" });
		const f = fixture();
		await expect(
			loadCurrentBasis(p, f.findings, { startedAt: f.startedAt, maxAgeMs: f.maxAgeMs }),
		).rejects.toMatchObject({
			code: "BASIS_UNAVAILABLE",
		});
		expect(network.request).not.toHaveBeenCalled();
	});
	it("measures completion only after the last asynchronous source is collected", async () => {
		const f = fixture(),
			calls: string[] = [];
		const p: CurrentBasisProducer = {
			database: async () => {
				calls.push("database");
				return { ...f.database, observedAt: NOW + 1 };
			},
			releases: async () => {
				calls.push("releases");
				return { ...f.releases, observedAt: NOW + 500 };
			},
			security: async () => {
				await Promise.resolve();
				calls.push("security");
				return { ...f.security, observedAt: NOW + 999 };
			},
		};
		const result = await loadCurrentBasis(
			p,
			f.findings,
			{ startedAt: NOW, maxAgeMs: 3_600_000 },
			() => {
				calls.push("clock");
				return NOW + 1000;
			},
		);
		expect(calls).toEqual(["database", "releases", "security", "clock"]);
		expect(result.observedAt).toBe(NOW + 1);
		expect(result.tuplePayloads.observation[3]).toBe(NOW + 1000);
	});
	it("refuses evidence that becomes stale during asynchronous collection", async () => {
		const f = change(fixture(), ["security", "observedAt"], NOW - 3_600_000 + 1);
		let clock = NOW;
		const p = producer(f);
		p.security = async () => {
			await Promise.resolve();
			clock = NOW + 2;
			return f.security;
		};
		await expect(
			loadCurrentBasis(p, f.findings, { startedAt: NOW, maxAgeMs: 3_600_000 }, () => clock),
		).rejects.toMatchObject({ code: "BASIS_STALE" });
	});
	it("uses the default completion clock after collection", async () => {
		const f = fixture(),
			p = producer(f),
			clock = vi.spyOn(Date, "now").mockReturnValue(NOW + 1000);
		p.security = async () => {
			expect(clock).not.toHaveBeenCalled();
			return { ...f.security, observedAt: NOW + 1 };
		};
		try {
			const result = await loadCurrentBasis(p, f.findings, { startedAt: NOW, maxAgeMs: 3_600_000 });
			expect(result.tuplePayloads.observation[3]).toBe(NOW + 1000);
			expect(clock).toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});
	it("refuses a completion timestamp supplied as a collection option", async () => {
		const f = fixture();
		await expect(
			loadCurrentBasis(producer(f), f.findings, {
				startedAt: NOW,
				maxAgeMs: 3_600_000,
				completedAt: NOW + 1000,
			} as never),
		).rejects.toMatchObject({ code: "BASIS_INVALID" });
	});
});

const v2JsonHash = (value: unknown): string =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const v2Hash = (domain: string, value: unknown): string =>
	createHash("sha256")
		.update(`draftyak/native-dependency-policy/${domain}/v1\0`)
		.update(canonicalC2(value))
		.digest("hex");

/** Wholly invented DATA. None of these structural fixtures is a native source receipt. */
async function v2Fixture(offset = 0, deliveredAt = "a".repeat(40)): Promise<CurrentBasisV2Input> {
	const legacy = fixture(),
		graphPayload = ["TEST_ONLY_GRAPH", 1, SOURCE] as const;
	const ancestors = BOUNDED_TUPLES.map(([name, version]) => {
		const tuplePayload = ["TEST_ONLY_ANCESTOR", 1, SOURCE, name, version] as const;
		return {
			target: { source: SOURCE, name, version },
			packageCount: 1,
			tuplePayload,
			digest: createHash("sha256")
				.update("draftyak/native-dependency-policy/ancestor/v1\0")
				.update(JSON.stringify(tuplePayload))
				.digest("hex"),
		};
	});
	const diagnostics = legacy.findings.map((finding) => ({
		category: "advisories" as const,
		severity: "error" as const,
		code: finding.classification,
		graphs: [
			{ name: finding.name, version: finding.version, kind: null, parents: [], repeat: false },
		],
		advisory: finding.advisory,
	}));
	const report = {
		version: 1 as const,
		complete: true as const,
		fullExitCode: 1,
		advisoryExitCode: 1,
		denyWarnings: false,
		counts: {
			advisories: { errors: 5, warnings: 0, notes: 0, helps: 0 },
			bans: { errors: 0, warnings: 0, notes: 0, helps: 0 },
			licenses: { errors: 0, warnings: 0, notes: 0, helps: 0 },
			sources: { errors: 0, warnings: 0, notes: 0, helps: 0 },
		},
		diagnostics,
		advisoryDiagnostics: diagnostics,
		findings: legacy.findings,
		dependencyCount: 5,
	};
	const audit: NativeAuditData = {
		kind: "SAME_ROOT_STRICT_AUDIT_DATA",
		authority: false,
		reusableNativeSourceBasis: false,
		runId: "7".repeat(32),
		startedAt: NOW - 3000 + offset,
		completedAt: NOW - 2500 + offset,
		observedAt: NOW - 3000 + offset,
		database: { ...legacy.database, observedAt: NOW - 2900 + offset },
		graphDigest: createHash("sha256")
			.update("draftyak/native-dependency-policy/graph/v1\0")
			.update(JSON.stringify(graphPayload))
			.digest("hex"),
		graph: {
			version: 1,
			digest: "",
			packageCount: 5,
			tuplePayload: graphPayload,
			ancestorDigests: ancestors,
		},
		environmentDigest: "1".repeat(64),
		inputDigest: "2".repeat(64),
		lockDigest: "3".repeat(64),
		toolsDigest: "4".repeat(64),
		policySha256: "5".repeat(64),
		effectivePolicySha256: "6".repeat(64),
		reportDigest: v2JsonHash(report),
		report,
		strictPass: false,
		captures: ["metadata", "full", "advisory"].map((id) => ({
			id,
			exitCode: id === "metadata" ? 0 : 1,
			stdoutBytes: 2,
			stdoutSha256: "8".repeat(64),
			stderrBytes: 0,
			stderrSha256: "9".repeat(64),
		})),
	};
	Reflect.set(audit.graph, "digest", audit.graphDigest);
	const scope = currentBasisV2Scope(audit),
		originalC2 = await c2FixtureBasis(),
		shift = NOW - 2100 + offset - originalC2.startedAtMs;
	const releases = {
		...originalC2,
		scopeBinding: scope,
		startedAtMs: originalC2.startedAtMs + shift,
		completedAtMs: originalC2.completedAtMs + shift,
		observations: originalC2.observations.map((o) => ({
			...o,
			initial: { ...o.initial, observedAtMs: o.initial.observedAtMs + shift },
			recheck: { ...o.recheck, observedAtMs: o.recheck.observedAtMs + shift },
		})),
	};
	const channels = (
		[
			["G1", 366664320, "gtk-rs/gtk-rs-core"],
			["G2", 639304056, "z-galaxy/zbus"],
		] as const
	).map(([channel, id, fullName], index) => {
		const receipt = (time: number, n: number) => ({
			observedAt: time + offset,
			bodySha256: String(n).repeat(64),
			projectionSha256: String(n + 2).repeat(64),
		});
		return {
			channel,
			repository: { id, fullName, defaultBranch: "main" },
			inventory: [] as never[],
			initial: {
				repository: receipt(NOW - 1700 + index, 1),
				advisories: receipt(NOW - 1690 + index, 2),
			},
			recheck: {
				repository: receipt(NOW - 1600 + index, 1),
				advisories: receipt(NOW - 1590 + index, 2),
			},
		};
	});
	const github = {
		delivery: "fixed-public-github-advisory-channels" as const,
		revision: createHash("sha256")
			.update("draftyak/native-dependency-policy/github-security-channels/v1\0")
			.update(
				JSON.stringify(
					channels.map((c) => [
						c.channel,
						c.repository.id,
						c.repository.fullName,
						c.repository.defaultBranch,
						c.initial.repository.projectionSha256,
						c.initial.advisories.projectionSha256,
					]),
				),
			)
			.digest("hex"),
		deliveryRevision: "d".repeat(64),
		observedAt: NOW - 1700 + offset,
		completedAt: NOW - 1300 + offset,
		channels,
	};
	Reflect.set(
		github,
		"deliveryRevision",
		createHash("sha256")
			.update("draftyak/native-dependency-policy/github-security-channel-delivery/v1\0")
			.update(JSON.stringify([NOW - 1800 + offset, github.completedAt, channels]))
			.digest("hex"),
	);
	const tuples = BOUNDED_TUPLES.map(([name, version, advisory], index) => ({
		name,
		version,
		advisory,
		source: SOURCE,
		ancestor: ancestors[index]!.digest,
	}));
	const record = {
		version: 2,
		releaseBasisSchemaVersion: 2,
		state: "active",
		termination: "release-or-validated-fix",
		evidenceKind: "actual-source",
		confirmation: "unchanged-scope",
		binding: {
			graph: scope.graph,
			lock: scope.lock,
			inputs: scope.inputs,
			policy: audit.policySha256,
			basis: "a".repeat(64),
			releases: "b".repeat(64),
			security: "c".repeat(64),
		},
		review: { at: "2026-10-20T13:15:04Z", due: "2026-10-27T13:15:04Z" },
		exceptions: tuples,
	};
	const currentAuthority = { revision: deliveredAt, recordDigest: v2JsonHash(record), record };
	const resources = manualFixture(),
		wall = () => NOW - 1000 + offset;
	const manual = createTestManualReleaseObserver({
		fetch: async (url) => {
			const found = resources.get(url);
			if (!found) throw new Error("missing invented M resource");
			return found;
		},
		wall,
		monotonic: () => 0,
	});
	const content = await manual.observe(),
		dispositions = () =>
			BOUNDED_TUPLES.map(([tuple]) => ({
				tuple,
				relevance: "not-relevant",
				outcome: "unchanged-scope",
			}));
	const assessment = {
		version: 1,
		kind: "OWNER_MANUAL_RELEASE_ASSESSMENT",
		assessedAt: 1000,
		originalObservation: {
			revision: "e".repeat(64),
			startedAt: 100,
			completedAt: 200,
			oldestObservedAt: 150,
		},
		manualSemanticRevision: content.semanticRevision,
		scope: { ...scope, policy: audit.policySha256 },
		coverage: {
			model: "D189-fixed-manual-release-content",
			exclusions: [
				"unpublished-private-draft-embargoed-unreported",
				"unlisted-linked-websites-issues-chat-discussions-mailing-lists-policies",
				"native-system-ancestor-notices-outside-fixed-methods",
				"transitive-release-notices-outside-five-tuples",
			],
		},
		tuples,
		inventories: content.inventories,
		channels: content.inventories.map((i) => ({
			channel: i.channel,
			dispositions: dispositions(),
		})),
		items: content.inventories.flatMap((i) =>
			i.releases.map((r) => ({
				channel: i.channel,
				releaseId: r.id,
				dispositions: dispositions(),
			})),
		),
	};
	const source = createTestProtectedManualAssessmentSource({
		authority: {
			currentRevision: async () => deliveredAt,
			recordAt: async () => Buffer.from(JSON.stringify(record)),
			manualAssessmentAt: async () => Buffer.from(JSON.stringify(assessment)),
		},
		manual,
		wall,
	});
	const manualFacts = source.facts(await source.observe());
	return {
		audit,
		releases,
		github,
		manual: manualFacts,
		currentAuthority,
		startedAt: NOW - 3100 + offset,
		completedAt: NOW + 100 + offset,
		maxAgeMs: 3_600_000,
	};
}
function v2Change(
	input: CurrentBasisV2Input,
	path: readonly (string | number)[],
	value: unknown,
): CurrentBasisV2Input {
	const output = structuredClone(input);
	let target: unknown = output;
	for (const key of path.slice(0, -1)) target = (target as Record<string, unknown>)[String(key)];
	Reflect.set(target as object, String(path.at(-1)), value);
	return output;
}
function resealManual(input: CurrentBasisV2Input): CurrentBasisV2Input {
	const output = structuredClone(input),
		row = output.manual as unknown as Record<string, unknown>,
		record = row.assessment as Record<string, unknown>;
	const m = row.manual as Record<string, unknown>;
	m.observationRevision = v2Hash("manual-release-observations", {
		kind: m.kind,
		origin: m.origin,
		semanticRevision: m.semanticRevision,
		startedAt: m.startedAt,
		completedAt: m.completedAt,
		receipts: m.receipts,
	});
	const { originalObservation: _old, ...semantic } = record;
	row.semanticDigest = v2Hash("protected-manual-assessment/semantic", {
		manualSemanticRevision: record.manualSemanticRevision,
		assessment: semantic,
	});
	const delivery = row.delivery as Record<string, unknown>;
	delivery.assessmentContentDigest = v2Hash("protected-manual-assessment/content", record);
	delivery.assessmentRecordSha256 = v2JsonHash(record);
	const { observationDigest: _digest, ...payload } = row;
	row.observationDigest = v2Hash("protected-manual-assessment/delivery", payload);
	return output;
}

describe("lossless finite schema2 current basis DATA", () => {
	it("keeps complete source-aware fields and receipts without a v1 conversion or authority", async () => {
		const input = await v2Fixture(),
			result = normalizeCurrentBasisV2(input);
		expect(result).toMatchObject({
			version: 2,
			releaseBasisSchemaVersion: 2,
			authority: false,
			reusableNativeSourceBasis: false,
		});
		expect(result.scope.coverage).toBe(CURRENT_BASIS_V2_COVERAGE_DIGEST);
		expect(result.observedAt).toBe(input.audit.observedAt);
		expect(result.components.releases).toEqual(input.releases);
		expect(result.components.releases.crates[0]?.versions[0]?.api.publication.fractionDigits).toBe(
			9,
		);
		expect(
			result.components.releases.crates[0]?.versions[0]?.index.publication.fractionDigits,
		).toBe(0);
		expect(result.components.manual.assessment.assessedAt).toBe(1000);
		expect(Object.isFrozen(result.components.manual.assessment.items)).toBe(true);
		expect(result.components.audit.report.fullExitCode).toBe(1);
		expect(result).not.toHaveProperty("verdict");
	});
	it.each(["precision", "licence"])(
		"retains independent API %s instead of a lossy v1 release row",
		async (field) => {
			const input = await v2Fixture(),
				before = normalizeCurrentBasisV2(input);
			const changed = await syntheticC2Basis((resources) => {
				const url = "https://crates.io/api/v1/crates/glib",
					bytes = resources.get(url);
				if (!bytes) throw new Error("missing invented crate API response");
				const data = JSON.parse(new TextDecoder().decode(bytes)) as {
					versions: Record<string, unknown>[];
				};
				const version = data.versions[0];
				if (!version) throw new Error("missing invented version");
				if (field === "precision") version.created_at = "2025-01-01T00:00:00.123456788Z";
				else version.license = "Apache-2.0";
				resources.set(url, Buffer.from(JSON.stringify(data)));
			});
			const shift = input.releases.startedAtMs - changed.startedAtMs;
			const releases = {
				...changed,
				scopeBinding: input.releases.scopeBinding,
				startedAtMs: changed.startedAtMs + shift,
				completedAtMs: changed.completedAtMs + shift,
				observations: changed.observations.map((o) => ({
					...o,
					initial: { ...o.initial, observedAtMs: o.initial.observedAtMs + shift },
					recheck: { ...o.recheck, observedAtMs: o.recheck.observedAtMs + shift },
				})),
			};
			const after = normalizeCurrentBasisV2({ ...input, releases });
			expect(after.releasesDigest).not.toBe(before.releasesDigest);
			expect(after.components.releases).toEqual(releases);
			expect(after.components.releases.crates[0]?.versions[0]?.index.publication).toEqual(
				before.components.releases.crates[0]?.versions[0]?.index.publication,
			);
		},
	);
	it("reuses the exact old assessment with fresh current observations/B without an hourly human refresh", async () => {
		const a = normalizeCurrentBasisV2(await v2Fixture()),
			b = normalizeCurrentBasisV2(await v2Fixture(100, "b".repeat(40)));
		expect([b.basisDigest, b.releasesDigest, b.securityDigest]).toEqual([
			a.basisDigest,
			a.releasesDigest,
			a.securityDigest,
		]);
		expect(b.observationDigest).not.toBe(a.observationDigest);
		expect(b.sourceRevisions).not.toEqual(a.sourceRevisions);
		expect(b.components.manual.delivery.assessmentContentDigest).toBe(
			a.components.manual.delivery.assessmentContentDigest,
		);
		expect(b.components.manual.assessment.assessedAt).toBe(
			a.components.manual.assessment.assessedAt,
		);
	});
	it("binds FULL static assessment provenance H_A even when reduced M semantics stay equal", async () => {
		const input = await v2Fixture(),
			before = normalizeCurrentBasisV2(input);
		const changed = resealManual(
			v2Change(input, ["manual", "assessment", "originalObservation", "revision"], "f".repeat(64)),
		);
		expect(changed.manual.semanticDigest).toBe(input.manual.semanticDigest);
		expect(changed.manual.delivery.assessmentContentDigest).not.toBe(
			input.manual.delivery.assessmentContentDigest,
		);
		expect(normalizeCurrentBasisV2(changed).securityDigest).not.toBe(before.securityDigest);
	});
	it("never puts dynamic B or full delivery hashes into semantic binding", async () => {
		const input = await v2Fixture(),
			before = normalizeCurrentBasisV2(input);
		const changed = v2Change(input, ["github", "deliveryRevision"], "f".repeat(64));
		const after = normalizeCurrentBasisV2(changed);
		expect(after.securityDigest).toBe(before.securityDigest);
		expect(after.observationDigest).not.toBe(before.observationDigest);
	});
	it.each([
		["old authority", ["currentAuthority", "record", "releaseBasisSchemaVersion"], undefined],
		["foreign B", ["currentAuthority", "revision"], "c".repeat(40)],
		["foreign B hash", ["manual", "delivery", "authorityRecordSha256"], "f".repeat(64)],
		["foreign C2 graph", ["releases", "scopeBinding", "graph"], "f".repeat(64)],
		["declared coverage", ["manual", "assessment", "scope", "coverage"], "f".repeat(64)],
		["lost API licence", ["releases", "crates", 0, "versions", 0, "api", "license"], undefined],
		["missing M channel", ["manual", "assessment", "channels"], []],
		[
			"invented unknown relevance",
			["manual", "assessment", "items", 0, "dispositions", 0, "relevance"],
			"unknown",
		],
		["missing G channel", ["github", "channels"], []],
		["foreign G repository", ["github", "channels", 0, "repository", "id"], 1],
		["mismatched report", ["audit", "reportDigest"], "f".repeat(64)],
	] as const)(
		"refuses %s instead of accepting opaque declared evidence",
		async (_name, path, value) => {
			const input = v2Change(await v2Fixture(), path, value);
			expect(() => normalizeCurrentBasisV2(input)).toThrow(BasisError);
		},
	);
	it("refuses missing/duplicate actual ancestors rather than trusting protected tuple hashes", async () => {
		const input = await v2Fixture();
		for (const rows of [
			input.audit.graph.ancestorDigests.slice(1),
			[...input.audit.graph.ancestorDigests, input.audit.graph.ancestorDigests[0]],
		])
			expect(() =>
				normalizeCurrentBasisV2(v2Change(input, ["audit", "graph", "ancestorDigests"], rows)),
			).toThrow(BasisError);
	});
	it("refuses a resealed foreign protected ancestor and per-tuple omission", async () => {
		const input = await v2Fixture();
		for (const changed of [
			resealManual(
				v2Change(input, ["manual", "assessment", "tuples", 2, "ancestor"], "f".repeat(64)),
			),
			resealManual(v2Change(input, ["manual", "assessment", "channels", 1, "dispositions"], [])),
		])
			expect(() => normalizeCurrentBasisV2(changed)).toThrow(BasisError);
	});
	it("refuses duplicate source receipts even when their observation hashes are recomputed", async () => {
		const input = await v2Fixture();
		const manual = resealManual(
			v2Change(
				input,
				["manual", "manual", "receipts"],
				[...input.manual.manual.receipts, input.manual.manual.receipts[0]],
			),
		);
		expect(() => normalizeCurrentBasisV2(manual)).toThrow(BasisError);
		const releases = v2Change(
			input,
			["releases", "observations"],
			[...input.releases.observations, input.releases.observations[0]],
		);
		expect(() => normalizeCurrentBasisV2(releases)).toThrow(BasisError);
	});
	it("retains exact original source cutoff through a later completion check", async () => {
		const input = await v2Fixture(),
			oldest = input.audit.observedAt;
		expect(() =>
			normalizeCurrentBasisV2({ ...input, completedAt: oldest + 3_600_000 - 1 }),
		).not.toThrow();
		expect(() => normalizeCurrentBasisV2({ ...input, completedAt: oldest + 3_600_000 })).toThrow(
			BasisError,
		);
	});
	it("does not change original source revisions merely because validation completes later", async () => {
		const input = await v2Fixture(),
			before = normalizeCurrentBasisV2(input),
			after = normalizeCurrentBasisV2({ ...input, completedAt: input.completedAt + 100 });
		expect(after.sourceRevisions).toEqual(before.sourceRevisions);
		expect(after.observationDigest).not.toBe(before.observationDigest);
	});
	it("refuses nested effectful DATA without invoking getters or coercion", async () => {
		const input = await v2Fixture();
		let calls = 0;
		const hostile = Object.defineProperty({}, "assessment", {
			enumerable: true,
			get() {
				calls++;
				return input.manual.assessment;
			},
		});
		expect(() => normalizeCurrentBasisV2(v2Change(input, ["manual"], hostile))).toThrow(BasisError);
		expect(calls).toBe(0);
	});
});
