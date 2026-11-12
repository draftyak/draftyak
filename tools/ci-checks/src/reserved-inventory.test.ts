import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { reservedWord } from "../../../reserved-tests.ts";
import { sourceCopies } from "../test/source-copies.ts";
import { type TempRepo, tempRepo } from "../test/temp-repo.ts";
import {
	changedPaths,
	describeChange,
	INVENTORY,
	loosened,
	maintainers,
	unaccounted,
} from "./reserved-inventory.ts";

// Synthetic rows; the reserved word appears only in fixture names, never in titles or messages.
const word = ["si", "wc"].join("");
const inventory = (files: object[]): string => JSON.stringify({ about: "synthetic", files });
const testFile = (file: string): string => `pkgs/${word}-only/test/${file}`;
const row = (file: string, minPassed: number, more: object = {}) => ({
	file: testFile(file),
	tier: "unit",
	minPassed,
	...more,
});
const base = inventory([row("a.test.ts", 4), row("b.test.ts", 2), row("c.test.ts", 3)]);
// A head that loosens the base in each of the four ways, and the lines that name them.
const loosening = inventory([
	row("a.test.ts", 3),
	row("b.test.ts", 2, { tier: "heavy", maxSkipped: 1 }),
]);
const LOOSENED: readonly string[] = [
	"row 1 lowered minPassed",
	"row 2 changed its tier",
	"row 2 raised maxSkipped",
	"row 3 was removed or renamed",
];
// JSON.parse quotes about ten characters around its error: here, the reserved word.
const broken = `{"files": [{"file": ${testFile("a.test.ts")}}]}`;
const script = path.join(import.meta.dirname, "reserved-inventory.ts");
const cli = (repo: TempRepo, env: Record<string, string>) => {
	const result = spawnSync(process.execPath, [script], {
		cwd: repo.dir,
		encoding: "utf8",
		env: { ...process.env, BASE_REPO: "o/r", HEAD_REPO: "o/r", ...env },
	});
	// Nothing the guard prints names a reserved file or branch.
	expect(reservedWord.test(result.stdout + result.stderr), result.stdout + result.stderr).toBe(
		false,
	);
	return result;
};

describe("the reserved inventory check", () => {
	it("allows added rows and raised minimums", () => {
		const head = inventory([
			row("a.test.ts", 5),
			row("b.test.ts", 2),
			row("c.test.ts", 3),
			row("d.test.ts", 1),
		]);
		expect(loosened(base, head)).toEqual([]);
	});

	it("names by row number a removed row, a lowered minimum, a changed tier or a raised maxSkipped", () => {
		const changes = loosened(base, loosening).map(describeChange);
		expect(changes).toEqual(LOOSENED);
		expect(changes.filter((change) => reservedWord.test(change))).toEqual([]);
	});

	it("never quotes an inventory it can't parse", () => {
		expect(() => JSON.parse(broken)).toThrow(reservedWord);
		expect(loosened(base, base)).toEqual([]);
		for (const [before, after, side] of [
			[base, broken, "head"],
			[broken, base, "base"],
		] as const) {
			let message = "";
			try {
				loosened(before, after);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toBe(`the ${side}'s inventory isn't valid JSON`);
		}
	});

	it("takes the maintainer's branch only from this repository, by a reserved word in its name", () => {
		const repo = "example/project";
		expect(maintainers({ headRef: `maint/${word}-fix`, headRepo: repo, baseRepo: repo })).toBe(
			true,
		);
		expect(
			maintainers({ headRef: `maint/${word}-fix`, headRepo: "fork/project", baseRepo: repo }),
		).toBe(false);
		expect(maintainers({ headRef: "m0-70-fix", headRepo: repo, baseRepo: repo })).toBe(false);
		expect(maintainers({ headRef: `x-${word}`, headRepo: repo, baseRepo: undefined })).toBe(false);
	});

	it("accounts for a loosened row only on the maintainer's branch, with that row's own file changed", () => {
		const own = { headRef: `maint/${word}-rows`, headRepo: "o/r", baseRepo: "o/r" };
		const other = { ...own, headRef: "m1-30-x" };
		const head = inventory([row("a.test.ts", 3), row("b.test.ts", 2), row("c.test.ts", 1)]);
		const changes = loosened(base, head);
		const rows = (left: ReturnType<typeof unaccounted>) => left.map((change) => change.row);
		// Another row's file, or none, accounts for nothing.
		expect(rows(unaccounted(changes, own, new Set([testFile("b.test.ts")])))).toEqual([1, 3]);
		expect(rows(unaccounted(changes, own, new Set()))).toEqual([1, 3]);
		const both = new Set([testFile("a.test.ts"), testFile("c.test.ts")]);
		expect(rows(unaccounted(changes, own, both))).toEqual([]);
		expect(rows(unaccounted(changes, own, new Set([testFile("a.test.ts")])))).toEqual([3]);
		// The branch rule still holds.
		expect(rows(unaccounted(changes, other, both))).toEqual([1, 3]);
	});

	it("reads both sides of a rename from git's NUL-separated name-status", () => {
		const output = ["M", "a.ts", "R100", "old.ts", "new.ts", "D", "gone.ts", ""].join("\0");
		expect([...changedPaths(output)]).toEqual(["a.ts", "old.ts", "new.ts", "gone.ts"]);
	});

	const repo = tempRepo();
	afterAll(() => repo.remove());
	repo.write(INVENTORY, base);
	for (const file of ["a.test.ts", "b.test.ts", "c.test.ts"]) repo.write(testFile(file), "// x\n");
	const sha = repo.commit("chore: base");

	it("exits 1 on a loosened inventory unless the maintainer's branch also changes the row's file, naming neither", () => {
		repo.write(
			INVENTORY,
			inventory([row("a.test.ts", 1), row("b.test.ts", 2), row("c.test.ts", 3)]),
		);
		const failed = cli(repo, { BASE_SHA: sha, HEAD_REF: "m1-30-x" });
		expect(failed.status).toBe(1);
		expect(failed.stdout).toContain("row 1 lowered minPassed");
		// The maintainer's branch name alone doesn't do.
		expect(cli(repo, { BASE_SHA: sha, HEAD_REF: `maint/${word}-rows` }).status).toBe(1);
		// With the row's own file changed, it does; another row's file doesn't.
		repo.write(testFile("b.test.ts"), "// b, changed\n");
		expect(cli(repo, { BASE_SHA: sha, HEAD_REF: `maint/${word}-rows` }).status).toBe(1);
		repo.write(testFile("a.test.ts"), "// a, changed\n");
		expect(cli(repo, { BASE_SHA: sha, HEAD_REF: `maint/${word}-rows` }).status).toBe(0);
		expect(cli(repo, { BASE_SHA: sha, HEAD_REF: "m1-30-x" }).status).toBe(1);
		// A deleted file counts as changed.
		repo.write(testFile("a.test.ts"), "// x\n");
		rmSync(path.join(repo.dir, testFile("a.test.ts")));
		expect(cli(repo, { BASE_SHA: sha, HEAD_REF: `maint/${word}-rows` }).status).toBe(0);
		expect(cli(repo, { BASE_SHA: "0".repeat(40), HEAD_REF: "m1-30-x" }).status).toBe(0);
		repo.write(testFile("a.test.ts"), "// x\n");
		repo.write(testFile("b.test.ts"), "// x\n");
		repo.write(INVENTORY, base);
		const kept = cli(repo, { BASE_SHA: sha, HEAD_REF: "m1-30-x" });
		expect([kept.status, kept.stdout]).toEqual([
			0,
			"reserved-inventory: every base row is kept, at or above its minimum\n",
		]);
	});

	it("fails with exit 2, quoting nothing, when the head's inventory is broken or gone", () => {
		repo.write(INVENTORY, broken);
		const unreadable = cli(repo, { BASE_SHA: sha, HEAD_REF: "m1-30-x" });
		expect([unreadable.status, unreadable.stderr]).toEqual([
			2,
			"reserved-inventory: the head's inventory isn't valid JSON\n",
		]);
		rmSync(path.join(repo.dir, INVENTORY));
		expect(cli(repo, { BASE_SHA: sha, HEAD_REF: "m1-30-x" }).status).toBe(2);
		repo.write(INVENTORY, base);
		expect(cli(repo, { BASE_SHA: sha, HEAD_REF: "m1-30-x" }).status).toBe(0);
	});

	it("fails with exit 2 when git can't read the base, rather than take it for a first appearance", () => {
		expect(cli(repo, { BASE_SHA: sha, HEAD_REF: "m1-30-x" }).status).toBe(0);
		const missing = cli(repo, { BASE_SHA: "1".repeat(40), HEAD_REF: "m1-30-x" });
		expect(missing.status).toBe(2);
		expect(missing.stdout).toBe("");
	});
});

// Mutation cases: each of loosened()'s checks removed from a copy of reserved-inventory.ts lets its
// loosening through, so the case that names all four fails without it. The copy left as it is
// names all four.
describe("the reserved inventory check with each of its checks removed", () => {
	const copies = sourceCopies([
		"tools/ci-checks/src/reserved-inventory.ts",
		"tools/ci-checks/src/commit-identity.ts",
		"tools/ci-checks/src/lib.ts",
		"reserved-tests.ts",
	]);
	afterAll(() => copies.remove());
	const named = async (change?: readonly [string, string]): Promise<string[]> => {
		const copy = await copies.load<typeof import("./reserved-inventory.ts")>(change);
		return copy.loosened(base, loosening).map(copy.describeChange);
	};

	it("names every loosening from a copy left as it is", async () => {
		expect(await named()).toEqual(LOOSENED);
	});

	it.each([
		[
			"a removed row",
			'if (now === undefined) return [change("was removed or renamed")];',
			"if (now === undefined) return [];",
			"row 3 was removed or renamed",
		],
		[
			"a changed tier",
			'if (now.tier !== row.tier) found.push(change("changed its tier"));',
			"",
			"row 2 changed its tier",
		],
		[
			"a lowered minPassed",
			'if (now.minPassed < row.minPassed) found.push(change("lowered minPassed"));',
			"",
			"row 1 lowered minPassed",
		],
		[
			"a raised maxSkipped",
			'if (now.maxSkipped > row.maxSkipped) found.push(change("raised maxSkipped"));',
			"",
			"row 2 raised maxSkipped",
		],
	] as const)("lets %s through once its check is removed", async (_label, from, to, line) => {
		expect(await named([from, to])).toEqual(LOOSENED.filter((other) => other !== line));
	});
});

describe("the reserved inventory's first appearance", () => {
	const repo = tempRepo();
	afterAll(() => repo.remove());
	repo.write("README.md", "# x\n");
	const before = repo.commit("chore: before the inventory");

	it("allows a base without the inventory and reports every head row as new", () => {
		repo.write(INVENTORY, base);
		const first = cli(repo, { BASE_SHA: before, HEAD_REF: "m1-30-x" });
		expect([first.status, first.stdout]).toEqual([
			0,
			"reserved-inventory: the base has no inventory yet, so all 3 row(s) are new\n",
		]);
		// The head is still read: a broken one fails without quoting it.
		repo.write(INVENTORY, broken);
		const unreadable = cli(repo, { BASE_SHA: before, HEAD_REF: "m1-30-x" });
		expect([unreadable.status, unreadable.stderr]).toEqual([
			2,
			"reserved-inventory: the head's inventory isn't valid JSON\n",
		]);
		repo.write(INVENTORY, base);
		const after = repo.commit("chore: add the inventory");
		const kept = cli(repo, { BASE_SHA: after, HEAD_REF: "m1-30-x" });
		expect([kept.status, kept.stdout]).toEqual([
			0,
			"reserved-inventory: every base row is kept, at or above its minimum\n",
		]);
	});
});
