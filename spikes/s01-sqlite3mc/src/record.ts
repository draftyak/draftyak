// node src/record.ts [vitest args]: the heavy suite with strict skips, recording this machine's
// evidence/load-<host>.json and the matrix. Other local heavy runs (verify:m0) leave evidence alone.
import { spawn } from "node:child_process";
import path from "node:path";
import { fingerprint, writeEvidence } from "@draftyak/spike-kit";
import {
	evidenceDir,
	type HostLoads,
	installedBasis,
	type LoadRun,
	writeMatrix,
} from "./matrix.ts";
import { hostTarget, spikeDir } from "./prebuilds.ts";

// DRAFTYAK_RECORD_EVIDENCE=1 records and 0 doesn't; unset, only CI runs (spikes-run) record.
export function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (value !== "" && value !== "0" && value !== "1") {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1" || (value === "" && !!env.CI);
}

// spikes-run's DRAFTYAK_NODES: both (also when unset), minimum or bundled.
export function selectedNodes(
	versions: { readonly minimum: string; readonly bundled: string },
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const value = env.DRAFTYAK_NODES || "both";
	if (value === "both") return [...new Set([versions.minimum, versions.bundled])];
	if (value === "minimum" || value === "bundled") return [versions[value]];
	throw new Error(`DRAFTYAK_NODES is both, minimum or bundled, not "${value}"`);
}

export type Planned = Pick<LoadRun, "target" | "nodeVersion" | "via">;

// The planned cases that produced no run: filtered out or skipped. Their host file isn't written.
export function unrun(planned: readonly Planned[], runs: readonly LoadRun[]): Planned[] {
	const ran = ({ target, nodeVersion, via }: Planned): boolean =>
		runs.some((run) => run.target === target && run.nodeVersion === nodeVersion && run.via === via);
	return planned.filter((pair) => !ran(pair));
}

// Writes load-<host>.json, then outside CI the matrix. A CI run uploads only its host file, so
// runners never collide; the matrix is rebuilt where their artifacts are downloaded.
export async function writeLoadEvidence(
	runs: readonly LoadRun[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
	const print = await fingerprint({ cwd: spikeDir });
	const { package: pkg, napiExpected } = await installedBasis();
	const host = hostTarget();
	const data: HostLoads = { host, package: pkg, napiExpected, runs };
	const file = path.join(evidenceDir, `load-${host}.json`);
	const written = [await writeEvidence(file, data, { fingerprint: print })];
	const matrix = env.CI ? null : await writeMatrix(evidenceDir, print);
	return matrix === null ? written : [...written, matrix];
}

if (import.meta.main) {
	// Vitest gets Ctrl+C from the console itself; stay alive until it has shut down.
	process.on("SIGINT", () => {});
	const run = path.join(spikeDir, "..", "kit", "run.ts");
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
