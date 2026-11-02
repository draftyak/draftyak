import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as readers from "../../bundle-hub/src/inventory.ts";
import { unpack } from "../../release-guard/src/tar.ts";
import { assembleNpm } from "../src/npm.ts";
import {
	type NpmFixture,
	npmFixture,
	put,
	refreshInventory,
	removeNpmFixture,
} from "./npm-fixture.ts";

const policyFile = path.resolve(import.meta.dirname, "../../fetch-node/versions.json");
const originalRead = readers.regularBytes;
const fixtures: NpmFixture[] = [];
function fixture(target?: Parameters<typeof npmFixture>[1]): NpmFixture {
	const value = npmFixture(false, target);
	fixtures.push(value);
	return value;
}
function policy(contents: string): void {
	vi.spyOn(readers, "regularBytes").mockImplementation((file, maximum) =>
		path.resolve(file) === policyFile ? Buffer.from(contents) : originalRead(file, maximum),
	);
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const value of fixtures.splice(0)) removeNpmFixture(value);
});

describe("authoritative npm Node policy", () => {
	it("derives both Node floors from repository metadata rather than candidate or caller metadata", () => {
		policy('{"minimum":"26.6.0","bundled":"26.12.0"}');
		const f = fixture();
		put(f.repo, "tools/fetch-node/versions.json", '{"minimum":"1.0.0","bundled":"1.0.0"}');
		const metadata = JSON.parse(readFileSync(path.join(f.bundle, "bundle.json"), "utf8"));
		metadata.node.minimumVersion = "1.0.0";
		put(f.bundle, "bundle.json", JSON.stringify(metadata));
		refreshInventory(f.bundle);
		// Unrecognized candidate policy fields must not become authority, even with fresh hashes.
		expect(() => assembleNpm(f)).toThrow("unexpected field");
		expect(readdirSync(f.out)).toEqual([]);
		delete metadata.node.minimumVersion;
		put(f.bundle, "bundle.json", JSON.stringify(metadata));
		refreshInventory(f.bundle);
		const files = unpack(readFileSync(assembleNpm(f).file));
		const pkg = JSON.parse(files.get("package/package.json")?.toString("utf8") ?? "null");
		const bundle = JSON.parse(files.get("package/bundle.json")?.toString("utf8") ?? "null");
		expect(pkg.engines).toEqual({ node: ">=26.6.0" });
		expect(bundle.node).toEqual({ mode: "host", minimumVersion: "26.6.0" });
		expect(bundle.stagingNode.version).toBe("26.12.0");
		expect(bundle.stagingNode.includedInPackage).toBe(false);
		expect(files.has("package/node")).toBe(false);
	});

	it("rejects staging version drift even when its metadata and inventory agree", () => {
		const f = fixture();
		policy('{"minimum":"26.5.1","bundled":"26.13.0"}');
		expect(() => assembleNpm(f)).toThrow("repository bundled pin");
		expect(readdirSync(f.out)).toEqual([]);
	});

	it.each([
		"null",
		"[]",
		"{}",
		'{"minimum":"26.5.1"}',
		'{"minimum":26,"bundled":"26.12.0"}',
		'{"minimum":"26.5","bundled":"26.12.0"}',
		'{"minimum":"26.5.1-beta.1","bundled":"26.12.0"}',
		'{"minimum":"026.5.1","bundled":"26.12.0"}',
		'{"minimum":"26.13.0","bundled":"26.12.0"}',
		'{"minimum":"27.0.0","bundled":"27.1.0"}',
		'{"minimum":"26.5.1","bundled":"26.9007199254740992.0"}',
		'{"minimum":"26.5.1","minimum":"1.0.0","bundled":"26.12.0"}',
		'{"minimum":"26.5.1","bundled":"26.12.0","allowUnverified":true}',
	])("refuses invalid repository Node metadata without an artifact: %s", (contents) => {
		const f = fixture();
		policy(contents);
		expect(() => assembleNpm(f)).toThrow();
		expect(readdirSync(f.out)).toEqual([]);
	});

	it("refuses missing repository Node metadata rather than taking a candidate fallback", () => {
		const f = fixture();
		vi.spyOn(readers, "regularBytes").mockImplementation((file, maximum) => {
			if (path.resolve(file) === policyFile) throw new Error("Repository Node policy unavailable");
			return originalRead(file, maximum);
		});
		expect(() => assembleNpm(f)).toThrow("Repository Node policy unavailable");
		expect(readdirSync(f.out)).toEqual([]);
	});

	it("uses one canonical policy snapshot for rendered bytes, engines, bundle floor and bundled pin", () => {
		policy('{"minimum":"26.6.0","bundled":"26.12.0"}');
		const f = fixture();
		vi.restoreAllMocks();
		let reads = 0;
		vi.spyOn(readers, "regularBytes").mockImplementation((file, maximum) => {
			if (path.resolve(file) !== policyFile) return originalRead(file, maximum);
			reads++;
			return Buffer.from(
				reads === 1
					? '{"minimum":"26.6.0","bundled":"26.12.0"}'
					: '{"minimum":"26.7.0","bundled":"26.13.0"}',
			);
		});
		const files = unpack(readFileSync(assembleNpm(f).file));
		expect(reads).toBe(1);
		expect(JSON.parse(files.get("package/package.json")?.toString() ?? "null").engines).toEqual({
			node: ">=26.6.0",
		});
		const metadata = JSON.parse(files.get("package/bundle.json")?.toString() ?? "null");
		expect(metadata.node).toEqual({ mode: "host", minimumVersion: "26.6.0" });
		expect(metadata.stagingNode.version).toBe("26.12.0");
		expect(files.get("package/draftyak.mjs")).toEqual(
			readFileSync(path.join(f.bundle, "draftyak.mjs")),
		);
	});

	it("keeps target coverage mandatory when the repository minimum changes", () => {
		policy('{"minimum":"26.6.0","bundled":"26.12.0"}');
		const f = fixture({ platform: "win", arch: "arm64" });
		rmSync(path.join(f.bundle, "native/prebuilds/win32-arm64.node"));
		refreshInventory(f.bundle, ["native/prebuilds"]);
		expect(() => assembleNpm(f)).toThrow("required built payload");
		expect(readdirSync(f.out)).toEqual([]);
	});
});
