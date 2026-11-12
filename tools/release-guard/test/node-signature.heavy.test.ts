import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { directory, hash, localPath, read } from "../src/integrity.ts";
import { nodeHeavyInput } from "./helpers/node-heavy-input.ts";

it("refuses a corrupted official signature before probing otherwise authenticated Node inputs", () => {
	const { source, version, binary, bytes } = nodeHeavyInput(
		process.env.DRAFTYAK_TEST_NODE_CACHE,
		process.platform,
		process.arch,
	);
	const publicInput = process.env.DRAFTYAK_CACHE_DIR;
	if (typeof publicInput !== "string" || !path.isAbsolute(publicInput))
		throw new Error("explicit public scratch root is required");
	const publicRoot = localPath(publicInput);
	mkdirSync(publicRoot, { recursive: true });
	directory(publicRoot);
	const scratch = mkdtempSync(path.join(publicRoot, "draftyak-node-signature-"));
	if (
		path.dirname(scratch) !== publicRoot ||
		!path.basename(scratch).startsWith("draftyak-node-signature-")
	)
		throw new Error("unsafe signature-test scratch path");
	const stage = path.join(scratch, "stage");
	const cache = path.join(scratch, "source");
	const archive = `node-v${version}-${source.platform}-${source.arch}.${source.platform === "win" ? "zip" : "tar.gz"}`;
	const probe = "DYTEST-authenticated-probe-entered\n";
	const accepted = "DYTEST-authentication-and-probe-passed\n";
	try {
		mkdirSync(stage);
		mkdirSync(cache);
		for (const file of ["SHASUMS256.txt", "SHASUMS256.txt.sig", archive])
			writeFileSync(path.join(cache, file), read(source.root, file), { flag: "wx" });
		writeFileSync(path.join(stage, binary), bytes, { flag: "wx" });
		const preserved = ["SHASUMS256.txt", archive].map((file) => ({
			file,
			sha256: hash(read(cache, file)),
		}));
		const originalSignature = read(cache, "SHASUMS256.txt.sig");
		const originalSignatureHash = hash(originalSignature);
		const node = { path: binary, version, sha256: hash(bytes), bytes: bytes.length };
		const input = JSON.stringify({ root: stage, node, source: { ...source, root: cache } });
		const childSource = `
import cp from "node:child_process";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const original = cp.spawnSync;
cp.spawnSync = (file, ...args) => {
  if (path.basename(String(file)) === ${JSON.stringify(binary)}) process.stdout.write(${JSON.stringify(probe)});
  return original(file, ...args);
};
syncBuiltinESMExports();
const { authenticatedNodeProbe } = await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src/trusted-node.ts")).href)});
const input = JSON.parse(process.argv[1]);
try {
  await authenticatedNodeProbe(input.root, input.node, input.source);
  process.stdout.write(${JSON.stringify(accepted)});
} catch (error) {
  process.stderr.write(String(error?.message) + "\\n");
  process.exitCode = 1;
}
`;
		const run = () =>
			spawnSync(
				process.execPath,
				["--disable-sigusr1", "--input-type=module", "-e", childSource, input],
				{
					cwd: scratch,
					env: {
						PATH: process.env.PATH ?? process.env.Path,
						SystemRoot: process.env.SystemRoot,
						WINDIR: process.env.WINDIR,
						DRAFTYAK_GPG: process.env.DRAFTYAK_GPG,
						TEMP: scratch,
						TMP: scratch,
						DO_NOT_TRACK: "1",
					},
					encoding: "utf8",
					timeout: 90_000,
					maxBuffer: 65_536,
					windowsHide: true,
					shell: false,
				},
			);
		const positive = run();
		expect(positive.error).toBeUndefined();
		expect(positive.status, positive.stderr).toBe(0);
		expect(positive.stderr).toBe("");
		expect(positive.stdout).toBe(probe + accepted);
		// Preserve nonzero length so rejection must reach canonical signature verification.
		writeFileSync(path.join(cache, "SHASUMS256.txt.sig"), Buffer.alloc(originalSignature.length));
		expect(hash(read(cache, "SHASUMS256.txt.sig"))).not.toBe(originalSignatureHash);
		const negative = run();
		expect(negative.error).toBeUndefined();
		expect(negative.status, negative.stderr).toBe(1);
		expect(negative.stderr).toContain("signature check failed");
		expect(negative.stdout).toBe("");
		for (const { file, sha256 } of preserved) expect(hash(read(cache, file))).toBe(sha256);
		expect(hash(read(stage, binary))).toBe(node.sha256);
		expect(hash(read(source.root, "SHASUMS256.txt.sig"))).toBe(originalSignatureHash);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}, 180_000);
