import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { BasisError, normalizeCurrentBasis, type ReleaseBasis } from "../src/current-basis.ts";
import { BOUNDED_TUPLES } from "../src/decision.ts";
import { projectReleaseCrates, ReleaseProjectionError } from "../src/release-projection.ts";

const source = "registry+https://github.com/rust-lang/crates.io-index";
const published = "2026-01-01T00:00:00.123Z";
const epoch = Date.UTC(2026, 0, 1, 0, 0, 0, 123);
function release(version: string) {
	return {
		version,
		createdAt: epoch,
		publishedAt: published,
		yanked: version.includes("beta"),
		checksum: "a".repeat(64),
		license: "MIT OR Apache-2.0" as string | null,
		dependencies: [
			{
				name: "synthetic-dependency",
				requirement: "^1.2.3",
				kind: "normal",
				target: null as string | null,
				optional: false,
				defaultFeatures: true,
				features: ["alpha", "beta"],
				registry: null as string | null,
				rename: null as string | null,
			},
		],
	};
}
function fixture() {
	// Invented technical data only; matching views do not authenticate an upstream source.
	const api = BOUNDED_TUPLES.map(([name, version]) => ({
		source,
		name: name as string,
		versions: [release(version), release("99.0.0-beta.1")],
	}));
	return { api, index: structuredClone(api) };
}
type Pair = ReturnType<typeof fixture>;
type Version = ReturnType<typeof release>;
function first(pair: Pair, side: "api" | "index" = "index"): Version {
	const value = pair[side][0]?.versions[0];
	if (!value) throw new Error("Synthetic fixture missing");
	return value;
}
function dep(row: Version) {
	const value = row.dependencies[0];
	if (!value) throw new Error("Synthetic fixture missing");
	return value;
}
function refusal(value: unknown): ReleaseProjectionError {
	let error: unknown;
	try {
		projectReleaseCrates(value);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(ReleaseProjectionError);
	expect(error).toMatchObject({
		code: "RELEASE_PROJECTION_INVALID",
		message: "release projection refused",
	});
	return error as ReleaseProjectionError;
}
function normalize(crates: ReleaseBasis["crates"], observedAt = epoch + 1) {
	return normalizeCurrentBasis({
		findings: [],
		database: {
			delivery: "independent-current-head",
			commit: "a".repeat(40),
			currentCommit: "a".repeat(40),
			revision: "b".repeat(64),
			observedAt,
		},
		releases: { source: "crates.io", revision: "c".repeat(64), observedAt, crates },
		security: {
			source: "verified-security-event-feed",
			revision: "d".repeat(64),
			observedAt,
			events: [],
		},
		startedAt: observedAt,
		completedAt: observedAt + 1,
		maxAgeMs: 3_600_000,
	});
}

describe("closed technical release join", () => {
	it("preserves every supplied version, prerelease and yank as accepted basis payload", () => {
		const input = fixture();
		const before = structuredClone(input);
		const result = projectReleaseCrates(input);
		expect(result).toHaveLength(5);
		expect(result.every((crate) => crate.versions.length === 2)).toBe(true);
		expect(
			result.every((crate) =>
				crate.versions.some((v) => v.version === "99.0.0-beta.1" && v.yanked),
			),
		).toBe(true);
		expect(
			result.every((crate) => crate.versions.every((v) => !Object.hasOwn(v, "publishedAt"))),
		).toBe(true);
		expect(normalize(result).version).toBe(1);
		expect(input).toEqual(before);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result[0]?.versions[0]?.dependencies[0]?.features)).toBe(true);
		dep(first(input, "api")).features.push("later-input-change");
		expect(result[0]?.versions[0]?.dependencies[0]?.features).toEqual(["alpha", "beta"]);
	});
	it("orders sets only without normalizing literal technical strings", () => {
		const input = fixture();
		input.index.reverse();
		for (const crate of input.index) {
			crate.versions.reverse();
			for (const row of crate.versions) dep(row).features.reverse();
		}
		expect(projectReleaseCrates(input)).toEqual(projectReleaseCrates(fixture()));
	});
	it("retains the existing normalizer's license grammar including slash refusal", () => {
		const input = fixture();
		first(input, "api").license = first(input).license = "MIT/Apache-2.0";
		refusal(input);
	});
	it("does not turn paired truncation into a completeness or authority claim", () => {
		const input = fixture();
		for (const side of [input.api, input.index]) for (const crate of side) crate.versions.pop();
		const payload = projectReleaseCrates(input);
		expect(payload.every((crate) => crate.versions.length === 1)).toBe(true);
		expect(Object.keys(payload)).toEqual(["0", "1", "2", "3", "4"]);
		expect(
			payload.every((crate) => Object.keys(crate).sort().join() === "name,source,versions"),
		).toBe(true);
		for (const crate of payload)
			for (const row of crate.versions) {
				expect(Object.keys(row).sort()).toEqual([
					"checksum",
					"createdAt",
					"dependencies",
					"license",
					"version",
					"yanked",
				]);
			}
	});
	it("retains the existing producer's future-publication refusal", () => {
		const payload = projectReleaseCrates(fixture());
		let error: unknown;
		try {
			normalize(payload, epoch - 1);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(BasisError);
		expect(error).toMatchObject({
			code: "BASIS_INVALID",
			message: "current dependency basis refused",
		});
	});
	it.each([
		["missing crate", (p: Pair) => p.api.pop()],
		[
			"paired missing crate",
			(p: Pair) => {
				p.api.pop();
				p.index.pop();
			},
		],
		[
			"duplicate crate",
			(p: Pair) => {
				const row = p.api[0];
				if (row) p.api[1] = row;
			},
		],
		[
			"unknown crate",
			(p: Pair) => {
				const row = p.index[0];
				if (row) row.name = "unknown";
			},
		],
		[
			"wrong registry source",
			(p: Pair) => {
				const row = p.index[0];
				if (row) row.source = "registry+https://invalid.example/index";
			},
		],
		[
			"missing affected versions on both sides",
			(p: Pair) => {
				for (const side of [p.api, p.index]) for (const crate of side) crate.versions.shift();
			},
		],
		[
			"unequal complete version sets",
			(p: Pair) => {
				p.index[0]?.versions.pop();
			},
		],
		[
			"duplicate version",
			(p: Pair) => {
				const row = p.index[0];
				if (row) row.versions.push(structuredClone(first(p)));
			},
		],
	] as const)("refuses %s", (_name, change) => {
		const input = fixture();
		change(input);
		refusal(input);
	});

	const joins: [string, (row: Version) => void][] = [
		[
			"checksum",
			(r) => {
				r.checksum = "b".repeat(64);
			},
		],
		[
			"yank",
			(r) => {
				r.yanked = !r.yanked;
			},
		],
		[
			"license",
			(r) => {
				r.license = "BSD-3-Clause";
			},
		],
		[
			"dependency name",
			(r) => {
				dep(r).name = "another-dependency";
			},
		],
		[
			"dependency requirement",
			(r) => {
				dep(r).requirement = "~1.2.3";
			},
		],
		[
			"dependency kind",
			(r) => {
				dep(r).kind = "build";
			},
		],
		[
			"dependency target",
			(r) => {
				dep(r).target = "cfg(unix)";
			},
		],
		[
			"optional",
			(r) => {
				dep(r).optional = true;
			},
		],
		[
			"default features",
			(r) => {
				dep(r).defaultFeatures = false;
			},
		],
		[
			"requested feature",
			(r) => {
				dep(r).features = ["alpha"];
			},
		],
		[
			"dependency registry",
			(r) => {
				dep(r).registry = "sparse+https://registry.example/index/";
			},
		],
		[
			"dependency rename",
			(r) => {
				dep(r).rename = "renamed";
			},
		],
		[
			"valid different publication",
			(r) => {
				r.createdAt += 1000;
				r.publishedAt = "2026-01-01T00:00:01.123Z";
			},
		],
	];
	it.each(joins)("refuses an exact %s join mismatch", (_field, change) => {
		const input = fixture();
		change(first(input));
		refusal(input);
	});
	it.each(["2026-01-01T00:00:00.123000Z", "2026-01-01T00:00:00.123+00:00"])(
		"does not equate a different publication literal %s",
		(literal) => {
			const input = fixture();
			first(input).publishedAt = literal;
			refusal(input);
		},
	);
	it("rejects duplicated canonical dependency and feature rows even on matching sides", () => {
		const dependencies = fixture();
		for (const side of ["api", "index"] as const) {
			const row = first(dependencies, side);
			row.dependencies.push(structuredClone(dep(row)));
		}
		refusal(dependencies);
		const featureRows = fixture();
		for (const side of ["api", "index"] as const)
			dep(first(featureRows, side)).features.push("alpha");
		refusal(featureRows);
	});
});

describe("publication exactness", () => {
	it("accepts millisecond-representable extra zero digits without rewriting the literal", () => {
		const input = fixture();
		first(input, "api").publishedAt = first(input).publishedAt = "2026-01-01T00:00:00.123000Z";
		expect(projectReleaseCrates(input)).toHaveLength(5);
	});
	it.each([
		"2026-01-01T00:00:00.123001Z",
		"2026-01-01T00:00:00.123000001Z",
		"2026-01-01T00:00:00.124Z",
		"2026-01-01T00:00:00.123-00:00",
		"2026-01-01T00:00:00.123+00:60",
		"2026-01-01T00:00:00.123+24:00",
		"2026-01-01T00:00:60.123Z",
		"2026-01-01T24:00:00.123Z",
		"2026-01-01T00:00:00.123Z\n",
	])("refuses exact epoch mismatch or unrepresentable publication %s", (publishedAt) => {
		const input = fixture();
		first(input, "api").publishedAt = first(input).publishedAt = publishedAt;
		refusal(input);
	});
	it("refuses calendar rollover even if Date.parse would normalize to the supplied epoch", () => {
		const input = fixture();
		for (const side of ["api", "index"] as const) {
			first(input, side).publishedAt = "2026-02-30T00:00:00.123Z";
			first(input, side).createdAt = Date.UTC(2026, 2, 2, 0, 0, 0, 123);
		}
		refusal(input);
	});
	it("accepts the same exact offset representation only with its matching epoch", () => {
		const input = fixture();
		for (const side of ["api", "index"] as const)
			first(input, side).publishedAt = "2025-12-31T19:00:00.123-05:00";
		expect(projectReleaseCrates(input)).toHaveLength(5);
	});
	it.each([String(epoch), NaN, Infinity, epoch + 0.5, -1])(
		"refuses noninteger numeric epoch %s",
		(value) => {
			const input = fixture();
			Object.assign(first(input), { createdAt: value });
			refusal(input);
		},
	);
});

describe("inert data, privacy and bounds", () => {
	it("refuses unknown prose fields without reading their accessors or returning their data", () => {
		const input = fixture();
		let read = 0;
		Object.defineProperty(first(input), "authors", {
			enumerable: true,
			get() {
				read++;
				throw new Error("synthetic private detail");
			},
		});
		refusal(input);
		expect(read).toBe(0);
	});
	it("refuses accessors for known fields without executing them", () => {
		const input = fixture();
		let read = 0;
		Object.defineProperty(first(input), "checksum", {
			enumerable: true,
			get() {
				read++;
				return "a".repeat(64);
			},
		});
		refusal(input);
		expect(read).toBe(0);
	});
	it("refuses proxies without invoking traps", () => {
		let traps = 0;
		refusal(
			new Proxy(fixture(), {
				ownKeys() {
					traps++;
					throw new Error("synthetic private detail");
				},
			}),
		);
		expect(traps).toBe(0);
	});
	it("refuses custom prototypes and symbol keys", () => {
		const custom = fixture();
		Object.setPrototypeOf(first(custom), { extra: true });
		refusal(custom);
		const symbols = fixture();
		Object.assign(first(symbols), { [Symbol("synthetic")]: true });
		refusal(symbols);
	});
	it("refuses sparse, extra-property and cyclic arrays", () => {
		const sparse = fixture();
		delete dep(first(sparse)).features[0];
		refusal(sparse);
		const extra = fixture();
		Object.assign(extra.index, { extra: true });
		refusal(extra);
		const cyclic = fixture();
		Object.assign(dep(first(cyclic)), { features: [cyclic] });
		refusal(cyclic);
	});
	it("refuses invalid Unicode and credential-bearing registries", () => {
		const unicode = fixture();
		dep(first(unicode)).target = "\ud800";
		refusal(unicode);
		const credentials = fixture();
		dep(first(credentials)).registry = "https://synthetic:secret@registry.example/index";
		refusal(credentials);
	});
	it("accepts the exact single-scalar byte limit on matching sides", () => {
		const input = fixture();
		first(input, "api").license = first(input).license = "M".repeat(65_536);
		expect(projectReleaseCrates(input)).toHaveLength(5);
	});
	it("refuses a matching single-scalar byte overbound", () => {
		const input = fixture();
		first(input, "api").license = first(input).license = "M".repeat(65_537);
		refusal(input);
	});
	it("accepts the exact row limit with unique valid feature tokens", () => {
		const input = fixture();
		const features = Array.from({ length: 100_000 }, (_, index) => `f${index}`);
		for (const side of ["api", "index"] as const) dep(first(input, side)).features = [...features];
		expect(projectReleaseCrates(input)).toHaveLength(5);
	});
	it("refuses matching row overbounds with unique valid feature tokens", () => {
		const input = fixture();
		const features = Array.from({ length: 100_001 }, (_, index) => `f${index}`);
		for (const side of ["api", "index"] as const) dep(first(input, side)).features = [...features];
		refusal(input);
	});
	it("refuses aggregate technical string overbounds with each scalar below its limit", () => {
		const input = fixture();
		const license = "M".repeat(65_536);
		for (const side of [input.api, input.index]) {
			const crate = side[0];
			if (!crate) throw new Error("Synthetic fixture missing");
			for (let number = 0; number < 513; number++) {
				const row = release(`100.${number}.0`);
				row.license = license;
				crate.versions.push(row);
			}
		}
		refusal(input);
	});
	it("does not accept currentness, source-ref or authority selectors", () => {
		for (const key of ["observedAt", "revision", "endpoint", "ref", "complete", "verified"])
			refusal({ ...fixture(), [key]: true });
	});
});

const sides = ["api", "index"] as const;
function both(input: Pair, change: (row: Version, side: "api" | "index") => void): Pair {
	for (const side of sides) change(first(input, side), side);
	return input;
}

describe("matching hostile views isolate each field guard", () => {
	const fields: [string, (row: Version) => void][] = [
		["version is a scalar", (row) => Object.assign(row, { version: null })],
		[
			"version grammar",
			(row) => {
				row.version = "not-a-version";
			},
		],
		["checksum is a scalar", (row) => Object.assign(row, { checksum: 1 })],
		[
			"checksum is lowercase hexadecimal",
			(row) => {
				row.checksum = "A".repeat(64);
			},
		],
		[
			"checksum is exactly 64 characters",
			(row) => {
				row.checksum = "a".repeat(63);
			},
		],
		["license is a scalar or null", (row) => Object.assign(row, { license: false })],
		[
			"license grammar",
			(row) => {
				row.license = "MIT/Apache-2.0";
			},
		],
		["yank is a boolean", (row) => Object.assign(row, { yanked: "false" })],
		["createdAt is numeric", (row) => Object.assign(row, { createdAt: String(epoch) })],
		[
			"createdAt is finite",
			(row) => {
				row.createdAt = Infinity;
			},
		],
		[
			"createdAt is integral",
			(row) => {
				row.createdAt = epoch + 0.5;
			},
		],
		["publication is a scalar", (row) => Object.assign(row, { publishedAt: [] })],
		[
			"publication grammar",
			(row) => {
				row.publishedAt = "not-a-timestamp";
			},
		],
		[
			"dependency name grammar",
			(row) => {
				dep(row).name = "bad name";
			},
		],
		["dependency name is a scalar", (row) => Object.assign(dep(row), { name: null })],
		["requirement is a scalar", (row) => Object.assign(dep(row), { requirement: {} })],
		[
			"requirement grammar",
			(row) => {
				dep(row).requirement = "not a range";
			},
		],
		[
			"kind is an admitted literal",
			(row) => {
				dep(row).kind = "optional";
			},
		],
		["kind is a scalar", (row) => Object.assign(dep(row), { kind: 1 })],
		["target is a scalar or null", (row) => Object.assign(dep(row), { target: false })],
		[
			"empty Buffer is not a target string",
			(row) => Object.assign(dep(row), { target: Buffer.alloc(0) }),
		],
		["plain object is not a target string", (row) => Object.assign(dep(row), { target: {} })],
		[
			"target Unicode has no lone high surrogate",
			(row) => {
				dep(row).target = "\ud800";
			},
		],
		[
			"target Unicode has no lone low surrogate",
			(row) => {
				dep(row).target = "\udc00";
			},
		],
		["optional is a boolean", (row) => Object.assign(dep(row), { optional: 0 })],
		["defaultFeatures is a boolean", (row) => Object.assign(dep(row), { defaultFeatures: "true" })],
		["features contain scalar tokens", (row) => Object.assign(dep(row), { features: [false] })],
		[
			"feature token grammar",
			(row) => {
				dep(row).features = ["bad feature"];
			},
		],
		[
			"feature Unicode is well formed",
			(row) => {
				dep(row).features = ["a\ud800"];
			},
		],
		[
			"feature tokens are unique",
			(row) => {
				dep(row).features = ["alpha", "alpha"];
			},
		],
		["registry is a scalar or null", (row) => Object.assign(dep(row), { registry: {} })],
		[
			"registry uses HTTPS",
			(row) => {
				dep(row).registry = "http://registry.example/index";
			},
		],
		[
			"registry grammar",
			(row) => {
				dep(row).registry = "https://registry.example/<invalid>";
			},
		],
		[
			"registry has no credentials",
			(row) => {
				dep(row).registry = "https://DYTEST-user:DYTEST-pass@registry.example/index";
			},
		],
		["rename is a scalar or null", (row) => Object.assign(dep(row), { rename: 1 })],
		[
			"rename grammar",
			(row) => {
				dep(row).rename = "bad rename";
			},
		],
		[
			"dependency rows are unique",
			(row) => {
				row.dependencies.push(structuredClone(dep(row)));
			},
		],
		["version object rejects unknown fields", (row) => Object.assign(row, { extra: true })],
		["dependency object rejects unknown fields", (row) => Object.assign(dep(row), { extra: true })],
		["dependency object is not an array", (row) => Object.assign(row, { dependencies: [[]] })],
		["version object is not an array", (row) => Object.setPrototypeOf(row, Array.prototype)],
	];
	it.each(fields)("refuses matching invalid views: %s", (_name, change) => {
		refusal(both(fixture(), change));
	});
	it("refuses matching malformed optional versions while retaining every required release", () => {
		const input = fixture();
		for (const side of sides) {
			const optional = input[side][0]?.versions[1];
			if (!optional) throw new Error("Synthetic fixture missing");
			optional.version = "not-a-version";
		}
		refusal(input);
	});
	it("isolates negative epoch refusal using a matching representable negative publication", () => {
		refusal(
			both(fixture(), (row) => {
				row.createdAt = -1;
				row.publishedAt = "1969-12-31T23:59:59.999Z";
			}),
		);
	});
	it.each([
		[
			"source",
			(crate: Pair["api"][number]) => {
				crate.source = "registry+https://invalid.example/index";
			},
		],
		[
			"name grammar",
			(crate: Pair["api"][number]) => {
				crate.name = "glib!";
			},
		],
		[
			"unknown bounded name",
			(crate: Pair["api"][number]) => {
				crate.name = "unknown-crate";
			},
		],
		["name type", (crate: Pair["api"][number]) => Object.assign(crate, { name: null })],
		["source type", (crate: Pair["api"][number]) => Object.assign(crate, { source: 1 })],
		["unknown field", (crate: Pair["api"][number]) => Object.assign(crate, { extra: true })],
	] as const)("refuses matching crate %s", (_name, change) => {
		const input = fixture();
		for (const side of sides) {
			const crate = input[side][0];
			if (!crate) throw new Error("Synthetic fixture missing");
			change(crate);
		}
		refusal(input);
	});
	it("refuses matching duplicate versions", () => {
		const input = fixture();
		for (const side of sides) input[side][0]?.versions.push(structuredClone(first(input, side)));
		refusal(input);
	});
	it("refuses two matching glib rows standing in for another required crate", () => {
		const input = fixture();
		for (const side of sides) {
			const glib = input[side][0];
			if (!glib) throw new Error("Synthetic fixture missing");
			input[side][1] = structuredClone(glib);
		}
		refusal(input);
	});
	it("refuses a matching four-crate census", () => {
		const input = fixture();
		input.api.pop();
		input.index.pop();
		refusal(input);
	});
	it("refuses matching views that omit the affected version", () => {
		const input = fixture();
		for (const side of sides) input[side][0]?.versions.shift();
		refusal(input);
	});
	it("allows null scalar alternatives and distinct complete dependency identities", () => {
		const input = both(fixture(), (row) => {
			row.license = null;
			const original = dep(row);
			row.dependencies = [
				{ ...original, kind: "normal", features: [] },
				{ ...original, kind: "build", target: "cfg(unix)", features: [] },
				{ ...original, kind: "dev", rename: "renamed", features: [] },
			];
		});
		for (const row of input.index[0]?.versions ?? []) row.dependencies.reverse();
		const output = projectReleaseCrates(input);
		const glib = output.find((crate) => crate.name === "glib");
		const row = glib?.versions.find((row) => row.version === first(input).version);
		expect(row?.license).toBeNull();
		expect(row?.dependencies).toHaveLength(3);
		expect(row?.dependencies.map((value) => value.kind).sort()).toEqual(["build", "dev", "normal"]);
	});
});

type ListPath = readonly (string | number)[];
function listPositions(): [string, ListPath][] {
	const input = fixture();
	const positions: [string, ListPath][] = [["crate list", []]];
	for (const [c, crate] of input.api.entries()) {
		positions.push([`versions ${c}`, [c, "versions"]]);
		for (const [v, row] of crate.versions.entries()) {
			positions.push([`dependencies ${c}/${v}`, [c, "versions", v, "dependencies"]]);
			for (const d of row.dependencies.keys())
				positions.push([
					`features ${c}/${v}/${d}`,
					[c, "versions", v, "dependencies", d, "features"],
				]);
		}
	}
	return positions;
}
function replaceList(
	input: Pair,
	side: "api" | "index",
	path: ListPath,
	change: (array: unknown[]) => unknown,
): void {
	if (!path.length) {
		Object.assign(input, { [side]: change(input[side]) });
		return;
	}
	let parent: object = input[side];
	for (const part of path.slice(0, -1)) parent = Reflect.get(parent, part) as object;
	const key = path[path.length - 1];
	if (key === undefined) throw new Error("Synthetic list path missing");
	Reflect.set(parent, key, change(Reflect.get(parent, key) as unknown[]));
}
class SyntheticArray extends Array<unknown> {}
describe.each(listPositions())("list guards at %s", (_position, path) => {
	it.each([
		"null",
		"plain array-like",
		"Array-prototype nonarray",
		"null-prototype array",
		"subclass array",
	])("refuses matching %s views", (kind) => {
		const input = fixture();
		for (const side of sides)
			replaceList(input, side, path, (array) => {
				if (kind === "null") return null;
				if (kind === "null-prototype array") return Object.setPrototypeOf([...array], null);
				if (kind === "subclass array")
					return Object.setPrototypeOf([...array], SyntheticArray.prototype);
				const object: object = Object.create(
					kind === "Array-prototype nonarray" ? Array.prototype : Object.prototype,
				);
				for (const [index, value] of array.entries())
					Object.defineProperty(object, String(index), { value, enumerable: true });
				Object.defineProperty(object, "length", { value: array.length });
				return object;
			});
		refusal(input);
	});
	it("refuses matching transparent list proxies before any trap", () => {
		const input = fixture();
		let traps = 0;
		for (const side of sides)
			replaceList(
				input,
				side,
				path,
				(array) =>
					new Proxy(array, {
						get(target, key, receiver) {
							traps++;
							return Reflect.get(target, key, receiver);
						},
						getPrototypeOf(target) {
							traps++;
							return Reflect.getPrototypeOf(target);
						},
						ownKeys(target) {
							traps++;
							return Reflect.ownKeys(target);
						},
						getOwnPropertyDescriptor(target, key) {
							traps++;
							return Reflect.getOwnPropertyDescriptor(target, key);
						},
					}),
			);
		refusal(input);
		expect(traps).toBe(0);
	});
	it("converts matching revoked list proxies to the fixed refusal", () => {
		const input = fixture();
		let traps = 0;
		for (const side of sides)
			replaceList(input, side, path, (array) => {
				const revoked = Proxy.revocable(array, {
					get() {
						traps++;
						return undefined;
					},
				});
				revoked.revoke();
				return revoked.proxy;
			});
		const error = refusal(input);
		expect(String(error)).toBe("ReleaseProjectionError: release projection refused");
		expect(traps).toBe(0);
	});
});

/** Count a JSON-like value tree, not unique objects: shared views still contain two logical copies. */
function inputMeasure(value: unknown): { nodes: number; bytes: number } {
	let nodes = 0,
		bytes = 0;
	const pending = [value];
	while (pending.length) {
		const current = pending.pop();
		nodes++;
		if (typeof current === "string") bytes += Buffer.byteLength(current);
		else if (Array.isArray(current)) pending.push(...current);
		else if (current !== null && typeof current === "object") {
			for (const [key, child] of Object.entries(current)) {
				bytes += Buffer.byteLength(key);
				pending.push(child);
			}
		} else if (current !== null && typeof current !== "number" && typeof current !== "boolean")
			throw new Error("Invalid synthetic JSON-like fixture");
	}
	return { nodes, bytes };
}
function minimumDependency(name: string) {
	return {
		name,
		requirement: "*",
		kind: "normal",
		target: null,
		optional: false,
		defaultFeatures: false,
		features: [] as string[],
		registry: null,
		rename: null,
	};
}
function nodeBoundary(target: number): Pair {
	const input = fixture();
	const perPair = 2 * inputMeasure(minimumDependency("bulk")).nodes;
	const count = Math.floor((target - inputMeasure(input).nodes) / perPair);
	const rows = Array.from({ length: count }, (_, index) =>
		minimumDependency(`bulk-${String(index).padStart(5, "0")}`),
	);
	for (const side of sides) {
		const row = first(input, side);
		row.dependencies = [...row.dependencies, ...rows];
	}
	const additional = (target - inputMeasure(input).nodes) / 2;
	if (!Number.isInteger(additional) || additional < 0 || additional >= perPair)
		throw new Error("Synthetic node budget math invalid");
	for (const side of sides)
		dep(first(input, side)).features.push(
			...Array.from({ length: additional }, (_, i) => `node-padding-${i}`),
		);
	expect(inputMeasure(input).nodes).toBe(target);
	return input;
}
function byteBoundary(target: number): Pair {
	const input = fixture();
	const crate = input.api[0];
	if (!crate) throw new Error("Synthetic fixture missing");
	for (let index = 0; index < 500; index++) {
		const row = release(`100.${index}.0`);
		row.license = "M";
		row.dependencies = [];
		crate.versions.push(row);
	}
	input.index = structuredClone(input.api);
	let remaining = target - inputMeasure(input).bytes;
	for (const [index, row] of crate.versions.entries()) {
		const other = input.index[0]?.versions[index];
		if (!other || row.license === null) throw new Error("Synthetic fixture missing");
		const add = Math.min(65_536 - Buffer.byteLength(row.license), remaining / 2);
		if (!Number.isInteger(add) || add < 0) throw new Error("Synthetic byte budget math invalid");
		row.license += "M".repeat(add);
		other.license = row.license;
		remaining -= 2 * add;
		if (!remaining) break;
	}
	if (remaining) throw new Error("Synthetic byte fixture too small");
	expect(inputMeasure(input).bytes).toBe(target);
	return input;
}
describe("whole paired-view logical resource budgets", () => {
	it("accepts exactly 33,554,432 decoded object-key and string bytes", () => {
		const input = byteBoundary(33_554_432);
		expect(inputMeasure(input).nodes).toBeLessThan(999_999);
		expect(projectReleaseCrates(input)).toHaveLength(5);
	});
	it("refuses 33,554,434 decoded bytes shared across the two views", () => {
		refusal(byteBoundary(33_554_434));
	});
	it("accepts 999,999 logical input nodes", () => {
		const input = nodeBoundary(999_999);
		expect(inputMeasure(input).bytes).toBeLessThan(33_554_432);
		expect(projectReleaseCrates(input)).toHaveLength(5);
	});
	it("refuses 1,000,001 logical input nodes shared across the two views", () => {
		refusal(nodeBoundary(1_000_001));
	});
});

describe("native exception privacy", () => {
	it("converts a genuine ERR_INVALID_URL without exposing the synthetic credential canary", () => {
		const inputUrl = "https://DYTEST-user:DYTEST-URL-CANARY@%";
		let native: unknown;
		try {
			new URL(inputUrl);
		} catch (caught) {
			native = caught;
		}
		expect(native).toBeInstanceOf(TypeError);
		expect(native).toMatchObject({ code: "ERR_INVALID_URL", input: inputUrl });
		const input = both(fixture(), (row) => {
			dep(row).registry = inputUrl;
		});
		const error = refusal(input);
		for (const rendered of [String(error), error.stack ?? "", inspect(error, { depth: 10 })]) {
			expect(rendered).not.toContain(inputUrl);
			expect(rendered).not.toContain("DYTEST-URL-CANARY");
		}
		expect(Object.hasOwn(error, "input")).toBe(false);
		expect(Object.hasOwn(error, "cause")).toBe(false);
	});
	it("converts a genuine IsArray TypeError without returning the native exception", () => {
		const revoked = Proxy.revocable([], {});
		revoked.revoke();
		let native: unknown;
		try {
			Array.isArray(revoked.proxy);
		} catch (caught) {
			native = caught;
		}
		expect(native).toBeInstanceOf(TypeError);
		const input = fixture();
		Object.assign(input, { api: revoked.proxy, index: revoked.proxy });
		const error = refusal(input);
		expect(String(error)).not.toContain((native as Error).message);
		expect(inspect(error)).not.toContain((native as Error).message);
	});
});

describe("reachable calendar, offset and fraction controls", () => {
	it.each([
		["second 60", "2026-01-01T00:00:60.123Z", Date.UTC(2026, 0, 1, 0, 1, 0, 123)],
		["minute 60", "2026-01-01T00:60:00.123Z", Date.UTC(2026, 0, 1, 1, 0, 0, 123)],
		["hour 24", "2026-01-01T24:00:00.123Z", Date.UTC(2026, 0, 2, 0, 0, 0, 123)],
		["offset hour 24", "2026-01-01T00:00:00.123+24:00", Date.UTC(2025, 11, 31, 0, 0, 0, 123)],
		["offset minute 60", "2026-01-01T00:00:00.123+00:60", Date.UTC(2025, 11, 31, 23, 0, 0, 123)],
		["unknown zero offset", "2026-01-01T00:00:00.123-00:00", epoch],
		["non-leap February 29", "2025-02-29T00:00:00.123Z", Date.UTC(2025, 2, 1, 0, 0, 0, 123)],
	] as const)(
		"refuses %s with the normalized epoch supplied on both sides",
		(_name, literal, value) => {
			refusal(
				both(fixture(), (row) => {
					row.createdAt = value;
					row.publishedAt = literal;
				}),
			);
		},
	);
	it.each([
		["2026-01-01T00:00:00Z", Date.UTC(2026, 0, 1)],
		["2026-01-01T00:00:00.1Z", Date.UTC(2026, 0, 1, 0, 0, 0, 100)],
		["2026-01-01T00:00:00.12Z", Date.UTC(2026, 0, 1, 0, 0, 0, 120)],
		["2024-02-29T00:00:00.123Z", Date.UTC(2024, 1, 29, 0, 0, 0, 123)],
	] as const)("preserves the representable exact literal %s", (literal, value) => {
		expect(
			projectReleaseCrates(
				both(fixture(), (row) => {
					row.createdAt = value;
					row.publishedAt = literal;
				}),
			),
		).toHaveLength(5);
	});
	it("freezes every nested output object and detaches it from every caller-owned value", () => {
		const input = fixture();
		const output = projectReleaseCrates(input);
		const saved = structuredClone(output);
		const pending: unknown[] = [output];
		let objects = 0;
		while (pending.length) {
			const item = pending.pop();
			if (item !== null && typeof item === "object") {
				objects++;
				expect(Object.isFrozen(item)).toBe(true);
				pending.push(...Object.values(item));
			}
		}
		expect(objects).toBeGreaterThan(30);
		for (const side of sides) {
			first(input, side).license = null;
			dep(first(input, side)).target = "changed";
			dep(first(input, side)).features.push("changed");
			input[side][0]?.versions.pop();
		}
		expect(output).toEqual(saved);
	});
});

describe("dependency identity work", () => {
	it("serializes each dependency identity at most once instead of on every comparison", () => {
		const input = fixture();
		const count = 2048;
		const rows = Array.from({ length: count }, (_, index) =>
			minimumDependency(`metric-${String((index * 97) % count).padStart(5, "0")}`),
		);
		for (const side of sides) first(input, side).dependencies = structuredClone(rows);
		const supplied = sides.reduce(
			(sum, side) =>
				sum +
				input[side].reduce(
					(n, crate) => n + crate.versions.reduce((m, row) => m + row.dependencies.length, 0),
					0,
				),
			0,
		);
		const stringify = JSON.stringify;
		let serializations = 0;
		const tracked = ((value: unknown, replacer?: unknown, space?: unknown) => {
			if (
				value !== null &&
				typeof value === "object" &&
				Object.hasOwn(value, "requirement") &&
				Object.hasOwn(value, "defaultFeatures")
			)
				serializations++;
			return Reflect.apply(stringify, JSON, [value, replacer, space]);
		}) as typeof JSON.stringify;
		let output: ReleaseBasis["crates"] | undefined;
		try {
			JSON.stringify = tracked;
			output = projectReleaseCrates(input);
		} finally {
			JSON.stringify = stringify;
		}
		expect(output).toHaveLength(5);
		expect(serializations).toBeLessThanOrEqual(supplied);
	});
	it("keeps all 49,000 shuffled valid dependencies in deterministic order", () => {
		const input = fixture();
		const count = 49_000;
		const names = Array.from(
			{ length: count },
			(_, index) => `bulk-${String(index).padStart(5, "0")}`,
		);
		const rows = Array.from({ length: count }, (_, index) =>
			minimumDependency(names[(index * 97) % count] ?? "missing"),
		);
		for (const side of sides) first(input, side).dependencies = structuredClone(rows);
		const output = projectReleaseCrates(input);
		const dependencies = output
			.find((crate) => crate.name === "glib")
			?.versions.find((row) => row.version === first(input).version)?.dependencies;
		expect(dependencies).toHaveLength(count);
		const digest = (values: readonly string[]) =>
			createHash("sha256").update(JSON.stringify(values)).digest("hex");
		expect(digest((dependencies ?? []).map((row) => row.name))).toBe(digest(names));
	});
});
