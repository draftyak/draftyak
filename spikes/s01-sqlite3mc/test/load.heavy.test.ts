import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	docker,
	needDocker,
	nodeBinary,
	nodeVersions,
	runInDocker,
	stageForDocker,
} from "@draftyak/spike-kit";
import { afterAll, describe, expect, it } from "vitest";
import type { LoadRun } from "../src/matrix.ts";
import {
	copyPrebuild,
	hostTarget,
	PACKAGE,
	type Prebuild,
	spikeDir,
	type Target,
} from "../src/prebuilds.ts";
import type { ProbeResult } from "../src/probe.ts";
import { type Planned, recording, selectedNodes, unrun, writeLoadEvidence } from "../src/record.ts";

// Each case runs src/probe.ts on another Node: the verified official binaries from fetch-node
// (M0.5), natively and in Docker on glibc, and the digest-pinned node:<v>-alpine images for musl,
// for which Node publishes no binary. images.json's glibc image is node:26.12.0-bookworm-slim,
// used only as Debian plus the libatomic1 Node's Linux binaries need.
const versions = selectedNodes(nodeVersions());
const images = JSON.parse(
	readFileSync(path.join(spikeDir, "..", "..", "tools", "fetch-node", "images.json"), "utf8"),
) as { glibc: string; musl: Record<string, string> };
const arch = process.arch === "arm64" ? "arm64" : "x64";
const probe = path.join(spikeDir, "src", "probe.ts");

type Case = Planned & {
	readonly target: Target;
	readonly nodeFrom: LoadRun["nodeFrom"];
	readonly image?: string;
};
const native: Case[] = versions.map((nodeVersion) => ({
	target: hostTarget(),
	nodeVersion,
	via: "native",
	nodeFrom: "fetch-node",
}));
const linux: Case[] = versions.flatMap((nodeVersion): Case[] => [
	{
		target: `linux-${arch}`,
		nodeVersion,
		via: "docker",
		nodeFrom: "fetch-node",
		image: images.glibc,
	},
	{
		target: `linuxmusl-${arch}`,
		nodeVersion,
		via: "docker",
		nodeFrom: "image",
		image: images.musl[nodeVersion] ?? "",
	},
]);

const runs: LoadRun[] = [];
const prebuilds = new Map<Target, Prebuild>();
const bundle = (target: Target): Prebuild => {
	const prebuild = prebuilds.get(target) ?? copyPrebuild(target);
	prebuilds.set(target, prebuild);
	return prebuild;
};
let stage: ReturnType<typeof stageForDocker> | undefined;

// Evidence is written only by a run asked to record (src/record.ts, CI), and only when every case
// this host can run produced a run: a name filter or a skip leaves the committed files alone.
afterAll(async () => {
	stage?.remove();
	if (!recording()) return;
	const missing = unrun([...native, ...(docker.linuxContainers() ? linux : [])], runs);
	if (missing.length > 0) {
		const pairs = missing.map(({ target, nodeVersion, via }) => `${target} ${nodeVersion} ${via}`);
		console.log(`evidence not recorded: no run for ${pairs.join(", ")}`);
		return;
	}
	for (const file of await writeLoadEvidence(runs)) console.log(`evidence: ${file}`);
});

interface Launched {
	readonly stdout: string;
	readonly stderr: string;
	readonly ended: string;
}

// Windows reports a crash as an NTSTATUS exit code, such as 0xc0000005.
function ended(code: number, signal?: string | null): string {
	if (signal) return `signal:${signal}`;
	return `exit:${code < 0 || code > 255 ? `0x${(code >>> 0).toString(16)}` : code}`;
}

// Runs a case's steps. A case that ends without the probe's JSON line for its own target and Node
// still records a failed run: the probe's exit code or signal, a timeout, the target and Node the
// probe found instead, or the error code or name of the step that threw.
async function attempt(
	c: Case,
	steps: (at: { step: string }) => Promise<Launched>,
): Promise<LoadRun> {
	const where = {
		via: c.via,
		nodeFrom: c.nodeFrom,
		...(c.image === undefined ? {} : { image: c.image }),
	};
	const failed = (error: string): LoadRun => {
		const { target, nodeVersion } = c;
		return { loaded: false, error, target, nodeVersion, napiVersion: null, ...where };
	};
	const at = { step: "setup" };
	let run: LoadRun;
	try {
		const { stdout, stderr, ended: end } = await steps(at);
		if (stderr.trim() !== "") console.log(stderr.trim());
		const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
		const result = line.startsWith("{") ? (JSON.parse(line) as ProbeResult) : undefined;
		const ours = result?.target === c.target && result.nodeVersion === c.nodeVersion;
		if (result && !ours) console.log(`probe: ${line}`);
		run =
			result && ours
				? { ...result, ...where }
				: failed(result ? `ran as ${result.target} on ${result.nodeVersion}` : end);
	} catch (error) {
		const { code, name } = error as { code?: unknown; name?: unknown };
		const named = typeof name === "string" && name !== "Error" ? name : at.step;
		runs.push(failed(typeof code === "string" ? code : named));
		throw error;
	}
	runs.push(run);
	return run;
}

function nodeProbe(node: string, prebuild: string, signal: AbortSignal): Promise<Launched> {
	const options = { cwd: spikeDir, timeout: 120_000, windowsHide: true, signal };
	return new Promise((resolve, reject) => {
		execFile(node, [probe, prebuild], options, (error, stdout, stderr) => {
			if (typeof error?.code === "string") return reject(error);
			const code = typeof error?.code === "number" ? error.code : 0;
			resolve({ stdout, stderr, ended: error?.killed ? "timeout" : ended(code, error?.signal) });
		});
	});
}

describe(`the host's prebuild (${hostTarget()})`, () => {
	it.for(native)("loads through nativeBinding on Node $nodeVersion", async (c, ctx) => {
		const run = await attempt(c, async (at) => {
			at.step = "fetch-node";
			const node = await nodeBinary(c.nodeVersion);
			at.step = "copy";
			const { file } = bundle(c.target);
			at.step = "probe";
			return nodeProbe(node, file, ctx.signal);
		});
		const { target, nodeVersion } = c;
		expect(run).toMatchObject({ loaded: true, target, nodeVersion, fromBundle: true });
	});
});

describe("Linux prebuilds in Docker, from a stageForDocker() copy", () => {
	it.for(linux)(
		"$target loads on Node $nodeVersion",
		{ tags: ["requires:docker"] },
		async (c, ctx) => {
			await needDocker(ctx);
			const run = await attempt(c, async (at) => {
				at.step = "fetch-node";
				const linuxNode = { platform: "linux", arch } as const;
				const node =
					c.nodeFrom === "fetch-node"
						? path.dirname(await nodeBinary(c.nodeVersion, linuxNode))
						: undefined;
				at.step = "stage";
				const targets: Target[] = [`linux-${arch}`, `linuxmusl-${arch}`];
				const files = targets.map((name) => path.relative(spikeDir, bundle(name).file));
				const spec = { name: "s01-load", from: spikeDir, packages: [PACKAGE] };
				const staged =
					stage ?? stageForDocker({ ...spec, files: ["package.json", "src", ...files] });
				stage = staged;
				at.step = "docker";
				const result = await runInDocker({
					image: c.image ?? "",
					network: "none",
					platform: `linux/${arch === "x64" ? "amd64" : "arm64"}`,
					mounts: [
						{ source: staged.dir, target: "/stage" },
						...(node === undefined ? [] : [{ source: node, target: "/opt/node" }]),
					],
					cmd: [
						node === undefined ? "node" : "/opt/node/node",
						"/stage/src/probe.ts",
						`/stage/bundle/prebuilds/${c.target}.node`,
					],
					signal: ctx.signal,
				});
				return { ...result, ended: result.timedOut ? "timeout" : ended(result.code) };
			});
			const { target, nodeVersion } = c;
			expect(run).toMatchObject({ loaded: true, target, nodeVersion, fromBundle: true });
			expect(run.loaded && run.libc).toMatch(
				target.startsWith("linux-") ? /^glibc \d+\.\d+$/ : /^musl$/,
			);
		},
	);
});
