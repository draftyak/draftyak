import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RESERVED_TESTS } from "../../../reserved-tests.ts";
import { START_STOP_LINE } from "../lib/bootstrap.ts";
import { GATE_ROOT_ENV, type GateResult, runGate } from "../lib/gate.ts";
import * as proof from "../lib/proof.ts";
import { type ProofEntryDeps, proofEntry } from "../reserved-proof.ts";
import { gitEnvOf, ownWorkspace, spawnSpy, tempRepo } from "./temp-repo.ts";

// The proof's entry with every dependency stubbed. The opt-in flag comes in a plain env object,
// never through process.env; the gate is a stub, and lib/proof.ts is either a stub main or
// its own main over defaults whose tools are spies that start nothing.
const root = mkdtempSync(path.join(tmpdir(), "draftyak-proof-entry-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const on = { [RESERVED_TESTS]: "1", PATH: "x" };
const CHECK_LINE =
	"reserved check: 3 path(s), 0 untracked file(s), 2 folder(s), 0 Cargo file(s), 0 Rust source(s) and 1 module(s) and config(s) checked, with their folders, references and scanned folders; no problem found in them";
const G1 =
	"reserved tripwire: 1 path(s) name a reserved word outside the allowed reserved roots, or spell it in upper case";
const STOPPED = `reserved proof: ${proof.GATE_STOPPED}`;

const passing = (): GateResult => ({
	ok: true,
	lines: [CHECK_LINE],
	listing: { root, entries: [], untracked: [] },
	tracked: ["package.json", "pkgs/a/package.json"],
});
const refusing = (): GateResult => ({
	ok: false,
	lines: [G1, START_STOP_LINE],
	listing: null,
	tracked: [],
});

interface Handed {
	readonly argv: readonly string[];
	readonly deps: proof.Deps;
}

function entry(
	env: NodeJS.ProcessEnv,
	gate: () => Promise<GateResult> = async () => passing(),
	use: "stub" | "proof" = "stub",
) {
	const lines: string[] = [];
	const order: string[] = [];
	const spy = spawnSpy();
	const handed: Handed[] = [];
	const defaults: typeof proof.defaults = {
		root,
		env: {},
		print: (line) => lines.push(`defaults: ${line}`),
		async tracked() {
			await spy.git(["ls-files", "-z"], { cwd: root, env: {} });
			return [];
		},
		turbo: (args) => spy.run({ command: "turbo", args }),
		async turboDry(args) {
			await spy.run({ command: "turbo", args });
			return '{"tasks":[]}';
		},
		biome: async (args) => ({ code: await spy.run({ command: "biome", args }), output: "" }),
		marksDir() {
			order.push("marksDir");
			throw new Error("no marks folder in this test");
		},
	};
	const stubMain: typeof proof.main = async (argv, deps) => {
		handed.push({ argv, deps });
		return 0;
	};
	const deps: ProofEntryDeps = {
		env,
		print: (line) => lines.push(line),
		async gate() {
			order.push("gate");
			return gate();
		},
		async loadProof() {
			order.push("loadProof");
			const main = use === "proof" ? proof.main : stubMain;
			return { main, defaults, GATE_STOPPED: proof.GATE_STOPPED };
		},
	};
	return { deps, lines, order, spy, handed, defaults };
}

describe("the proof's entry", () => {
	it("stops on an unset or bad flag in lib/proof.ts's own words, before the gate or the proof loads", async () => {
		for (const env of [
			{},
			{ PATH: "x" },
			{ [RESERVED_TESTS]: "true" },
			{ [RESERVED_TESTS]: "" },
			{ [RESERVED_TESTS]: " 1" },
		]) {
			const { deps, lines, order, spy, defaults } = entry(env);
			expect([env, await proofEntry(["--tier", "unit"], deps)]).toEqual([env, 1]);
			expect([env, order, spy.calls]).toEqual([env, [], []]);
			// lib/proof.ts's main, given the same env and arguments, says the same.
			const own: string[] = [];
			const code = await proof.main(["--tier", "unit"], {
				...defaults,
				env,
				print: (line) => own.push(line),
				gate: async () => passing(),
			});
			expect([env, code, lines]).toEqual([env, 1, own]);
			expect([env, lines.length]).toEqual([env, 1]);
		}
	});

	it("prints a refusing gate's lines and its own stop line, and never loads lib/proof.ts", async () => {
		const { deps, lines, order, spy } = entry(on, async () => refusing());
		expect(await proofEntry(["--tier", "unit", "--tier", "heavy"], deps)).toBe(1);
		expect(lines).toEqual([G1, START_STOP_LINE, STOPPED]);
		expect(order).toEqual(["gate"]);
		expect(spy.calls).toEqual([]);
		// The line is lib/proof.ts's GATE_STOPPED, printed before that module could be loaded.
		expect(STOPPED).toBe(
			"reserved proof: not proven: the reserved check stopped it before any run",
		);
	});

	it("stops on a gate that throws, or answers anything but a pass with its listing", async () => {
		const answers = [
			async () => {
				throw new Error("gate");
			},
			async () => ({ ...passing(), ok: "yes" }),
			async () => ({ ...passing(), lines: [], listing: null }),
			async () => ({ lines: [] }),
		] as unknown as (() => Promise<GateResult>)[];
		for (const gate of answers) {
			const { deps, lines, order, spy } = entry(on, gate);
			expect(await proofEntry(["--tier", "unit"], deps)).toBe(1);
			expect([order, spy.calls, lines.at(-1)]).toEqual([["gate"], [], STOPPED]);
		}
	});

	it("hands lib/proof.ts's main the held gate result, the gate's listing and the gate root once the gate passed", async () => {
		const held = passing();
		const { deps, lines, order, spy, handed, defaults } = entry(on, async () => held);
		expect(await proofEntry(["--tier", "unit", "--names"], deps)).toBe(0);
		expect(order).toEqual(["gate", "loadProof"]);
		expect(handed.map(({ argv }) => argv)).toEqual([["--tier", "unit", "--names"]]);
		const given = handed[0]?.deps;
		// main's own gate call answers with the result the entry holds; the gate never runs twice.
		expect(await given?.gate()).toBe(held);
		expect(await given?.tracked()).toEqual(held.tracked);
		expect(order).toEqual(["gate", "loadProof"]);
		expect(GATE_ROOT_ENV).toBe("DRAFTYAK_GATE_ROOT");
		expect(given?.env).toEqual({ ...on, [GATE_ROOT_ENV]: root });
		// Everything else is lib/proof.ts's own defaults, printing through the entry.
		expect(given?.print).toBe(deps.print);
		for (const key of ["root", "turbo", "turboDry", "biome", "marksDir"] as const) {
			expect([key, given?.[key] === defaults[key]]).toEqual([key, true]);
		}
		// The entry prints nothing itself on a pass: main prints the gate's lines.
		expect([lines, spy.calls]).toEqual([[], []]);
	});

	it("leaves usage, live and device to lib/proof.ts's main, which exits 2 before any tool runs", async () => {
		const owner = "reserved proof: live and device tiers run only in owner sessions, never here";
		for (const [argv, live] of [
			[["--tier", "live"], true],
			[["--tier", "device"], true],
			[["--tier", "unit", "--tier", "device"], true],
			[["--tier", "x"], false],
			[["--bogus"], false],
			[[], false],
			[["--tier", "unit", "--within", "pkgs", "--filter", "x"], false],
		] as const) {
			const { deps, lines, order, spy } = entry(on, undefined, "proof");
			expect([argv, await proofEntry(argv, deps)]).toEqual([argv, 2]);
			expect([argv, order, spy.calls]).toEqual([argv, ["gate", "loadProof"], []]);
			expect([argv, lines.includes(owner)]).toEqual([argv, live]);
		}
	});

	it("runs lib/proof.ts's own main on the held result: the gate's lines print once, ahead of the run", async () => {
		const { deps, lines, order, spy } = entry(on, undefined, "proof");
		// No inventory in the checkout and no reserved file in the listing: not proven, with no run.
		expect(await proofEntry(["--tier", "unit"], deps)).toBe(1);
		expect(lines[0]).toBe(CHECK_LINE);
		expect(lines.filter((line) => line === CHECK_LINE)).toHaveLength(1);
		expect(lines.at(-1)).toBe("reserved proof: not proven: 1 problem(s)");
		expect([order, spy.calls]).toEqual([["gate", "loadProof"], []]);
	});
});

// The entry with the real gate (lib/gate.ts's runGate) on a synthetic checkout, and a stub
// main, so no reserved suite and no tool runs.
describe("the proof's entry with the real gate", () => {
	it("hands a passing gate's listing to the proof, and stops at a refusing one before lib/proof.ts loads", async () => {
		const repo = tempRepo();
		try {
			for (const [file, text] of Object.entries({
				"pnpm-workspace.yaml": ownWorkspace,
				"package.json": '{ "name": "fixture", "private": true, "type": "module" }\n',
				"packages/a/package.json": '{ "name": "a" }\n',
				"packages/a/tsconfig.json": '{ "include": ["**/*.ts"] }\n',
				"packages/a/src/index.ts": "export const a = 1;\n",
			})) {
				repo.write(file, text);
			}
			repo.commit();
			const handed: proof.Deps[] = [];
			const loads: string[] = [];
			const lines: string[] = [];
			const deps: ProofEntryDeps = {
				env: on,
				print: (line) => lines.push(line),
				gate: () => runGate({ root: repo.dir, env: gitEnvOf(repo) }),
				async loadProof() {
					loads.push("loadProof");
					const main: typeof proof.main = async (_argv, given) => {
						handed.push(given);
						return 0;
					};
					return { main, defaults: proof.defaults, GATE_STOPPED: proof.GATE_STOPPED };
				},
			};
			expect(await proofEntry(["--tier", "unit"], deps)).toBe(0);
			expect([lines, loads]).toEqual([[], ["loadProof"]]);
			expect(handed[0]?.env[GATE_ROOT_ENV]).toBe(repo.dir);
			expect((await handed[0]?.tracked())?.toSorted()).toEqual([
				"package.json",
				"packages/a/package.json",
				"packages/a/src/index.ts",
				"packages/a/tsconfig.json",
				"pnpm-workspace.yaml",
			]);
			expect((await handed[0]?.gate())?.lines).toEqual([
				expect.stringMatching(/^reserved check: /),
			]);

			// An ignored file under a tsc root: the gate refuses, and the proof never loads.
			repo.ignore("packages/a/src/stray.ts");
			repo.write("packages/a/src/stray.ts", "export {};\n");
			lines.length = 0;
			expect(await proofEntry(["--tier", "unit"], deps)).toBe(1);
			expect(loads).toEqual(["loadProof"]);
			expect(lines.slice(-2)).toEqual([START_STOP_LINE, STOPPED]);
			expect(lines.every((line) => line.startsWith("reserved "))).toBe(true);
		} finally {
			repo.remove();
		}
	});
});
