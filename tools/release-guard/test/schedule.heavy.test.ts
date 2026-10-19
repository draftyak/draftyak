import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { cacheRoot } from "../../fetch-node/fetch-node.mjs";
import { directory, hash, localPath, read } from "../src/integrity.ts";
import { inspectScheduleEquivalence } from "../src/schedule.ts";

const worktree = path.resolve(import.meta.dirname, "../../..");
const repo = localPath(
	process.env.DRAFTYAK_SCHEDULE_SOURCE_REPO ?? path.join(worktree, ".cache/product"),
);
const artifactInput = process.env.DRAFTYAK_SCHEDULE_NATIVE_ARTIFACT;
const artifact = artifactInput ? localPath(artifactInput) : undefined;
const version = "26.12.0";
const platform = process.platform === "win32" ? "win" : process.platform;
const nodeSource = localPath(path.join(cacheRoot(), "node", version));
const nodeFile = path.join(
	nodeSource,
	`${platform}-${process.arch}`,
	platform === "win" ? "node.exe" : "node",
);
const missing = !artifact || !existsSync(repo) || !existsSync(nodeFile) || !existsSync(artifact);

it.skipIf(missing && process.env.DRAFTYAK_STRICT_SKIPS !== "1")(
	"compiles the actual native scheduling module offline and compares authenticated Node Temporal (native-component acceptance only)",
	async () => {
		if (missing || !artifact)
			throw new Error(
				"requires reviewed source snapshot, authenticated cached Node and DRAFTYAK_SCHEDULE_NATIVE_ARTIFACT (single-link staged native candidate)",
			);
		const cache = path.join(worktree, "tools/release-guard/.cache");
		mkdirSync(cache, { recursive: true });
		directory(cache);
		const scratch = mkdtempSync(path.join(cache, "schedule-heavy-"));
		if (path.dirname(scratch) !== cache || !path.basename(scratch).startsWith("schedule-heavy-"))
			throw new Error("unsafe schedule heavy cleanup path");
		try {
			const nativePath = localPath(artifact);
			// All inputs are read through the link-free, single-link integrity reader.
			const native = read(path.dirname(nativePath), path.basename(nativePath));
			const official = read(path.dirname(nodeFile), path.basename(nodeFile));
			copyFileSync(nativePath, path.join(scratch, "native-candidate"));
			copyFileSync(nodeFile, path.join(scratch, "node"));
			const report = await inspectScheduleEquivalence({
				repo,
				root: scratch,
				nativeArtifact: { path: "native-candidate", sha256: hash(native), bytes: native.length },
				node: { path: "node", sha256: hash(official), bytes: official.length, version },
				nodeSource: {
					root: nodeSource,
					platform: platform as "win" | "linux" | "darwin",
					arch: process.arch as "x64" | "arm64",
				},
			});
			expect(report.counts.transitions).toBe(12);
			expect(report.counts.walls).toBe(72);
			expect(report.counts.instants).toBe(96);
			expect(report.counts.schedules).toBeGreaterThan(384);
			expect(report.versions.node).toBe(version);
			expect(report.versions.jiff).toBe("0.2.38");
			process.stdout.write(
				`${JSON.stringify({ check: "native-component-schedule-equivalence", ...report })}\n`,
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	},
	240_000,
);
