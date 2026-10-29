import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuditFinding } from "../src/cargo-deny.ts";
import type { CurrentBasisInput, CurrentBasisProducer } from "../src/current-basis.ts";
import { BOUNDED_TUPLES } from "../src/decision.ts";

const network = vi.hoisted(() => ({
	request: vi.fn(() => {
		throw Error("network is forbidden in this fixture");
	}),
}));
vi.mock("node:https", () => ({ request: network.request }));
const { BasisError, normalizeCurrentBasis, loadCurrentBasis, UnavailableCurrentBasisProducer } =
	await import("../src/current-basis.ts");
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
