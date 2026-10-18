import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { hash, localPath, read } from "../src/integrity.ts";
import { authenticatedNodeProbe, type NodeSource } from "../src/trusted-node.ts";

const platform =
	process.platform === "win32" ? "win" : (process.platform as NodeSource["platform"]);
const arch = process.arch as NodeSource["arch"];
const cache = localPath(
	process.env.DRAFTYAK_TEST_NODE_CACHE ??
		(process.platform === "win32"
			? "C:/dev/.draftyak-cache/node/26.12.0"
			: path.join(homedir(), ".cache/draftyak/node/26.12.0")),
);
const binary = platform === "win" ? "node.exe" : "node";
const cached = `${platform}-${arch}/${binary}`;
const available =
	existsSync(path.join(cache, cached)) && existsSync(path.join(cache, "SHASUMS256.txt.sig"));

it.skipIf(!available)(
	"authenticates and probes an already-cached official Node offline (not a product bundle)",
	async () => {
		const root = localPath(path.resolve(import.meta.dirname, "../.cache"));
		mkdirSync(root, { recursive: true });
		const stage = mkdtempSync(path.join(root, "draftyak-official-node-test-"));
		if (path.dirname(path.resolve(stage)) !== root)
			throw new Error("unsafe heavy-test scratch path");
		try {
			const bytes = read(cache, cached);
			writeFileSync(path.join(stage, binary), bytes, { flag: "wx" });
			await expect(
				authenticatedNodeProbe(
					stage,
					{
						path: binary,
						version: "26.12.0",
						sha256: hash(bytes),
						bytes: bytes.length,
					},
					{ root: cache, platform, arch },
				),
			).resolves.toBeUndefined();
		} finally {
			rmSync(stage, { recursive: true, force: true });
		}
	},
);
