import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Downloads from nodejs.org, and Docker for the Linux cases; with DRAFTYAK_STRICT_SKIPS=1 a missing
// Docker fails those cases instead of skipping them.
const tool = path.join(import.meta.dirname, "..");
const json = (file: string) => JSON.parse(readFileSync(path.join(tool, file), "utf8"));
const versions: Record<string, string> = json("versions.json");
const images = json("images.json");
const timeout = 600_000;
const docker = spawnSync("docker", ["info"], { stdio: "ignore", timeout }).status === 0;
const withDocker = docker || process.env.DRAFTYAK_STRICT_SKIPS === "1";
const tmp = mkdtempSync(path.join(tmpdir(), "draftyak-fetch-node-heavy-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function fetchNode(args: string, env: NodeJS.ProcessEnv = process.env) {
	const argv = [path.join(tool, "fetch-node.mjs"), ...args.split(" ")];
	return spawnSync(process.execPath, argv, { encoding: "utf8", env, timeout });
}

describe.each(Object.values(versions))("node v%s from nodejs.org", (version) => {
	it("verifies and runs this host's binary", { timeout }, () => {
		const result = fetchNode(`--version ${version} --print-path`);
		expect(result.status, result.stderr).toBe(0);
		const printed = execFileSync(result.stdout.trim(), ["--version"], { encoding: "utf8" });
		expect(printed.trim()).toBe(`v${version}`);
	});

	it.runIf(withDocker)("runs the Linux x64 binary in the pinned glibc image", { timeout }, () => {
		const result = fetchNode(`--version ${version} --platform linux --arch x64 --docker-smoke`);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(`v${version}`);
	});

	it.runIf(withDocker)("pins a musl node:alpine image of the same version", { timeout }, () => {
		const probe =
			"process.version + (process.report.getReport().header.glibcVersionRuntime ?? ' musl')";
		const args = ["run", "--rm", "--network", "none", images.musl[version], "node", "-p", probe];
		const result = spawnSync("docker", args, { encoding: "utf8", timeout });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(`v${version} musl`);
	});
});

describe("a copy of the verified cache", () => {
	const version = versions.bundled ?? "";
	const platform = process.platform === "win32" ? "win" : process.platform;
	const archive = `node-v${version}-${platform}-${process.arch}.${platform === "win" ? "zip" : "tar.gz"}`;

	it.each([
		[archive, /SHA-256 mismatch/],
		["SHASUMS256.txt", /signature check failed: BADSIG/],
	])("exits 2 when %s has one changed byte", { timeout }, (file, error) => {
		const fetched = fetchNode(`--version ${version} --print-path`);
		expect(fetched.status, fetched.stderr).toBe(0);
		const root = path.join(tmp, file);
		const copy = path.join(root, "node", version);
		mkdirSync(copy, { recursive: true });
		for (const name of ["SHASUMS256.txt", "SHASUMS256.txt.sig", archive]) {
			cpSync(path.join(fetched.stdout.trim(), "..", "..", name), path.join(copy, name));
		}
		const bytes = readFileSync(path.join(copy, file));
		bytes[bytes.length >> 1] = (bytes[bytes.length >> 1] ?? 0) ^ 0x01;
		writeFileSync(path.join(copy, file), bytes);
		const result = fetchNode(`--version ${version} --offline`, {
			...process.env,
			DRAFTYAK_CACHE_DIR: root,
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(error);
	});
});
