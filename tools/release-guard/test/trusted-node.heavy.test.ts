import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { hash, localPath } from "../src/integrity.ts";
import { authenticatedNodeProbe } from "../src/trusted-node.ts";
import { nodeHeavyInput } from "./helpers/node-heavy-input.ts";

it("authenticates and probes an already-cached official Node offline (not a product bundle)", async () => {
	const { source, version, binary, bytes } = nodeHeavyInput(
		process.env.DRAFTYAK_TEST_NODE_CACHE,
		process.platform,
		process.arch,
	);
	const root = localPath(path.resolve(import.meta.dirname, "../.cache"));
	mkdirSync(root, { recursive: true });
	const stage = mkdtempSync(path.join(root, "draftyak-official-node-test-"));
	if (path.dirname(path.resolve(stage)) !== root) throw new Error("unsafe heavy-test scratch path");
	try {
		writeFileSync(path.join(stage, binary), bytes, { flag: "wx" });
		await expect(
			authenticatedNodeProbe(
				stage,
				{
					path: binary,
					version,
					sha256: hash(bytes),
					bytes: bytes.length,
				},
				source,
			),
		).resolves.toBeUndefined();
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
});
