import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	biomeNegations,
	lowerCaseReserved,
	OFF_NOTICE,
	RESERVED_TESTS,
	repoPath,
	reservedGlobs,
	reservedPackageDirs,
	reservedPath,
	reservedSpellings,
	reservedTestsOn,
	reservedTurboArgs,
	reservedWord,
	type TestTier,
	TURBO_USAGE,
	testTier,
	tierFiles,
	windowsChildEnv,
	withoutReservedTests,
	workspaceGlobs,
	workspacePackageDirs,
	workspaceParents,
} from "../../../reserved-tests.ts";
import { reservedOffConfig } from "../../../spikes/kit/off.ts";
import {
	type CountsReport,
	LOADED_RESERVED,
	moduleFile,
	PLUGIN_MISSING,
	tierFiles as sharedTierFiles,
} from "../../../vitest.shared.ts";
import * as allowed from "../lib/allowed.ts";
import { capture } from "../lib/spawn.ts";
import { approvedWorkspace } from "../lib/workspace-policy.ts";

// The shared helper and default-off controls, on synthetic paths, folders and checkouts. The
// reserved words are built here, so this file never spells one; test titles and assertion values
// never hold one, and compared values and child output are scrubbed of them and of the reserved
// spike's number, so a failure prints only neutral labels.
const repo = path.resolve(import.meta.dirname, "..", "..", "..");
const word = ["si", "wc"].join("");
const parts = ["dynamic", "agent"];
const hyphen = parts.join("-");
const underscore = parts.join("_");
const spikeNumber = ["s0", "7"].join("");
const capital = (text: string): string => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
const reservedText = new RegExp(`${word}|${spikeNumber}[-_]|${parts.join("[-_]")}`, "gi");
const scrub = (text: string): string => text.replace(reservedText, "<reserved>");

// Compares as JSON; a failure prints both sides scrubbed.
function same(actual: unknown, expected: unknown): void {
	const [a, b] = [JSON.stringify(actual), JSON.stringify(expected)];
	expect(a === b ? "same" : `${scrub(a)}\n  is not\n${scrub(b)}`).toBe("same");
}

const windows = process.platform === "win32";
const outcome = (env: NodeJS.ProcessEnv, on: typeof reservedTestsOn = reservedTestsOn): string => {
	try {
		return on(env) ? "on" : "off";
	} catch (error) {
		return error instanceof Error ? error.message : "refused";
	}
};
const refusal = (value: string): string =>
	`${RESERVED_TESTS} must be unset (off) or exactly 1 (on), not ${JSON.stringify(value)}`;
// Values the flag refuses, as neither on nor off.
const refused: readonly string[] = ["", "0", "true", " 1", "1\n", "1 ", "01", "yes", "TRUE"];

describe("DRAFTYAK_RESERVED_TESTS", () => {
	it("is off when unset and on only for exactly 1", () => {
		expect([
			outcome({}),
			outcome({ [RESERVED_TESTS]: undefined }),
			outcome({ [RESERVED_TESTS]: "1" }),
		]).toEqual(["off", "off", "on"]);
	});

	it.each(refused)("refuses %j instead of reading it as on or off", (value) => {
		expect(outcome({ [RESERVED_TESTS]: value })).toBe(refusal(value));
	});

	it("doesn't echo a long value or one that names a reserved word", () => {
		const named = outcome({ [RESERVED_TESTS]: `x-${word}` });
		expect(reservedWord.test(named)).toBe(false);
		expect(named).toContain("not a 6-character value");
		expect(outcome({ [RESERVED_TESTS]: "1".repeat(40) })).toContain("not a 40-character value");
	});

	it("reads the flag in any case on Windows, as a child process gets it", () => {
		const lower = { draftyak_reserved_tests: "1" };
		expect(outcome(lower)).toBe(windows ? "on" : "off");
		expect(outcome({ draftyak_reserved_tests: "true" })).toBe(windows ? refusal("true") : "off");
		expect(outcome({ ...lower, ...withoutReservedTests(lower) })).toBe("off");
	});

	it("strips the flag from a child's env in any case Windows stored it", () => {
		const env = { draftyak_reserved_tests: "1", PATH: "x" };
		expect(withoutReservedTests(env)).toStrictEqual({
			[RESERVED_TESTS]: undefined,
			draftyak_reserved_tests: undefined,
		});
	});
});

// Mutation cases: reservedTestsOn from a copy of reserved-tests.ts in a temp folder. With its exact
// value check loosened or its refusal removed, it reads every refused value as on or as off, so
// "refuses %j instead of reading it as on or off" fails. The copy left as it is refuses them all.
describe("DRAFTYAK_RESERVED_TESTS without its exact value check", () => {
	let dir = "";
	let copies = 0;
	beforeAll(() => {
		dir = neutralTempDir();
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	// The outcome of each value: unset, exactly 1, then each refused value.
	const read = async (change?: readonly [string, string]): Promise<string[]> => {
		let text = readFileSync(path.join(repo, "reserved-tests.ts"), "utf8");
		if (change !== undefined) {
			const parts = text.split(change[0]);
			if (parts.length !== 2)
				throw new Error(`reserved-tests.ts must hold ${JSON.stringify(change[0])} once`);
			text = parts.join(change[1]);
		}
		const copy = path.join(dir, `copy-${++copies}`, "reserved-tests.ts");
		write(copy, text);
		const copied = (await import(
			pathToFileURL(copy).href
		)) as typeof import("../../../reserved-tests.ts");
		return [undefined, "1", ...refused].map((value) =>
			outcome({ [RESERVED_TESTS]: value }, copied.reservedTestsOn),
		);
	};

	it("refuses every other value from a copy left as it is", async () => {
		expect(await read()).toEqual(["off", "on", ...refused.map(refusal)]);
	});

	it("reads every refused value as on once the check for exactly 1 is loosened", async () => {
		const change = [
			'if (value === "1") return true;',
			"if (value !== undefined) return true;",
		] as const;
		expect(await read(change)).toEqual(["off", "on", ...refused.map(() => "on")]);
	});

	it("reads every refused value as off once its refusal is removed", async () => {
		const refusing = `throw new Error(\`\${RESERVED_TESTS} must be unset (off) or exactly 1 (on), not \${shown(value)}\`);`;
		expect(await read([refusing, "return false;"])).toEqual([
			"off",
			"on",
			...refused.map(() => "off"),
		]);
	});
});

describe("reserved paths", () => {
	// Nothing on disk: the helper only compares paths here.
	const outside = path.join(tmpdir(), "draftyak-paths");
	const checkout = path.join(outside, `checkout-${word}`);
	const pkg = path.join(checkout, "pkgs", "p");

	it("finds each word in any case, with either separator, as a file or a folder", () => {
		const reserved = [
			path.join(pkg, `X-${word.toUpperCase()}.ts`),
			path.join(pkg, `${underscore}.ts`),
			path.join(pkg, hyphen, "a.ts"),
			path.join(pkg, word, "plain.ts"),
			path.join(pkg, `x-${word}.ts`),
			path.join(pkg, parts.map(capital).join("_"), "b.ts"),
		];
		const ordinary = [
			path.join(pkg, "plain.ts"),
			path.join(pkg, parts[0] ?? "", `${parts[1]}.ts`),
			path.join(pkg, `${parts.join("")}.ts`),
			path.join(pkg, `${word.slice(0, 2)}-${word.slice(2)}.ts`),
		];
		expect(reserved.map((file) => reservedPath(file, checkout))).toEqual(reserved.map(() => true));
		expect(ordinary.map((file) => reservedPath(file, checkout))).toEqual(ordinary.map(() => false));
	});

	it("reads only the part below the repository root, so the checkout's own name never counts", () => {
		expect(repoPath(path.join(checkout, "pkgs", "plain"), checkout)).toBe("pkgs/plain");
		expect(reservedPath(path.join(checkout, "pkgs", "plain"), checkout)).toBe(false);
		expect(reservedPath(checkout, checkout)).toBe(false);
		expect(reservedPath(path.join(checkout, "pkgs", `${word}-only`), checkout)).toBe(true);
	});

	it("reads a path outside the repository whole", () => {
		expect(reservedWord.test(outside)).toBe(false);
		expect(repoPath(outside, checkout)).toBeNull();
		expect(reservedPath(path.join(outside, "plain"), checkout)).toBe(false);
		expect(reservedPath(path.join(outside, `x-${word}`, "y"), checkout)).toBe(true);
	});

	it("measures from this repository's root by default", () => {
		expect(repoPath(path.join(repo, "tools", "verify"))).toBe("tools/verify");
		expect(reservedPath(path.join(repo, "tools", "verify"))).toBe(false);
		expect(reservedPath(path.join(repo, "spikes", `${spikeNumber}-${word}`))).toBe(true);
	});

	it("spells each word in lower case once per separator, as biome.json's negations match", () => {
		same(reservedSpellings, [word, hyphen, underscore]);
		same(biomeNegations, [`!**/*${word}*`, `!**/*${hyphen}*`, `!**/*${underscore}*`]);
		const lower = [`a/x-${word}/b.ts`, `a/${underscore}.ts`, `a/${hyphen}/b.ts`, "plain/a.ts"];
		const mixed = [
			`a/X-${word.toUpperCase()}/b.ts`,
			`a/${parts.map(capital).join("_")}.ts`,
			`a/${word}/${capital(word)}.ts`,
		];
		expect(lower.map(lowerCaseReserved)).toEqual([true, true, true, true]);
		expect(mixed.map(lowerCaseReserved)).toEqual([false, false, false]);
	});

	it("matches each word in any case with either separator, through globs that never spell one", () => {
		expect(reservedGlobs.length).toBe(4);
		expect(reservedGlobs.filter((glob) => reservedWord.test(glob))).toEqual([]);
		const matched = (file: string): boolean =>
			reservedGlobs.some((glob) => path.posix.matchesGlob(file, glob));
		const files = [
			`p/x-${word.toUpperCase()}.ts`,
			`p/${capital(word)}/a.ts`,
			`p/${underscore}.ts`,
			`p/${hyphen}/a.ts`,
			`p/${parts.map((part) => part.toUpperCase()).join("-")}.ts`,
		];
		expect(files.map(matched)).toEqual(files.map(() => true));
		expect(["p/plain.ts", `p/${parts.join("")}.ts`].map(matched)).toEqual([false, false]);
	});
});

describe("test tiers", () => {
	it("names each test file's tier as the tier globs pick it", () => {
		const names = [
			"a.test.ts",
			"p/a.heavy.test.ts",
			"a.live.test.ts",
			"p/q/a.device.test.ts",
			"a.test.tsx",
			"a.test.mts",
			"a.heavy.test.mts",
			"a.ts",
			"a.test.ts.map",
		];
		const byGlob = (file: string): string | null =>
			(["heavy", "live", "device", "unit"] as const).find((tier) =>
				path.posix.matchesGlob(file, tierFiles[tier]),
			) ?? null;
		const tiers = names.map((name) => testTier(name));
		expect(tiers).toEqual(["unit", "heavy", "live", "device", null, null, null, null, null]);
		expect(tiers).toEqual(names.map(byGlob));
	});

	it("reads the tier from the globs it is given, so .tsx and .mts files count once a glob takes them", () => {
		const wider = {
			unit: "**/*.test.{ts,tsx,mts}",
			heavy: "**/*.heavy.test.{ts,tsx,mts}",
			live: "**/*.live.test.{ts,tsx,mts}",
			device: "**/*.device.test.{ts,tsx,mts}",
		};
		const names = ["a.test.tsx", "a.test.mts", "a.heavy.test.mts", "a.live.test.tsx", "a.test.js"];
		expect(names.map((name) => testTier(name, wider))).toEqual([
			"unit",
			"unit",
			"heavy",
			"live",
			null,
		]);
	});

	it("keeps the tier globs vitest.shared.ts had, and vitest.shared.ts re-exports them", () => {
		expect(sharedTierFiles).toBe(tierFiles);
		same(tierFiles, {
			unit: "**/*.test.ts",
			heavy: "**/*.heavy.test.ts",
			live: "**/*.live.test.ts",
			device: "**/*.device.test.ts",
		});
	});
});

describe("pnpm-workspace.yaml's packages", () => {
	const made: string[] = [];
	afterAll(() => {
		for (const dir of made) rmSync(dir, { recursive: true, force: true });
	});
	const workspace = (text: string | null): string => {
		const dir = mkdtempSync(path.join(tmpdir(), "draftyak-workspace-"));
		made.push(dir);
		if (text !== null) writeFileSync(path.join(dir, "pnpm-workspace.yaml"), text);
		return dir;
	};
	const unreadable = "pnpm-workspace.yaml has no readable packages: list";

	it("reads the packages: list, its parent folders and the package folders in them", () => {
		const at = workspace(
			"# packages\npackages:\n  - pkgs/*\n  - tools/*\n  - solo\n\nminimumReleaseAge: 1\n",
		);
		for (const dir of ["pkgs/plain", `pkgs/${word}-only`, "pkgs/no-manifest", "tools/t", "solo"]) {
			mkdirSync(path.join(at, dir), { recursive: true });
			if (!dir.endsWith("no-manifest")) writeFileSync(path.join(at, dir, "package.json"), "{}");
		}
		expect(workspaceGlobs(at)).toEqual(["pkgs/*", "tools/*", "solo"]);
		expect(workspaceParents(at)).toEqual(["pkgs", "tools"]);
		same(workspacePackageDirs(at), ["pkgs/plain", `pkgs/${word}-only`, "solo", "tools/t"]);
		same(reservedPackageDirs(at), [`pkgs/${word}-only`]);
	});

	it("reads CRLF lines, comments and trailing spaces as the approved grammar does", () => {
		const at = workspace(
			"\uFEFFpackages:\r\n  - pkgs/*  \r\n  # later\r\n\r\n  - solo\r\nengineStrict: true\r\n",
		);
		expect(workspaceGlobs(at)).toEqual(["pkgs/*", "solo"]);
	});

	it("reads the repository's own file, which lib/workspace-policy.ts approves", () => {
		const text = readFileSync(path.join(repo, "pnpm-workspace.yaml"), "utf8");
		expect(approvedWorkspace(text)).toBe(true);
		expect(workspaceGlobs(repo)).toEqual([
			"apps/*",
			"packages/*",
			"plugins/*",
			"spikes/*",
			"tools/*",
		]);
	});

	it.each([
		["a missing file", null],
		["no packages: key", "minimumReleaseAge: 1\n"],
		["an empty list", "packages:\n\nminimumReleaseAge: 1\n"],
		["a flow list", "packages: [pkgs/*]\n"],
		["a list at the key's own indent", "packages:\n- pkgs/*\n"],
		["a deeper indent", "packages:\n    - pkgs/*\n"],
		["a tab indent", "packages:\n\t- pkgs/*\n"],
		["a quoted glob", "packages:\n  - 'pkgs/*'\n"],
		["an entry with a comment", "packages:\n  - pkgs/* # all\n"],
		["a negated glob", "packages:\n  - pkgs/*\n  - '!pkgs/x'\n"],
		["a recursive glob", "packages:\n  - pkgs/**\n"],
		["a parent folder", "packages:\n  - ../pkgs/*\n"],
		["an absolute folder", "packages:\n  - /pkgs/*\n"],
		["a second packages: key", "packages:\n  - pkgs/*\npackages:\n  - tools/*\n"],
		["a lone carriage return", "packages:\r  - pkgs/*\n"],
		["a key inside the list", "packages:\n  - pkgs/*\n  extra: 1\n"],
	])("throws for %s, and so does every caller, instead of finding no packages", (_label, text) => {
		const at = workspace(text);
		expect(() => workspaceGlobs(at)).toThrow(unreadable);
		expect(() => workspaceParents(at)).toThrow(unreadable);
		expect(() => workspacePackageDirs(at)).toThrow(unreadable);
		expect(() => reservedPackageDirs(at)).toThrow(unreadable);
		expect(() => reservedTurboArgs(["run", "test"], {}, at)).toThrow(unreadable);
	});
});

describe("the turbo launchers' package filters", () => {
	const at = mkdtempSync(path.join(tmpdir(), "draftyak-workspace-"));
	afterAll(() => rmSync(at, { recursive: true, force: true }));
	writeFileSync(path.join(at, "pnpm-workspace.yaml"), "packages:\n  - pkgs/*\n");
	for (const dir of ["pkgs/plain", `pkgs/${word}-only`]) {
		mkdirSync(path.join(at, dir), { recursive: true });
		writeFileSync(path.join(at, dir, "package.json"), "{}");
	}

	it("leaves reserved packages out of turbo runs, before any --, unless the flag is on", () => {
		const off = `--filter=!./pkgs/${word}-only`;
		same(reservedTurboArgs(["run", "test"], {}, at), ["run", "test", off]);
		same(reservedTurboArgs(["run", "test", "--", "--silent"], {}, at), [
			"run",
			"test",
			off,
			"--",
			"--silent",
		]);
		same(reservedTurboArgs(["run", "test"], { [RESERVED_TESTS]: "1" }, at), ["run", "test"]);
		expect(() => reservedTurboArgs(["run", "test"], { [RESERVED_TESTS]: "0" }, at)).toThrow(
			refusal("0"),
		);
	});

	it.each([[["test"]], [["watch", "test"]], [["--version"]], [[]]])(
		"refuses %j, which turbo would run without the filters",
		(args) => {
			for (const env of [{}, { [RESERVED_TESTS]: "1" }]) {
				expect(() => reservedTurboArgs(args, env, at)).toThrow(TURBO_USAGE);
			}
		},
	);
});

describe("windowsChildEnv", () => {
	const setting = "NoDefaultCurrentDirectoryInExePath";
	const plain = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => key.toUpperCase() !== setting.toUpperCase()),
	);

	it("sets the Windows command-search setting once, and leaves other platforms' env as it is", () => {
		const env = { PATH: "x", [setting.toLowerCase()]: "0" };
		const child = windowsChildEnv(env);
		expect(child).toStrictEqual(windows ? { PATH: "x", [setting]: "1" } : env);
		expect(env).toStrictEqual({ PATH: "x", [setting.toLowerCase()]: "0" });
		if (!windows) expect(child).toBe(env);
	});

	it.runIf(windows)(
		"keeps cmd.exe from running a command file in the working folder before PATH",
		async () => {
			const dir = mkdtempSync(path.join(tmpdir(), "draftyak-search-"));
			try {
				writeFileSync(path.join(dir, "node.cmd"), "@echo shadowed\r\n");
				const shell = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
				const run = (env: NodeJS.ProcessEnv) =>
					capture({ command: shell, args: ["/d", "/c", "node", "--version"] }, { cwd: dir, env });
				const [bare, guarded] = await Promise.all([run(plain), run(windowsChildEnv(plain))]);
				// Without the setting, cmd.exe runs the folder's node.cmd; with it, the node on PATH.
				expect(bare.stdout.trim()).toBe("shadowed");
				expect(guarded.stdout.trim()).toMatch(/^v\d+\.\d+\.\d+$/);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("the reserved-tests.ts command", () => {
	const command = (args: readonly string[]) =>
		capture(
			{ command: process.execPath, args: [path.join(repo, "reserved-tests.ts"), ...args] },
			{ cwd: repo },
		);

	it("exits 0 for a path that names a reserved word below the root and 1 for any other", async () => {
		const paths = [
			`pkgs/p/x-${word}.ts`,
			`pkgs/p/X-${word.toUpperCase()}.ts`,
			`pkgs/p/${underscore}.ts`,
			`pkgs/p/${hyphen}/a.ts`,
			"pkgs/p/plain.ts",
			".",
		];
		const results = await Promise.all(paths.map((file) => command(["--reserved", file])));
		expect(results.map(({ code }) => code)).toEqual([0, 0, 0, 0, 1, 1]);
		expect(results.map(({ stdout, stderr }) => stdout + stderr)).toEqual(paths.map(() => ""));
	});

	it.each([
		[[]],
		[["--wired"]],
		[["--reserved"]],
		[["--reserved", ""]],
		[["--reserved", "a", "b"]],
	])("exits 2 with the usage line for %j", async (args) => {
		const result = await command(args);
		expect([result.code, result.stdout, result.stderr.trim()]).toEqual([
			2,
			"",
			"usage: node reserved-tests.ts --reserved <path>",
		]);
	});
});

describe("OFF_NOTICE", () => {
	it("is the notice the kit's reservedOffConfig writes, byte for byte, and names no path", () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			reservedOffConfig();
			expect(write.mock.calls).toEqual([[`${OFF_NOTICE}\n`]]);
		} finally {
			write.mockRestore();
		}
		expect(reservedWord.test(OFF_NOTICE)).toBe(false);
		expect(OFF_NOTICE).not.toMatch(/[\\/]/);
	});
});

describe("the allowed reserved set", () => {
	it("holds exactly the allowed root and the two documents", () => {
		const spike = `${spikeNumber}-${word}`;
		same(Object.keys(allowed).toSorted(), ["ALLOWED_DOCS", "ALLOWED_ROOTS"]);
		same(allowed.ALLOWED_ROOTS, [`spikes/${spike}/`]);
		same(allowed.ALLOWED_DOCS, [
			`docs/roadmap/m7-${word}.md`,
			`docs/adr/0009-${spike}-sign-in-with-chatgpt.md`,
		]);
		expect([Object.isFrozen(allowed.ALLOWED_ROOTS), Object.isFrozen(allowed.ALLOWED_DOCS)]).toEqual(
			[true, true],
		);
	});
});

describe("the draftyak:reserved-tests plugin's parts", () => {
	it("reads the file behind a Vite module id, and nothing for a virtual one", () => {
		const file = path.join(tmpdir(), "m.ts");
		const slashed = file.split(path.sep).join("/");
		expect(moduleFile(`${file}?v=1`)).toBe(file);
		expect(moduleFile(`${file}#x`)).toBe(file);
		expect(moduleFile(`/@fs${slashed.startsWith("/") ? "" : "/"}${slashed}`)).toBe(slashed);
		expect(moduleFile(`\0virtual:${file}`)).toBeNull();
		expect(moduleFile("virtual:x")).toBeNull();
		expect(moduleFile("vitest")).toBeNull();
	});

	it("keeps the load refusal's and the planted include's fixed texts", () => {
		expect(LOADED_RESERVED).toBe(
			"a default run loaded a reserved module; DRAFTYAK_RESERVED_TESTS=1 runs it",
		);
		expect(PLUGIN_MISSING).toBe("draftyak-reserved-tests-plugin-missing/**");
	});
});

// Real Vitest runs in synthetic checkouts under the system temp folder. Each holds byte copies of
// every root .ts file (the shared config, the shared helper, the refusing root config) and of the
// spike kit, refusing configs in the folders that hold its packages, and a node_modules link to
// this checkout's, so the copies' repository root is that checkout. The main one's folder name
// holds a reserved word, which must never count; a neutral one serves the runs whose output is read
// whole. Each run gets fresh package folders.
const tiers: readonly TestTier[] = ["unit", "heavy", "live", "device"];
const suffix = (tier: TestTier): string => (tier === "unit" ? ".test.ts" : `.${tier}.test.ts`);
const mode = (tier: TestTier): string[] => (tier === "unit" ? [] : ["--mode", tier]);
const passing = 'import { it } from "vitest";\nit("runs", () => {});\n';
const counted =
	'import { it } from "vitest";\nit("counts one", () => {});\nit("counts two", () => {});\nit.skip("skips one", () => {});\nit.todo("todo one");\n';
const failing =
	'import { it } from "vitest";\nit("is collected", () => {\n\tthrow new Error("collected");\n});\n';
const sharedConfig =
	'import { vitestConfig } from "../../vitest.shared.ts";\nexport default (env) => vitestConfig(env);\n';
// The maintainer's interface for a reserved-only spike's config: only the kit's off.ts is
// imported up front, and the kit's factory only once the spike's tests may run.
const offConfig =
	'import { reservedOffConfig, reservedSpikeOff } from "../kit/off.ts";\nexport default async (env) =>\n\treservedSpikeOff(import.meta.dirname)\n\t\t? reservedOffConfig()\n\t\t: (await import("../kit/vitest.ts")).spikeVitestConfig(env);\n';
// A package config that replaces test.exclude, as one leaving fixtures out would.
const ownExclude =
	'import { configDefaults } from "vitest/config";\nimport { vitestConfig } from "../../vitest.shared.ts";\nexport default (env) => {\n\tconst base = vitestConfig(env);\n\treturn { ...base, test: { ...base.test, exclude: [...configDefaults.exclude, "**/fixtures/**"] } };\n};\n';
// A module that records being loaded.
const marking = (name: string): string =>
	`import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./${name}", import.meta.url), "");\n`;
// A test file that imports a specifier built at run time, one character at a time, so neither the
// file nor a code frame Vitest prints from it spells that specifier.
const computedImport = (specifier: string): string => {
	const name = [...specifier].map((char) => JSON.stringify(char)).join(", ");
	return `import { it, vi } from "vitest";\nconst name = [${name}].join("");\nit("imports", async () => {\n\tawait import(/* @vite-ignore */ name);\n});\nit("imports the actual module", async () => {\n\tawait vi.importActual(name);\n});\n`;
};

type Files = Readonly<Record<string, readonly [label: string, text: string]>>;
interface Instance {
	readonly dir: string;
	readonly labels: ReadonlyMap<string, string>;
}
interface Outcome {
	readonly code: number;
	readonly out: string;
	readonly err: string;
	readonly ran: Readonly<Record<string, string>>;
}

// An ordinary package: one passing file per tier, and failing reserved fixtures in every tier,
// spelled in either case, with either separator, as a file or as a folder.
const plainFiles: Files = Object.fromEntries([
	...tiers.map((tier) => [
		`a${suffix(tier)}`,
		[`ordinary ${tier}`, tier === "unit" ? counted : passing],
	]),
	...tiers.map((tier) => [`x-${word}${suffix(tier)}`, [`reserved ${tier}`, failing]]),
	[`${word.toUpperCase()}-upper.test.ts`, ["reserved upper-case file", failing]],
	[`in-${capital(word)}-folder/b.test.ts`, ["reserved mixed-case folder", failing]],
	[`x-${underscore}.test.ts`, ["reserved underscore file", failing]],
	[`${hyphen.toUpperCase()}/c.test.ts`, ["reserved upper-case folder", failing]],
]);
const onlyFiles: Files = Object.fromEntries(
	tiers.map((tier) => [`c${suffix(tier)}`, [`reserved-only ${tier}`, failing]]),
);

const vitestManifest = createRequire(import.meta.url).resolve("vitest/package.json");
const vitestBin = path.join(
	path.dirname(vitestManifest),
	(JSON.parse(readFileSync(vitestManifest, "utf8")) as { bin: { vitest: string } }).bin.vitest,
);
// A clean child: no outer Vitest or turbo state, colours, CI behaviour or DRAFTYAK_* variables.
const inherited = /^(?:VITEST|TEST$|NODE_ENV$|DRAFTYAK_|TURBO_|FORCE_COLOR$|GITHUB_ACTIONS$|CI$)/i;
const childEnv = Object.fromEntries(
	Object.entries(process.env).filter(([name]) => !inherited.test(name)),
);
const on = { [RESERVED_TESTS]: "1" };
const key = (file: string): string =>
	windows ? path.resolve(file).toLowerCase() : path.resolve(file);
const write = (file: string, text: string): void => {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
};

// A synthetic checkout at `dir`: the root .ts files and the spike kit as this checkout has them,
// refusing configs in the folders that hold its packages, and node_modules linked to this
// checkout's (a junction on Windows, which needs no privilege).
function syntheticCheckout(dir: string): void {
	for (const file of readdirSync(repo).filter((name) => name.endsWith(".ts"))) {
		write(path.join(dir, file), readFileSync(path.join(repo, file), "utf8"));
	}
	cpSync(path.join(repo, "spikes", "kit"), path.join(dir, "spikes", "kit"), {
		recursive: true,
		filter: (source) => !["node_modules", ".cache"].includes(path.basename(source)),
	});
	const refusing = readFileSync(path.join(repo, "spikes", "vitest.config.ts"), "utf8");
	for (const parent of ["pkgs", "spikes"]) {
		write(path.join(dir, parent, "vitest.config.ts"), refusing);
	}
	symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"), "junction");
}

// A fresh temp folder whose path holds no reserved word, so a run in it reads as ordinary.
function neutralTempDir(): string {
	for (let attempt = 0; attempt < 5; attempt++) {
		const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-reserved-tests-")));
		if (!reservedWord.test(dir)) return dir;
		rmSync(dir, { recursive: true, force: true });
	}
	throw new Error("the temp folder's path holds a reserved word");
}

describe.concurrent("reserved-test discovery in real Vitest runs", () => {
	let base = "";
	let checkout = "";
	let neutral = "";
	let serial = 0;

	beforeAll(() => {
		base = neutralTempDir();
		checkout = path.join(base, `checkout-${word}`);
		neutral = path.join(base, "neutral");
		syntheticCheckout(checkout);
		syntheticCheckout(neutral);
	});
	afterAll(() => rmSync(base, { recursive: true, force: true }));

	function instance(
		parent: string,
		name: string,
		config: string,
		files: Files,
		root: string = checkout,
	): Instance {
		const dir = path.join(root, parent, `${name}-${++serial}`);
		write(path.join(dir, "vitest.config.mjs"), config);
		const labels = new Map<string, string>();
		for (const [file, [label, text]] of Object.entries(files)) {
			write(path.join(dir, file), text);
			labels.set(key(path.join(dir, file)), label);
		}
		return { dir, labels };
	}

	async function spawnRun(
		args: readonly string[],
		cwd: string,
		env: NodeJS.ProcessEnv,
		known: readonly Instance[],
		reporters = true,
	): Promise<Outcome> {
		const report = path.join(base, `report-${++serial}.json`);
		const reporter = reporters
			? [
					...["--configLoader", "native", "--reporter=default", "--reporter=json"],
					`--outputFile.json=${report}`,
				]
			: ["--configLoader", "native"];
		const result = await capture(
			{ command: process.execPath, args: [...args, ...reporter] },
			{ cwd, env: { ...childEnv, NO_COLOR: "1", ...env } },
		);
		const ran: Record<string, string> = {};
		if (existsSync(report)) {
			const { testResults } = JSON.parse(readFileSync(report, "utf8")) as {
				testResults: { name: string; status: string }[];
			};
			for (const { name, status } of testResults) {
				const label = known.map((at) => at.labels.get(key(name))).find(Boolean);
				ran[label ?? "an unknown file"] = status;
			}
		}
		// Scrubbed: an assertion that prints the child's output names no reserved word.
		return { code: result.code, out: scrub(result.stdout), err: scrub(result.stderr), ran };
	}

	const vitest = (at: Instance, args: readonly string[], env: NodeJS.ProcessEnv = {}) =>
		spawnRun([vitestBin, "run", ...args], at.dir, env, [at]);
	// The child's whole output, unscrubbed; assertions on it print only booleans and scrubbed text.
	const rawRun = async (at: Instance, env: NodeJS.ProcessEnv) => {
		const result = await capture(
			{ command: process.execPath, args: [vitestBin, "run", "--configLoader", "native"] },
			{ cwd: at.dir, env: { ...childEnv, NO_COLOR: "1", ...env } },
		);
		return { code: result.code, text: `${result.stdout}\n${result.stderr}` };
	};
	const plain = () => instance("pkgs", "plain", sharedConfig, plainFiles);
	const only = () => instance("pkgs", `${word}-only`, sharedConfig, onlyFiles);
	const lib = `lib-${word}.ts`;

	it("carries every root module and the spike kit, and reaches Vitest through the node_modules link", ({
		expect,
	}) => {
		const roots = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".ts"));
		for (const dir of [checkout, neutral]) {
			expect(roots(dir)).toEqual(roots(repo));
			expect(existsSync(path.join(dir, "spikes", "kit", "off.ts"))).toBe(true);
			expect(realpathSync.native(path.join(dir, "node_modules", "vitest", "package.json"))).toBe(
				realpathSync.native(vitestManifest),
			);
		}
		expect([reservedWord.test(checkout), reservedWord.test(neutral)]).toEqual([true, false]);
	});

	it("fails a default run that imports a reserved module by a computed name, printing neither its name nor its path", async ({
		expect,
	}) => {
		const make = () =>
			instance(
				"pkgs",
				"computed",
				sharedConfig,
				{
					"b.test.ts": ["computed import", computedImport(`./${lib}`)],
					[lib]: ["library", marking("ran")],
				},
				neutral,
			);
		const [off, optIn] = [make(), make()];
		const [refused, loaded] = await Promise.all([rawRun(off, {}), rawRun(optIn, on)]);
		const target = path.join(off.dir, lib);
		const forms = [target, target.split(path.sep).join("/"), pathToFileURL(target).href];
		const text = refused.text.toLowerCase();
		expect(
			{
				code: refused.code,
				refused: refused.text.includes(LOADED_RESERVED),
				ran: existsSync(path.join(off.dir, "ran")),
				word: reservedWord.test(refused.text),
				path: forms.some((form) => text.includes(form.toLowerCase())),
			},
			scrub(refused.text),
		).toEqual({ code: 1, refused: true, ran: false, word: false, path: false });
		expect({
			code: loaded.code,
			refused: loaded.text.includes(LOADED_RESERVED),
			ran: existsSync(path.join(optIn.dir, "ran")),
		}).toEqual({ code: 0, refused: false, ran: true });
	}, 120_000);

	it("refuses a reserved module in a default run after an opted-in run filled the package's module cache", async ({
		expect,
	}) => {
		const at = instance(
			"pkgs",
			"cached",
			sharedConfig,
			{
				"b.test.ts": ["cached import", computedImport(`./${lib}`)],
				[lib]: ["library", marking("ran")],
			},
			neutral,
		);
		const marker = path.join(at.dir, "ran");
		const first = await rawRun(at, on);
		const ranFirst = existsSync(marker);
		rmSync(marker, { force: true });
		const second = await rawRun(at, {});
		expect(
			[
				first.code,
				ranFirst,
				second.code,
				second.text.includes(LOADED_RESERVED),
				existsSync(marker),
			],
			scrub(second.text),
		).toEqual([0, true, 1, true, false]);
		// The runs shared Vitest's module cache, as consecutive runs in a package do.
		expect(existsSync(path.join(at.dir, "node_modules", ".vitest-cache"))).toBe(true);
	}, 120_000);

	it("fails a default run that reaches a reserved module some other way, naming no path", async ({
		expect,
	}) => {
		const [setup, global] = [`x-${word}-setup.ts`, `x-${word}-global.ts`];
		const withSetup = (key: string, file: string): string =>
			`import { vitestConfig } from "../../vitest.shared.ts";\nexport default (env) => {\n\tconst base = vitestConfig(env);\n\treturn { ...base, test: { ...base.test, ${key}: ["./${file}"] } };\n};\n`;
		const globalSetup = `${marking("global-ran")}export default function setup() {}\n`;
		const make = () => [
			instance("pkgs", "setup", withSetup("setupFiles", setup), {
				"a.test.ts": ["setup unit", passing],
				[setup]: ["reserved setup", marking("setup-ran")],
			}),
			instance("pkgs", "global", withSetup("globalSetup", global), {
				"a.test.ts": ["global setup unit", passing],
				[global]: ["reserved global setup", globalSetup],
			}),
			instance("pkgs", "computed", sharedConfig, {
				"b.test.ts": ["computed import", computedImport(`./${lib}`)],
				[lib]: ["reserved library", marking("lib-ran")],
			}),
		];
		const markers = ["setup-ran", "global-ran", "lib-ran"];
		const outcome = async (env: NodeJS.ProcessEnv) => {
			const made = make();
			const results = await Promise.all(made.map((at) => vitest(at, [], env)));
			return results.map((result, index) => {
				const text = `${result.out}\n${result.err}`;
				const lines = text.split(/\r?\n/).filter((line) => line.includes(LOADED_RESERVED));
				return {
					code: result.code,
					ran: existsSync(path.join(made[index]?.dir ?? "", markers[index] ?? "")),
					refused: lines.length > 0,
					bare: lines.every((line) => /^\s*(?:Error: )?a default run loaded/.test(line)),
				};
			});
		};
		const refused = { code: 1, ran: false, refused: true, bare: true };
		expect(await outcome({})).toEqual([refused, refused, refused]);
		const loaded = { code: 0, ran: true, refused: false, bare: true };
		expect(await outcome(on)).toEqual([loaded, loaded, loaded]);
	}, 120_000);

	it("fails a default run that reaches a reserved module through an alias or a linked package's exports, naming no path", async ({
		expect,
	}) => {
		const aliased = `import { fileURLToPath } from "node:url";\nimport { vitestConfig } from "../../vitest.shared.ts";\nexport default (env) => {\n\tconst base = vitestConfig(env);\n\treturn { ...base, resolve: { alias: { "@neutral/lib": fileURLToPath(new URL("./${lib}", import.meta.url)) } } };\n};\n`;
		const importing = (specifier: string): string =>
			`import { it } from "vitest";\nit("imports", async () => {\n\tawait import("${specifier}");\n});\n`;
		// A package linked into node_modules, as pnpm links a workspace package, whose exports lead a
		// neutral subpath and a reserved one to a reserved module. Returns that module's path.
		const linked = (at: Instance): string => {
			const dep = path.join(neutral, "pkgs", `dep-${++serial}`);
			const exports = { "./sub": `./${lib}`, [`./${word}`]: `./${lib}` };
			write(
				path.join(dep, "package.json"),
				JSON.stringify({ name: "zz-dep", type: "module", exports }),
			);
			write(path.join(dep, lib), marking("ran"));
			mkdirSync(path.join(at.dir, "node_modules"));
			symlinkSync(dep, path.join(at.dir, "node_modules", "zz-dep"), "junction");
			return path.join(dep, lib);
		};
		const outcome = async (env: NodeJS.ProcessEnv) => {
			const alias = instance(
				"pkgs",
				"alias",
				aliased,
				{
					"b.test.ts": ["alias import", importing("@neutral/lib")],
					[lib]: ["aliased library", marking("ran")],
				},
				neutral,
			);
			const exported = instance(
				"pkgs",
				"exports",
				sharedConfig,
				{ "b.test.ts": ["exports import", importing("zz-dep/sub")] },
				neutral,
			);
			const subpath = instance(
				"pkgs",
				"subpath",
				sharedConfig,
				{ "b.test.ts": ["subpath import", computedImport(`zz-dep/${word}`)] },
				neutral,
			);
			const made = [
				[alias, path.join(alias.dir, lib)],
				[exported, linked(exported)],
				[subpath, linked(subpath)],
			] as const;
			return Promise.all(
				made.map(async ([at, target]) => {
					const result = await rawRun(at, env);
					const forms = [target, target.split(path.sep).join("/"), pathToFileURL(target).href];
					const text = result.text.toLowerCase();
					return {
						code: result.code,
						refused: result.text.includes(LOADED_RESERVED),
						ran: existsSync(path.join(path.dirname(target), "ran")),
						word: reservedWord.test(result.text),
						path: forms.some((form) => text.includes(form.toLowerCase())),
					};
				}),
			);
		};
		const refused = { code: 1, refused: true, ran: false, word: false, path: false };
		expect(await outcome({})).toEqual([refused, refused, refused]);
		const loaded = { code: 0, refused: false, ran: true, word: false, path: false };
		expect(await outcome(on)).toEqual([loaded, loaded, loaded]);
	}, 120_000);

	// Mutation cases: each of the shared config's controls removed from a copy of vitest.shared.ts,
	// in a checkout of its own, lets through the fixture that the cases around these refuse, so their
	// assertions fire without it.
	const mutatedCheckout = (changes: readonly (readonly [string, string])[]): string => {
		const dir = path.join(base, `mutated-${++serial}`);
		syntheticCheckout(dir);
		let text = readFileSync(path.join(repo, "vitest.shared.ts"), "utf8");
		for (const [from, to] of changes) {
			const parts = text.split(from);
			if (parts.length !== 2)
				throw new Error(`vitest.shared.ts must hold ${JSON.stringify(from)} once`);
			text = parts.join(to);
		}
		writeFileSync(path.join(dir, "vitest.shared.ts"), text);
		return dir;
	};

	it("runs a reserved unit fixture in a default run once the exclude is removed", async ({
		expect,
	}) => {
		const dir = mutatedCheckout([
			["exclude: optIn ? exclude : [...exclude, ...reservedGlobs],", "exclude,"],
			["config.exclude = withReserved(config.exclude);", ""],
		]);
		const files: Files = {
			"a.test.ts": ["ordinary unit", passing],
			[`x-${word}.test.ts`]: ["reserved unit", failing],
		};
		const result = await vitest(instance("pkgs", "unexcluded", sharedConfig, files, dir), []);
		expect(result.ran).toEqual({ "ordinary unit": "passed", "reserved unit": "failed" });
		expect(result.code).toBe(1);
	}, 120_000);

	it("runs a reserved-only package's unit tier in a default run once the turn-off is removed", async ({
		expect,
	}) => {
		const dir = mutatedCheckout([
			["if (off) config.include = [];", "if (false) config.include = [];"],
		]);
		const result = await vitest(instance("pkgs", `${word}-only`, sharedConfig, onlyFiles, dir), []);
		expect(result.ran).toEqual({ "reserved-only unit": "failed" });
		expect(result.code).toBe(1);
	}, 120_000);

	it("loads a reserved module in a default run once the load refusal is removed", async ({
		expect,
	}) => {
		const dir = mutatedCheckout([
			["if (!optIn && reservedModule(id)) throw new Error(LOADED_RESERVED);", ""],
		]);
		const at = instance(
			"pkgs",
			"computed",
			sharedConfig,
			{
				"b.test.ts": ["computed import", computedImport(`./${lib}`)],
				[lib]: ["library", marking("ran")],
			},
			dir,
		);
		const loaded = await rawRun(at, {});
		expect(
			{
				code: loaded.code,
				refused: loaded.text.includes(LOADED_RESERVED),
				ran: existsSync(path.join(at.dir, "ran")),
			},
			scrub(loaded.text),
		).toEqual({ code: 0, refused: false, ran: true });
	}, 120_000);

	it.for(tiers)("runs only the ordinary %s file by default", async (tier, { expect }) => {
		const result = await vitest(plain(), mode(tier));
		expect(result.ran).toEqual({ [`ordinary ${tier}`]: "passed" });
		expect(result.code).toBe(0);
	});

	const unitVariants = [
		"reserved upper-case file",
		"reserved mixed-case folder",
		"reserved underscore file",
		"reserved upper-case folder",
	];
	it.for(tiers)(
		"discovers the reserved %s fixtures with the flag, and they fail",
		async (tier, { expect }) => {
			const result = await vitest(plain(), mode(tier), on);
			const reserved = [`reserved ${tier}`, ...(tier === "unit" ? unitVariants : [])];
			expect(result.ran).toEqual({
				[`ordinary ${tier}`]: "passed",
				...Object.fromEntries(reserved.map((label) => [label, "failed"])),
			});
			expect(result.code).toBe(1);
		},
	);

	it("keeps reserved files out when a package config replaces test.exclude", async ({ expect }) => {
		const files: Files = {
			"a.test.ts": ["own-exclude ordinary", passing],
			[`x-${word}.test.ts`]: ["own-exclude reserved", failing],
			"fixtures/f.test.ts": ["own-exclude fixture", failing],
		};
		const at = () => instance("pkgs", "own-exclude", ownExclude, files);
		const [off, optIn] = await Promise.all([vitest(at(), []), vitest(at(), [], on)]);
		expect([off.code, off.ran]).toEqual([0, { "own-exclude ordinary": "passed" }]);
		expect([optIn.code, optIn.ran]).toEqual([
			1,
			{ "own-exclude ordinary": "passed", "own-exclude reserved": "failed" },
		]);
	});

	it("keeps reserved benchmark files out of vitest bench unless the flag is on", async ({
		expect,
	}) => {
		const files: Files = {
			"a.test.ts": ["bench package unit", passing],
			"a.bench.ts": ["ordinary bench", marking("ordinary-loaded")],
			[`x-${word}.bench.ts`]: ["reserved bench", marking("reserved-loaded")],
		};
		const run = async (env: NodeJS.ProcessEnv) => {
			const at = instance("pkgs", "bench", sharedConfig, files);
			const result = await spawnRun([vitestBin, "bench", "--run"], at.dir, env, [at], false);
			const loaded = ["ordinary-loaded", "reserved-loaded"].filter((name) =>
				existsSync(path.join(at.dir, name)),
			);
			return [result.ran, loaded];
		};
		expect(await run({})).toEqual([{}, ["ordinary-loaded"]]);
		expect(await run(on)).toEqual([{}, ["ordinary-loaded", "reserved-loaded"]]);
	});

	it.for(tiers)(
		"ends a reserved-only package's %s run with the fixed notice and exit 0",
		async (tier, { expect }) => {
			const result = await vitest(only(), mode(tier));
			expect(result.ran).toEqual({});
			expect(result.err).toContain(OFF_NOTICE);
			expect(result.code).toBe(0);
		},
	);

	it.for(["unit", "heavy"] as const)(
		"runs a reserved-only package's %s tier with the flag",
		async (tier, { expect }) => {
			const result = await vitest(only(), mode(tier), on);
			expect(result.ran).toEqual({ [`reserved-only ${tier}`]: "failed" });
			expect(result.err).not.toContain(OFF_NOTICE);
			expect(result.code).toBe(1);
		},
	);

	it("still fails an ordinary package without unit tests, with or without the flag", async ({
		expect,
	}) => {
		const files: Files = { "e.heavy.test.ts": ["empty-package heavy", passing] };
		const empty = () => instance("pkgs", "empty", sharedConfig, files);
		const results = await Promise.all([
			vitest(empty(), []),
			vitest(empty(), [], on),
			vitest(empty(), ["--mode", "live"]),
			vitest(empty(), ["--mode", "heavy"]),
		]);
		expect(results.map((result) => result.code)).toEqual([1, 1, 0, 0]);
		expect(results[0]?.err).toContain("No test files found, exiting with code 1");
		expect(results[3]?.ran).toEqual({ "empty-package heavy": "passed" });
	});

	it("keeps a reserved-only package off when --root or --dir points at it from elsewhere", async ({
		expect,
	}) => {
		const [from, target] = [plain(), only()];
		const results = await Promise.all([
			spawnRun([vitestBin, "run", "--root", target.dir], from.dir, {}, [from, target]),
			spawnRun([vitestBin, "run", "--dir", target.dir], from.dir, {}, [from, target]),
			spawnRun([vitestBin, "run", "--dir", target.dir], from.dir, on, [from, target]),
		]);
		expect(results.map((result) => [result.code, result.ran])).toEqual([
			[0, {}],
			[0, {}],
			[1, { "reserved-only unit": "failed" }],
		]);
	});

	it("refuses Vitest started in a folder that holds packages or a package's reserved tests, or through --root ..", async ({
		expect,
	}) => {
		const at = plain();
		// A package subfolder that holds reserved tests refuses runs too (the subfolder policy below).
		const nested = instance("pkgs", "nested", sharedConfig, {
			"a.test.ts": ["nested ordinary", passing],
			[`test/x-${word}.test.ts`]: ["nested reserved", failing],
			"test/vitest.config.ts": [
				"nested refusal",
				'// Refuses a Vitest run started here; see the root vitest.config.ts.\nexport { default } from "../../../vitest.config.ts";\n',
			],
		});
		const results = await Promise.all([
			spawnRun([vitestBin, "list", "--filesOnly"], path.dirname(at.dir), {}, [at], false),
			spawnRun([vitestBin, "run", "--root", ".."], at.dir, {}, [at]),
			spawnRun([vitestBin, "list", "--filesOnly"], checkout, {}, [at], false),
			spawnRun([vitestBin, "run"], path.join(nested.dir, "test"), {}, [nested]),
		]);
		for (const result of results) {
			expect([result.code, result.ran]).toEqual([1, {}]);
			expect(result.err).toContain("start Vitest only as pnpm --filter <package> exec vitest run");
			expect(result.out).not.toContain(".test.ts");
		}
		const own = await spawnRun([vitestBin, "list", "--filesOnly"], at.dir, {}, [at], false);
		expect(own.code).toBe(0);
		expect(own.out).toContain("a.test.ts");
	});

	it("fails every run whose config drops the plugin, naming the planted include", async ({
		expect,
	}) => {
		const config =
			'import { vitestConfig } from "../../vitest.shared.ts";\nexport default (env) => ({ ...vitestConfig(env), plugins: [] });\n';
		const files: Files = {
			"a.test.ts": ["dropped unit", passing],
			"a.heavy.test.ts": ["dropped heavy", passing],
		};
		const dropped = () => instance("pkgs", "dropped", config, files);
		const results = await Promise.all([
			vitest(dropped(), []),
			vitest(dropped(), ["--mode", "heavy"]),
		]);
		for (const result of results) {
			expect([result.code, result.ran]).toEqual([1, {}]);
			expect(result.err).toContain(PLUGIN_MISSING);
		}
	});

	it("refuses an ambiguous flag at config load and runs nothing", async ({ expect }) => {
		const result = await vitest(plain(), [], { [RESERVED_TESTS]: "yes" });
		expect([result.code, result.ran]).toEqual([1, {}]);
		expect(result.err).toContain(`${RESERVED_TESTS} must be unset (off)`);
	});

	it("prints no reserved word when a child fails on a path inside the checkout", async ({
		expect,
	}) => {
		// A config that fails to load, naming its own path (the checkout's folder holds a word).
		const config = 'import "./missing-module.ts";\nexport default {};\n';
		const at = instance("pkgs", "broken", config, { "a.test.ts": ["broken unit", passing] });
		const raw = await capture(
			{ command: process.execPath, args: [vitestBin, "run", "--configLoader", "native"] },
			{ cwd: at.dir, env: { ...childEnv, NO_COLOR: "1" } },
		);
		const result = await vitest(at, []);
		expect(result.code).toBe(1);
		expect(reservedWord.test(raw.stderr)).toBe(true);
		expect(reservedWord.test(`${result.out}\n${result.err}`)).toBe(false);
	});

	it("writes per-file counts, and no test names, when DRAFTYAK_TEST_COUNTS_DIR is set", async ({
		expect,
	}) => {
		const at = plain();
		const counts = mkdtempSync(path.join(base, "counts-"));
		const [off, optIn] = [path.join(counts, "off"), path.join(counts, "on")];
		await vitest(at, [], { DRAFTYAK_TEST_COUNTS_DIR: off });
		await vitest(at, [], { DRAFTYAK_TEST_COUNTS_DIR: optIn, ...on });
		const read = (dir: string): CountsReport[] =>
			readdirSync(dir).map((file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")));
		const label = (file: string) => at.labels.get(key(path.join(checkout, file))) ?? file;
		const summary = (report: CountsReport | undefined) => ({
			tier: report?.tier,
			optIn: report?.optIn,
			reason: report?.reason,
			root: report?.root === repoPath(at.dir, checkout),
			files: Object.fromEntries(
				(report?.files ?? []).map(({ file, ...rest }) => [label(file), rest]),
			),
		});
		const [offReports, onReports] = [read(off), read(optIn)];
		expect([offReports.length, onReports.length]).toEqual([1, 1]);
		const ordinary = { state: "passed", errors: 0, passed: 2, failed: 0, skipped: 1, todo: 1 };
		const reserved = { state: "failed", errors: 0, passed: 0, failed: 1, skipped: 0, todo: 0 };
		expect(summary(offReports[0])).toEqual({
			tier: "unit",
			optIn: false,
			reason: "passed",
			root: true,
			files: { "ordinary unit": ordinary },
		});
		const onSummary = summary(onReports[0]);
		expect(onSummary).toMatchObject({ tier: "unit", optIn: true, reason: "failed", root: true });
		expect(onSummary.files).toEqual({
			"ordinary unit": ordinary,
			"reserved unit": reserved,
			"reserved upper-case file": reserved,
			"reserved mixed-case folder": reserved,
			"reserved underscore file": reserved,
			"reserved upper-case folder": reserved,
		});
		const text = JSON.stringify(onReports);
		const titles = ["counts one", "counts two", "skips one", "todo one", "is collected"];
		expect(titles.filter((title) => text.includes(title))).toEqual([]);
	});

	it("writes one counts report per run, however often a config lists the plugin", async ({
		expect,
	}) => {
		const twice =
			'import { vitestConfig } from "../../vitest.shared.ts";\nexport default (env) => {\n\tconst base = vitestConfig(env);\n\treturn { ...base, plugins: [...base.plugins, ...base.plugins] };\n};\n';
		const at = instance("pkgs", "twice", twice, { "a.test.ts": ["twice unit", passing] });
		const counts = mkdtempSync(path.join(base, "counts-twice-"));
		const result = await vitest(at, [], { DRAFTYAK_TEST_COUNTS_DIR: counts });
		expect([result.code, result.ran]).toEqual([0, { "twice unit": "passed" }]);
		expect(readdirSync(counts)).toHaveLength(1);
	});

	it("ends a direct Vitest run in a reserved spike through the kit's off.ts alone, before the kit's factory loads", async ({
		expect,
	}) => {
		// A checkout whose kit factory throws on load: a config that reaches it fails to load.
		const broken = path.join(base, `broken-${word}`);
		syntheticCheckout(broken);
		write(path.join(broken, "spikes", "kit", "vitest.ts"), 'throw new Error("broken factory");\n');
		const spike = (name: string) => {
			const dir = path.join(broken, "spikes", `${name}-${++serial}`);
			write(path.join(dir, "vitest.config.ts"), offConfig);
			write(path.join(dir, "s.test.ts"), failing);
			return dir;
		};
		// Vitest itself, as `pnpm --filter <glob> exec vitest run` starts it: the default config loader.
		const vitestIn = (dir: string, env: NodeJS.ProcessEnv = {}) =>
			capture(
				{ command: process.execPath, args: [vitestBin, "run"] },
				{ cwd: dir, env: { ...childEnv, NO_COLOR: "1", ...env } },
			);
		const [reserved, ordinary] = [spike(`${word}-spike`), spike("plain")];
		const [off, optIn, plainRun] = await Promise.all([
			vitestIn(reserved),
			vitestIn(reserved, on),
			vitestIn(ordinary),
		]);
		expect([off.code, off.stderr.includes(OFF_NOTICE)]).toEqual([0, true]);
		expect(scrub(`${off.stdout}\n${off.stderr}`)).not.toContain("broken factory");
		// Opted in, or in an ordinary spike, the config loads the broken factory and fails.
		expect([optIn.code, scrub(optIn.stderr).includes("broken factory")]).toEqual([1, true]);
		expect([plainRun.code, scrub(plainRun.stderr).includes("broken factory")]).toEqual([1, true]);
	}, 120_000);
});

// Whether <dir>/vitest.config.ts refuses Vitest: the root's own refusal, or a re-export of it.
function refusesAt(root: string, dir: string): boolean {
	const file = path.join(root, dir, "vitest.config.ts");
	if (!existsSync(file)) return false;
	const text = readFileSync(file, "utf8");
	if (dir === "")
		return text.includes("start Vitest only as pnpm --filter <package> exec vitest run");
	const up = "../".repeat(dir.split("/").length);
	return text.includes(`export { default } from "${up}vitest.config.ts";`);
}

// Vitest reads a config only where it starts, so a package folder between a package's root and a
// reserved test file would run with Vitest's defaults: each ordinary one refuses runs instead.
function refusalFolders(tracked: readonly string[], packageDirs: readonly string[]): string[] {
	const folders = new Set<string>();
	for (const file of tracked) {
		if (testTier(file) === null || !reservedWord.test(file)) continue;
		const pkg = packageDirs
			.filter((dir) => file.startsWith(`${dir}/`))
			.toSorted((a, b) => b.length - a.length)[0];
		if (pkg === undefined || reservedWord.test(pkg)) continue;
		for (let dir = path.posix.dirname(file); dir !== pkg; dir = path.posix.dirname(dir)) {
			if (!reservedWord.test(dir)) folders.add(dir);
		}
	}
	return [...folders].toSorted();
}

describe("package Vitest configs", () => {
	const configNames = ["ts", "mts", "cts", "js", "mjs", "cjs"].map((ext) => `vitest.config.${ext}`);
	const shared = /\b(?:vitestConfig|spikeVitestConfig|heavyVitestConfig)\(/;
	// Tracked paths, names only.
	const tracked = async (): Promise<string[]> => {
		const listed = await capture({ command: "git", args: ["ls-files", "-z"] }, { cwd: repo });
		return listed.stdout.split("\0").filter(Boolean);
	};

	it("give every package with test files its own config, starting from a shared factory", async () => {
		const files = await tracked();
		// Reserved packages' configs are their maintainer's.
		const dirs = workspacePackageDirs(repo).filter((dir) => !reservedWord.test(dir));
		const tested = dirs.filter((dir) =>
			files.some((file) => file.startsWith(`${dir}/`) && testTier(file) !== null),
		);
		const missing = tested.filter(
			(dir) => !configNames.some((name) => existsSync(path.join(repo, dir, name))),
		);
		const loose = tested.flatMap((dir) =>
			configNames
				.filter((name) => existsSync(path.join(repo, dir, name)))
				.filter((name) => !shared.test(readFileSync(path.join(repo, dir, name), "utf8")))
				.map((name) => `${dir}/${name}`),
		);
		expect(tested.length).toBeGreaterThan(5);
		expect([missing, loose]).toEqual([[], []]);
	});

	it("refuse Vitest at the root and in each folder pnpm-workspace.yaml lists packages in, present yet or not", () => {
		// A branch that adds its first apps/ or plugins/ package then inherits the refusal.
		const parents = workspaceParents(repo);
		expect(parents.length).toBeGreaterThan(1);
		expect(refusesAt(repo, "")).toBe(true);
		same(
			parents.filter((dir) => !refusesAt(repo, dir)),
			[],
		);
	});

	it("refuse Vitest in each ordinary folder between a package and a reserved test file it holds", async () => {
		const needed = refusalFolders(await tracked(), workspacePackageDirs(repo));
		same(
			needed.filter((dir) => !refusesAt(repo, dir)),
			[],
		);
	});

	it("names the folders a reserved test file in an ordinary package needs refusing", () => {
		const files = [
			"pkgs/p/package.json",
			"pkgs/p/a.test.ts",
			`pkgs/p/x-${word}.test.ts`,
			`pkgs/p/test/x-${word}.test.ts`,
			`pkgs/p/test/deep/y-${word}.heavy.test.ts`,
			`pkgs/p/test/${word}/inner/z.test.ts`,
			`pkgs/p/test/x-${word}-helper.ts`,
			`pkgs/${word}-only/package.json`,
			`pkgs/${word}-only/test/a.test.ts`,
		];
		const dirs = ["pkgs/p", `pkgs/${word}-only`];
		same(refusalFolders(files, dirs), ["pkgs/p/test", "pkgs/p/test/deep"]);
	});

	it("spell reserved words in lower case in every tracked path, as biome.json's negations do", async () => {
		// A count only: the paths are reserved.
		expect((await tracked()).filter((file) => !lowerCaseReserved(file)).length).toBe(0);
		const biome = JSON.parse(readFileSync(path.join(repo, "biome.json"), "utf8")) as {
			files: { includes: string[] };
		};
		same(
			biomeNegations.filter((glob) => !biome.files.includes.includes(glob)),
			[],
		);
	});
});

describe("Vitest at the repository root", () => {
	it("refuses to run there, where every package and tier would mix", async () => {
		const result = await capture(
			{ command: process.execPath, args: [vitestBin, "list", "--filesOnly"] },
			{ cwd: repo, env: { ...childEnv, NO_COLOR: "1" } },
		);
		expect(result.code).toBe(1);
		expect(scrub(result.stderr)).toContain(
			"start Vitest only as pnpm --filter <package> exec vitest run",
		);
		// A length only: a root run would list reserved files.
		expect(result.stdout.length).toBe(0);
	}, 120_000);
});
