// Runs S2b's probes inside a Linux container (a read-only stage, --network none) for each mounted
// Node: `node docker-runner-s2b.ts <matrix|memory|sampler-cost|fifo> <config>`. It covers the POSIX
// paths a Windows host can't (SIGUSR1, real handle passing, /proc sampling, FIFO stdio) and prints
// one ##DYS2BMATRIX## line. It imports only ./s2b.ts, ./memory.ts and ./fifo.ts, which stay
// install-free.
import fs from "node:fs";
import path from "node:path";
import { FIFO_MODES, spawnCostOrError } from "./fifo.ts";
import {
	FAST_INTERVAL_MS,
	killSamplerFor,
	measureSamplingCost,
	PLAN_INTERVAL_MS,
	runUntouched,
	runWatchdogKill,
	samplersFor,
	spawnGrower,
} from "./memory.ts";
import {
	fuzzModes,
	runFdAdopt,
	runHubProbe,
	runInspector,
	runTemplatePlugin,
	runV8,
	runValidatorControl,
	spikeDir,
} from "./s2b.ts";

interface RunnerNode {
	readonly bin: string;
	readonly label: string;
}
interface RunnerConfig {
	readonly nodes: readonly RunnerNode[];
	readonly workRoot: string;
	readonly bundleDir?: string;
}

const [mode = "matrix", raw = "{}"] = process.argv.slice(2);
const config = JSON.parse(raw) as RunnerConfig;
const pluginDir = path.join(spikeDir, "fixtures", "s2b");
let dirs = 0;
const dataDir = (): string => {
	const dir = path.join(config.workRoot, `d${dirs++}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function matrix(node: RunnerNode) {
	const hub = (probe: string, extra: { mode?: string } = {}) =>
		runHubProbe(node.bin, probe, { pluginDir, dataDir: dataDir(), ...extra });
	const fuzz = [];
	for (const fuzzMode of fuzzModes("linux")) {
		fuzz.push({ mode: fuzzMode, run: await hub("fuzz", { mode: fuzzMode }) });
	}
	const bundle = config.bundleDir ?? "";
	return {
		label: node.label,
		channel: await hub("channel"),
		fuzz,
		fallback1: await hub("fallback1"),
		fallback1RoundTrip: await hub("fallback1-round-trip"),
		fallback1Template: await runTemplatePlugin(node.bin, bundle, dataDir(), "fallback1"),
		lateReply: await hub("late-reply"),
		sendAfterExit: await hub("send-after-exit"),
		controls: {
			malformed: await hub("control-malformed"),
			fakeAck: await hub("control-fake-ack"),
			handle: await hub("control-handle"),
		},
		fdAdopt: await runFdAdopt(node.bin, pluginDir, dataDir()),
		v8: {
			production: await runV8(node.bin, pluginDir, dataDir(), true),
			control: await runV8(node.bin, pluginDir, dataDir(), false),
		},
		inspector: {
			production: await runInspector(node.bin, pluginDir, dataDir(), true),
			control: await runInspector(node.bin, pluginDir, dataDir(), false),
		},
		template: await runTemplatePlugin(node.bin, bundle, dataDir()),
		validators: await runValidatorControl(node.bin, bundle, dataDir()),
	};
}

async function memory(node: RunnerNode) {
	const at = () => ({ nodeBin: node.bin, pluginDir, dataDir: dataDir() });
	const sampler = killSamplerFor("linux");
	const kills = [];
	for (const grow of ["arraybuffer", "wasm"]) {
		kills.push(await runWatchdogKill(at(), node.label, grow, sampler, FAST_INTERVAL_MS));
	}
	for (const grow of ["arraybuffer-fast", "wasm-fast"]) {
		kills.push(await runWatchdogKill(at(), node.label, grow, sampler, PLAN_INTERVAL_MS));
	}
	const untouched = await runUntouched(at(), node.label, samplersFor("linux"));
	return { label: node.label, kills, untouched };
}

async function samplerCost(node: RunnerNode) {
	const idle = spawnGrower({ nodeBin: node.bin, pluginDir, dataDir: dataDir() }, "idle");
	await sleep(300);
	const costs = [];
	for (const sampler of samplersFor("linux")) {
		costs.push(await measureSamplingCost(sampler, idle.pid ?? -1));
		sampler.close();
	}
	idle.kill("SIGKILL");
	const spawnCost = await spawnCostOrError(
		{ nodeBin: node.bin, pluginDir, dataDir: dataDir() },
		node.label,
	);
	return { label: node.label, costs, spawnCost };
}

// Remedy (f): every FIFO mode in a stand-in hub, then the template plugin on FIFO stdio, then the
// held-writer control for the FIFO diagnostics.
async function fifo(node: RunnerNode) {
	const modes = [];
	for (const mode of Object.keys(FIFO_MODES)) {
		modes.push({
			mode,
			run: await runHubProbe(node.bin, "fifo", { pluginDir, dataDir: dataDir(), mode }),
		});
	}
	const template = await runTemplatePlugin(node.bin, config.bundleDir ?? "", dataDir(), "fifo");
	const held = await runHubProbe(node.bin, "fifo-held", { pluginDir, dataDir: dataDir() });
	return { label: node.label, modes, template, held };
}

const runs = { matrix, memory, "sampler-cost": samplerCost, fifo } as const;
const run = runs[mode as keyof typeof runs];
if (run === undefined) throw new Error(`unknown runner mode ${mode}`);
const nodes = [];
for (const node of config.nodes) nodes.push(await run(node));
fs.writeSync(1, `##DYS2BMATRIX##${JSON.stringify({ mode, nodes })}\n`);
process.exit(0);
