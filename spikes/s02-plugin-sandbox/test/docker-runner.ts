// Runs inside a Linux container (staged, read-only, --network none) with the fetched Node binaries
// mounted. It runs the whole escape matrix for each Node and prints one result line the host parses.
// Launched with plain `node docker-runner.ts <configJson>`; imports are type-stripped by Node. It
// imports only ./escape-matrix.ts and node: built-ins, so it runs unchanged in the container.

import { spawnSync } from "node:child_process";
import os from "node:os";
import {
	type ArgvReport,
	type ControlOutcome,
	type DataDirLinkOutcome,
	FIXTURES,
	type FixtureOutcome,
	type PrespawnOutcome,
	runArgvReport,
	runControl,
	runDataDirLink,
	runFixture,
	runPrespawnLink,
	setupCanaries,
	startListeners,
	VARIANTS,
} from "./escape-matrix.ts";

interface RunnerNode {
	readonly bin: string;
	readonly label: string;
}
interface RunnerConfig {
	readonly nodes: readonly RunnerNode[];
	readonly fixtureSource: string;
	readonly workRoot: string;
}

const config = JSON.parse(process.argv[2] ?? "{}") as RunnerConfig;
const canaries = setupCanaries(config.workRoot, config.fixtureSource, process.env, "linux");
const listeners = await startListeners("linux", canaries.root);

const fixtures: FixtureOutcome[] = [];
const prespawn: PrespawnOutcome[] = [];
const dataDirLinks: DataDirLinkOutcome[] = [];
const controls: ControlOutcome[] = [];
const argvReports: ArgvReport[] = [];

function nodeVersions(bin: string): { nodeVersion: string; v8Version: string } {
	const r = spawnSync(
		bin,
		["-e", "process.stdout.write(process.versions.node+' '+process.versions.v8)"],
		{
			encoding: "utf8",
		},
	);
	const [nodeVersion = "", v8Version = ""] = r.stdout.trim().split(" ");
	return { nodeVersion, v8Version };
}

for (const node of config.nodes) {
	for (const fixture of FIXTURES) {
		if (!fixture.posix) continue;
		for (const variant of VARIANTS) {
			fixtures.push(await runFixture(node.bin, node.label, canaries, listeners, fixture, variant));
		}
	}
	for (const variant of VARIANTS) {
		argvReports.push(await runArgvReport(node.bin, node.label, canaries, listeners, variant));
		// Junctions are Windows-only; symlinks and hard links are the Linux pre-spawn link cases.
		for (const kind of ["symlink", "hardlink"] as const) {
			prespawn.push(
				await runPrespawnLink(node.bin, node.label, canaries, listeners, kind, variant),
			);
		}
	}
	for (const kind of ["symlink", "hardlink"] as const) {
		dataDirLinks.push(await runDataDirLink(node.bin, node.label, canaries, listeners, kind));
	}
	for (const kind of ["sqlite", "vfs"] as const) {
		controls.push(await runControl(node.bin, node.label, canaries, listeners, kind));
	}
}

await listeners.close();

const runtime = {
	platform: process.platform,
	arch: process.arch,
	kernelVersion: os.release(),
	nodes: config.nodes.map((n) => ({ label: n.label, ...nodeVersions(n.bin) })),
};

process.stdout.write(
	`##DYMATRIX##${JSON.stringify({ cases: fixtures, prespawn, dataDirLinks, controls, argvReports, runtime })}\n`,
);
