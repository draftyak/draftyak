import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
afterEach(() => {
	for (const value of fixtures.splice(0)) removeNpmFixture(value);
});
function fixture(target?: Parameters<typeof npmFixture>[1]): NpmFixture {
	const f = npmFixture(false, target);
	fixtures.push(f);
	return f;
}
it.each([
	{ platform: "win" as const, arch: "x64" as const, selected: "win32-x64" },
	{ platform: "darwin" as const, arch: "arm64" as const, selected: "darwin-arm64" },
	{ platform: "linux" as const, arch: "x64" as const, selected: "linux-x64" },
])(
	"preserves the actual $selected target and only its selected binding in npm",
	({ platform, arch, selected }) => {
		const f = fixture({ platform, arch });
		const tree = unpackTree(readFileSync(assembleNpm(f).file));
		const metadata = JSON.parse(tree.files.get("package/bundle.json")?.toString() ?? "null");
		expect(metadata.target).toEqual({ platform, arch });
		expect(metadata.native.bindings).toEqual({ [selected]: `native/prebuilds/${selected}.node` });
		expect(
			[...tree.files.keys()].filter((file) => file.startsWith("package/native/prebuilds/")),
		).toEqual([`package/native/prebuilds/${selected}.node`]);
		const artifact = path.basename([...readdirSync(f.out)][0] ?? "");
		expect(
			guard(
				{
					schemaVersion: 1,
					version: f.version,
					artifacts: inventory(f.out),
					npm: [{ path: artifact, workspace: "apps/cli" }],
				},
				{ root: f.out, repo: f.repo, scope: "artifacts" },
			).findings,
		).toEqual([]);
	},
);
it.each([
	"extra map",
	"missing map",
	"wrong path",
	"extra prebuild",
	"extra directory",
	"missing prebuild",
	"coerced target",
] as const)("refuses %s selected-native drift without output", (kind) => {
	const f = fixture();
	const metadata = JSON.parse(readFileSync(path.join(f.bundle, "bundle.json"), "utf8"));
	if (kind === "extra map")
		metadata.native.bindings["win32-x64"] = "native/prebuilds/win32-x64.node";
	if (kind === "missing map") metadata.native.bindings = {};
	if (kind === "wrong path")
		metadata.native.bindings["linux-x64"] = "native/prebuilds/win32-x64.node";
	if (kind === "coerced target") metadata.target.platform = ["linux"];
	if (kind === "extra prebuild")
		put(f.bundle, "native/prebuilds/win32-x64.node", "unselected; not executable");
	if (kind === "missing prebuild") rmSync(path.join(f.bundle, "native/prebuilds/linux-x64.node"));
	if (kind === "extra directory") mkdirSync(path.join(f.bundle, "native/prebuilds/extra-empty"));
	put(f.bundle, "bundle.json", JSON.stringify(metadata));
	refreshInventory(
		f.bundle,
		kind === "extra directory"
			? ["native/prebuilds/extra-empty"]
			: kind === "missing prebuild"
				? ["native/prebuilds"]
				: [],
	);
	expect(() => assembleNpm(f)).toThrow();
	expect(readdirSync(f.out)).toEqual([]);
});
