import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as archiveModule from "../../src/artifacts/archive.ts";
import { ArtifactError } from "../../src/artifacts/archive.ts";
import { preparePinnedPackage } from "../../src/artifacts/pin.ts";
import { makePinnedPackage, makeTar, packageEntries } from "./fixtures.ts";

afterEach(() => vi.restoreAllMocks());

describe("neutral pinned package", () => {
	it("pins exact compressed bytes before parsing any archive", () => {
		const spy = vi.spyOn(archiveModule, "unpackTarball");
		const { lock } = makePinnedPackage();
		const invalidArchive = Buffer.from("DYTEST not gzip");
		expect(() => preparePinnedPackage(invalidArchive, lock)).toThrow(ArtifactError);
		expect(spy).not.toHaveBeenCalled();
		const matching = {
			...lock,
			integrity: `sha512-${createHash("sha512").update(invalidArchive).digest("base64")}`,
		};
		expect(() => preparePinnedPackage(invalidArchive, matching)).toThrow(ArtifactError);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("refuses a valid package whose compressed bytes differ from the pin", () => {
		const pinned = makePinnedPackage();
		const other = makePinnedPackage(
			packageEntries(undefined, [{ name: "package/extra", body: "DYTEST" }]),
		);
		expect(() => preparePinnedPackage(other.archive, pinned.lock)).toThrow(ArtifactError);
		expect(preparePinnedPackage(other.archive, other.lock).files.has("extra")).toBe(true);
	});

	it("parses once and returns deterministic exact-byte digests and common identity", () => {
		const spy = vi.spyOn(archiveModule, "unpackTarball");
		const { archive, lock } = makePinnedPackage(
			packageEntries(undefined, [
				{ name: "package/z", body: "DYTEST-z" },
				{ name: "package/A", body: "" },
			]),
		);
		const result = preparePinnedPackage(archive, lock);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(result.inventory.name).toBe("fixture-artifact");
		expect(result.inventory.version).toBe("1.2.3");
		expect(result.metadata).toMatchObject({
			name: lock.name,
			version: lock.version,
			type: "module",
		});
		expect(result.inventory.files.map((row) => row.path)).toEqual([
			"A",
			"index.mjs",
			"package.json",
			"z",
		]);
		expect(result.inventory.files.find((row) => row.path === "z")).toEqual({
			path: "z",
			bytes: 8,
			sha256: createHash("sha256").update("DYTEST-z").digest("hex"),
		});
		expect(result.files.get("A")).toEqual(Buffer.alloc(0));
	});

	it.each([
		{ name: "other-artifact", version: "1.2.3", type: "module" },
		{ name: "fixture-artifact", version: "1.2.4", type: "module" },
		{ name: "fixture-artifact", version: "1.2.3", type: "commonjs" },
		{ name: "fixture-artifact", version: "1.2.3" },
		["fixture-artifact", "1.2.3", "module"],
		null,
	])("refuses mismatched or non-object package metadata %#", (metadata) => {
		const fixture = makePinnedPackage(packageEntries(metadata));
		expect(() => preparePinnedPackage(fixture.archive, fixture.lock)).toThrow(ArtifactError);
	});

	it("requires both the entry and package.json before preparing a result", () => {
		for (const entries of [
			[{ name: "package/index.mjs", body: "DYTEST" }],
			[
				{
					name: "package/package.json",
					body: JSON.stringify({ name: "fixture-artifact", version: "1.2.3", type: "module" }),
				},
			],
		]) {
			const fixture = makePinnedPackage(entries);
			expect(() => preparePinnedPackage(fixture.archive, fixture.lock)).toThrow(ArtifactError);
		}
	});

	it("does not silently absorb consumer entry, dependency or native selection policy", () => {
		const metadata = {
			name: "fixture-artifact",
			version: "1.2.3",
			type: "module",
			dependencies: { "fixture-child": "1.0.0" },
			optionalDependencies: {},
			bin: "entry.js",
			scripts: { install: "DYTEST not executed" },
		};
		const fixture = makePinnedPackage(
			[
				{ name: "package/package.json", body: JSON.stringify(metadata) },
				{ name: "package/entry.js", body: "DYTEST not executed" },
				{ name: "package/Addon.node", body: "DYTEST not loaded" },
				{ name: "package/NODE_MODULES/a", body: "DYTEST" },
			],
			{ entry: "entry.js" },
		);
		const result = preparePinnedPackage(fixture.archive, fixture.lock);
		expect(result.files.has("entry.js")).toBe(true);
		expect(result.metadata).toMatchObject(metadata);
	});

	it("reports one fixed content-free error for invalid compressed or metadata data", () => {
		const fixture = makePinnedPackage([
			{ name: "package/package.json", body: "DYTEST invalid JSON marker" },
			{ name: "package/index.mjs", body: "DYTEST" },
		]);
		try {
			preparePinnedPackage(fixture.archive, fixture.lock);
			throw new Error("missing refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(ArtifactError);
			expect((error as Error).message).toBe("Artifact verification refused.");
			expect((error as Error).message).not.toContain("DYTEST");
		}
		const exact = makePinnedPackage();
		const changed = Buffer.from(exact.archive);
		changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
		expect(() => preparePinnedPackage(changed, exact.lock)).toThrow(ArtifactError);
		const emptyTar = gzipSync(makeTar([]));
		expect(() =>
			preparePinnedPackage(emptyTar, {
				...exact.lock,
				integrity: `sha512-${createHash("sha512").update(emptyTar).digest("base64")}`,
			}),
		).toThrow(ArtifactError);
	});
});
