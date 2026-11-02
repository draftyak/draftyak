import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { HUB_MIGRATION_FILES } from "../../bundle-hub/src/hub-migrations.ts";
import { unpack } from "../../release-guard/src/tar.ts";
import { assembleNpm } from "../src/npm.ts";
import {
	type NpmFixture,
	npmFixture,
	put,
	refreshInventory,
	removeNpmFixture,
} from "./npm-fixture.ts";

const fixtures: NpmFixture[] = [];
function fixture(): NpmFixture {
	const value = npmFixture();
	fixtures.push(value);
	return value;
}
afterEach(() => {
	for (const value of fixtures.splice(0)) removeNpmFixture(value);
});

function refreshAfterRemoval(f: NpmFixture, file: string): void {
	const parent = `hub/${path.posix.dirname(file)}`;
	refreshInventory(f.bundle, readdirSync(path.join(f.bundle, parent)).length ? [] : [parent]);
}

it("preserves every admitted runtime-relative Hub SQL asset through the npm archive", () => {
	const f = fixture();
	const archive = unpack(readFileSync(assembleNpm(f).file));
	for (const file of HUB_MIGRATION_FILES)
		expect(archive.get(`package/hub/${file}`)).toEqual(
			readFileSync(path.join(f.bundle, "hub", file)),
		);
});

it.each(HUB_MIGRATION_FILES)("refuses a candidate missing Hub SQL %s", (file) => {
	const f = fixture();
	rmSync(path.join(f.bundle, "hub", file));
	refreshAfterRemoval(f, file);
	expect(() => assembleNpm(f)).toThrow("hub migration inventory");
});

it.each(HUB_MIGRATION_FILES)("refuses a candidate with misplaced Hub SQL %s", (file) => {
	const f = fixture();
	const wrong = path.join(f.bundle, "hub/migrations", file.replaceAll("/", "_"));
	mkdirSync(path.dirname(wrong), { recursive: true });
	renameSync(path.join(f.bundle, "hub", file), wrong);
	refreshAfterRemoval(f, file);
	expect(() => assembleNpm(f)).toThrow("hub migration inventory");
});

it.each(HUB_MIGRATION_FILES)("refuses a candidate with empty Hub SQL %s", (file) => {
	const f = fixture();
	put(f.bundle, `hub/${file}`, "");
	refreshInventory(f.bundle);
	expect(() => assembleNpm(f)).toThrow("hub migration inventory");
});
