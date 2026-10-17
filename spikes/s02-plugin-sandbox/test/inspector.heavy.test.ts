import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireBenchLock, hostTarget, nodeBinary, nodeVersions } from "@draftyak/spike-kit";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { evidenceFile, missing, recordEvidence, unmet } from "./record.ts";
import {
	type InspectorResult,
	inspectorStayedClosed,
	runInspector,
	selectedNodes,
	spikeDir,
} from "./s2b.ts";

const NODES = selectedNodes(nodeVersions());
const arch = hostTarget().arch;

function hostSuite(
	label: string,
	capTag: "windows" | "linux" | "macos",
	platform: NodeJS.Platform,
): void {
	describe(`inspector / signal attack vs a --disable-sigusr1 hub (${label})`, () => {
		const bins: Record<string, string> = {};
		let root = "";
		let pluginDir = "";
		let dirs = 0;
		const production = new Map<string, InspectorResult>();
		const control = new Map<string, InspectorResult>();

		beforeAll(async () => {
			if (process.platform !== platform) return;
			for (const v of NODES) bins[v] = await nodeBinary(v, hostTarget());
			root = fs.mkdtempSync(path.join(os.tmpdir(), `dy-s02-insp-${label}-`));
			pluginDir = path.join(root, "plugin");
			fs.cpSync(path.join(spikeDir, "fixtures", "s2b"), pluginDir, { recursive: true });
		}, 180_000);

		afterAll(async () => {
			if (root) fs.rmSync(root, { recursive: true, force: true });
			if (process.platform !== platform) return;
			const findings = {
				noInspectorUnderDisableSigusr1: NODES.every((v) => {
					const run = production.get(v);
					return run !== undefined && inspectorStayedClosed(run);
				}),
				controlOpensInspectorWithoutTheFlag: NODES.every(
					(v) => control.get(v)?.hubInspectorOpened === true,
				),
			};
			await recordEvidence(
				evidenceFile("inspector", `${platform}-${arch}`),
				[
					...missing("production", NODES, production),
					...missing("control", NODES, control),
					...unmet(findings),
				],
				{
					target: `${platform}-${arch}`,
					nodes: NODES,
					platform,
					production: [...production].map(([node, run]) => ({ node, ...run })),
					control: [...control].map(([node, run]) => ({ node, ...run })),
					findings,
				},
			);
		});

		const t = (): { tags: string[] } => ({ tags: [`requires:${capTag}`] });
		const dataDir = (): string => {
			const dir = path.join(root, `data-${dirs++}`);
			fs.mkdirSync(dir, { recursive: true });
			return dir;
		};
		// An opened inspector binds the fixed port 127.0.0.1:9229, so each run holds the machine lock
		// (port-only: no idle check).
		const attack = async (
			ctx: TestContext,
			v: string,
			disableSigusr1: boolean,
		): Promise<InspectorResult> => {
			using _lock = await acquireBenchLock({
				label: "s2b-inspector-9229",
				idle: false,
				signal: ctx.signal,
			});
			return runInspector(bins[v] as string, pluginDir, dataDir(), disableSigusr1);
		};

		it("opens no inspector on the hub (both Nodes)", t(), async (ctx) => {
			for (const v of NODES) {
				const run = await attack(ctx, v, true);
				production.set(v, run);
				expect(run.answers, `${v}: the stand-in hub answered`).toBeGreaterThan(0);
				expect(run.hubInspectorOpened, `${v}: hub inspector stayed closed`).toBe(false);
			}
		});

		it("CONTROL: a hub without --disable-sigusr1 gets its inspector opened", t(), async (ctx) => {
			for (const v of NODES) {
				const run = await attack(ctx, v, false);
				control.set(v, run);
				expect(run.hubInspectorOpened, `${v}: the attack opens it without the flag`).toBe(true);
			}
		});
	});
}

hostSuite("windows", "windows", "win32");
hostSuite("linux", "linux", "linux");
hostSuite("macos", "macos", "darwin");
