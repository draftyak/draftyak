import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it, type Mock, vi } from "vitest";
import { tar, zip } from "../../fetch-node/test/archives.ts";
import { guardRelease, manifest } from "../src/guard.ts";
import { hash, inventory, localPath } from "../src/integrity.ts";
import { authenticatedNodeProbe, type NodeSource, type NodeTestDeps } from "../src/trusted-node.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "draftyak-node-trust-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const platform =
	process.platform === "win32" ? "win" : (process.platform as NodeSource["platform"]);
const arch = process.arch as NodeSource["arch"];

function fixture(): {
	stage: string;
	repo: string;
	source: NodeSource;
	node: { path: string; sha256: string; bytes: number; version: string };
	archive: string;
	deps: {
		signature: Mock<NonNullable<NodeTestDeps["signature"]>>;
		probe: Mock<NonNullable<NodeTestDeps["probe"]>>;
	};
} {
	const folder = mkdtempSync(path.join(scratch, "case-"));
	const stage = path.join(folder, "stage");
	const cache = path.join(folder, "cache");
	const repo = path.join(folder, "repo");
	for (const dir of [stage, cache, path.join(repo, "tools/fetch-node")])
		mkdirSync(dir, { recursive: true });
	const version = "26.12.0";
	const binary = platform === "win" ? "node.exe" : "node";
	const official = "synthetic authenticated bytes; test probe only";
	writeFileSync(path.join(stage, binary), official);
	writeFileSync(
		path.join(repo, "tools/fetch-node/versions.json"),
		JSON.stringify({ bundled: version }),
	);
	const prefix = `node-v${version}-${platform}-${arch}`;
	const entry = `${prefix}/${platform === "win" ? binary : `bin/${binary}`}`;
	const bytes =
		platform === "win"
			? zip([{ name: entry, data: official }])
			: gzipSync(tar([{ name: entry, data: official }]));
	const archive = path.join(cache, `${prefix}.${platform === "win" ? "zip" : "tar.gz"}`);
	writeFileSync(archive, bytes);
	writeFileSync(path.join(cache, "SHASUMS256.txt"), `${hash(bytes)}  ${path.basename(archive)}\n`);
	writeFileSync(path.join(cache, "SHASUMS256.txt.sig"), "fixture signature");
	const signature = vi.fn(async (_sums: Buffer, sig: Buffer) => {
		if (sig.toString() !== "fixture signature") throw new Error("untrusted signature");
		return "fixture signer";
	});
	const probe = vi.fn(
		(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => {
			expect(readFileSync(file, "utf8")).toBe(official);
			expect(path.dirname(file)).toBe(cwd);
			expect(cwd).not.toBe(stage);
			expect(args.slice(0, 3)).toEqual(["--disable-sigusr1", "--input-type=module", "-e"]);
			for (const name of [
				"NODE_OPTIONS",
				"NODE_PATH",
				"LD_PRELOAD",
				"LD_LIBRARY_PATH",
				"DYLD_INSERT_LIBRARIES",
			])
				expect(env[name]).toBeUndefined();
			return {
				status: 0,
				stdout: JSON.stringify({ version, temporal: "object", disabled: true }),
				stderr: "",
			};
		},
	);
	return {
		stage,
		repo,
		archive,
		source: { root: cache, platform, arch },
		node: {
			path: binary,
			version,
			bytes: Buffer.byteLength(official),
			sha256: hash(Buffer.from(official)),
		},
		deps: { signature, probe },
	};
}

describe("independent official Node trust", () => {
	it.each([
		"\\\\server\\share",
		"//server/share",
		"\\\\?\\C:\\cache",
		"https://example.invalid/cache",
		"C:relative",
		"/dev/null",
		"/proc/self/environ",
		"/tmp/.env.live/cache",
	])("rejects non-local/private input before lookup: %s", (file) => {
		expect(() => localPath(file)).toThrow();
	});
	it("requires independently authenticated source even for a matching self-hash", async () => {
		const f = fixture();
		const report = await guardRelease(
			{ schemaVersion: 1, version: "0.1.0", artifacts: inventory(f.stage), npm: [], node: f.node },
			{ root: f.stage, repo: f.repo, scope: "artifacts" },
			f.deps,
		);
		expect(report.findings[0]?.check).toBe("bundled-node-runtime");
		expect(f.deps.signature).not.toHaveBeenCalled();
		expect(f.deps.probe).not.toHaveBeenCalled();
	});
	it.each(["signature", "archive", "candidate", "source"])(
		"refuses bad %s before any candidate execution",
		async (kind) => {
			const f = fixture();
			if (kind === "signature")
				writeFileSync(path.join(f.source.root, "SHASUMS256.txt.sig"), "invalid");
			if (kind === "archive") writeFileSync(f.archive, "changed archive");
			if (kind === "candidate") {
				writeFileSync(path.join(f.stage, f.node.path), "malicious candidate");
				const bytes = readFileSync(path.join(f.stage, f.node.path));
				f.node = { ...f.node, sha256: hash(bytes), bytes: bytes.length };
			}
			const source = kind === "source" ? { ...f.source, root: "\\\\remote\\cache" } : f.source;
			await expect(authenticatedNodeProbe(f.stage, f.node, source, f.deps)).rejects.toThrow();
			expect(f.deps.probe).not.toHaveBeenCalled();
		},
	);
	it("authenticates source and candidate before probing in a private clean directory", async () => {
		const f = fixture();
		const report = await guardRelease(
			{
				schemaVersion: 1,
				version: "0.1.0",
				artifacts: inventory(f.stage),
				npm: [],
				node: f.node,
				nodeSource: f.source,
			},
			{ root: f.stage, repo: f.repo, scope: "artifacts" },
			f.deps,
		);
		expect(report.findings).toEqual([]);
		expect(report.checks).toContain("bundled-node-authentication");
		expect(f.deps.signature).toHaveBeenCalledOnce();
		expect(f.deps.probe).toHaveBeenCalledOnce();
	});
	it("fails an authenticated runtime lacking Temporal", async () => {
		const f = fixture();
		f.deps.probe.mockReturnValue({
			status: 0,
			stdout: JSON.stringify({ version: f.node.version, temporal: "undefined", disabled: true }),
			stderr: "",
		});
		await expect(authenticatedNodeProbe(f.stage, f.node, f.source, f.deps)).rejects.toThrow(
			"Temporal missing",
		);
	});
	it("does not accept JSON booleans as authentication evidence", () => {
		const f = fixture();
		expect(() =>
			manifest({
				schemaVersion: 1,
				version: "0.1.0",
				artifacts: inventory(f.stage),
				npm: [],
				node: f.node,
				nodeSource: { ...f.source, verified: true },
			}),
		).toThrow("unsupported field");
	});
});
