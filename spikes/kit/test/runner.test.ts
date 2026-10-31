import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { withoutReservedTests } from "../../../reserved-tests.ts";
import { GATE_ROOT_ENV } from "../../../tools/verify/lib/bootstrap.ts";
import {
	markedPackages,
	TYPECHECK_MARKS as PROOF_MARKS,
	readMarks,
} from "../../../tools/verify/lib/proof.ts";
import { exec } from "../exec.ts";
import { gitEnv, kitDir, repoRoot } from "../repo.ts";
import { TYPECHECK_MARKS, writeTypecheckMark } from "../runner.ts";

const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-kit-marks-")));
afterAll(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
let folders = 0;
const fresh = (name: string): string => {
	const dir = path.join(base, `${name}-${++folders}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};

describe("typecheck marks", () => {
	it("are the folder variable the reserved proof sets", () => {
		expect(TYPECHECK_MARKS).toBe(PROOF_MARKS);
	});

	it("go one per call into a new file, in the shape the proof reads", () => {
		const dir = fresh("direct");
		writeTypecheckMark(dir, "spikes/a", 0);
		writeTypecheckMark(dir, "spikes/a", 2);
		const files = readdirSync(dir);
		expect(files).toHaveLength(2);
		expect(files.every((file) => /^[0-9a-f-]{36}\.json$/.test(file))).toBe(true);
		const marks = files.map((file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")));
		expect(marks.toSorted((a, b) => a.code - b.code)).toStrictEqual([
			{ version: 1, package: "spikes/a", code: 0 },
			{ version: 1, package: "spikes/a", code: 2 },
		]);
		expect(readMarks(dir)).toEqual({ marks: expect.arrayContaining(marks), unreadable: 0 });
		expect(() => writeTypecheckMark(path.join(dir, "missing"), "spikes/a", 0)).toThrow();
	});
});

// The kit in a checkout of its own, with a package whose typescript is a fake tsc that exits
// with FAKE_TSC_EXIT. Mutations change the copy of runner.ts.
describe("run.ts --typecheck with DRAFTYAK_TYPECHECK_MARKS", () => {
	const env = Object.fromEntries(
		Object.entries({ ...process.env, ...withoutReservedTests(process.env) }).filter(
			([name]) => name.toUpperCase() !== TYPECHECK_MARKS,
		),
	);

	function mutated(source: string, from: string, to: string): string {
		const parts = source.split(from);
		if (parts.length !== 2) throw new Error(`runner.ts must hold ${JSON.stringify(from)} once`);
		return parts.join(to);
	}

	function checkout(change: (source: string) => string = (source) => source) {
		const repo = fresh("repo");
		const put = (rel: string, text: string): void => {
			mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
			writeFileSync(path.join(repo, rel), text);
		};
		const copy = (rel: string): void => put(rel, readFileSync(path.join(repoRoot, rel), "utf8"));
		put("package.json", JSON.stringify({ private: true, type: "module" }));
		for (const file of ["reserved-tests.ts", "tools/verify/lib/bootstrap.ts"]) copy(file);
		for (const file of ["off.ts", "run.ts", "repo.ts", "exec.ts"]) copy(`spikes/kit/${file}`);
		put("spikes/kit/runner.ts", change(readFileSync(path.join(kitDir, "runner.ts"), "utf8")));
		// The fake tsc, as typescript's package.json names it; it leaves a file when it runs.
		const typescript = "spikes/probe/node_modules/typescript";
		put(
			`${typescript}/package.json`,
			JSON.stringify({ name: "typescript", bin: { tsc: "bin/tsc" } }),
		);
		put(
			`${typescript}/bin/tsc`,
			[
				'const { writeFileSync } = require("node:fs");',
				'writeFileSync(require("node:path").join(process.cwd(), "tsc-ran"), "");',
				'process.exitCode = Number(process.env.FAKE_TSC_EXIT ?? "0");',
			].join("\n"),
		);
		put("spikes/probe/tsconfig.json", "{}\n");
		// The kit's start checks need git to list its helpers; the copy runs as under a gated launcher.
		const init = spawnSync("git", ["init", "-q"], { cwd: repo, env: gitEnv(), windowsHide: true });
		if (init.status !== 0) throw new Error("git init failed in the kit's copy");
		const probe = path.join(repo, "spikes", "probe");
		const typecheck = async (extra: NodeJS.ProcessEnv, cwd = probe) => {
			rmSync(path.join(cwd, "tsc-ran"), { force: true });
			const script = path.join(repo, "spikes", "kit", "run.ts");
			const result = await exec(process.execPath, [script, "--typecheck"], {
				cwd,
				env: { ...env, [GATE_ROOT_ENV]: repo, ...extra },
				timeoutMs: 60_000,
			});
			return {
				code: result.code,
				ran: existsSync(path.join(cwd, "tsc-ran")),
				stderr: result.stderr,
			};
		};
		return { repo, typecheck };
	}

	it("writes one mark per tsc run, for exit 0 and for a failure, and none without the variable", async () => {
		const { typecheck } = checkout();
		const marks = fresh("marks");
		const passed = await typecheck({ [TYPECHECK_MARKS]: marks, FAKE_TSC_EXIT: "0" });
		expect([passed.code, passed.ran]).toEqual([0, true]);
		expect(readMarks(marks)).toEqual({
			marks: [{ version: 1, package: "spikes/probe", code: 0 }],
			unreadable: 0,
		});
		expect(markedPackages(["spikes/probe"], readMarks(marks))).toEqual(["spikes/probe"]);

		const failing = fresh("marks");
		const failed = await typecheck({ [TYPECHECK_MARKS]: failing, FAKE_TSC_EXIT: "3" });
		expect([failed.code, failed.ran]).toEqual([3, true]);
		expect(readMarks(failing).marks).toEqual([{ version: 1, package: "spikes/probe", code: 3 }]);
		expect(markedPackages(["spikes/probe"], readMarks(failing))).toEqual([]);

		const unset = await typecheck({ FAKE_TSC_EXIT: "0" });
		expect([unset.code, unset.ran]).toEqual([0, true]);
		expect([readdirSync(marks).length, readdirSync(failing).length]).toEqual([1, 1]);
	});

	it("exits 2 when the mark can't be written, and stops before tsc for a folder it can't mark", async () => {
		const { repo, typecheck } = checkout();
		const missing = path.join(base, "no-such-folder");
		const lost = await typecheck({ [TYPECHECK_MARKS]: missing, FAKE_TSC_EXIT: "0" });
		expect([lost.code, lost.ran]).toEqual([2, true]);
		expect(lost.stderr).toContain("run: the typecheck mark wasn't written (ENOENT)");
		expect(existsSync(missing)).toBe(false);

		const relative = await typecheck({ [TYPECHECK_MARKS]: "marks", FAKE_TSC_EXIT: "0" });
		expect([relative.code, relative.ran]).toEqual([2, false]);
		expect(relative.stderr).toContain(`${TYPECHECK_MARKS} must be an absolute folder`);

		// The repository root is no package of its own.
		rootTsconfig(repo);
		const root = await typecheck({ [TYPECHECK_MARKS]: fresh("marks"), FAKE_TSC_EXIT: "0" }, repo);
		expect([root.code, root.ran]).toEqual([2, false]);
		expect(root.stderr).toContain("needs a package folder below the repository root");
	});

	// Mutation case: the proof counts no package of a kit that doesn't write its marks.
	it("leaves the proof's markedPackages at 0 when the writer is disabled", async () => {
		const { typecheck } = checkout((source) =>
			mutated(source, "writeTypecheckMark(marks.dir, marks.pkg, exit);", "void marks;"),
		);
		const marks = fresh("marks");
		const result = await typecheck({ [TYPECHECK_MARKS]: marks, FAKE_TSC_EXIT: "0" });
		expect([result.code, result.ran]).toEqual([0, true]);
		expect(markedPackages(["spikes/probe"], readMarks(marks))).toHaveLength(0);
	});
});

// A tsconfig.json at the root, for the root case above.
function rootTsconfig(repo: string): void {
	writeFileSync(path.join(repo, "tsconfig.json"), "{}\n");
}
