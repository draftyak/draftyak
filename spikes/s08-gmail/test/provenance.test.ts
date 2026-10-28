import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StatusRunner } from "../../kit/provenance.ts";
import { GmailProvenance, provenanceFor } from "./provenance.ts";

// Every filesystem/Git operation below is confined to a newly created synthetic root.
const owned = new Set<string>();
function scratch(): string {
	const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "draftyak-s8-provenance-")));
	owned.add(root);
	return root;
}
afterEach(() => {
	for (const root of owned) {
		if (
			path.dirname(root) !== realpathSync.native(os.tmpdir()) ||
			!path.basename(root).startsWith("draftyak-s8-provenance-") ||
			realpathSync.native(root) !== root
		)
			throw new Error("synthetic cleanup root mismatch");
		rmSync(root, { recursive: true });
		if (existsSync(root)) throw new Error("synthetic cleanup incomplete");
		owned.delete(root);
	}
});

function repository() {
	const root = scratch();
	const repo = path.join(root, "repo");
	const spike = path.join(repo, "spikes/s08-gmail");
	const home = path.join(root, "home");
	const temp = path.join(root, "tmp");
	const hooks = path.join(root, "hooks");
	const template = path.join(root, "template");
	for (const dir of [spike, home, temp, hooks, template]) mkdirSync(dir, { recursive: true });
	const config = path.join(home, "gitconfig");
	writeFileSync(
		config,
		"[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[commit]\n\tgpgsign = false\n[maintenance]\n\tauto = false\n",
	);
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "",
		...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: home,
		TEMP: temp,
		TMP: temp,
		GIT_CONFIG_GLOBAL: config,
		GIT_CONFIG_SYSTEM: config,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: "0",
		GIT_TEMPLATE_DIR: template,
		GIT_TERMINAL_PROMPT: "0",
	};
	const git = (args: readonly string[], cwd = repo) => {
		if (cwd !== repo && cwd !== spike) throw new Error("synthetic Git cwd mismatch");
		const result = spawnSync(
			"git",
			[
				"-c",
				`core.hooksPath=${hooks}`,
				"-c",
				"core.fsmonitor=false",
				"-c",
				"maintenance.auto=false",
				"-c",
				"commit.gpgsign=false",
				...args,
			],
			{
				cwd,
				env,
				encoding: "utf8",
				shell: false,
				windowsHide: true,
				timeout: 5_000,
				maxBuffer: 65_536,
			},
		);
		if (result.error || result.signal !== null)
			throw new Error("synthetic Git did not complete normally");
		return { code: result.status ?? -1, stdout: result.stdout };
	};
	const must = (...args: string[]): void => {
		if (git(args).code !== 0) throw new Error("synthetic Git setup failed");
	};
	const write = (relative: string, text = "synthetic\n"): string => {
		const file = path.resolve(repo, relative);
		if (!file.startsWith(`${repo}${path.sep}`)) throw new Error("synthetic write escaped root");
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
		return file;
	};
	must("init", "-q", `--template=${template}`);
	for (const file of [
		"README.md",
		"spikes/s08-gmail/test/input.ts",
		"spikes/synthetic-sibling/input.ts",
		"spikes/s08-gmail/evidence/tracked.json",
	])
		write(file);
	write(".gitignore", "ignored.tmp\n");
	must("add", "-A");
	must("commit", "-qm", "synthetic fixture");
	// Reinstate only this fixture's controlled config/home after adapter sanitation. No inherited
	// Git override or arbitrary adapter environment is forwarded to a real child.
	const run: StatusRunner = (args, options) => git(args, options.cwd);
	return { root, repo, spike, write, run, provenance: new GmailProvenance(spike, run, {}) };
}

describe("S8 provenance adapter", () => {
	it.each([
		["a".repeat(40), "a".repeat(40)],
		["b".repeat(64), "b".repeat(64)],
		["A".repeat(40), null],
		["a".repeat(39), null],
		["", null],
	] as const)("keeps the verified HEAD grammar for %s", (head, expected) => {
		const run: StatusRunner = (args) => ({
			code: 0,
			stdout: args[0] === "rev-parse" ? `${head}\n` : "",
		});
		expect(new GmailProvenance("invented", run, {}).codeState()).toEqual({
			commit: expected,
			dirty: false,
		});
	});

	it("does not call Git on construction and removes every case variant of inherited GIT_", () => {
		const seen: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
		const run: StatusRunner = (args, options) => {
			seen.push({ args, env: options.env });
			return { code: 0, stdout: args[0] === "rev-parse" ? "a".repeat(40) : "" };
		};
		const provenance = new GmailProvenance("invented", run, {
			GIT_DIR: "invented",
			gIt_Config_Global: "invented",
			git_EXEC_PATH: "invented",
			KEEP: "synthetic",
		});
		expect(seen).toEqual([]);
		expect(provenance.codeState()).toEqual({ commit: "a".repeat(40), dirty: false });
		expect(seen.map(({ args }) => args)).toEqual([
			["rev-parse", "HEAD"],
			["status", "--porcelain", "--untracked-files=all", "--", ":/"],
		]);
		for (const entry of seen) expect(entry.env).toEqual({ KEEP: "synthetic" });
	});

	it.each(["nonzero", "throw"] as const)(
		"retains unavailable status for %s even if a fingerprint says clean",
		async (failure) => {
			const run: StatusRunner = (args) => {
				if (args[0] === "rev-parse") return { code: 0, stdout: "a".repeat(40) };
				if (failure === "throw") throw new Error("synthetic status failure");
				return { code: 1, stdout: "" };
			};
			const provenance = new GmailProvenance("invented", run, {});
			expect(provenance.codeState()).toEqual({ commit: "a".repeat(40), dirty: null });
			expect(
				await provenance.fingerprint(async () => ({
					dirty: false,
					commit: "a".repeat(40),
					marker: 7,
				})),
			).toEqual({ dirty: null, commit: "a".repeat(40), marker: 7 });
		},
	);

	it.each(["nonzero", "throw"] as const)(
		"cannot supply a commit after a %s HEAD lookup",
		(failure) => {
			const run: StatusRunner = (args) => {
				if (args[0] !== "rev-parse") return { code: 0, stdout: "" };
				if (failure === "throw") throw new Error("synthetic HEAD failure");
				return { code: 1, stdout: "a".repeat(40) };
			};
			expect(new GmailProvenance("invented", run, {}).codeState()).toEqual({
				commit: null,
				dirty: false,
			});
		},
	);

	it("returns the same lazy tracker for a normalized directory", () => {
		const root = scratch();
		expect(provenanceFor(path.join(root, "spike"))).toBe(
			provenanceFor(path.join(root, "spike/test/..")),
		);
	});

	it("keeps differently cased resolved spellings on separate trackers", () => {
		const parent = path.resolve("synthetic-gmail-provenance-case-key");
		const upper = path.join(parent, "Repo");
		const lower = path.join(parent, "repo");
		expect(upper).not.toBe(lower);
		const upperTracker = provenanceFor(upper);
		const lowerTracker = provenanceFor(lower);
		expect(upperTracker).not.toBe(lowerTracker);
		expect(provenanceFor(upper)).toBe(upperTracker);
		expect(provenanceFor(lower)).toBe(lowerTracker);
		expect(provenanceFor(path.join(upper, "test", ".."))).toBe(upperTracker);
		expect(provenanceFor(path.join(lower, "test", ".."))).toBe(lowerTracker);
	});

	it.each([
		"README.md",
		"spikes/synthetic-sibling/input.ts",
		"spikes/s08-gmail/test/input.ts",
		"untracked.ts",
		"spikes/synthetic-sibling/untracked.ts",
		"spikes/s08-gmail/untracked.ts",
		"spikes/s08-gmail/evidence/foreign.json",
		"spikes/s08-gmail/evidence/input.ts",
		"spikes/s08-gmail/evidence/tracked.json",
	])("counts changed input %s from the S8 cwd", (file) => {
		const fixture = repository();
		expect(fixture.provenance.codeState().dirty).toBe(false);
		fixture.write(file, "changed synthetic input\n");
		expect(fixture.provenance.codeState().dirty).toBe(true);
	});

	it("keeps ignored files ignored", () => {
		const fixture = repository();
		fixture.write("ignored.tmp");
		expect(fixture.provenance.codeState().dirty).toBe(false);
	});

	it("owns only the successful exact output on the same tracker", async () => {
		const fixture = repository();
		const output = path.join(fixture.spike, "evidence/live.json");
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const operation = fixture.provenance.write(output, async () => {
			fixture.write("spikes/s08-gmail/evidence/live.json", "{}\n");
			await held;
			return output;
		});
		try {
			expect(fixture.provenance.codeState().dirty).toBe(true);
		} finally {
			release();
			await operation;
		}
		expect(fixture.provenance.codeState().dirty).toBe(false);
		expect(await fixture.provenance.fingerprint(async () => ({ dirty: true, marker: 7 }))).toEqual({
			dirty: false,
			marker: 7,
		});
		expect(new GmailProvenance(fixture.spike, fixture.run, {}).codeState().dirty).toBe(true);
		fixture.write("spikes/s08-gmail/evidence/sibling.json", "{}\n");
		expect(fixture.provenance.codeState().dirty).toBe(true);
	});

	it.each(["reject", "null", "different", "directory"] as const)(
		"does not own a %s writer outcome",
		async (outcome) => {
			const fixture = repository();
			const output = path.join(fixture.spike, "evidence/live.json");
			const operation = fixture.provenance.write(output, async () => {
				if (outcome === "directory") {
					mkdirSync(output, { recursive: true });
					writeFileSync(path.join(output, "child.txt"), "synthetic\n");
				} else fixture.write("spikes/s08-gmail/evidence/live.json", "synthetic partial\n");
				if (outcome === "reject") throw new Error("synthetic writer rejection");
				return outcome === "null" ? null : outcome === "different" ? `${output}.other` : output;
			});
			if (outcome === "null") expect(await operation).toBeNull();
			else
				await expect(operation).rejects.toThrow(
					outcome === "reject"
						? "synthetic writer rejection"
						: outcome === "different"
							? "writer returned a different output"
							: "written output must remain a regular file",
				);
			expect(fixture.provenance.codeState().dirty).toBe(true);
			if (outcome !== "directory") expect(readFileSync(output, "utf8")).toBe("synthetic partial\n");
		},
	);

	it.each(["changed", "replaced", "deleted"] as const)(
		"keeps a %s owned output dirty",
		async (change) => {
			const fixture = repository();
			const output = path.join(fixture.spike, "evidence/live.json");
			await fixture.provenance.write(output, async () =>
				fixture.write("spikes/s08-gmail/evidence/live.json", "{}\n"),
			);
			expect(fixture.provenance.codeState().dirty).toBe(false);
			if (change === "changed") writeFileSync(output, '{"changed":true}\n');
			if (change === "replaced") {
				const replacement = fixture.write("spikes/s08-gmail/evidence/replacement.json", "{}\n");
				renameSync(replacement, output);
			}
			if (change === "deleted") rmSync(output);
			expect(fixture.provenance.codeState().dirty).toBe(true);
		},
	);
});

describe("the literal S8 caller binding", () => {
	const section = (source: string, start: string, end: string): string => {
		const first = source.indexOf(start);
		const last = source.indexOf(end, first + start.length);
		if (first < 0 || first !== source.lastIndexOf(start) || last < 0)
			throw new Error("source section mismatch");
		return source.slice(first, last);
	};
	it("shares report fingerprint/write ownership and never registers a preview", () => {
		const source = readFileSync(new URL("./live-session.ts", import.meta.url), "utf8");
		const report = section(source, "async function reportStep(", "\nconst RUNNERS:");
		expect(report).toContain("const provenance = provenanceFor(session.repoDir);");
		expect(report).toContain("const shown = await provenance.fingerprint(() =>");
		expect(report).toContain("cwd: session.repoDir,");
		expect(report).toContain("const recorded = session.record && problems.length === 0;");
		expect(report).toContain(
			'const dir = recorded ? session.evidenceDir : path.join(session.dir, "evidence");',
		);
		expect(report).toContain('const target = path.join(dir, "live.json");');
		expect(report).toContain(
			"const write = () => writeEvidence(target, report.data, { fingerprint: shown });",
		);
		expect(report).toContain(
			"const file = recorded ? await provenance.write(target, write) : await write();",
		);
		expect(report).not.toMatch(/\?\?|new (?:Gmail|Evidence)Provenance/);
		expect(report).toMatch(/`evidence not recorded \(\$\{why\}\); preview: \$\{file\}`/);
	});

	it("retains step schema and independent revocation/current/prior-step clean gates", () => {
		const source = readFileSync(new URL("./live-session.ts", import.meta.url), "utf8");
		const save = section(source, "export function saveStep(", "\nexport interface SessionInput");
		expect(save).toContain(
			"const record: StepRecord = { at: new Date().toISOString(), ...codeState(session.repoDir), data };",
		);
		expect(save).toContain(
			"writeJson(stateFile(session.dir), { ...state, steps: { ...state.steps, [step]: record } });",
		);
		const clean = section(
			source,
			"export function recordProblems(",
			"\nasync function reportStep(",
		);
		expect(clean).toContain('if (acceptance.revoked !== "yes")');
		expect(clean).toContain("if (print.commit === null || print.dirty !== false)");
		expect(clean).toContain("record.commit !== print.commit || record.dirty !== false");
		expect(source).toContain('import { codeState, provenanceFor } from "./provenance.ts";');
		expect(source).not.toContain("--untracked-files=no");
		expect(source).not.toContain(":(exclude)evidence");
	});
});
