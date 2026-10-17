import { spawn } from "node:child_process";
import path from "node:path";
import {
	type Fingerprint,
	fingerprint,
	nodeBinary,
	nodeVersions,
	writeEvidence,
} from "@draftyak/spike-kit";
import type { ProbeReply, ProbeRequest } from "./temporal-probe.ts";

export const spikeDir: string = path.resolve(import.meta.dirname, "..");
export const target: string = `${process.platform}-${process.arch}`;

export interface SelectedNode {
	readonly role: "minimum" | "bundled";
	readonly version: string;
}

// spikes-run's DRAFTYAK_NODES: both (also when unset), minimum or bundled.
export function selectedNodes(env: NodeJS.ProcessEnv = process.env): SelectedNode[] {
	const value = env.DRAFTYAK_NODES || "both";
	if (value !== "both" && value !== "minimum" && value !== "bundled") {
		throw new Error(`DRAFTYAK_NODES is both, minimum or bundled, not "${value}"`);
	}
	const versions = nodeVersions();
	return (["minimum", "bundled"] as const)
		.filter((role) => value === "both" || value === role)
		.map((role) => ({ role, version: versions[role] }));
}

// DRAFTYAK_RECORD_EVIDENCE=1 records and 0 doesn't; unset, only CI runs record.
export function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (value !== "" && value !== "0" && value !== "1") {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1" || (value === "" && !!env.CI);
}

// Runs a program without a shell, `input` on its stdin; rejects unless it exits 0.
export function run(
	command: string,
	args: readonly string[],
	options: {
		readonly input?: string;
		readonly cwd?: string;
		readonly env?: NodeJS.ProcessEnv;
	} = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? spikeDir,
			env: options.env,
			timeout: 600_000,
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject).once("close", (code) => {
			const tail = stderr.trim().split(/\r?\n/).slice(-20).join("\n");
			if (code === 0) resolve(stdout);
			else reject(new Error(`${path.basename(command)} ${args.join(" ")} exited ${code}\n${tail}`));
		});
		child.stdin.end(options.input ?? "");
	});
}

// test/temporal-probe.ts on a verified official Node binary (fetch-node, through the kit).
export async function probe(version: string, request: ProbeRequest): Promise<ProbeReply> {
	const script = path.join(spikeDir, "test", "temporal-probe.ts");
	const stdout = await run(await nodeBinary(version), ["--no-warnings", script], {
		input: JSON.stringify(request),
	});
	return JSON.parse(stdout) as ProbeReply;
}

// One fingerprint for every evidence file of a run, taken before the first is written, so a
// re-recording of tracked files still reads dirty: false; vitest.config.ts keeps the heavy files
// in one worker so they share it.
let shared: Promise<Fingerprint> | undefined;

export async function record(
	name: string,
	data: Readonly<Record<string, unknown>>,
): Promise<string> {
	shared ??= fingerprint({ cwd: spikeDir });
	const file = path.join(spikeDir, "evidence", `${name}-${target}.json`);
	return writeEvidence(file, data, { fingerprint: await shared });
}
