import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { guardRelease } from "../src/guard.ts";
import { directory, hash, inventory, json, localPath, object, text } from "../src/integrity.ts";
import * as scheduling from "../src/schedule.ts";
import { nodeHeavyInput } from "./helpers/node-heavy-input.ts";

const worktree = path.resolve(import.meta.dirname, "../../..");
const repo = localPath(worktree);

it("guards real authenticated Node through the shared M1 scheduling oracle without claiming product acceptance", async () => {
	const { source, version, binary, bytes } = nodeHeavyInput(
		process.env.DRAFTYAK_TEST_NODE_CACHE,
		process.platform,
		process.arch,
	);
	const cache = path.join(worktree, "tools/release-guard/.cache");
	mkdirSync(cache, { recursive: true });
	directory(cache);
	const scratch = mkdtempSync(path.join(cache, "schedule-heavy-"));
	if (path.dirname(scratch) !== cache || !path.basename(scratch).startsWith("schedule-heavy-"))
		throw new Error("unsafe schedule heavy cleanup path");
	const original = scheduling.inspectScheduleEquivalence;
	const reports: scheduling.ScheduleReport[] = [];
	const inspector = vi
		.spyOn(scheduling, "inspectScheduleEquivalence")
		.mockImplementation(async (...args) => {
			const report = await original(...args);
			reports.push(report);
			return report;
		});
	try {
		writeFileSync(path.join(scratch, binary), bytes, { flag: "wx" });
		const result = await guardRelease(
			{
				schemaVersion: 1,
				version: text(object(json(repo, "apps/hub/package.json")).version),
				artifacts: inventory(scratch),
				npm: [],
				nodes: [{ path: binary, sha256: hash(bytes), bytes: bytes.length, version, source }],
			},
			{ repo, root: scratch, scope: "full" },
		);
		expect(inspector, "real canonical schedule inspector must execute").toHaveBeenCalledOnce();
		const report = reports[0];
		expect(report).toBeDefined();
		if (!report) throw new Error("real schedule inspection report missing");
		expect(report.counts).toEqual({ resolutions: 49, renderings: 36, snapshots: 12 });
		expect(report.versions.node).toBe(version);
		expect(report.versions.jiff).toBe("0.2.38");
		expect(report.boundary).toContain("M4 approval-window validation");
		expect(result.checks).toContain("schedule-equivalence");
		expect(
			result.findings.filter((finding) => finding.check.startsWith("schedule-equivalence")),
		).toEqual([]);
		expect(result.warnings ?? []).toEqual(
			report.warnings.map((reason) => ({ check: `schedule-equivalence:${binary}`, reason })),
		);
		expect(result.findings.some((finding) => finding.check === "native-features")).toBe(true);
		process.stdout.write(
			`${JSON.stringify({ check: "shared-schedule-oracle-equivalence", ...report })}\n`,
		);
	} finally {
		inspector.mockRestore();
		rmSync(scratch, { recursive: true, force: true });
	}
}, 240_000);
