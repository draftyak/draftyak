import { spawnSync } from "node:child_process";
import {
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
} from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { digest } from "../../bundle-hub/src/inventory.ts";
import { guard } from "../../release-guard/src/guard.ts";
import { inventory } from "../../release-guard/src/integrity.ts";
import { unpack } from "../../release-guard/src/tar.ts";
import { assembleNpm } from "../src/npm.ts";
import {
	fixtureTargets,
	type NpmFixture,
	npmFixture,
	put,
	refreshInventory,
	removeNpmFixture,
} from "./npm-fixture.ts";

const temporary: NpmFixture[] = [];
function fixture(python = false): NpmFixture {
	const value = npmFixture(python);
	temporary.push(value);
	return value;
}
afterEach(() => {
	for (const value of temporary.splice(0)) removeNpmFixture(value);
});

it.each([false, true])("creates a deterministic standard npm archive with Python=%s", (python) => {
	const f = fixture(python);
	const artifact = assembleNpm(f);
	expect(path.basename(artifact.file)).toBe(`draftyak-${f.version}.tgz`);
	const first = readFileSync(artifact.file);
	const files = unpack(first);
	const pkg = JSON.parse(files.get("package/package.json")?.toString() ?? "null");
	expect(pkg).toEqual({
		name: "draftyak",
		version: f.version,
		type: "module",
		license: "Apache-2.0",
		engines: { node: ">=26.5.1" },
		bin: { draftyak: "cli/draftyak.mjs" },
		...(python ? { dependencies: { "@draftyak/runtime-python": f.version } } : {}),
	});
	expect(files.get("package/LICENSE")).toEqual(readFileSync(path.join(f.repo, "LICENSE")));
	expect(files.get("package/NOTICE")).toEqual(readFileSync(path.join(f.repo, "NOTICE")));
	expect(files.get("package/cli/draftyak.mjs")).toEqual(
		readFileSync(path.join(f.bundle, "cli/draftyak.mjs")),
	);
	for (const target of fixtureTargets)
		expect(files.has(`package/native/prebuilds/${target}.node`)).toBe(true);
	expect(files.has("package/node")).toBe(false);
	expect(files.has("package/LICENSE.node")).toBe(false);
	expect(files.has("package/inventory.json")).toBe(false);
	expect(files.get("package/provenance/bundle.inventory.json")).toEqual(
		readFileSync(path.join(f.bundle, "inventory.json")),
	);
	const metadata = JSON.parse(files.get("package/bundle.json")?.toString() ?? "null");
	expect(metadata.node).toEqual({ mode: "host", minimumVersion: "26.5.1" });
	expect(metadata.stagingNode.includedInPackage).toBe(false);
	const packageInventory = JSON.parse(
		files.get("package/package.inventory.json")?.toString() ?? "null",
	);
	expect(
		packageInventory.files.map((file: { path: string }) => `package/${file.path}`).sort(),
	).toEqual([...files.keys()].filter((file) => file !== "package/package.inventory.json").sort());
	for (const file of packageInventory.files) {
		const bytes = files.get(`package/${file.path}`);
		expect(bytes?.length).toBe(file.bytes);
		expect(digest(bytes ?? Buffer.alloc(0))).toBe(file.sha256);
	}
	expect(artifact.sha256).toBe(digest(first));
	expect(artifact.bytes).toBe(first.length);
	expect(statSync(artifact.file).nlink).toBe(1);
	utimesSync(path.join(f.bundle, "cli/main.js"), new Date(0), new Date(0));
	const other = path.join(f.root, "other-output");
	mkdirSync(other);
	expect(readFileSync(assembleNpm({ ...f, out: other }).file)).toEqual(first);
	const release = {
		schemaVersion: 1,
		version: f.version,
		artifacts: inventory(f.out),
		npm: [{ path: path.basename(artifact.file), workspace: "apps/cli" }],
	};
	expect(guard(release, { root: f.out, repo: f.repo, scope: "artifacts" }).findings).toEqual([]);
});

it("encodes long payload paths in ustar and marks only the npm launcher executable", () => {
	const f = fixture();
	const long = `hub/plugins/${"segment".repeat(9)}/${"component".repeat(8)}/entry.mjs`;
	put(f.bundle, long, "export default {};\n");
	refreshInventory(f.bundle);
	const packed = readFileSync(assembleNpm(f).file);
	expect(unpack(packed).has(`package/${long}`)).toBe(true);
	const tar = gunzipSync(packed);
	for (let at = 0; at < tar.length - 1024; ) {
		const header = tar.subarray(at, at + 512);
		const name = header.subarray(0, 100).toString().split("\0")[0];
		const prefix = header.subarray(345, 500).toString().split("\0")[0];
		const file = prefix ? `${prefix}/${name}` : name;
		const mode = Number.parseInt(header.subarray(100, 108).toString(), 8);
		expect(mode).toBe(file === "package/cli/draftyak.mjs" ? 0o755 : 0o644);
		expect(Number.parseInt(header.subarray(136, 148).toString(), 8)).toBe(0);
		const size = Number.parseInt(header.subarray(124, 136).toString(), 8);
		at += 512 + Math.ceil(size / 512) * 512;
	}
});

it.each(["missing", "tampered", "extra"])(
	"rejects %s candidate bytes without producing an archive",
	(kind) => {
		const f = fixture();
		if (kind === "missing") rmSync(path.join(f.bundle, "cli/main.js"));
		if (kind === "tampered") put(f.bundle, "cli/main.js", "modified");
		if (kind === "extra") put(f.bundle, "extra.txt", "extra");
		expect(() => assembleNpm(f)).toThrow();
		expect(readdirSync(f.out)).toEqual([]);
	},
);

it.each([
	"cli/main.js",
	"hub/hub.mjs",
	"native/prebuilds/win32-arm64.node",
	"native/lib/methods/transaction.js",
])("rejects a freshly inventoried but incomplete payload %s", (file) => {
	const f = fixture();
	rmSync(path.join(f.bundle, file));
	refreshInventory(f.bundle);
	expect(() => assembleNpm(f)).toThrow("required built payload");
	expect(readdirSync(f.out)).toEqual([]);
});

it("rejects a modified protected launcher and hidden install hooks even with updated inventories", () => {
	const f = fixture();
	put(f.bundle, "cli/draftyak.mjs", "// Unprotected fixture\n");
	refreshInventory(f.bundle);
	expect(() => assembleNpm(f)).toThrow("protected repository launcher");
	const other = fixture();
	put(
		other.bundle,
		"hub/plugins/fixture/package.json",
		'{"scripts":{"postinstall":"must-never-run"}}',
	);
	refreshInventory(other.bundle);
	expect(() => assembleNpm(other)).toThrow("lifecycle hooks");
});

it("rejects runtime drift and never silently drops a declared Python runtime", () => {
	const f = fixture(true);
	put(f.bundle, "runtime-python/shim.mjs", "changed");
	refreshInventory(f.bundle);
	expect(() => assembleNpm(f)).toThrow("inventory mismatch");
	const other = fixture(true);
	rmSync(path.join(other.bundle, "runtime-python.inventory.json"));
	refreshInventory(other.bundle);
	expect(() => assembleNpm(other)).toThrow("required built payload");
});

it("rejects hard links, junction ancestors, private-state paths and case aliases", () => {
	const hard = fixture();
	linkSync(path.join(hard.bundle, "cli/main.js"), path.join(hard.root, "hard-alias"));
	expect(() => assembleNpm(hard)).toThrow("hard-link");
	const linked = fixture();
	const alias = path.join(linked.root, "linked");
	symlinkSync(linked.bundle, alias, process.platform === "win32" ? "junction" : "dir");
	expect(() => assembleNpm({ ...linked, bundle: alias })).toThrow("link");
	const state = fixture();
	const original = JSON.parse(readFileSync(path.join(state.bundle, "inventory.json"), "utf8"));
	original.files.push({ path: ".env.live", bytes: 0, sha256: "0".repeat(64) });
	put(state.bundle, "inventory.json", JSON.stringify(original));
	expect(() => assembleNpm(state)).toThrow("private-state");
	const collided = fixture();
	const inventory = JSON.parse(readFileSync(path.join(collided.bundle, "inventory.json"), "utf8"));
	inventory.files.push({ ...inventory.files[0], path: inventory.files[0].path.toUpperCase() });
	put(collided.bundle, "inventory.json", JSON.stringify(inventory));
	expect(() => assembleNpm(collided)).toThrow("case-aliased");
});

it("refuses output overwrite and output paths inside the candidate", () => {
	const f = fixture();
	const first = assembleNpm(f);
	const bytes = readFileSync(first.file);
	expect(() => assembleNpm(f)).toThrow("already exists");
	expect(readFileSync(first.file)).toEqual(bytes);
	const other = fixture();
	const target = path.join(other.out, `draftyak-${other.version}.tgz`);
	mkdirSync(target);
	expect(() => assembleNpm(other)).toThrow("already exists");
	expect(readdirSync(other.out)).toEqual([path.basename(target)]);
	expect(() => assembleNpm({ ...other, out: other.bundle })).toThrow("outside the candidate");
});

it("preserves a dangling output alias and removes scratch after exclusive publication fails", () => {
	const f = fixture();
	const output = path.join(f.out, `draftyak-${f.version}.tgz`);
	symlinkSync(
		path.join(f.out, "absent-target"),
		output,
		process.platform === "win32" ? "junction" : "dir",
	);
	expect(() => assembleNpm(f)).toThrow();
	expect(readdirSync(f.out)).toEqual([path.basename(output)]);
});

it("CLI fails closed when product input is absent", () => {
	const f = fixture();
	const result = spawnSync(
		process.execPath,
		[
			path.resolve(import.meta.dirname, "../src/npm.ts"),
			"--bundle",
			path.join(f.root, "missing"),
			"--out",
			f.out,
		],
		{ encoding: "utf8" },
	);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("npm-artifact:");
	expect(readdirSync(f.out)).toEqual([]);
});
