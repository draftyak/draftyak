import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { preSpawnLinkScan, RefusedSpawnError, spawnPlugin } from "../src/spawn.ts";

describe("preSpawnLinkScan", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dy-s02-scan-"));
	afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

	const freshBundle = (name: string): string => {
		const dir = path.join(root, name);
		fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
		fs.writeFileSync(path.join(dir, "entry.mjs"), "export default 1;\n");
		fs.writeFileSync(path.join(dir, "sub", "data.txt"), "x\n");
		return dir;
	};

	it("passes a clean bundle with no links", () => {
		expect(preSpawnLinkScan([freshBundle("clean")])).toBeNull();
	});

	it("finds a hard link (nlink > 1) anywhere in the bundle", () => {
		const dir = freshBundle("hard");
		const outside = path.join(root, "outside.key");
		fs.writeFileSync(outside, "secret\n");
		fs.linkSync(outside, path.join(dir, "sub", "sneaky"));
		const finding = preSpawnLinkScan([dir]);
		expect(finding?.kind).toBe("hardlink");
		expect(path.basename(finding?.path ?? "")).toBe("sneaky");
	});

	it("finds a junction, reported as a symbolic link", { tags: ["requires:windows"] }, () => {
		const dir = freshBundle("jx");
		const targetDir = path.join(root, "jx-target");
		fs.mkdirSync(targetDir, { recursive: true });
		fs.symlinkSync(targetDir, path.join(dir, "link"), "junction");
		expect(preSpawnLinkScan([dir])?.kind).toBe("symlink");
	});

	it("finds a symlink", { tags: ["requires:symlink-privilege"] }, () => {
		const dir = freshBundle("sym");
		fs.symlinkSync(path.join(root, "outside.key"), path.join(dir, "link"), "file");
		expect(preSpawnLinkScan([dir])?.kind).toBe("symlink");
	});

	it("makes spawnPlugin refuse a bundle that holds a link, before any spawn", () => {
		const dir = freshBundle("refuse");
		const outside = path.join(root, "outside2.key");
		fs.writeFileSync(outside, "secret\n");
		fs.linkSync(outside, path.join(dir, "hardlink"));
		expect(() =>
			spawnPlugin({
				nodeBin: process.execPath,
				pluginDir: dir,
				dataDir: path.join(root, "data"),
				pluginId: "p",
				instanceId: "i",
				entry: path.join(dir, "entry.mjs"),
			}),
		).toThrow(RefusedSpawnError);
	});

	it("refuses a shell-shim node binary", () => {
		expect(() =>
			spawnPlugin({
				nodeBin: "C:/x/node.cmd",
				pluginDir: freshBundle("shim"),
				dataDir: path.join(root, "data"),
				pluginId: "p",
				instanceId: "i",
				entry: path.join(root, "shim", "entry.mjs"),
			}),
		).toThrow(/shell shim/);
	});

	it("fails closed on a missing directory or a non-directory root", () => {
		expect(preSpawnLinkScan([path.join(root, "does-not-exist")])?.kind).toBe("unreadable");
		const file = path.join(root, "a-file");
		fs.writeFileSync(file, "x\n");
		expect(preSpawnLinkScan([file])?.kind).toBe("irregular");
	});

	it("fails closed when a scan root is itself a junction", { tags: ["requires:windows"] }, () => {
		const target = freshBundle("root-jx-target");
		const link = path.join(root, "root-jx");
		fs.symlinkSync(target, link, "junction");
		expect(preSpawnLinkScan([link])?.kind).toBe("symlink");
	});

	it("fails closed when a scan root is itself a symlink", {
		tags: ["requires:symlink-privilege"],
	}, () => {
		const target = freshBundle("root-sym-target");
		const link = path.join(root, "root-sym");
		fs.symlinkSync(target, link, "dir");
		expect(preSpawnLinkScan([link])?.kind).toBe("symlink");
	});

	it("validates the exec argv before spawning (rejects a wildcard pluginDir)", () => {
		expect(() =>
			spawnPlugin({
				nodeBin: process.execPath,
				pluginDir: "*",
				dataDir: path.join(root, "data"),
				pluginId: "p",
				instanceId: "i",
				entry: path.join(root, "x.mjs"),
			}),
		).toThrow(/absolute path/);
	});
});
