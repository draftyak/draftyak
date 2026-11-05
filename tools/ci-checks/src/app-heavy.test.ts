import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { changedApplication, heavyApplications } from "./app-heavy.ts";
import type { WorkspacePackage } from "./changes.ts";
import { areaNames, classify } from "./changes.ts";

const roots: string[] = [];
const packages = new Map<string, readonly WorkspacePackage[]>();
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const manifest = (name: string): string =>
	JSON.stringify({ name, scripts: { "test:heavy": "vitest run --mode heavy" } });
function fixture(files: Record<string, string> = {}): string {
	const root = mkdtempSync(path.join(tmpdir(), "draftyak-app-heavy-"));
	roots.push(root);
	packages.set(
		root,
		Object.keys(files)
			.filter((file) => file.endsWith("/package.json"))
			.map((file) => ({ folder: path.posix.dirname(file), dependencies: [] })),
	);
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), content);
	}
	return root;
}
const valid = {
	"apps/cli/package.json": manifest("@draftyak/cli"),
	"apps/hub/package.json": manifest("@draftyak/hub"),
};
const root = fixture(valid);
const select = (files: string[], directory = root) =>
	classify(
		files,
		directory,
		() => [],
		() => packages.get(directory) ?? [],
	);

describe("reviewed native application heavy suites", () => {
	it("discovers exactly the two real manifests and nonempty scripts", () => {
		expect(heavyApplications(root)).toEqual(["apps/cli", "apps/hub"]);
	});
	it.each(["cli", "hub"])("retains dependent filters for %s source and config", (app) => {
		for (const suffix of [
			"src/main.ts",
			"package.json",
			"vitest.config.ts",
			"test/a.heavy.test.ts",
		]) {
			const areas = select([`apps/${app}/${suffix}`]);
			expect(areas.heavy).toEqual([`...{./apps/${app}}`]);
			expect(areaNames(areas)).toEqual(["ts", `heavy:...{./apps/${app}}`]);
			expect(areas.rust).toEqual([]);
		}
	});
	it("deduplicates source/global targets and preserves dependent selection", () => {
		expect(select(["apps/hub/src/a.ts", "apps/hub/src/b.ts", "package.json"]).heavy).toEqual([
			"...{./apps/hub}",
			"./apps/cli",
		]);
	});
	it.each([
		".node-version",
		"tools/fetch-node/versions.json",
		"pnpm-workspace.yaml",
		"package.json",
		"turbo.json",
		"tsconfig.base.json",
		"vitest.shared.ts",
		"pnpm-lock.yaml",
	])("selects eligible applications on global %s", (file) => {
		expect(select([file]).heavy).toEqual(["./apps/cli", "./apps/hub"]);
	});
	it("keeps app coverage when a lock update also changes an unrelated package manifest", () => {
		const mixed = fixture({ ...valid, "packages/other/package.json": '{"name":"other"}' });
		expect(select(["pnpm-lock.yaml", "packages/other/package.json"], mixed).heavy).toEqual([
			"...{./packages/other}",
			"./apps/cli",
			"./apps/hub",
		]);
	});
	it("preserves existing package and spike filters alongside applications", () => {
		const mixed = fixture({
			...valid,
			"packages/core/package.json": manifest("@draftyak/core"),
			"spikes/probe/package.json": "{}",
		});
		const result = select(
			["apps/cli/src/a.ts", "packages/core/src/a.ts", "spikes/probe/src/a.ts"],
			mixed,
		);
		expect(result.heavy).toEqual(["...{./apps/cli}", "...{./packages/core}"]);
		expect(result.spikes).toEqual(["spikes/probe"]);
	});
	it("keeps app documentation docs-only", () => {
		expect(areaNames(select(["apps/cli/README.md", "apps/hub/README.md"]))).toEqual(["docs-only"]);
	});
	it.each([
		"apps/unknown/src/a.ts",
		"apps/hub-extra/src/a.ts",
		"apps/cli-extra/src/a.ts",
		"apps/Hub/src/a.ts",
		"apps/CLI/src/a.ts",
		"apps/hub",
		"apps/cli",
		"/apps/hub/src/a.ts",
		"./apps/hub/src/a.ts",
		"apps/./hub/src/a.ts",
		"apps/hub/../cli/src/a.ts",
		"apps/hub//src/a.ts",
		"apps/hub/",
		"apps\\hub\\src\\a.ts",
		"apps/hub/src/line\nbreak.ts",
		"apps/hub/src/zero\0.ts",
	])("does not normalize or admit %j", (file) => {
		expect(changedApplication(file)).toBeUndefined();
		// Git supplies relative names; reject an absolute input before filesystem classification.
		if (!path.posix.isAbsolute(file)) expect(select([file]).heavy).toEqual([]);
	});
	it.each([
		"{}",
		"null",
		"[]",
		'"@draftyak/hub"',
		'{"name":"@draftyak/other","scripts":{"test:heavy":"test"}}',
		'{"name":"@draftyak/hub"}',
		'{"name":"@draftyak/hub","scripts":null}',
		'{"name":"@draftyak/hub","scripts":[]}',
		'{"name":"@draftyak/hub","scripts":{"test:heavy":null}}',
		'{"name":"@draftyak/hub","scripts":{"test:heavy":1}}',
		'{"name":"@draftyak/hub","scripts":{"test:heavy":""}}',
		JSON.stringify({ name: "@draftyak/hub", scripts: { "test:heavy": " \t\n" } }),
	])("does not invent a heavy suite for manifest %j", (content) => {
		const absent = fixture({ "apps/hub/package.json": content });
		expect(heavyApplications(absent)).toEqual([]);
		expect(select(["apps/hub/src/a.ts", "pnpm-lock.yaml"], absent).heavy).toEqual([]);
	});
	it.each(["cli", "hub"])("requires the exact package identity for %s", (app) => {
		for (const wrong of ["@draftyak/other", `@draftyak/${app === "cli" ? "hub" : "cli"}`]) {
			const mismatched = fixture({ [`apps/${app}/package.json`]: manifest(wrong) });
			expect(heavyApplications(mismatched)).toEqual([]);
			expect(select([`apps/${app}/src/a.ts`, "package.json"], mismatched).heavy).toEqual([]);
		}
	});
	it("does not admit a script at an arbitrary application root", () => {
		const arbitrary = fixture({ "apps/other/package.json": manifest("@draftyak/other") });
		expect(heavyApplications(arbitrary)).toEqual([]);
		expect(select(["apps/other/src/a.ts", "package.json"], arbitrary).heavy).toEqual([]);
	});
	it("handles absent app roots and directory-only placeholders", () => {
		const absent = fixture();
		mkdirSync(path.join(absent, "apps", "hub"), { recursive: true });
		expect(heavyApplications(absent)).toEqual([]);
		expect(select(["apps/hub/src/a.ts", "package.json"], absent).heavy).toEqual([]);
	});
	it("refuses malformed manifest JSON without displaying it", () => {
		const malformed = fixture({ "apps/hub/package.json": "{broken-marker" });
		expect(() => select(["apps/hub/src/a.ts"], malformed)).toThrow(
			/^invalid heavy application manifest: apps\/hub$/,
		);
	});
	it("does not follow a linked application directory", () => {
		const target = fixture({ "hub/package.json": manifest("@draftyak/hub") });
		const linked = fixture();
		mkdirSync(path.join(linked, "apps"));
		symlinkSync(path.join(target, "hub"), path.join(linked, "apps", "hub"), "junction");
		expect(heavyApplications(linked)).toEqual([]);
	});
	it("does not follow a linked apps parent", () => {
		const target = fixture(valid);
		const linked = fixture();
		symlinkSync(path.join(target, "apps"), path.join(linked, "apps"), "junction");
		expect(heavyApplications(linked)).toEqual([]);
	});
	it("requires a regular manifest file", () => {
		const directory = fixture();
		mkdirSync(path.join(directory, "apps", "hub", "package.json"), { recursive: true });
		expect(heavyApplications(directory)).toEqual([]);
	});
	it("does not read a linked manifest file", () => {
		const target = fixture({ "package.json": manifest("@draftyak/hub") });
		const linked = fixture();
		mkdirSync(path.join(linked, "apps", "hub"), { recursive: true });
		symlinkSync(
			path.join(target, "package.json"),
			path.join(linked, "apps", "hub", "package.json"),
			"file",
		);
		expect(heavyApplications(linked)).toEqual([]);
	});
});

describe("reviewed doctor heavy suite", () => {
	const doctor = "tools/doctor";
	const withDoctor = fixture({
		...valid,
		[`${doctor}/package.json`]: manifest("@draftyak/doctor"),
	});

	it("admits the actual merged doctor package and its existing heavy script", () => {
		const repository = path.resolve(import.meta.dirname, "../../..");
		const actual = JSON.parse(readFileSync(path.join(repository, doctor, "package.json"), "utf8"));
		expect(actual.name).toBe("@draftyak/doctor");
		expect(actual.scripts?.["test:heavy"]).toEqual(expect.stringMatching(/\S/));
		expect(heavyApplications(repository)).toContain(doctor);
		expect(heavyApplications(withDoctor)).toEqual(["apps/cli", "apps/hub", doctor]);
	});
	it.each(["diagnostics.ts", "package.json", "vitest.config.ts", "test/compiled.heavy.test.ts"])(
		"retains the dependent doctor filter for %s",
		(suffix) => {
			const result = select([`${doctor}/${suffix}`], withDoctor);
			expect(result.heavy).toEqual(["...{./tools/doctor}"]);
			expect(areaNames(result)).toEqual(["ts", "heavy:...{./tools/doctor}"]);
			expect(result.rust).toEqual([]);
		},
	);
	it.each([
		".node-version",
		"tools/fetch-node/versions.json",
		"pnpm-workspace.yaml",
		"package.json",
		"turbo.json",
		"tsconfig.base.json",
		"vitest.shared.ts",
		"pnpm-lock.yaml",
	])("keeps applications and doctor selected for global %s", (file) => {
		expect(select([file], withDoctor).heavy).toEqual([
			"./apps/cli",
			"./apps/hub",
			"./tools/doctor",
		]);
	});
	it("retains doctor for a lock update paired with an unrelated manifest", () => {
		const mixed = fixture({
			...valid,
			[`${doctor}/package.json`]: manifest("@draftyak/doctor"),
			"packages/other/package.json": '{"name":"other"}',
		});
		expect(select(["pnpm-lock.yaml", "packages/other/package.json"], mixed).heavy).toEqual([
			"...{./packages/other}",
			"./apps/cli",
			"./apps/hub",
			"./tools/doctor",
		]);
	});
	it("deduplicates doctor source and global admission without dropping application coverage", () => {
		expect(select([`${doctor}/diagnostics.ts`, "package.json"], withDoctor).heavy).toEqual([
			"...{./tools/doctor}",
			"./apps/cli",
			"./apps/hub",
		]);
	});
	it("keeps doctor documentation docs-only", () => {
		expect(areaNames(select([`${doctor}/README.md`], withDoctor))).toEqual(["docs-only"]);
	});
	it.each([
		"tools/other/diagnostics.ts",
		"tools/doctor-extra/diagnostics.ts",
		"tools/Doctor/diagnostics.ts",
		"tools/doctor",
		"tools/doctor/",
		"/tools/doctor/diagnostics.ts",
		"./tools/doctor/diagnostics.ts",
		"tools/./doctor/diagnostics.ts",
		"tools/doctor/../other/diagnostics.ts",
		"tools/doctor//diagnostics.ts",
		"tools\\doctor\\diagnostics.ts",
		"tools/doctor/line\nbreak.ts",
		"tools/doctor/zero\0.ts",
	])("does not normalize a doctor lookalike %j", (file) => {
		expect(changedApplication(file)).toBeUndefined();
		if (!path.posix.isAbsolute(file)) expect(select([file], withDoctor).heavy).toEqual([]);
	});
	it.each([
		"{}",
		"null",
		"[]",
		'"@draftyak/doctor"',
		'{"name":"@draftyak/other","scripts":{"test:heavy":"test"}}',
		'{"name":"@draftyak/doctor"}',
		'{"name":"@draftyak/doctor","scripts":null}',
		'{"name":"@draftyak/doctor","scripts":[]}',
		'{"name":"@draftyak/doctor","scripts":{"test:heavy":null}}',
		'{"name":"@draftyak/doctor","scripts":{"test:heavy":1}}',
		'{"name":"@draftyak/doctor","scripts":{"test:heavy":""}}',
		JSON.stringify({ name: "@draftyak/doctor", scripts: { "test:heavy": " \t\n" } }),
	])("does not invent a doctor suite for manifest %j", (content) => {
		const invalid = fixture({ [`${doctor}/package.json`]: content });
		expect(heavyApplications(invalid)).toEqual([]);
		expect(select([`${doctor}/diagnostics.ts`, "pnpm-lock.yaml"], invalid).heavy).toEqual([]);
	});
	it("keeps both applications when the doctor directory or script is absent", () => {
		const absent = fixture(valid);
		mkdirSync(path.join(absent, doctor), { recursive: true });
		expect(heavyApplications(absent)).toEqual(["apps/cli", "apps/hub"]);
		expect(select([`${doctor}/diagnostics.ts`], absent).heavy).toEqual([]);
	});
	it("does not read an unreviewed tools manifest", () => {
		const unreviewed = fixture({
			[`${doctor}/package.json`]: manifest("@draftyak/doctor"),
			"tools/unreviewed/package.json": "{DYTEST-must-not-read",
		});
		expect(heavyApplications(unreviewed)).toEqual([doctor]);
		expect(select(["pnpm-lock.yaml"], unreviewed).heavy).toEqual(["./tools/doctor"]);
	});
	it("refuses malformed doctor JSON without displaying its contents", () => {
		const malformed = fixture({ [`${doctor}/package.json`]: "{DYTEST-private-marker" });
		expect(() => heavyApplications(malformed)).toThrow(
			/^invalid heavy application manifest: tools\/doctor$/,
		);
	});
	it("does not follow a linked tools parent", () => {
		const target = fixture({ [`${doctor}/package.json`]: manifest("@draftyak/doctor") });
		const linked = fixture();
		symlinkSync(path.join(target, "tools"), path.join(linked, "tools"), "junction");
		expect(heavyApplications(linked)).toEqual([]);
	});
	it("does not follow a linked doctor directory", () => {
		const target = fixture({ "doctor/package.json": manifest("@draftyak/doctor") });
		const linked = fixture();
		mkdirSync(path.join(linked, "tools"));
		symlinkSync(path.join(target, "doctor"), path.join(linked, doctor), "junction");
		expect(heavyApplications(linked)).toEqual([]);
	});
	it("requires a physical tools directory and a regular doctor manifest", () => {
		const parentFile = fixture({ tools: "DYTEST-not-directory" });
		expect(heavyApplications(parentFile)).toEqual([]);
		const manifestDirectory = fixture();
		mkdirSync(path.join(manifestDirectory, doctor, "package.json"), { recursive: true });
		expect(heavyApplications(manifestDirectory)).toEqual([]);
	});
	it("does not read a linked doctor manifest", () => {
		const target = fixture({ "package.json": manifest("@draftyak/doctor") });
		const linked = fixture();
		mkdirSync(path.join(linked, doctor), { recursive: true });
		symlinkSync(
			path.join(target, "package.json"),
			path.join(linked, doctor, "package.json"),
			"file",
		);
		expect(heavyApplications(linked)).toEqual([]);
	});
});
