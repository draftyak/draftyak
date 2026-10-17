// S2b evidence is written only when asked (DRAFTYAK_RECORD_EVIDENCE=1) or in CI, and only from a
// run in which every planned case ran and every finding holds: plain heavy runs, verify:m0
// included, and partial or failing runs write nothing. `node test/record.ts [vitest args]` is the
// strict heavy run with recording on.
import { spawn } from "node:child_process";
import path from "node:path";
import { writeEvidence } from "@draftyak/spike-kit";

// DRAFTYAK_RECORD_EVIDENCE=1 records and 0 doesn't; unset, only CI runs (spikes-run) record.
export function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (value !== "" && value !== "0" && value !== "1") {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1" || (value === "" && !!env.CI);
}

// evidence/<area>-<target>.json; a run limited by DRAFTYAK_NODES gets its own name (…-minimum.json,
// …-bundled.json), so it never replaces a file that covers both Nodes.
export function evidenceFile(
	area: string,
	target: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const nodes = env.DRAFTYAK_NODES || "both";
	const suffix = nodes === "both" ? "" : `-${nodes}`;
	return path.join(import.meta.dirname, "..", "evidence", `${area}-${target}${suffix}.json`);
}

// The planned keys (Nodes, modes) with no recorded run.
export function missing(
	label: string,
	planned: readonly string[],
	ran: ReadonlyMap<string, unknown>,
): string[] {
	return planned.filter((key) => !ran.has(key)).map((key) => `${label} ${key} did not run`);
}

export function unmet(findings: Readonly<Record<string, boolean>>): string[] {
	return Object.entries(findings)
		.filter(([, held]) => !held)
		.map(([name]) => `${name} is false`);
}

export async function recordEvidence(
	file: string,
	problems: readonly string[],
	data: Readonly<Record<string, unknown>>,
): Promise<void> {
	if (!recording()) return;
	if (problems.length > 0) {
		console.log(`evidence not recorded (${path.basename(file)}): ${problems.join("; ")}`);
		return;
	}
	console.log(`evidence: ${await writeEvidence(file, data)}`);
}

if (import.meta.main) {
	process.on("SIGINT", () => {});
	const run = path.join(import.meta.dirname, "..", "..", "kit", "run.ts");
	const env = { ...process.env, DRAFTYAK_RECORD_EVIDENCE: "1" };
	spawn(process.execPath, [run, "--heavy", "--strict", ...process.argv.slice(2)], {
		env,
		stdio: "inherit",
	})
		.once("error", (error) => {
			console.error(`record: ${error.message}`);
			process.exitCode = 2;
		})
		.once("close", (code) => {
			process.exitCode ??= code ?? 1;
		});
}
