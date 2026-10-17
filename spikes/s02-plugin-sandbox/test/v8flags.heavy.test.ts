import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostTarget, nodeBinary, nodeVersions } from "@draftyak/spike-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evidenceFile, missing, recordEvidence, unmet } from "./record.ts";
import { runV8, selectedNodes, spikeDir, type V8Outcome, v8Blocked, v8Weakened } from "./s2b.ts";

const NODES = selectedNodes(nodeVersions());
const arch = hostTarget().arch;

function hostSuite(
	label: string,
	capTag: "windows" | "linux" | "macos",
	platform: NodeJS.Platform,
): void {
	describe(`runtime V8 flag weakening (${label})`, () => {
		const bins: Record<string, string> = {};
		let root = "";
		let pluginDir = "";
		let dirs = 0;
		const production = new Map<string, V8Outcome>();
		const control = new Map<string, V8Outcome>();

		beforeAll(async () => {
			if (process.platform !== platform) return;
			for (const v of NODES) bins[v] = await nodeBinary(v, hostTarget());
			root = fs.mkdtempSync(path.join(os.tmpdir(), `dy-s02-v8-${label}-`));
			pluginDir = path.join(root, "plugin");
			fs.cpSync(path.join(spikeDir, "fixtures", "s2b"), pluginDir, { recursive: true });
		}, 180_000);

		afterAll(async () => {
			if (root) fs.rmSync(root, { recursive: true, force: true });
			if (process.platform !== platform) return;
			const findings = {
				productionAbortsTheAttack: NODES.every((v) => {
					const outcome = production.get(v);
					return outcome !== undefined && v8Blocked(outcome);
				}),
				weakeningWorksWithoutFreezeFlag: NODES.every((v) => {
					const outcome = control.get(v);
					return outcome !== undefined && v8Weakened(outcome);
				}),
			};
			await recordEvidence(
				evidenceFile("v8flags", `${platform}-${arch}`),
				[
					...missing("production", NODES, production),
					...missing("control", NODES, control),
					...unmet(findings),
				],
				{
					target: `${platform}-${arch}`,
					nodes: NODES,
					attack: "v8.setFlagsFromString('--allow-natives-syntax') then node:vm %StringParseInt",
					production: [...production].map(([node, outcome]) => ({ node, outcome })),
					control: [...control].map(([node, outcome]) => ({ node, outcome })),
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

		it("the production argv aborts the natives-syntax weakening on both Nodes", t(), async () => {
			for (const v of NODES) {
				const outcome = await runV8(bins[v] as string, pluginDir, dataDir(), true);
				production.set(v, outcome);
				// Natives were blocked before the attack, and V8's frozen-flags check then aborted the
				// plugin at setFlagsFromString, so the "after" probe never ran.
				expect(outcome.beforePrinted, `${v}: the "before" probe ran`).toBe(true);
				expect(outcome.before.error, `${v}: natives blocked before`).toBe("SyntaxError");
				expect(outcome.after, `${v}: no "after" probe`).toBeNull();
				expect(outcome.aborted, `${v}: the plugin aborted`).toBe(true);
				expect(outcome.freezeCheckFailed, `${v}: V8's frozen-flags check fired`).toBe(true);
			}
		});

		it("CONTROL: without --freeze-flags-after-init the weakening succeeds", t(), async () => {
			for (const v of NODES) {
				const outcome = await runV8(bins[v] as string, pluginDir, dataDir(), false);
				control.set(v, outcome);
				expect(outcome.before.error, `${v}: natives blocked before`).toBe("SyntaxError");
				expect(outcome.after?.worked, `${v}: natives work once V8 is weakened`).toBe(true);
			}
		});
	});
}

hostSuite("windows", "windows", "win32");
hostSuite("linux", "linux", "linux");
hostSuite("macos", "macos", "darwin");
