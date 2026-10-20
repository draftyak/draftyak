import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { tempRepo } from "../test/temp-repo.ts";
import { category, itemOf, measure, parseNumstat, report, sizeBand } from "./pr-size.ts";

describe("pr-size", () => {
	it.each([
		["tools/ci-checks/src/dco.ts", "code"],
		[".github/workflows/ci.yml", "code"],
		["tools/ci-checks/vitest.config.ts", "code"],
		["tools/verify/steps/test.ts", "code"],
		["tools/vendor-guard/src/rules.ts", "code"],
		["spikes/kit/evidence.ts", "code"],
		["tools/ci-checks/src/pr-size.test.ts", "tests"],
		["spikes/kit/test/env.heavy.test.ts", "tests"],
		["tools/ci-checks/test/temp-repo.ts", "tests"],
		["spikes/s05-desktop/tauri-app/src-tauri/tests/sidecar.rs", "tests"],
		["apps/web/src/__tests__/inbox.tsx", "tests"],
		["spikes/s04-oauth-as/fixtures/cimd/client.json", "tests"],
		["docs/roadmap/m0.md", "docs"],
		["docs/vendor.md", "docs"],
		["LICENSE", "docs"],
		["NOTICE", "docs"],
		["pnpm-lock.yaml", "lockfiles"],
		["spikes/s05-desktop/rust/Cargo.lock", "lockfiles"],
		["spikes/s11-python-runtime/runtime.lock.json", "lockfiles"],
		["spikes/s12-sms/probe-android/gradlew.bat", "wrappers"],
		["spikes/s12-sms/probe-android/gradle/wrapper/gradle-wrapper.properties", "wrappers"],
		["spikes/s08-gmail/vendor/gmail-discovery.json", "vendored"],
		["spikes/s03-mcp-sdk/vendor/basic-host/LICENSE", "vendored"],
		["tools/fetch-node/test/fixtures/vendor/nodejs/v26.12.0/SHASUMS256.txt", "vendored"],
		["spikes/s12-sms/vectors/gsm7.json", "vectors"],
		["spec/vectors/jcs/rfc8785.json", "vectors"],
		["packages/protocol/scripts/vectors/jcs.ts", "code"],
		["packages/protocol/test/vectors.ts", "tests"],
		["spec/plugin-manifest-v1.schema.json", "generated"],
		["spec/schemas/plugin-error-v1.schema.json", "generated"],
		["packages/protocol/test/fixtures/x.schema.json", "tests"],
		["packages/protocol/scripts/spec/errors.ts", "code"],
		["spikes/s01-sqlite3mc/evidence/load-matrix.json", "evidence"],
	])("%s is %s", (file, expected) => {
		expect(category(file)).toBe(expected);
	});

	it("bands counted code lines into S, M and L", () => {
		const bands = [0, 400, 401, 900, 901, 1500, 1501].map(sizeBand);
		expect(bands).toEqual(["S", "S", "M", "M", "L", "L", "over ~1,500"]);
	});

	it("reports counted code with its band, each uncounted category and the raw total", () => {
		const size = measure([
			{ file: "src/a.ts", added: 1200, deleted: 34 },
			{ file: "src/a.test.ts", added: 640, deleted: 0 },
			{ file: "docs/roadmap/m0.md", added: 3, deleted: 3 },
			{ file: "pnpm-lock.yaml", added: 2, deleted: 0 },
		]);
		expect(report(size)).toEqual([
			"  counted code              1,234 lines: L",
			"  not counted:",
			"    tests and fixtures        640 lines",
			"    prose docs                  6 lines",
			"    lockfiles                   2 lines",
			"    generated wrapper files     0 lines",
			"    vendored upstream files     0 lines",
			"    generated vectors           0 lines",
			"    generated schemas           0 lines",
			"    evidence JSON               0 lines",
			"  raw total                 1,882 lines",
		]);
	});

	it("reads the item and its target from the branch", () => {
		const branches = ["m0-03-ci-skeleton", "m0-06a-spike-kit", "m1b-12-pairing", "m0", "main"];
		expect(branches.map(itemOf)).toEqual([
			{ id: "M0.3", into: "m0" },
			{ id: "M0.6a", into: "m0" },
			{ id: "M1b.12", into: "m1b" },
			{ id: "M0", into: "main" },
			undefined,
		]);
	});

	it.each([
		["m1-99-size-probe", "M1.99", "m1"],
		["m1-100-size-probe", "M1.100", "m1"],
		["m2-142-size-probe", "M2.142", "m2"],
		["m10-1000-size-probe", "M10.1000", "m10"],
		["m1b-100a-size-probe", "M1b.100a", "m1b"],
		["m11-1234567890-size-probe", "M11.1234567890", "m11"],
		["m1-0100-size-probe", "M1.100", "m1"],
		["m1-0000-size-probe", "M1.0", "m1"],
	])("infers the complete item and base for %s", (branch, id, into) => {
		expect(itemOf(branch)).toEqual({ id, into });
	});

	it("keeps distinct arbitrary-width item numbers exact while normalizing leading zeros", () => {
		const numbers = ["9007199254740992", "9007199254740993", "9".repeat(400)];
		const ids = numbers.map((number) => itemOf(`m1-${number}-size-probe`)?.id);
		expect(ids).toEqual(numbers.map((number) => `M1.${number}`));
		expect(new Set(ids).size).toBe(numbers.length);
		for (const number of numbers) {
			expect(itemOf(`m1b-000${number}a-size-probe`)).toEqual({
				id: `M1b.${number}a`,
				into: "m1b",
			});
		}
	});

	it.each([
		"m1-1-size-probe",
		"m1-9a-size-probe",
		"m1--size-probe",
		"m1-+100-size-probe",
		"m1-1_00-size-probe",
		"m1-0x64-size-probe",
		"m1-100ab-size-probe",
		"m1-100A-size-probe",
		"prefix-m1-100-size-probe",
		"refs/heads/m1-100-size-probe",
		" m1-100-size-probe",
		"m1/100-size-probe",
		"M1-100-size-probe",
		"m-100-size-probe",
		"m1bb-100-size-probe",
		"mx-100-size-probe",
		"m1-100-",
		"m1-100--size-probe",
		"m1-100-size-probe-",
		"m1-100-size--probe",
		"m1-100-Size-probe",
		"m1-100-size_probe",
		"m1-100-size.probe",
		"m1-100-size-probe/extra",
		"m1-100-size-probe ",
	])("does not infer an item or base from malformed branch %s", (branch) => {
		expect(itemOf(branch)).toBeUndefined();
	});

	it("measures a branch above 99 against its inferred remote base through the CLI", () => {
		const repo = tempRepo();
		try {
			const base = repo.commit("chore: size base");
			repo.git("update-ref", "refs/remotes/origin/m2", base);
			repo.git("checkout", "-q", "-b", "m2-142-width-probe");
			repo.write("src/probe.ts", "export const probe = true;\n");
			repo.commit("feat: size probe");
			const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "pr-size.ts")], {
				cwd: repo.dir,
				encoding: "utf8",
				windowsHide: true,
			});
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain(
				"pr-size: M2.142, m2-142-width-probe against origin/m2, 1 files",
			);
			expect(result.stdout).toMatch(/counted code\s+1 lines: S/);
		} finally {
			repo.remove();
		}
	});

	const repo = tempRepo();
	afterAll(() => repo.remove());

	it("measures a real diff with an edit, a rename, a binary and uncounted files", () => {
		repo.write("src/a.ts", "one\ntwo\nthree\n");
		repo.write("src/old.ts", "export const x = 1;\n");
		const base = repo.commit("chore: base");
		repo.write("src/a.ts", "one\n2\nthree\n");
		repo.git("mv", "src/old.ts", "src/new.ts");
		repo.write("src/a.test.ts", "it();\n".repeat(4));
		repo.write("README.md", "# A\n");
		repo.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n".repeat(10));
		repo.write("logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0]));
		repo.write("spikes/s01-sqlite3mc/evidence/env.json", '{\n  "os": "linux"\n}\n');
		repo.commit("feat: change");
		const stats = parseNumstat(repo.git("diff", "--numstat", "-z", "-M", `${base}...HEAD`));
		expect(stats.map((stat) => stat.file).toSorted()).toEqual([
			"README.md",
			"logo.png",
			"pnpm-lock.yaml",
			"spikes/s01-sqlite3mc/evidence/env.json",
			"src/a.test.ts",
			"src/a.ts",
			"src/new.ts",
		]);
		expect(measure(stats)).toEqual({
			raw: 20,
			counted: 2,
			byCategory: {
				code: 2,
				tests: 4,
				docs: 1,
				lockfiles: 10,
				wrappers: 0,
				vendored: 0,
				vectors: 0,
				generated: 0,
				evidence: 3,
			},
			files: 7,
		});
	});
});
