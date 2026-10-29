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
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capture } from "./spawn.ts";
import {
	approvedWorkspace,
	listedWorktrees,
	namedFiles,
	namedWorktreeFiles,
	type ReadDirectory,
	type StatPath,
} from "./workspace-policy.ts";

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

const entry = (name: string, directory = false) => ({
	name,
	isDirectory: () => directory,
	isSymbolicLink: () => false,
});
const kind = (directory: boolean, link = false) => ({
	isDirectory: () => directory,
	isSymbolicLink: () => link,
});
const failure = (code?: string): Error =>
	Object.assign(new Error("synthetic failure"), code === undefined ? {} : { code });
const sentinel = [entry(".gate-sentinel")];

type Listing = Awaited<ReturnType<ReadDirectory>>;
type Kind = Awaited<ReturnType<StatPath>>;

// Synthetic folders by relative path. The nth listing or lstat of a folder gets its nth outcome,
// the last one repeating; a folder without outcomes is empty and still a physical directory.
function synthetic(
	listings: Readonly<Record<string, readonly (Listing | Error)[]>>,
	stats: Readonly<Record<string, readonly (Kind | Error)[]>> = {},
) {
	const root = path.resolve("synthetic");
	const listed: string[] = [];
	const statted: string[] = [];
	const answer = <T>(
		calls: string[],
		outcomes: Readonly<Record<string, readonly (T | Error)[]>>,
		target: string,
		fallback: T,
	): T => {
		const dir = path.relative(root, target).split(path.sep).join("/");
		const queued = outcomes[dir] ?? [];
		const seen = calls.filter((call) => call === dir).length;
		calls.push(dir);
		const result = queued[Math.min(seen, queued.length - 1)] ?? fallback;
		if (result instanceof Error) throw result;
		return result;
	};
	const run = (): Promise<string[]> =>
		namedFiles(
			".gate-sentinel",
			root,
			false,
			async (dir) => answer(listed, listings, dir, []),
			async (target) => answer(statted, stats, target, kind(true)),
		);
	return { listed, statted, run };
}

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
		const root = path.resolve("synthetic");
		expect(
			await namedFiles(".gate-sentinel", root, false, async (dir) =>
				dir === root
					? [entry("near.gate-sentinel"), entry("a\nb", true)]
					: [entry(".gate-sentinel")],
			),
		).toEqual(["a\nb/.gate-sentinel"]);
	});

	it.each(["trailing", "forward"] as const)(
		"stops disappearance proof at a %s-spelled root",
		async (spelling) => {
			const root = path.resolve("synthetic-boundary");
			const input = spelling === "trailing" ? `${root}${path.sep}` : root.replaceAll("\\", "/");
			let rootReads = 0;
			let aboveRootReads = 0;
			await expect(
				namedFiles(
					".gate-sentinel",
					input,
					false,
					async (target) => {
						const absolute = path.resolve(target);
						if (absolute === root && rootReads++ === 0) return [entry("nested", true)];
						if (absolute === path.dirname(root)) {
							aboveRootReads++;
							return [];
						}
						throw failure("ENOENT");
					},
					async () => {
						throw failure("ENOENT");
					},
				),
			).rejects.toThrow("file-name inventory failed");
			expect(aboveRootReads).toBe(0);
		},
	);

	it.each(["relative", "trailing", "forward"] as const)(
		"preserves relative results and confirmed nested removal with a %s root",
		async (spelling) => {
			const root = path.resolve("synthetic-boundary");
			const input =
				spelling === "relative"
					? path.relative(process.cwd(), root)
					: spelling === "trailing"
						? `${root}${path.sep}`
						: root.replaceAll("\\", "/");
			let rootReads = 0;
			const found = await namedFiles(
				".gate-sentinel",
				input,
				false,
				async (target) => {
					expect(path.isAbsolute(target)).toBe(true);
					if (target === root)
						return rootReads++ === 0
							? [entry("gone", true), entry("kept", true)]
							: [entry("kept", true)];
					if (target === path.join(root, "kept")) return sentinel;
					throw failure("ENOENT");
				},
				async () => {
					throw failure("ENOENT");
				},
			);
			expect(found).toEqual(["kept/.gate-sentinel"]);
			expect(rootReads).toBe(2);
		},
	);

	it.each(["", "nested"])("fails closed if directory listing '%s' fails", async (failing) => {
		const root = path.resolve("synthetic");
		await expect(
			namedFiles(
				".gate-sentinel",
				root,
				false,
				async (dir) => {
					if (dir === path.join(root, failing)) throw new Error("synthetic refusal");
					return [{ name: "nested", isDirectory: () => true, isSymbolicLink: () => false }];
				},
				async () => kind(true),
			),
		).rejects.toThrow("file-name inventory failed");
	});

	it.each(["ENOENT", "ENOTDIR"])(
		"skips a folder that vanished during the walk (%s) and still walks its siblings",
		async (code) => {
			const fs = synthetic(
				{
					"": [[entry("gone", true), entry("kept", true)], [entry("kept", true)]],
					gone: [failure(code)],
					kept: [[entry("deeper", true)]],
					"kept/deeper": [sentinel],
				},
				{ gone: [failure(code)] },
			);
			expect(await fs.run()).toEqual(["kept/deeper/.gate-sentinel"]);
			expect(fs.listed.toSorted()).toEqual(["", "", "gone", "kept", "kept/deeper"]);
			expect(fs.statted).toEqual(["gone"]);
		},
	);

	it("lists a folder again after a transient failure", async () => {
		const fs = synthetic({ "": [[entry("busy", true)]], busy: [failure("EPERM"), sentinel] });
		expect(await fs.run()).toEqual(["busy/.gate-sentinel"]);
		expect(fs.listed).toEqual(["", "busy", "busy"]);
		expect(fs.statted).toEqual(["busy", "busy"]);
	});

	it.each([
		{ name: "a link", replacement: kind(true, true) },
		{ name: "a file", replacement: kind(false) },
		{ name: "unreadable metadata", replacement: failure("EACCES") },
		{ name: "a still-listed missing lookup", replacement: failure("ENOENT") },
	])("refuses a successful retry that changes the folder to $name", async ({ replacement }) => {
		const root = path.resolve("synthetic");
		let childReads = 0;
		let stats = 0;
		await expect(
			namedFiles(
				".gate-sentinel",
				root,
				false,
				async (target) => {
					if (target === root) return [entry("nested", true)];
					childReads++;
					if (childReads === 1) throw failure("EPERM");
					return sentinel;
				},
				async () => {
					stats++;
					const observed = childReads < 2 ? kind(true) : replacement;
					if (observed instanceof Error) throw observed;
					return observed;
				},
			),
		).rejects.toThrow("file-name inventory failed");
		expect(childReads).toBe(2);
		expect(stats).toBe(2);
	});

	it("skips a folder removed after its successful retry only with fresh parent proof", async () => {
		const fs = synthetic(
			{ "": [[entry("gone", true)], []], gone: [failure("EPERM"), sentinel] },
			{ gone: [kind(true), failure("ENOENT")] },
		);
		expect(await fs.run()).toEqual([]);
		expect(fs.listed).toEqual(["", "gone", "gone", ""]);
	});

	it("skips a folder that lstat reports gone after its retry fails", async () => {
		const fs = synthetic(
			{
				"": [[entry("pending", true), entry("kept", true)], [entry("kept", true)]],
				pending: [failure("EPERM"), failure("ENOENT")],
				kept: [sentinel],
			},
			{ pending: [failure("EPERM"), failure("ENOENT")] },
		);
		expect(await fs.run()).toEqual(["kept/.gate-sentinel"]);
		expect(fs.statted).toEqual(["pending", "pending"]);
	});

	it("fails closed if a folder that is still there fails its retry", async () => {
		const fs = synthetic({
			"": [[entry("locked", true), entry("kept", true)]],
			locked: [failure("EPERM")],
			kept: [sentinel],
		});
		await expect(fs.run()).rejects.toThrow("file-name inventory failed");
		expect(fs.listed.filter((dir) => dir === "locked")).toHaveLength(2);
		expect(fs.statted).toEqual(["locked", "locked"]);
	});

	it.each([
		["EACCES", failure("EACCES")],
		["EPERM", failure("EPERM")],
		["an error without a code", failure()],
	])("fails closed if lstat of a failed folder fails with %s", async (_name, error) => {
		const fs = synthetic({ "": [[entry("hidden", true)]], hidden: [error] }, { hidden: [error] });
		await expect(fs.run()).rejects.toThrow("file-name inventory failed");
		expect(fs.statted).toEqual(["hidden", "hidden"]);
	});

	it.each([
		["a link", kind(true, true)],
		["a file", kind(false)],
	])("fails closed without listing again once a failed folder is %s", async (_name, now) => {
		const fs = synthetic(
			{ "": [[entry("swapped", true)]], swapped: [failure("EPERM"), sentinel] },
			{ swapped: [now] },
		);
		await expect(fs.run()).rejects.toThrow("file-name inventory failed");
		expect(fs.listed).toEqual(["", "swapped"]);
	});

	it.each(["ENOENT", "EACCES"])(
		"fails closed if the root cannot be listed (%s), even if lstat reports it gone",
		async (code) => {
			const fs = synthetic({ "": [failure(code)] }, { "": [failure("ENOENT")] });
			await expect(fs.run()).rejects.toThrow("file-name inventory failed");
			expect(fs.listed).toEqual([""]);
		},
	);

	it("skips a folder removed from a real directory during the walk", async () => {
		const dir = await repository();
		const removed = path.join(dir, "removed");
		mkdirSync(path.join(removed, "deep"), { recursive: true });
		writeFileSync(path.join(removed, "deep", ".gate-sentinel"), "synthetic removed");
		mkdirSync(path.join(dir, "kept"));
		writeFileSync(path.join(dir, "kept", ".gate-sentinel"), "synthetic kept");
		const found = await namedFiles(".gate-sentinel", dir, false, async (target) => {
			if (target === removed) rmSync(removed, { recursive: true, force: true, maxRetries: 5 });
			return readdir(target, { withFileTypes: true });
		});
		expect(found).toEqual(["kept/.gate-sentinel"]);
		expect(existsSync(removed)).toBe(false);
	});

	it.runIf(process.platform !== "win32")(
		"fails closed for an actual non-UTF-8 directory name",
		async () => {
			const dir = await repository();
			const name = Buffer.concat([Buffer.from(`${dir}${path.sep}`), Buffer.from([0xff])]);
			mkdirSync(name);
			try {
				await expect(inventory(dir)).rejects.toThrow("file-name inventory failed");
			} finally {
				rmSync(name, { recursive: true, force: true });
			}
		},
	);

	it.each(["trailing.", "lone-\ud800", "invalid-\uFFFD"])(
		"does not mistake a still-listed non-round-tripping name %j for a removed folder",
		async (name) => {
			const fs = synthetic(
				{ "": [[entry(name, true)]], [name]: [failure("ENOENT")] },
				{ [name]: [failure("ENOENT")] },
			);
			await expect(fs.run()).rejects.toThrow("file-name inventory failed");
			expect(fs.listed.filter((dir) => dir === "")).toHaveLength(3);
		},
	);

	it.each([
		{ name: "duplicate names", entries: [entry("alias", true), entry("alias", true)] },
		{ name: "lossy UTF-8", entries: [entry("other-\uFFFD", true)] },
		{ name: "lone surrogate", entries: [entry("other-\ud800", true)] },
	])("refuses ambiguous parent evidence with $name", async ({ entries }) => {
		const fs = synthetic(
			{ "": [[entry("gone", true)], entries], gone: [failure("ENOENT")] },
			{ gone: [failure("ENOENT")] },
		);
		await expect(fs.run()).rejects.toThrow("file-name inventory failed");
	});

	it("refuses missing-child claims when its parent listing is unreadable", async () => {
		const fs = synthetic(
			{ "": [[entry("gone", true)], failure("EACCES")], gone: [failure("ENOENT")] },
			{ gone: [failure("ENOENT")] },
		);
		await expect(fs.run()).rejects.toThrow("file-name inventory failed");
	});

	it("confirms a removed parent from its own parent instead of trusting failed lookups", async () => {
		const fs = synthetic(
			{
				"": [[entry("parent", true), entry("kept", true)], [entry("kept", true)]],
				parent: [[entry("child", true)], failure("ENOENT")],
				"parent/child": [failure("ENOENT")],
				kept: [sentinel],
			},
			{ parent: [failure("ENOENT")], "parent/child": [failure("ENOENT")] },
		);
		expect(await fs.run()).toEqual(["kept/.gate-sentinel"]);
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
			await namedFiles(
				".gate-sentinel",
				root,
				false,
				async (dir) => {
					if (dir !== root) throw new Error("link target must not be listed");
					return [{ name: "link", isDirectory: () => true, isSymbolicLink: () => true }];
				},
				async () => kind(true, true),
			),
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

describe("registered worktree inventory", () => {
	const root = path.resolve("synthetic-worktree");
	const main = path.resolve("synthetic-main");
	const parent = path.dirname(root);
	const registered = (directory = root, prunable = false) => ({ directory, prunable });
	const missingRead: ReadDirectory = async (directory) => {
		if (directory === parent) return [entry(path.basename(main), true)];
		throw failure("ENOENT");
	};
	const missingStat: StatPath = async () => {
		throw failure("ENOENT");
	};

	it("parses exact NUL-delimited paths and explicit prunable records", () => {
		const spaced = `${root} with space\nand newline `;
		expect(
			listedWorktrees(
				`worktree ${main}\0HEAD abc\0branch refs/heads/main\0\0worktree ${spaced}\0prunable missing root\0\0`,
			),
		).toEqual([registered(main), registered(spaced, true)]);
		for (const text of [
			"",
			`worktree ${root}\n`,
			`worktree ${root}\0worktree ${main}\0\0`,
			`worktree ${root}\0prunable\0prunable again\0\0`,
			"worktree relative\0\0",
			`worktree ${root}\uFFFD\0\0`,
		]) {
			expect(() => listedWorktrees(text)).toThrow("file-name inventory failed");
		}
	});

	it("keeps a readable registered root without refreshing Git", async () => {
		let queries = 0;
		expect(
			await namedWorktreeFiles(
				".gate-sentinel",
				root,
				async () => {
					queries++;
					return [registered()];
				},
				false,
				async () => sentinel,
				async () => kind(true),
			),
		).toEqual([".gate-sentinel"]);
		expect(queries).toBe(0);
	});

	it.each(["absent", "prunable"] as const)(
		"skips a confirmed removed root only when fresh Git says %s",
		async (state) => {
			let queries = 0;
			expect(
				await namedWorktreeFiles(
					".gate-sentinel",
					root,
					async () => {
						queries++;
						return state === "absent"
							? [registered(main)]
							: [registered(main), registered(root, true)];
					},
					false,
					missingRead,
					missingStat,
				),
			).toEqual([]);
			expect(queries).toBe(1);
		},
	);

	it.each(["present", "unreadable-list", "empty-list", "ambiguous-list"] as const)(
		"refuses a missing root with %s fresh registration evidence",
		async (state) => {
			await expect(
				namedWorktreeFiles(
					".gate-sentinel",
					root,
					async () => {
						if (state === "unreadable-list") throw failure("EACCES");
						if (state === "empty-list") return [];
						if (state === "ambiguous-list") return [registered(), registered(root, true)];
						return [registered(main), registered()];
					},
					false,
					missingRead,
					missingStat,
				),
			).rejects.toThrow("file-name inventory failed");
		},
	);

	it.each(["ENOENT", "EACCES", "EPERM"])(
		"refuses unreadable or still-listed roots despite %s lookups without asking Git",
		async (code) => {
			let queries = 0;
			await expect(
				namedWorktreeFiles(
					".gate-sentinel",
					root,
					async () => {
						queries++;
						return [registered(main)];
					},
					false,
					async (directory) => {
						if (directory === parent) return [entry(path.basename(root), true)];
						throw failure(code);
					},
					async () => {
						if (code === "ENOENT") throw failure(code);
						return kind(true);
					},
				),
			).rejects.toThrow("file-name inventory failed");
			expect(queries).toBe(0);
		},
	);

	it("rechecks root existence after its successful final listing before admitting removal", async () => {
		let queries = 0;
		expect(
			await namedWorktreeFiles(
				".gate-sentinel",
				root,
				async () => {
					queries++;
					return [registered(main)];
				},
				false,
				async (directory) => (directory === root ? sentinel : missingRead(directory)),
				missingStat,
			),
		).toEqual([]);
		expect(queries).toBe(1);
	});

	it("skips an actual linked worktree removed after enumeration and confirms it with Git", async () => {
		const dir = await repository();
		expect((await git(dir, ["config", "user.name", "Nick Savov"])).code).toBe(0);
		expect((await git(dir, ["config", "user.email", "nicksavov@protonmail.com"])).code).toBe(0);
		writeFileSync(path.join(dir, "anchor.txt"), "synthetic anchor");
		expect((await git(dir, ["add", "--", "anchor.txt"])).code).toBe(0);
		expect(
			(await git(dir, ["commit", "--quiet", "-m", "test: anchor temporary worktree"])).code,
		).toBe(0);
		const linked = path.join(dir, "linked");
		expect((await git(dir, ["worktree", "add", "--quiet", "--detach", linked])).code).toBe(0);
		const list = async () => {
			const result = await git(dir, ["worktree", "list", "--porcelain", "-z"]);
			expect(result.code).toBe(0);
			return listedWorktrees(result.stdout);
		};
		const linkedIdentity = realpathSync.native(linked);
		expect(
			(await list()).some(({ directory }) => realpathSync.native(directory) === linkedIdentity),
		).toBe(true);
		let queries = 0;
		expect(
			await namedWorktreeFiles(
				".gate-sentinel",
				linked,
				async () => {
					queries++;
					return list();
				},
				false,
				async (target) => {
					if (target === linked)
						expect((await git(dir, ["worktree", "remove", "--force", linked])).code).toBe(0);
					return readdir(target, { withFileTypes: true });
				},
			),
		).toEqual([]);
		expect(queries).toBe(1);
		expect(existsSync(linked)).toBe(false);
	});
});
