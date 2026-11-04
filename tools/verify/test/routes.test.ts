import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { OFF_NOTICE, RESERVED_TESTS, reservedWord } from "../../../reserved-tests.ts";
import { aliasedCwd, gatedLauncher, kitMain } from "../../../spikes/kit/run.ts";
import {
	GATE_FAILED,
	GATE_ROOT_ENV,
	HELPERS,
	START_STOP_LINE,
	type StartProblem,
} from "../lib/bootstrap.ts";
import type { GateResult } from "../lib/gate.ts";
import { capture } from "../lib/spawn.ts";
import { prefetchEntry } from "../m0-prefetch.ts";
import { STOP_LINE } from "../reserved-tripwire.ts";
import { launch, turboMain } from "../turbo.ts";
import {
	canLink,
	copyOwn,
	gitEnvOf,
	ownRepo,
	ownWorkspace,
	scrub,
	type TempRepo,
	tempRepo,
	word,
} from "./temp-repo.ts";

// Every gated entry refuses on its own checkout before its first child. Each entry runs as
// a command in a synthetic checkout holding committed copies of the entry, its helpers and, for
// its first child, a stub that leaves a marker when it loads; node_modules is ignored and holds,
// when present, fakes of Vitest and tsc. The opt-in flag is set only in the proof's child env.
const repos: TempRepo[] = [];
afterEach(() => {
	for (const repo of repos.splice(0)) repo.remove();
});

const symlinks = canLink("file");
const NO_SYMLINKS = "file symlinks need Developer Mode or elevation on this Windows host";
const MARKER = "DY_ROUTE_MARKER";
const marks = `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.${MARKER} ?? "", "loaded");\n`;

const BASE: Readonly<Record<string, string>> = {
	"package.json": '{ "name": "fixture", "private": true, "type": "module" }\n',
	"pnpm-workspace.yaml": ownWorkspace,
	".gitignore": "node_modules/\n",
	"packages/a/package.json": '{ "name": "a", "private": true }\n',
	"packages/a/tsconfig.json": '{ "include": ["**/*.ts"] }\n',
	"packages/a/src/index.ts": 'import { b } from "./b.ts";\n\nexport const a = b;\n',
	"packages/a/src/b.ts": "export const b = 1;\n",
	"crates/r/Cargo.toml": '[package]\nname = "r"\nversion = "0.0.0"\n',
	"crates/r/src/lib.rs": "mod m;\n",
	"crates/r/src/m.rs": "pub fn m() {}\n",
	"spikes/probe/package.json": '{ "name": "probe", "private": true }\n',
	"spikes/probe/vitest.config.ts": "export default {};\n",
};

interface Route {
	// The entry below the root, and the files it loads.
	readonly entry: string;
	readonly files: readonly string[];
	// Stubs for its first child, committed in place of the real files.
	readonly children?: Readonly<Record<string, string>>;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	// Its exit code when the gate refuses, and when its inline start check does; what its baseline
	// prints once the gate passed.
	readonly refused: number;
	readonly started: number;
	readonly passed: (run: Ran, modules: boolean) => boolean;
	// The text of its gate call, and a passing stub for it: the committed mutation case.
	readonly gateCall: readonly [string, string];
}

interface Ran {
	readonly code: number;
	readonly lines: readonly string[];
	readonly child: boolean;
}

const gateFiles = ["tools/verify/gate.ts", "tools/verify/lib/bootstrap.ts", ...HELPERS.gate];
const helpersOf = (...sets: (keyof typeof HELPERS)[]): string[] => [
	...new Set([...gateFiles, ...sets.flatMap((set) => HELPERS[set])]),
];
const passingGate =
	"({ ok: true, lines: [], listing: { root: process.cwd(), entries: [], untracked: [] }, tracked: [] })";

const ROUTES: Readonly<Record<string, Route>> = {
	"tools/verify/turbo.ts": {
		entry: "tools/verify/turbo.ts",
		files: helpersOf("turbo"),
		args: ["run", "test"],
		refused: 2,
		started: 2,
		// Past the gate, turbo.ts resolves turbo, which no checkout here installs.
		passed: (run) =>
			run.code === 2 && run.lines.some((line) => / not found; run pnpm install$/.test(line)),
		gateCall: ["result = await deps.gate();", `result = ${passingGate};`],
	},
	"tools/verify/verify.ts": {
		entry: "tools/verify/verify.ts",
		files: helpersOf("verify"),
		children: {
			"tools/verify/steps/marker.ts": `${marks}export const step = { name: "marker", order: 1, profiles: [], run: async () => ({ status: "passed" }) };\n`,
			"tools/verify/profiles/marker.ts":
				'export const profile = { name: "marker", description: "", select: () => [] };\n',
		},
		args: ["--list"],
		refused: 1,
		started: 1,
		passed: (run) => run.code === 0 && run.child,
		gateCall: ["result = await gate();", `result = ${passingGate};`],
	},
	"spikes/kit/run.ts": {
		entry: "spikes/kit/run.ts",
		files: helpersOf("kitOff", "kitGate", "kitRun"),
		cwd: "spikes/probe",
		// The gate is a process of the kit's own, so its refusal's exit code passes through.
		refused: 1,
		started: 2,
		passed: (run, modules) =>
			modules
				? run.code === 0 && run.child
				: run.code === 2 && run.lines.includes("run: vitest isn't installed: run pnpm install"),
		gateCall: ["const code = await deps.gate();", "const code = 0;"],
	},
	"tools/verify/m0-prefetch.ts": {
		entry: "tools/verify/m0-prefetch.ts",
		files: helpersOf("prefetch"),
		children: {
			"tools/verify/prefetch.ts": `${marks}export const prefetchMain = async () => 0;\n`,
		},
		refused: 1,
		started: 1,
		passed: (run) => run.code === 0 && run.child,
		gateCall: ["result = await deps.gate();", `result = ${passingGate};`],
	},
	"tools/verify/reserved-proof.ts": {
		entry: "tools/verify/reserved-proof.ts",
		files: helpersOf("proof"),
		children: {
			"tools/verify/lib/proof.ts": `${marks}export const main = async () => 0;\nexport const defaults = {};\nexport const GATE_STOPPED = "not proven: the reserved check stopped it before any run";\n`,
		},
		env: { [RESERVED_TESTS]: "1" },
		args: ["--tier", "unit"],
		refused: 1,
		started: 1,
		passed: (run) => run.code === 0 && run.child,
		gateCall: ["result = await deps.gate();", `result = ${passingGate};`],
	},
};

// The route's checkout: BASE, its files and its stubs, committed; `change` edits the entry.
function checkout(route: Route, change?: readonly [string, string]): TempRepo {
	const repo = tempRepo();
	repos.push(repo);
	copyOwn(repo, [route.entry, ...route.files]);
	for (const [file, text] of Object.entries({ ...BASE, ...route.children })) repo.write(file, text);
	if (change !== undefined) {
		const source = readFileSync(path.join(ownRepo, route.entry), "utf8");
		const parts = source.split(change[0]);
		if (parts.length !== 2)
			throw new Error(`${route.entry} must hold ${JSON.stringify(change[0])} once`);
		repo.write(route.entry, parts.join(change[1]));
	}
	repo.commit();
	return repo;
}

// Fakes of Vitest's and TypeScript's bins, as the kit resolves them from package.json.
function installFakes(repo: TempRepo): void {
	const at = (rel: string, text: string): void => {
		mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
		writeFileSync(path.join(repo.dir, rel), text);
	};
	at(
		"node_modules/vitest/package.json",
		'{ "name": "vitest", "bin": { "vitest": "vitest.mjs" } }\n',
	);
	at("node_modules/vitest/vitest.mjs", marks);
	at(
		"node_modules/typescript/package.json",
		'{ "name": "typescript", "bin": { "tsc": "bin/tsc" } }\n',
	);
	at(
		"node_modules/typescript/bin/tsc",
		`require("node:fs").writeFileSync(process.env.${MARKER} ?? "", "loaded");\n`,
	);
}

// `node` goes before the entry on Node's command line, and `env` into its environment.
async function start(
	route: Pick<Route, "entry" | "args" | "cwd" | "env">,
	repo: TempRepo,
	extra: { readonly node?: readonly string[]; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<Ran> {
	const marker = path.join(repo.outside, "child-loaded");
	rmSync(marker, { force: true });
	// No inherited flag, no outer launcher's marker and no Node options: each run gates this
	// checkout itself.
	const inherited = Object.entries(gitEnvOf(repo)).filter(
		([name]) => ![RESERVED_TESTS, GATE_ROOT_ENV, "NODE_OPTIONS"].includes(name.toUpperCase()),
	);
	const entry = path.join(repo.dir, route.entry);
	const result = await capture(
		{ command: process.execPath, args: [...(extra.node ?? []), entry, ...(route.args ?? [])] },
		{
			cwd: path.join(repo.dir, route.cwd ?? ""),
			env: { ...Object.fromEntries(inherited), ...route.env, ...extra.env, [MARKER]: marker },
		},
	);
	const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter(Boolean);
	return { code: result.code, lines, child: existsSync(marker) };
}

// A refusal: the entry's refusal code, the tripwire's count lines and the stop line once, no path
// and no reserved word, and no child.
function refusedBy(route: Route, run: Ran): string[] {
	const problems: string[] = [];
	const stops = run.lines.filter((line) => line === STOP_LINE).length;
	if (run.code !== route.refused) problems.push(`exit ${run.code}`);
	if (stops !== 1) problems.push(`${stops} stop lines`);
	if (run.child) problems.push("its child ran");
	for (const line of run.lines) {
		const ours = line.startsWith("reserved tripwire: ") || line.startsWith("reserved proof: ");
		if (!ours) problems.push(`other line: ${scrub(line)}`);
		else if (line !== STOP_LINE && (/[\\/]/.test(line) || reservedWord.test(line))) {
			problems.push(`named line: ${scrub(line)}`);
		}
	}
	return problems;
}

// The planted trees, each refused by the gate before the entry's first child.
const PLANTED: Readonly<Record<string, (repo: TempRepo) => void>> = {
	"an untracked intermediary holding a literal target in the allowed root": (repo) => {
		repo.write("packages/a/src/via.ts", `import "../../../spikes/s07-${word()}/src/x.ts";\n`);
	},
	"an untracked helper importing a module that exists beside the checkout": (repo) => {
		writeFileSync(path.join(repo.outside, "helper.ts"), marks);
		repo.write("packages/a/src/beside.ts", 'import "../../../../outside/helper.ts";\n');
	},
	"an untracked module whose eager glob import matches a module beside the checkout": (repo) => {
		writeFileSync(path.join(repo.outside, "helper.ts"), marks);
		repo.write(
			"packages/a/src/glob.ts",
			'export const m = import.meta.glob("../../../../outside/*.ts", { eager: true });\n',
		);
	},
	"a test script running a helper that exists beside the checkout": (repo) => {
		writeFileSync(path.join(repo.outside, "helper.mjs"), marks);
		repo.write(
			"packages/a/package.json",
			'{ "name": "a", "private": true, "scripts": { "test": "node ../../../outside/helper.mjs" } }\n',
		);
	},
	"a test script running an ignored helper in the checkout": (repo) => {
		repo.ignore("packages/a/gen/");
		repo.write("packages/a/gen/x.mjs", marks);
		repo.write(
			"packages/a/package.json",
			'{ "name": "a", "private": true, "scripts": { "test": "node ./gen/x.mjs" } }\n',
		);
	},
	"a package whose entry point is an ignored module in the checkout": (repo) => {
		repo.ignore("packages/a/gen/");
		repo.write("packages/a/gen/x.js", marks);
		repo.write(
			"packages/a/package.json",
			'{ "name": "a", "private": true, "exports": { ".": "./gen/x.js" } }\n',
		);
	},
	"an ignored Rust module target": (repo) => {
		repo.git("rm", "-q", "--cached", "--", "crates/r/src/m.rs");
		repo.ignore("crates/r/src/m.rs");
	},
	"an ancestor folder replaced by a junction": (repo) => {
		const copy = path.join(repo.outside, "src");
		mkdirSync(copy);
		for (const name of ["index.ts", "b.ts"]) {
			writeFileSync(
				path.join(copy, name),
				readFileSync(path.join(repo.dir, "packages/a/src", name)),
			);
		}
		rmSync(path.join(repo.dir, "packages", "a", "src"), { recursive: true });
		repo.link("packages/a/src", copy, "junction");
	},
	"an input the gate can't read as what it is": (repo) => {
		repo.write("packages/a/package.json", "{ not json\n");
	},
};

describe("each gated entry on its own checkout", () => {
	for (const [name, route] of Object.entries(ROUTES)) {
		describe(name, () => {
			it("passes a clean checkout and reaches its first child, with and without node_modules", async () => {
				const repo = checkout(route);
				const bare = await start(route, repo);
				expect(route.passed(bare, false), JSON.stringify(bare.lines.map(scrub))).toBe(true);
				installFakes(repo);
				const installed = await start(route, repo);
				expect(route.passed(installed, true), JSON.stringify(installed.lines.map(scrub))).toBe(
					true,
				);
			});

			it.each(Object.keys(PLANTED))(
				"refuses %s before its first child, with and without node_modules",
				async (planted) => {
					const repo = checkout(route);
					PLANTED[planted]?.(repo);
					expect(refusedBy(route, await start(route, repo))).toEqual([]);
					installFakes(repo);
					expect(refusedBy(route, await start(route, repo))).toEqual([]);
				},
			);

			it("refuses an index entry replaced by a link before its first child", async (ctx) => {
				ctx.skip(!symlinks, NO_SYMLINKS);
				const repo = checkout(route);
				const target = path.join(repo.outside, "b.ts");
				writeFileSync(target, "export const b = 1;\n");
				rmSync(path.join(repo.dir, "packages", "a", "src", "b.ts"));
				repo.link("packages/a/src/b.ts", target, "file");
				expect(refusedBy(route, await start(route, repo))).toEqual([]);
				installFakes(repo);
				expect(refusedBy(route, await start(route, repo))).toEqual([]);
			});

			// Mutation case: with its gate call replaced by a pass, the same planted tree reaches the child.
			it("reaches its first child on a planted tree once its gate call always passes", async () => {
				const repo = checkout(route, route.gateCall);
				PLANTED["an untracked intermediary holding a literal target in the allowed root"]?.(repo);
				installFakes(repo);
				const run = await start(route, repo);
				expect(route.passed(run, true), JSON.stringify(run.lines.map(scrub))).toBe(true);
			});
		});
	}
});

// The entries Node starts with code or options it loads before their first line: a preload in
// NODE_OPTIONS, or --import on the command line. The preload runs, as nothing in the checkout can
// stop it; each entry then refuses at its inline start check with its own exit code, before any
// helper loads or any child starts. Harmless NODE_OPTIONS change nothing.
const PRELOADED = [
	"reserved tripwire: Node loaded code or options before this entry's first line (--require, --import, --loader, a startup snapshot or a config file, on its command line or in NODE_OPTIONS); nothing was checked",
	START_STOP_LINE,
];
const PRELOAD_MARKER = "DY_PRELOAD_MARKER";
const STARTED: Readonly<Record<string, Route | Pick<Route, "entry" | "files" | "started">>> = {
	...ROUTES,
	"tools/verify/gate.ts": { entry: "tools/verify/gate.ts", files: gateFiles, started: 1 },
	"tools/verify/preinstall.ts": {
		entry: "tools/verify/preinstall.ts",
		files: ["tools/verify/lib/bootstrap.ts", ...HELPERS.preinstall],
		started: 1,
	},
};

describe("each gated entry Node started with code it loads first", () => {
	for (const [name, route] of Object.entries(STARTED)) {
		it(`${name} refuses a preload in NODE_OPTIONS or on its command line before its first child`, async () => {
			const repo = tempRepo();
			repos.push(repo);
			copyOwn(repo, [route.entry, ...route.files]);
			const children = "children" in route ? route.children : {};
			for (const [file, text] of Object.entries({ ...BASE, ...children })) repo.write(file, text);
			repo.commit();
			const preload = path.join(repo.outside, "preload.cjs");
			const preloaded = path.join(repo.outside, "preloaded");
			writeFileSync(
				preload,
				`require("node:fs").writeFileSync(process.env.${PRELOAD_MARKER} ?? "", "ran");\n`,
			);
			const forward = preload.split(path.sep).join("/");
			const ways: readonly (readonly [string, Parameters<typeof start>[2]])[] = [
				["NODE_OPTIONS", { env: { NODE_OPTIONS: `--require "${forward}"` } }],
				["the command line", { node: ["--import", pathToFileURL(preload).href] }],
			];
			for (const [way, extra] of ways) {
				rmSync(preloaded, { force: true });
				const run = await start(route, repo, {
					...extra,
					env: { ...extra?.env, [PRELOAD_MARKER]: preloaded },
				});
				expect([way, run.code, run.lines, run.child, existsSync(preloaded)]).toEqual([
					way,
					route.started,
					PRELOADED,
					false,
					true,
				]);
			}
			// Options that load nothing leave the entry to its usual run.
			const harmless = await start(route, repo, {
				env: { NODE_OPTIONS: "--max-old-space-size=4096 --no-warnings" },
			});
			expect(harmless.lines.includes(PRELOADED[0] ?? "")).toBe(false);
			if ("passed" in route) {
				expect(route.passed(harmless, false), JSON.stringify(harmless.lines.map(scrub))).toBe(true);
			} else expect(harmless.code).toBe(0);
		});
	}
});

// --- the entries' main functions in process: what each calls, in which order ---

const CHECK = "reserved check: stubbed";
const passing = (root: string): GateResult => ({
	ok: true,
	lines: [CHECK],
	listing: { root, entries: [], untracked: [] },
	tracked: [],
});
const refusing: GateResult = {
	ok: false,
	lines: ["reserved tripwire: 1 stubbed problem(s)", STOP_LINE],
	listing: null,
	tracked: [],
};
const link: StartProblem = { rel: "tools/verify/lib/gate.ts", kind: "link" };
const START = [
	"reserved tripwire: 1 start file(s) or folder(s) failed their kind check; nothing was loaded",
	START_STOP_LINE,
];

describe("turboMain", () => {
	const root = ownRepo;
	function deps(gate: () => Promise<GateResult>, problems: readonly StartProblem[] = []) {
		const calls: string[] = [];
		const lines: string[] = [];
		const launched: NodeJS.ProcessEnv[] = [];
		return {
			calls,
			lines,
			launched,
			value: {
				print: (line: string) => lines.push(line),
				startCheck: () => {
					calls.push("start");
					return problems;
				},
				gate: () => {
					calls.push("gate");
					return gate();
				},
				launch: async (_argv: readonly string[], env: NodeJS.ProcessEnv) => {
					calls.push("launch");
					launched.push(env);
					return 0;
				},
			},
		};
	}

	it("stops at a failed start check before the flag and the gate (exit 2)", async () => {
		const run = deps(async () => passing(root), [link]);
		expect(await turboMain(["run", "test"], { [RESERVED_TESTS]: "yes" }, run.value)).toBe(2);
		expect([run.calls, run.lines]).toEqual([["start"], START]);
	});

	it("refuses a bad flag before the gate (exit 2)", async () => {
		const run = deps(async () => passing(root));
		expect(await turboMain(["run", "test"], { [RESERVED_TESTS]: "yes" }, run.value)).toBe(2);
		expect(run.calls).toEqual(["start"]);
	});

	it("stops at a refusing or failing gate with its lines, before turbo is resolved (exit 2)", async () => {
		const refused = deps(async () => refusing);
		expect(await turboMain(["run", "test"], {}, refused.value)).toBe(2);
		expect([refused.calls, refused.lines]).toEqual([["start", "gate"], refusing.lines]);
		const failed = deps(() => Promise.reject(new Error("gate")));
		expect(await turboMain(["run", "test"], {}, failed.value)).toBe(2);
		expect(failed.lines).toEqual([GATE_FAILED, START_STOP_LINE]);
		expect(failed.calls).toEqual(["start", "gate"]);
	});

	it("launches turbo after a passing gate, with the gate's root as the launcher marker", async () => {
		const run = deps(async () => passing(root));
		expect(await turboMain(["run", "test"], { KEEP: "1" }, run.value)).toBe(0);
		expect([run.calls, run.lines]).toEqual([["start", "gate", "launch"], [CHECK]]);
		expect(run.launched).toEqual([{ KEEP: "1", [GATE_ROOT_ENV]: root }]);
	});

	it("resolves turbo only through launch(), after the filters, and never for a refused task", async () => {
		const resolved: string[] = [];
		const started: (readonly string[])[] = [];
		const deps = {
			root,
			run: async (invocation: { args: readonly string[] }) => {
				started.push(invocation.args);
				return 0;
			},
			resolveTurbo: (at: string) => {
				resolved.push(at);
				return "turbo";
			},
			args: (args: readonly string[]) => [...args, "--filter=!./x"],
		};
		expect(await launch(["run", "test"], { [GATE_ROOT_ENV]: root }, deps)).toBe(0);
		expect([resolved, started]).toEqual([[root], [["run", "test", "--filter=!./x"]]]);
	});
});

describe("kitMain", () => {
	const root = ownRepo;
	function deps(
		options: {
			problems?: Partial<Record<string, readonly StartProblem[]>>;
			gate?: number;
			cwd?: string;
		} = {},
	) {
		const calls: string[] = [];
		const lines: string[] = [];
		const ran: NodeJS.ProcessEnv[] = [];
		return {
			calls,
			lines,
			ran,
			value: {
				root,
				cwd: options.cwd ?? path.join(root, "spikes", "kit"),
				print: (line: string) => lines.push(line),
				error: (line: string) => lines.push(line),
				startCheck: (set: "kitOff" | "kitGate" | "kitRun") => {
					calls.push(set);
					return options.problems?.[set] ?? [];
				},
				gate: async () => {
					calls.push("gate");
					return options.gate ?? 0;
				},
				runner: async () => {
					calls.push("runner");
					return {
						main: (_argv: readonly string[], env?: NodeJS.ProcessEnv) => {
							ran.push(env ?? {});
						},
					};
				},
			},
		};
	}
	const real = path.resolve(root);

	it("runs the gate itself outside a gated launcher, and hands the runner the marker", async () => {
		const run = deps();
		expect(await kitMain([], {}, run.value)).toBeUndefined();
		expect(run.calls).toEqual(["kitOff", "kitGate", "gate", "kitRun", "runner"]);
		expect(run.ran.map((env) => env[GATE_ROOT_ENV]?.toLowerCase())).toEqual([real.toLowerCase()]);
	});

	it("trusts a marker only when it names its own real root, and checks the runner's files either way", async () => {
		const trusted = deps();
		expect(await kitMain([], { [GATE_ROOT_ENV]: root }, trusted.value)).toBeUndefined();
		expect(trusted.calls).toEqual(["kitOff", "kitRun", "runner"]);
		for (const marker of [path.join(root, "spikes"), path.dirname(root), "", "relative"]) {
			const other = deps();
			expect(await kitMain([], { [GATE_ROOT_ENV]: marker }, other.value)).toBeUndefined();
			expect([marker, other.calls]).toEqual([
				marker,
				["kitOff", "kitGate", "gate", "kitRun", "runner"],
			]);
		}
		expect(gatedLauncher(root, root)).toBe(true);
		expect(gatedLauncher(root, undefined)).toBe(false);
	});

	it("passes a refusing gate's exit code through and never loads the runner", async () => {
		const run = deps({ gate: 1 });
		expect(await kitMain([], {}, run.value)).toBe(1);
		expect(run.calls).toEqual(["kitOff", "kitGate", "gate"]);
	});

	it.each(["kitOff", "kitGate", "kitRun"])(
		"stops at a failed %s start check with its two lines (exit 2)",
		async (set) => {
			const run = deps({ problems: { [set]: [link] } });
			expect(await kitMain([], {}, run.value)).toBe(2);
			expect(run.lines).toEqual(START);
			expect(run.calls.includes("runner")).toBe(false);
			expect(run.calls.at(-1)).toBe(set);
		},
	);

	it("refuses a runner.ts replaced under a trusted marker before it loads", async () => {
		const run = deps({ problems: { kitRun: [{ rel: "spikes/kit/runner.ts", kind: "link" }] } });
		expect(await kitMain([], { [GATE_ROOT_ENV]: root }, run.value)).toBe(2);
		expect(run.calls).toEqual(["kitOff", "kitRun"]);
	});

	it("stops a reserved folder at the off notice, before the gate", async () => {
		// Judged by name; outside the checkout, by its whole path.
		const off = deps({ cwd: path.join(tmpdir(), `x-${word()}`) });
		expect(await kitMain([], {}, off.value)).toBe(0);
		expect([off.calls, off.lines]).toEqual([["kitOff"], [OFF_NOTICE]]);
		// With the flag, the same folder runs, gated.
		const optedIn = deps({ cwd: path.join(tmpdir(), `x-${word()}`) });
		expect(await kitMain([], { [RESERVED_TESTS]: "1" }, optedIn.value)).toBeUndefined();
		expect(optedIn.calls).toEqual(["kitOff", "kitGate", "gate", "kitRun", "runner"]);
	});

	it("refuses a working folder that doesn't resolve to the same path below the real root", async () => {
		const missing = path.join(root, "spikes", "no-such-folder");
		expect(aliasedCwd(root, missing)).toBe(true);
		const run = deps({ cwd: missing });
		expect(await kitMain([], {}, run.value)).toBe(2);
		expect(run.calls).toEqual(["kitOff"]);
		expect(run.lines).toEqual([
			"reserved tripwire: the working folder is reached through a link, junction or other alias; nothing was run",
			START_STOP_LINE,
		]);
	});
});

describe("prefetchEntry", () => {
	const root = ownRepo;
	function deps(gate: () => Promise<GateResult>, problems: readonly StartProblem[] = []) {
		const calls: string[] = [];
		const lines: string[] = [];
		return {
			calls,
			lines,
			value: {
				root,
				print: (line: string) => lines.push(line),
				error: (line: string) => lines.push(line),
				startCheck: () => {
					calls.push("start");
					return problems;
				},
				gate: () => {
					calls.push("gate");
					return gate();
				},
				prefetch: async () => {
					calls.push("prefetch");
					return 0;
				},
			},
		};
	}

	it("checks its arguments first, then the start check, the flag and the gate", async () => {
		const usage = deps(async () => passing(root), [link]);
		expect(await prefetchEntry(["--bogus"], {}, usage.value)).toBe(2);
		expect(await prefetchEntry(["--help"], {}, usage.value)).toBe(0);
		expect(usage.calls).toEqual([]);
		const started = deps(async () => passing(root), [link]);
		expect(await prefetchEntry([], {}, started.value)).toBe(1);
		expect([started.calls, started.lines]).toEqual([["start"], START]);
		const flag = deps(async () => passing(root));
		expect(await prefetchEntry([], { [RESERVED_TESTS]: "yes" }, flag.value)).toBe(2);
		expect(flag.calls).toEqual(["start"]);
		const refused = deps(async () => refusing);
		expect(await prefetchEntry([], {}, refused.value)).toBe(1);
		expect([refused.calls, refused.lines]).toEqual([["start", "gate"], refusing.lines]);
		const passed = deps(async () => passing(root));
		expect(await prefetchEntry(["--"], {}, passed.value)).toBe(0);
		expect([passed.calls, passed.lines]).toEqual([["start", "gate", "prefetch"], [CHECK]]);
	});
});
