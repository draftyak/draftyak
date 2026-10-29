import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { changedApplication, heavyApplications } from "./app-heavy.ts";
import { areaNames, classify } from "./changes.ts";

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const manifest = (name: string): string =>
	JSON.stringify({ name, scripts: { "test:heavy": "vitest run --mode heavy" } });
function fixture(files: Record<string, string> = {}): string {
	const root = mkdtempSync(path.join(tmpdir(), "draftyak-app-heavy-"));
	roots.push(root);
	const importers = [
		".",
		...Object.keys(files)
			.filter((file) => file.endsWith("/package.json"))
			.map((file) => path.posix.dirname(file)),
	];
	writeFileSync(
		path.join(root, "pnpm-lock.yaml"),
		`lockfileVersion: '9.0'\nimporters:\n${importers.map((folder) => `  ${JSON.stringify(folder)}: {}\n`).join("")}`,
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
const select = (files: string[], directory = root) => classify(files, directory, () => []);

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
