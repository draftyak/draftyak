import { mkdirSync, readdirSync, readFileSync, rmdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { guard } from "../../release-guard/src/guard.ts";
import { inventory } from "../../release-guard/src/integrity.ts";
import { unpackTree } from "../../release-guard/src/tar.ts";
import { assembleNpm } from "../src/npm.ts";
import {
	type NpmFixture,
	npmFixture,
	put,
	refreshInventory,
	removeNpmFixture,
} from "./npm-fixture.ts";

const fixtures: NpmFixture[] = [];
const leaf = "cli/doctor/checks";
function fixture(): NpmFixture {
	const value = npmFixture();
	fixtures.push(value);
	mkdirSync(path.join(value.bundle, leaf), { recursive: true });
	refreshInventory(value.bundle, [leaf]);
	return value;
}
afterEach(() => {
	for (const value of fixtures.splice(0)) removeNpmFixture(value);
});

it("preserves only declared empty leaves through deterministic npm tar and release verification", () => {
	const f = fixture();
	const artifact = assembleNpm(f),
		bytes = readFileSync(artifact.file),
		tree = unpackTree(bytes);
	expect(tree.emptyDirectories).toEqual([`package/${leaf}`]);
	const declared = JSON.parse(
		tree.files.get("package/package.inventory.json")?.toString() ?? "null",
	);
	expect(declared.emptyDirectories).toEqual([leaf]);
	expect(tree.files.get("package/provenance/bundle.inventory.json")).toEqual(
		readFileSync(path.join(f.bundle, "inventory.json")),
	);
	const other = path.join(f.root, "other");
	mkdirSync(other);
	expect(readFileSync(assembleNpm({ ...f, out: other }).file)).toEqual(bytes);
	const release = {
		schemaVersion: 1,
		version: f.version,
		artifacts: inventory(f.out),
		npm: [{ path: path.basename(artifact.file), workspace: "apps/cli" }],
	};
	expect(guard(release, { root: f.out, repo: f.repo, scope: "artifacts" }).findings).toEqual([]);
});

it.each(["missing", "nonempty", "unlisted", "link"] as const)(
	"refuses %s declared directory state without an artifact or scratch residue",
	(kind) => {
		const f = fixture();
		if (kind === "missing") rmdirSync(path.join(f.bundle, leaf));
		if (kind === "nonempty") put(f.bundle, `${leaf}/extra.txt`, "not empty");
		if (kind === "unlisted") mkdirSync(path.join(f.bundle, "cli/extra-empty"));
		if (kind === "link") {
			rmdirSync(path.join(f.bundle, leaf));
			const target = path.join(f.root, "other-directory");
			mkdirSync(target);
			symlinkSync(
				target,
				path.join(f.bundle, leaf),
				process.platform === "win32" ? "junction" : "dir",
			);
		}
		expect(() => assembleNpm(f)).toThrow();
		expect(readdirSync(f.out)).toEqual([]);
	},
);

it.each([
	{ directories: [leaf, "CLI/other"] },
	{ directories: ["cli/doctor", leaf] },
	{ directories: ["cli/main.mjs"] },
])("refuses directory aliases, ancestors or file collisions $directories", ({ directories }) => {
	const f = fixture();
	const value = JSON.parse(readFileSync(path.join(f.bundle, "inventory.json"), "utf8"));
	value.emptyDirectories = directories;
	put(f.bundle, "inventory.json", JSON.stringify(value));
	expect(() => assembleNpm(f)).toThrow();
	expect(readdirSync(f.out)).toEqual([]);
});

it("keeps strict inventory unknown-field refusal", () => {
	const f = fixture();
	const value = JSON.parse(readFileSync(path.join(f.bundle, "inventory.json"), "utf8"));
	value.otherDirectories = [];
	put(f.bundle, "inventory.json", JSON.stringify(value));
	expect(() => assembleNpm(f)).toThrow("unexpected field");
	expect(readdirSync(f.out)).toEqual([]);
});

it("does not admit a postponed runtime through an empty directory record", () => {
	const f = fixture();
	mkdirSync(path.join(f.bundle, "hub/runtime-python"));
	refreshInventory(f.bundle, [leaf, "hub/runtime-python"]);
	expect(() => assembleNpm(f)).toThrow("canonical Python runtime producer is unavailable");
	expect(readdirSync(f.out)).toEqual([]);
});
