// jiff-check (jiff 0.2.38, answering from jiff-tzdb 0.1.9's bundled tzdata) against Temporal on
// each pinned Node: the three zones' transitions, every gap and fold wall time under Temporal's
// four disambiguations, and the localWallTime of instants around each transition. The cases and
// any difference go to evidence/dst-<target>.json for M1's schedule and DST vectors; a Node whose
// tzdata version equals jiff's must agree exactly.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { skipOrFail } from "@draftyak/spike-kit";
import { expect, it, type TestContext } from "vitest";
import {
	allTransitions,
	type Difference,
	differences,
	FROM_MS,
	instantCases,
	LATENESS_S,
	shiftMinutes,
	TO_MS,
	unexpectedKinds,
	wallCases,
	ZONES,
} from "./dst.ts";
import { probe, record, recording, run, selectedNodes, spikeDir, target } from "./nodes.ts";
import type { Rendered, Resolved, Transition } from "./temporal-probe.ts";

const jiffDir = path.join(spikeDir, "jiff-check");
// The spike's own target dir, whatever CARGO_TARGET_DIR says, and at most 6 jobs unless
// CARGO_BUILD_JOBS says otherwise: the dev box is shared.
const targetDir = path.join(jiffDir, "target");
const binary = path.join(
	targetDir,
	"debug",
	`jiff-check${process.platform === "win32" ? ".exe" : ""}`,
);
const cargoEnv: NodeJS.ProcessEnv = {
	...Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !/^CARGO_(?:TARGET_DIR|BUILD_TARGET_DIR|BUILD_TARGET)$/i.test(name),
		),
	),
	CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || String(Math.min(6, os.availableParallelism())),
	CARGO_TERM_COLOR: "never",
};
const cargo = (...args: string[]): Promise<string> =>
	run("cargo", args, { cwd: jiffDir, env: cargoEnv });
const nodes = selectedNodes();
let rustChecked = false;

function needCargo(ctx: TestContext): void {
	const found = spawnSync("cargo", ["--version"], {
		cwd: jiffDir,
		env: cargoEnv,
		windowsHide: true,
	});
	if (found.error || found.status !== 0) {
		skipOrFail(ctx, "cargo (Rust 1.95.0, rust-toolchain.toml)");
	}
}

// jiff-check's JSON line for each request line.
async function ask<T>(lines: readonly string[]): Promise<T[]> {
	const stdout = await run(binary, [], { cwd: jiffDir, input: `${lines.join("\n")}\n` });
	const replies = stdout
		.trim()
		.split(/\r?\n/)
		.map((line) => JSON.parse(line));
	const failed = replies.find((reply) => "error" in reply);
	if (failed) throw new Error(`jiff-check: ${failed.error}`);
	expect(replies).toHaveLength(lines.length);
	return replies as T[];
}

// Package versions by name; the semver-compatible "major" is 0.x below 1.
function locked(): Map<string, string[]> {
	const lock = readFileSync(path.join(jiffDir, "Cargo.lock"), "utf8");
	const found = new Map<string, string[]>();
	for (const [, name = "", version = ""] of lock.matchAll(
		/^name = "([^"]+)"\r?\nversion = "([^"]+)"/gm,
	)) {
		found.set(name, [...(found.get(name) ?? []), version]);
	}
	return found;
}
const major = (version: string): string => {
	const [first = "", second = ""] = version.split(".");
	return first === "0" ? `0.${second}` : first;
};

it("jiff-check passes rustfmt, clippy -D warnings and its own tests on the pinned crates", async (ctx) => {
	needCargo(ctx);
	const packages = locked();
	expect(packages.get("jiff")).toEqual(["0.2.38"]);
	expect(packages.get("jiff-tzdb")).toEqual(["0.1.9"]);
	// syn 2 (jiff-static, a cfg(any()) dependency) and syn 3 (behind defmt, an optional dependency
	// reached only through weak features) are in the lockfile but never built.
	const twoMajors = [...packages].filter(([, versions]) => new Set(versions.map(major)).size > 1);
	expect(twoMajors.map(([name]) => name)).toEqual(["syn"]);
	await cargo("fmt", "--check");
	await cargo(
		"clippy",
		"--locked",
		"--all-targets",
		"--target-dir",
		targetDir,
		"--",
		"-D",
		"warnings",
	);
	expect(await cargo("test", "--locked", "--target-dir", targetDir)).toMatch(
		/test result: ok\. 3 passed; 0 failed/,
	);
	rustChecked = true;
});

it("renders every DST gap and overlap as Temporal does on each Node, or lists the differences", async (ctx) => {
	needCargo(ctx);
	await cargo("build", "--locked", "--target-dir", targetDir);
	const [info] = await ask<{ tzdbVersion: string; defaultDatabase: string }>(["info"]);
	const jiffTransitions = (
		await ask<{ transitions: Omit<Transition, "zone">[] }>(
			ZONES.map((zone) => `transitions ${zone} ${FROM_MS} ${TO_MS}`),
		)
	).flatMap(({ transitions }, index) =>
		transitions.map((t) => ({ zone: ZONES[index] ?? "", ...t })),
	);

	const temporal = [];
	for (const node of nodes) {
		const reply = await probe(node.version, { zones: ZONES, fromMs: FROM_MS, toMs: TO_MS });
		temporal.push({
			...node,
			tz: reply.node.tz,
			icu: reply.node.icu,
			transitions: reply.transitions,
		});
	}
	// Every transition either side found, so a disagreement still gets its cases asked.
	const all = allTransitions(jiffTransitions, ...temporal.map((node) => node.transitions));
	const walls = wallCases(all);
	const instants = instantCases(all);
	const jiffWalls = (
		await ask<Omit<Resolved, "zone" | "wall">>(
			walls.map(({ zone, wall }) => `resolve ${zone} ${wall}`),
		)
	).map((reply, index) => ({
		zone: walls[index]?.zone ?? "",
		wall: walls[index]?.wall ?? "",
		...reply,
	}));
	const jiffInstants = (
		await ask<Omit<Rendered, "zone" | "epochMs">>(
			instants.map(({ zone, epochMs }) => `render ${zone} ${epochMs}`),
		)
	).map((reply, index) => ({ ...(instants[index] ?? { zone: "", epochMs: 0 }), ...reply }));

	const jiff = { transitions: jiffTransitions, walls: jiffWalls, instants: jiffInstants };
	const found: Difference[] = [];
	for (const node of temporal) {
		const reply = await probe(node.version, { walls, instants });
		found.push(...differences(node.version, { ...reply, transitions: node.transitions }, jiff));
	}

	// Recorded before any assertion, so a Node whose tzdata differs still gets its list.
	const sameData = temporal
		.filter((node) => node.tz === info?.tzdbVersion)
		.map((node) => node.version);
	if (recording() && rustChecked) {
		await record("dst", {
			target,
			nodeSelection: process.env.DRAFTYAK_NODES || "both",
			zones: ZONES,
			from: new Date(FROM_MS).toISOString(),
			to: new Date(TO_MS).toISOString(),
			latenessS: LATENESS_S,
			jiff: {
				jiffVersion: locked().get("jiff")?.[0],
				jiffTzdbVersion: locked().get("jiff-tzdb")?.[0],
				tzdbVersion: info?.tzdbVersion,
				database: "bundled",
				defaultDatabase: info?.defaultDatabase,
			},
			nodes: temporal.map(({ role, version, icu, tz }) => ({
				role,
				version,
				icuVersion: icu,
				tzVersion: tz,
				sameTzdataAsJiff: tz === info?.tzdbVersion,
				differences: found.filter((d) => d.node === version).length,
			})),
			transitions: jiffTransitions.map((t) => ({ ...t, shiftMinutes: shiftMinutes(t) })),
			walls: jiffWalls,
			instants: jiffInstants,
			differences: found,
		});
	}

	// jiff on its own: two transitions a year in each zone, and the kinds its own transitions give.
	expect(info?.tzdbVersion).toMatch(/^\d{4}[a-z]$/);
	for (const zone of ZONES) {
		const shifts = jiffTransitions.filter((t) => t.zone === zone).map(shiftMinutes);
		expect(shifts, zone).toHaveLength(4);
		expect(new Set(shifts.map(Math.abs)), zone).toEqual(
			new Set([zone === "Australia/Lord_Howe" ? 30 : 60]),
		);
	}
	expect(unexpectedKinds(jiffTransitions, jiffWalls)).toEqual([]);
	expect(
		jiffWalls.filter((wall) => wall.kind !== "unique").every((wall) => wall.reject === null),
	).toBe(true);
	expect(found.filter((d) => sameData.includes(d.node))).toEqual([]);
	if (found.length > 0)
		console.warn(`jiff and Temporal differ:\n${JSON.stringify(found, null, 1)}`);
});
