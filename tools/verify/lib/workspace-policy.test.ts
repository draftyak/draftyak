import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capture } from "./spawn.ts";
import { approvedWorkspace, namedFiles } from "./workspace-policy.ts";

const approved = `packages:
  - apps/*
  - packages/*
  - plugins/*
  - spikes/*
  - tools/*

minimumReleaseAge: 1440
minimumReleaseAgeExclude: []
allowBuilds: {}
engineStrict: true
savePrefix: ''
verifyDepsBeforeRun: error
`;

describe("complete workspace grammar", () => {
	it("accepts the approved configuration with comments, blank lines, BOM and CRLF", () => {
		expect(approvedWorkspace(approved)).toBe(true);
		expect(approvedWorkspace(`${approved}# comment\n`)).toBe(true);
		expect(approvedWorkspace(`\uFEFF# workspace\r\n${approved.replaceAll("\n", "\r\n")}\r\n`)).toBe(
			true,
		);
	});

	it.each(["\n", "\r\n"])("accepts SP/TAB spacing with line ending %j", (newline) => {
		const spaced = `\t# workspace\n \t\n${approved
			.split("\n")
			.map((line) => `${line} \t`)
			.join("\n")}\n \t# end\n`.replaceAll("\n", newline);
		for (const bom of ["", "\uFEFF"]) expect(approvedWorkspace(`${bom}${spaced}`)).toBe(true);
	});

	const nonYamlWhitespace = [
		["VT", "\u000B"],
		["FF", "\u000C"],
		["NEL", "\u0085"],
		["NBSP", "\u00A0"],
		["OGHAM", "\u1680"],
		["EN QUAD", "\u2000"],
		["FIGURE SPACE", "\u2007"],
		["LINE SEPARATOR", "\u2028"],
		["PARAGRAPH SEPARATOR", "\u2029"],
		["NARROW NBSP", "\u202F"],
		["MEDIUM MATHEMATICAL SPACE", "\u205F"],
		["IDEOGRAPHIC SPACE", "\u3000"],
		["BOM", "\uFEFF"],
	] as const;
	it.each(
		["engineStrict: true", "minimumReleaseAge: 1440", "verifyDepsBeforeRun: error"].flatMap(
			(line) => nonYamlWhitespace.map(([name, suffix]) => ({ line, name, suffix })),
		),
	)("refuses $name after the required value $line", ({ line, suffix }) => {
		expect(approvedWorkspace(approved.replace(`${line}\n`, `${line}${suffix}\n`))).toBe(false);
	});
	it.each(nonYamlWhitespace)("refuses non-YAML blank lines: %s", (_name, space) => {
		expect(approvedWorkspace(`${approved}${space}\n`)).toBe(false);
	});
	it.each(nonYamlWhitespace)("refuses non-YAML comment indentation: %s", (_name, space) => {
		expect(approvedWorkspace(`${approved}${space}# comment\n`)).toBe(false);
	});
	it.each(
		["\u00A0", "\uFEFF"].flatMap((prefix) =>
			["\u0085", "\u2028", "\u2029"].map((lineBreak) => ({ prefix, lineBreak })),
		),
	)("refuses comment-like text that YAML reads as an extra key %#", ({ prefix, lineBreak }) => {
		expect(
			approvedWorkspace(`${approved}${prefix}# comment${lineBreak}blockExoticSubdeps: false\n`),
		).toBe(false);
	});

	it.each([
		"# comment\rblockExoticSubdeps: false\n",
		"# comment\r",
		"# comment\rtrustPolicy: off\r\n",
	])("refuses standalone carriage returns before discarding comments: %j", (extra) => {
		expect(approvedWorkspace(`${approved}${extra}`)).toBe(false);
	});

	it.each(["", "\n\t\n", "# workspace\n"])("refuses an empty configuration: %j", (text) => {
		expect(approvedWorkspace(text)).toBe(false);
	});

	const required = approved.split("\n").filter((line) => line.trim() !== "");
	it.each(required.slice(0, -1).map((_, i) => i + 1))(
		"refuses a truncated approved prefix of %i lines",
		(length) => {
			expect(approvedWorkspace(`${required.slice(0, length).join("\n")}\n`)).toBe(false);
		},
	);

	it.each(required)("refuses a missing required line: %s", (line) => {
		expect(approvedWorkspace(approved.replace(`${line}\n`, ""))).toBe(false);
	});

	it.each([
		'"blockExoticSubdeps": false',
		"'blockExoticSubdeps': false",
		"strictDepBuilds : false",
		"strictDepBuilds: false",
		"minimumReleaseAge: 0",
		"allowBuilds: { compromised: true }",
		"allowBuilds: {}",
		"trustPolicy: off",
		"dangerouslyAllowAllBuilds: true",
		"onlyBuiltDependencies: [compromised]",
		"ignoredBuiltDependencies: [compromised]",
		"minimumReleaseAgeExclude: [compromised]",
		"packages: [outside/*]",
		"---\nstrictDepBuilds: false",
		"extra: &builds { allowBuilds: { compromised: true } }",
	])("refuses additional or duplicate YAML configuration: %s", (extra) => {
		expect(approvedWorkspace(`${approved}${extra}\n`)).toBe(false);
	});

	it.each([
		["minimumReleaseAge: 1440", "minimumReleaseAge: 0"],
		["allowBuilds: {}", "allowBuilds:\n  compromised: true"],
		["engineStrict: true", "engineStrict: false"],
		["savePrefix: ''", "savePrefix: '^'"],
		["verifyDepsBeforeRun: error", "verifyDepsBeforeRun: false"],
		["  - tools/*", "  - elsewhere/*"],
	])("refuses changes to an approved value: %s", (before, after) => {
		expect(approvedWorkspace(approved.replace(before, after))).toBe(false);
	});
});

const roots: string[] = [];
afterEach(() => {
	for (const dir of roots.splice(0)) {
		const resolved = realpathSync(dir);
		const parent = realpathSync(os.tmpdir());
		if (
			path.dirname(resolved) !== parent ||
			!path.basename(resolved).startsWith("dy-workspace-policy-")
		) {
			throw new Error("temporary directory boundary changed");
		}
		rmSync(resolved, { recursive: true, force: true });
	}
});

// Temporary Git commands must never inherit the invoking repository, including Windows key casing.
function gitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([name]) => !/^GIT_/i.test(name)));
}

function git(dir: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
	return capture({ command: "git", args }, { cwd: dir, env: gitEnvironment(env) });
}

async function repository(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dy-workspace-policy-"));
	roots.push(dir);
	expect((await git(dir, ["init", "--quiet"], env)).code).toBe(0);
	writeFileSync(path.join(dir, ".gitignore"), "cache/\n");
	return dir;
}

const inventory = (dir: string, insensitive?: boolean): Promise<string[]> =>
	namedFiles(".gate-sentinel", dir, insensitive);

describe("temporary Git isolation", () => {
	it("strips every reported local variable in every casing and preserves unrelated environment", async () => {
		const dir = await repository();
		const local = await git(dir, ["rev-parse", "--local-env-vars"]);
		expect(local.code).toBe(0);
		const names = local.stdout.trim().split(/\r?\n/);
		expect(names).toContain("GIT_DIR");
		const inherited: NodeJS.ProcessEnv = { DY_SYNTHETIC_CONTROL: "retained" };
		for (const name of [...names, "GIT_NAMESPACE"]) {
			for (const key of [name, name.toLowerCase(), name.toLowerCase().replace(/^git_/, "Git_")]) {
				inherited[key] = "synthetic";
			}
		}
		expect(gitEnvironment(inherited)).toEqual({ DY_SYNTHETIC_CONTROL: "retained" });
	});

	it.each(["uppercase", "mixed-case"])(
		"initializes and stages only the intended synthetic repository under %s Git variables",
		async (casing) => {
			const outer = await repository();
			writeFileSync(path.join(outer, "anchor.txt"), "synthetic outer anchor");
			writeFileSync(path.join(outer, ".gate-sentinel"), "synthetic outer sentinel");
			expect((await git(outer, ["add", "--", "anchor.txt"])).code).toBe(0);
			const index = path.join(outer, ".git", "index");
			const before = readFileSync(index);
			const inherited = gitEnvironment();
			for (const [name, value] of Object.entries({
				GIT_DIR: path.join(outer, ".git"),
				GIT_WORK_TREE: outer,
				GIT_INDEX_FILE: index,
			})) {
				const key = casing === "uppercase" ? name : name.toLowerCase().replace(/^git_/, "Git_");
				inherited[key] = value;
			}
			const inner = await repository(inherited);
			expect(
				existsSync(path.join(inner, ".git")),
				"temporary init must create its own repository",
			).toBe(true);
			writeFileSync(path.join(inner, ".gate-sentinel"), "synthetic inner sentinel");
			expect((await git(inner, ["add", "--", ".gate-sentinel"], inherited)).code).toBe(0);
			expect(
				readFileSync(index),
				"the other synthetic index must stay byte-for-byte unchanged",
			).toEqual(before);
			expect((await git(outer, ["ls-files"])).stdout).toBe("anchor.txt\n");
			expect((await git(inner, ["ls-files"])).stdout).toBe(".gate-sentinel\n");
			const clean = gitEnvironment(inherited);
			const positive = await git(inner, ["rev-parse", "--show-toplevel"], clean);
			expect(positive.code).toBe(0);
			expect(realpathSync.native(positive.stdout.trim())).toBe(realpathSync.native(inner));
		},
	);
});

describe("basename inventory", () => {
	it("finds untracked, tracked and deeply ignored files without reading their contents", async () => {
		const dir = await repository();
		writeFileSync(path.join(dir, ".gate-sentinel"), "synthetic root");
		mkdirSync(path.join(dir, "cache", "deep", "nested"), { recursive: true });
		writeFileSync(path.join(dir, "cache", "deep", "nested", ".gate-sentinel"), "synthetic ignored");
		writeFileSync(path.join(dir, "cache", "not-the-basename.txt"), "ordinary ignored file");
		expect(await inventory(dir)).toEqual([".gate-sentinel", "cache/deep/nested/.gate-sentinel"]);
		expect((await git(dir, ["add", "--", ".gate-sentinel"])).code).toBe(0);
		expect(await inventory(dir)).toEqual([".gate-sentinel", "cache/deep/nested/.gate-sentinel"]);
	});

	it("finds force-added ignored files once and preserves paths containing spaces", async () => {
		const dir = await repository();
		mkdirSync(path.join(dir, "cache", "with spaces"), { recursive: true });
		writeFileSync(path.join(dir, "cache", "with spaces", ".gate-sentinel"), "synthetic");
		expect((await git(dir, ["add", "-f", "--", "cache/with spaces/.gate-sentinel"])).code).toBe(0);
		expect(await inventory(dir)).toEqual(["cache/with spaces/.gate-sentinel"]);
	});

	it("finds matching files inside nested repositories", async () => {
		const dir = await repository();
		for (const nested of ["nested", "cache/nested"]) {
			const cwd = path.join(dir, nested);
			mkdirSync(cwd, { recursive: true });
			expect((await git(cwd, ["init", "--quiet"])).code).toBe(0);
			writeFileSync(path.join(cwd, ".gate-sentinel"), "synthetic nested");
		}
		expect(await inventory(dir)).toEqual(["cache/nested/.gate-sentinel", "nested/.gate-sentinel"]);
	});

	it("uses case-insensitive basenames for a case-insensitive filesystem", async () => {
		const dir = await repository();
		writeFileSync(path.join(dir, ".GATE-SENTINEL"), "synthetic");
		expect(await inventory(dir, true)).toEqual([".GATE-SENTINEL"]);
	});

	it("does not confuse nonmatching basenames or paths containing newlines", async () => {
		const entry = (name: string, directory = false) => ({
			name,
			isDirectory: () => directory,
			isSymbolicLink: () => false,
		});
		const root = path.resolve("synthetic");
		expect(
			await namedFiles(".gate-sentinel", root, false, async (dir) =>
				dir === root
					? [entry("near.gate-sentinel"), entry("a\nb", true)]
					: [entry(".gate-sentinel")],
			),
		).toEqual(["a\nb/.gate-sentinel"]);
	});

	it.each(["", "nested"])("fails closed if directory listing '%s' fails", async (failure) => {
		const root = path.resolve("synthetic");
		await expect(
			namedFiles(".gate-sentinel", root, false, async (dir) => {
				if (dir === path.join(root, failure)) throw new Error("synthetic refusal");
				return [{ name: "nested", isDirectory: () => true, isSymbolicLink: () => false }];
			}),
		).rejects.toThrow("file-name inventory failed");
	});

	it("does not follow directory links outside the worktree or into a cycle", async () => {
		const dir = await repository();
		const outside = await repository();
		writeFileSync(path.join(outside, ".gate-sentinel"), "synthetic outside");
		symlinkSync(outside, path.join(dir, "outside"), "junction");
		symlinkSync(dir, path.join(dir, "cycle"), "junction");
		symlinkSync(outside, path.join(dir, ".gate-sentinel"), "junction");
		expect(await inventory(dir)).toEqual([".gate-sentinel"]);
	});

	it("does not traverse links even if their metadata reports a directory", async () => {
		const root = path.resolve("synthetic");
		expect(
			await namedFiles(".gate-sentinel", root, false, async (dir) => {
				if (dir !== root) throw new Error("link target must not be listed");
				return [{ name: "link", isDirectory: () => true, isSymbolicLink: () => true }];
			}),
		).toEqual([]);
	});

	it("lists every level with bounded directory concurrency", async () => {
		const root = path.resolve("synthetic");
		let active = 0;
		let peak = 0;
		const found = await namedFiles(".gate-sentinel", root, false, async (dir) => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			active -= 1;
			if (dir !== root)
				return [{ name: ".gate-sentinel", isDirectory: () => false, isSymbolicLink: () => false }];
			return Array.from({ length: 17 }, (_, i) => ({
				name: `child${i}`,
				isDirectory: () => true,
				isSymbolicLink: () => false,
			}));
		});
		expect(found).toHaveLength(17);
		expect(peak).toBe(4);
	});

	it.each(["", "nested/file", "nested\\file", "*", "?", "[a]", "a\0b"])(
		"refuses a basename that could broaden the inventory: %s",
		async (basename) => {
			await expect(
				namedFiles(basename, "synthetic", false, async () => {
					throw new Error("listing must not run");
				}),
			).rejects.toThrow("invalid basename");
		},
	);
});
