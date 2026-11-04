import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_FINITE_GRAPH_TERM } from "../src/decision.ts";
import { proposedMobileHttpConfig } from "../src/mobile-http-policy.ts";

type TupleValue = string | number | boolean | null | Tuple;
type Tuple = TupleValue[];
interface FixtureGraph {
	version: number;
	digest: string;
	packageCount: number;
	tuplePayload: Tuple;
	ancestorDigests: unknown[];
}

const graphBytes = readFileSync(
	new URL("./fixtures/mobile-http-approved-graph.json", import.meta.url),
);
const policyBytes = readFileSync(
	new URL("./fixtures/mobile-http-approved-policy.toml", import.meta.url),
);
const graphSha = "643c93dbe52baf54637ba8ddf28ce24ad514fd2404e3a79a37d25aa7e2ce914e";
const policySha = "3dfd2b249ce43734a7ec281e10d1353a3bb9ce68a7684fa36639ea98f64791d0";
const effectiveSha = "ac7b77713e2e366fcfeb33fac5f2bd88fc9fbef9740a5ba49e12afdbce655ebf";
const graphDigest = "a4662c495976436a169207f85fe6ecd21aea53adbcb6d7e8ecb8349a18d446ce";
const denyRow = Buffer.from('    { name = "reqwest" },\n');
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// This public tuple is unchanged DATA from real input capture/binding and projection.
// It proves the pure transformation, without asserting process, freshness or basis authority.
const graph = (): FixtureGraph => JSON.parse(graphBytes.toString("utf8")) as FixtureGraph;
function tuple(value: TupleValue | undefined): Tuple {
	if (!Array.isArray(value)) throw new Error("PUBLIC_FIXTURE_SHAPE");
	return value;
}
function packageRow(value: FixtureGraph, name: string): Tuple {
	const matches = tuple(value.tuplePayload[3]).filter(
		(row) => Array.isArray(row) && tuple(row[0])[1] === name,
	);
	if (matches.length !== 1) throw new Error("PUBLIC_FIXTURE_PACKAGE");
	return tuple(matches[0]);
}
function reqwestEdge(value: FixtureGraph): Tuple {
	const matches = tuple(value.tuplePayload[4]).filter(
		(row) => Array.isArray(row) && tuple(row[1])[1] === "reqwest",
	);
	if (matches.length !== 1) throw new Error("PUBLIC_FIXTURE_EDGE");
	return tuple(matches[0]);
}
function refuses(value: unknown, policy: unknown = policyBytes): void {
	let refused = false;
	try {
		proposedMobileHttpConfig(value, policy);
	} catch (error) {
		refused = error instanceof Error && error.message === "PROPOSED_HTTP_GRAPH_REFUSED";
	}
	expect(refused).toBe(true);
}

beforeAll(() => {
	expect(graphBytes.length).toBe(1538960);
	expect(sha(graphBytes) === graphSha).toBe(true);
	expect(policyBytes.length).toBe(10130);
	expect(sha(policyBytes) === policySha).toBe(true);
});

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-18T13:15:04Z"));
});
afterEach(() => vi.restoreAllMocks());

describe("finite mobile HTTP policy on the public projected graph", () => {
	it("binds actual repository policy or refuses different root bytes", () => {
		const actualRootBytes = readFileSync(new URL("../../../crates/deny.toml", import.meta.url));
		if (actualRootBytes.equals(policyBytes)) {
			expect(sha(proposedMobileHttpConfig(graph(), actualRootBytes))).toBe(effectiveSha);
		} else {
			refuses(graph(), actualRootBytes);
		}
	});
	it.each([-1, 0, 1])("enforces the finite graph deadline at offset %s", (offset) => {
		vi.mocked(Date.now).mockReturnValue(CURRENT_FINITE_GRAPH_TERM.expiresAt + offset);
		if (offset < 0) expect(sha(proposedMobileHttpConfig(graph(), policyBytes))).toBe(effectiveSha);
		else refuses(graph());
	});
	it("removes exactly one deny row from the genuine projected graph and pinned candidate", () => {
		const value = graph();
		const before = JSON.stringify(value);
		expect(value.packageCount).toBe(553);
		expect(value.ancestorDigests.length).toBe(0);
		expect(
			createHash("sha256")
				.update("draftyak/native-dependency-policy/graph/v1\0")
				.update(JSON.stringify(value.tuplePayload))
				.digest("hex") === graphDigest,
		).toBe(true);
		const offset = policyBytes.indexOf(denyRow);
		expect(offset >= 0).toBe(true);
		expect(policyBytes.indexOf(denyRow, offset + denyRow.length)).toBe(-1);
		const effective = proposedMobileHttpConfig(value, policyBytes);
		const expected = Buffer.concat([
			policyBytes.subarray(0, offset),
			policyBytes.subarray(offset + denyRow.length),
		]);
		expect(denyRow.length).toBe(26);
		expect(effective.length).toBe(10104);
		expect(sha(effective) === effectiveSha).toBe(true);
		expect(effective.equals(expected)).toBe(true);
		expect(
			Buffer.concat([effective.subarray(0, offset), denyRow, effective.subarray(offset)]).equals(
				policyBytes,
			),
		).toBe(true);
		expect(sha(policyBytes) === policySha).toBe(true);
		expect(JSON.stringify(value) === before).toBe(true);
	});

	const changes: readonly [string, (value: FixtureGraph) => void][] = [
		[
			"graph version",
			(value) => {
				value.version = 2;
			},
		],
		[
			"selection tuple",
			(value) => {
				tuple(value.tuplePayload[2])[0] = false;
			},
		],
		[
			"tuple version",
			(value) => {
				value.tuplePayload[1] = 2;
			},
		],
		[
			"package version",
			(value) => {
				tuple(packageRow(value, "reqwest")[0])[2] = "0.13.6";
			},
		],
		[
			"package source",
			(value) => {
				tuple(packageRow(value, "reqwest")[0])[0] = "registry+https://example.invalid/index";
			},
		],
		[
			"resolved feature",
			(value) => {
				tuple(packageRow(value, "reqwest")[1]).push("blocking");
			},
		],
		[
			"resolved parent",
			(value) => {
				tuple(reqwestEdge(value)[0])[2] = "2.12.5";
			},
		],
		[
			"resolved target",
			(value) => {
				tuple(tuple(reqwestEdge(value)[3])[0])[1] = 'cfg(target_os = "android")';
			},
		],
		[
			"claimed digest",
			(value) => {
				value.digest = "0".repeat(64);
			},
		],
		[
			"claimed count",
			(value) => {
				value.packageCount = 552;
			},
		],
		[
			"unrelated package tuple while retaining the approved digest",
			(value) => {
				const rows = tuple(value.tuplePayload[3]);
				const row = rows.find((entry) => Array.isArray(entry) && tuple(entry[0])[1] !== "reqwest");
				tuple(tuple(row)[1]).push("changed-fixture-feature");
			},
		],
	];

	it.each(changes)("refuses a changed %s", (_name, change) => {
		const value = graph();
		change(value);
		refuses(value);
	});

	it("refuses changed candidate bytes of the same length", () => {
		const changed = Buffer.from(policyBytes);
		changed[0] = changed[0]! ^ 1;
		refuses(graph(), changed);
	});

	it("refuses a candidate with an added byte", () => {
		refuses(graph(), Buffer.concat([policyBytes, Buffer.from("\n")]));
	});

	it("refuses a nested accessor without executing it", () => {
		const value = graph();
		let calls = 0;
		Object.defineProperty(tuple(packageRow(value, "reqwest")[0]), "2", {
			enumerable: true,
			get: () => {
				calls++;
				return "0.13.5";
			},
		});
		refuses(value);
		expect(calls).toBe(0);
	});

	it("refuses a tuple serialization hook without executing it", () => {
		const value = graph();
		let calls = 0;
		Object.defineProperty(value.tuplePayload, "toJSON", {
			value: () => {
				calls++;
				return null;
			},
		});
		refuses(value);
		expect(calls).toBe(0);
	});
});
