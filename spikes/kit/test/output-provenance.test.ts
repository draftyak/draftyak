import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { EvidenceProvenance, evidenceStatusArgs, type StatusRunner } from "../provenance.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		if (
			path.dirname(root) !== path.resolve(tmpdir()) ||
			!path.basename(root).startsWith("dy-prov-")
		) {
			throw new Error("unexpected fixture cleanup target");
		}
		rmSync(root, { recursive: true, force: true });
	}
});

function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), "dy-prov-"));
	roots.push(root);
	const repo = path.join(root, "repo");
	const spike = path.join(repo, "spike");
	mkdirSync(path.join(spike, "evidence"), { recursive: true });
	const config = path.join(root, "gitconfig");
	writeFileSync(config, "[maintenance]\n\tauto = false\n");
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
		GIT_CONFIG_GLOBAL: config,
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const init = spawnSync("git", ["-c", "init.templateDir=", "init", "-q", repo], {
		env,
		encoding: "utf8",
		windowsHide: true,
	});
	if (init.status !== 0) throw new Error("synthetic repository initialization failed");
	let status = "";
	const run: StatusRunner = (args, options) => {
		const result = spawnSync("git", ["-c", "maintenance.auto=false", ...args], {
			...options,
			encoding: "utf8",
			windowsHide: true,
			timeout: 5_000,
		});
		if (result.error) throw new Error("synthetic status did not complete");
		status = result.stdout;
		return { code: result.status ?? -1, stdout: result.stdout };
	};
	return {
		spike,
		write(file: string, text = "{}\n") {
			const target = path.resolve(repo, file);
			if (!target.startsWith(`${repo}${path.sep}`)) throw new Error("fixture path escaped");
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, text);
			return target;
		},
		output: (name = "own.json") => path.join(spike, "evidence", name),
		tracker: (runner: StatusRunner = run) => new EvidenceProvenance(spike, runner, env),
		status: () => status,
	};
}

it.each(["src/new.ts", "test/new.test.ts", "fixtures/input.json", "spike/evidence/input.ts"])(
	"counts an untracked repository input: %s",
	(file) => {
		const f = fixture();
		const p = f.tracker();
		expect(p.dirty()).toBe(false);
		f.write(file);
		expect(p.dirty()).toBe(true);
	},
);

it("exempts only its successful exact output and retains foreign JSON siblings", async () => {
	const f = fixture();
	const p = f.tracker();
	await p.write(f.output(), async () => f.write("spike/evidence/own.json"));
	expect(p.dirty()).toBe(false);
	f.write("spike/evidence/foreign.json");
	expect(p.dirty()).toBe(true);
	expect(f.status()).toContain("foreign.json");
});

it("keeps bracketed output names literal rather than hiding a glob sibling", async () => {
	const f = fixture();
	const p = f.tracker();
	await p.write(f.output("run[1].json"), async () => f.write("spike/evidence/run[1].json"));
	expect(p.dirty()).toBe(false);
	f.write("spike/evidence/run1.json");
	expect(p.dirty()).toBe(true);
	expect(f.status()).toContain("run1.json");
	expect(f.status()).not.toContain("run[1].json");
});

it.each(["changed", "replaced", "directory", "deleted"] as const)(
	"keeps a previously owned output dirty when %s",
	async (change) => {
		const f = fixture();
		const p = f.tracker();
		const file = f.output();
		await p.write(file, async () => f.write("spike/evidence/own.json"));
		expect(p.dirty()).toBe(false);
		if (change === "changed") writeFileSync(file, "[]\n");
		else if (change === "replaced") {
			renameSync(file, path.join(f.spike, "..", "..", "old"));
			f.write("spike/evidence/own.json", "{}\n");
		} else {
			rmSync(file);
			if (change === "directory") mkdirSync(file);
		}
		expect(p.dirty()).toBe(true);
	},
);

it("does not acquire another instance's output ownership", async () => {
	const f = fixture();
	await f.tracker().write(f.output(), async () => f.write("spike/evidence/own.json"));
	expect(f.tracker().dirty()).toBe(true);
});

it("registers only after a successful write completes and can register its replacement", async () => {
	const f = fixture();
	const p = f.tracker();
	let finish: (() => void) | undefined;
	const pending = p.write(f.output(), async () => {
		f.write("spike/evidence/own.json");
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		return f.output();
	});
	expect(p.dirty()).toBe(true);
	finish?.();
	await pending;
	expect(p.dirty()).toBe(false);
	await p.write(f.output(), async () => f.write("spike/evidence/own.json", "[]\n"));
	expect(p.dirty()).toBe(false);
});

it("does not register a null or rejected write", async () => {
	const f = fixture();
	const p = f.tracker();
	f.write("spike/evidence/own.json");
	expect(await p.write(f.output(), async () => null)).toBeNull();
	expect(p.dirty()).toBe(true);
	await expect(
		p.write(f.output(), async () => {
			throw new Error("synthetic write failure");
		}),
	).rejects.toThrow("synthetic write failure");
	expect(p.dirty()).toBe(true);
});

it("refuses a different returned output without registering either path", async () => {
	const f = fixture();
	const p = f.tracker();
	f.write("spike/evidence/own.json");
	await expect(
		p.write(f.output(), async () => f.write("spike/evidence/foreign.json")),
	).rejects.toThrow("different output");
	rmSync(f.output("foreign.json"));
	expect(p.dirty()).toBe(true);
});

it.each(["outside", "non-json", "directory"])("refuses an invalid %s output", async (kind) => {
	const f = fixture();
	const p = f.tracker();
	const file =
		kind === "outside"
			? path.join(f.spike, "..", "evidence", "out.json")
			: f.output(kind === "non-json" ? "out.ts" : "directory.json");
	let called = false;
	await expect(
		p.write(file, async () => {
			called = true;
			mkdirSync(file);
			return file;
		}),
	).rejects.toThrow(kind === "directory" ? "regular file" : "generated output");
	expect(called).toBe(kind === "directory");
});

it("preserves status uncertainty instead of an earlier clean fingerprint", async () => {
	const f = fixture();
	const p = f.tracker(() => ({ code: 1, stdout: "" }));
	expect(p.dirty()).toBeNull();
	expect(await p.fingerprint(async () => ({ commit: "a".repeat(40), dirty: false }))).toEqual({
		commit: "a".repeat(40),
		dirty: null,
	});
	expect(
		f
			.tracker(() => {
				throw new Error("synthetic unavailable");
			})
			.dirty(),
	).toBeNull();
});

it("keeps a positively changed output dirty even when status fails", async () => {
	const f = fixture();
	const p = f.tracker(() => ({ code: 1, stdout: "" }));
	await p.write(f.output(), async () => f.write("spike/evidence/own.json"));
	rmSync(f.output());
	expect(p.dirty()).toBe(true);
});

it("passes exact root-wide arguments and strips inherited Git overrides case-insensitively", () => {
	const f = fixture();
	let seen = false;
	const run: StatusRunner = (args, options) => {
		seen = true;
		expect(args).toEqual(["status", "--porcelain", "--untracked-files=all", "--", ":/"]);
		expect(Object.keys(options.env).filter((key) => /^git_/i.test(key))).toEqual([]);
		expect(options.env.PATH).toBe("synthetic-path");
		return { code: 0, stdout: "" };
	};
	const p = new EvidenceProvenance(f.spike, run, {
		PATH: "synthetic-path",
		Git_Dir: "synthetic-dir",
		git_work_tree: "synthetic-tree",
		GIT_LITERAL_PATHSPECS: "1",
		git_glob_pathspecs: "1",
		GIT_NOGLOB_PATHSPECS: "1",
		GIT_ICASE_PATHSPECS: "1",
		GIT_CONFIG_COUNT: "1",
		GIT_INDEX_FILE: "synthetic-index",
	});
	expect(p.dirty()).toBe(false);
	expect(seen).toBe(true);
});

it("preserves the exact JSON exclusion grammar and public binding", () => {
	const f = fixture();
	expect(evidenceStatusArgs(f.spike, [f.output("a[1].json")]).at(-1)).toBe(
		":(exclude,literal)evidence/a[1].json",
	);
	expect(() => evidenceStatusArgs(f.spike, [path.join(f.spike, "other", "a.json")])).toThrow(
		"exact evidence",
	);
	const source = readFileSync(new URL("../evidence.ts", import.meta.url), "utf8");
	expect(source).toContain('export { evidenceStatusArgs } from "./provenance.ts"');
});
