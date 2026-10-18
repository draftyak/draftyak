import fs from "node:fs";
import path from "node:path";
import {
	hostTarget,
	needDocker,
	nodeBinary,
	nodeVersions,
	runInDocker,
	stageForDocker,
} from "@draftyak/spike-kit";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { MAX_MESSAGE_BYTES } from "../src/host-channel.ts";
import { PLUGIN_CHANNEL_ENV, PLUGIN_STDIO } from "../src/spawn.ts";
import { evidenceFile, missing, recordEvidence, unmet } from "./record.ts";
import {
	bundleTemplatePlugin,
	type ChannelResult,
	type ControlName,
	type ControlResult,
	channelProblem,
	controlProblem,
	type FdAdoptResult,
	FETCH_TARGETS,
	type FuzzResult,
	fuzzModes,
	fuzzProblem,
	type HubRun,
	type InspectorResult,
	inspectorStayedClosed,
	type LateReplyResult,
	lateReplyProblem,
	runFdAdopt,
	runHubProbe,
	runTemplatePlugin,
	runValidatorControl,
	type SendAfterExitResult,
	selectedNodes,
	sendAfterExitProblem,
	spikeDir,
	type TemplateResult,
	templateProblem,
	tempRoot,
	type V8Outcome,
	type ValidatorControl,
	v8Blocked,
	v8Weakened,
	validatorProblem,
} from "./s2b.ts";

const NODES = selectedNodes(nodeVersions());
const arch = hostTarget().arch;
const CONTROLS: readonly [ControlName, string][] = [
	["malformed", "control-malformed"],
	["fakeAck", "control-fake-ack"],
	["handle", "control-handle"],
];

// The fd-3 layout every run used, for the evidence.
const layout = (platform: NodeJS.Platform) => ({
	stdio: PLUGIN_STDIO,
	childChannelEnv: Object.keys(PLUGIN_CHANNEL_ENV),
	hubParser: platform === "win32" ? "libuv-frames-then-json-lines" : "json-lines",
	maxMessageBytes: MAX_MESSAGE_BYTES,
});

interface NodeRuns {
	channel?: HubRun<ChannelResult>;
	fdAdopt?: FdAdoptResult;
	fuzz: Map<string, HubRun<FuzzResult>>;
	lateReply?: HubRun<LateReplyResult>;
	sendAfterExit?: HubRun<SendAfterExitResult>;
	controls: Map<ControlName, HubRun<ControlResult>>;
	template?: TemplateResult;
	validators?: ValidatorControl;
}

// Every fact the evidence asserts, computed over the planned Nodes: a missing run is a failure.
function ipcFindings(platform: NodeJS.Platform, runs: ReadonlyMap<string, NodeRuns>) {
	const each = (test: (r: NodeRuns) => boolean): boolean =>
		NODES.every((v) => {
			const r = runs.get(v);
			return r !== undefined && test(r);
		});
	const modes = fuzzModes(platform);
	return {
		channelRoundTripsAndBrokerRefuses: each(
			(r) => !!r.channel && channelProblem(r.channel) === null,
		),
		fdAdoptionDeniedOnGatedNodes: each(
			(r) => !!r.fdAdopt && (!r.fdAdopt.gated || r.fdAdopt.denied),
		),
		hubSurvivesEveryFuzzCase: each((r) => modes.every((m) => r.fuzz.get(m)?.survived === true)),
		fuzzEndsInTheExpectedViolationAndKill: each((r) =>
			modes.every((m) => {
				const run = r.fuzz.get(m);
				return run !== undefined && fuzzProblem(m, platform, run) === null;
			}),
		),
		noHandleReachesTheHub: each((r) =>
			modes.every((m) => {
				const fds = r.fuzz.get(m)?.result?.fds;
				return fds === null || (fds !== undefined && fds.after === fds.before);
			}),
		),
		lateReplyAndSendAfterExitAreDropped: each(
			(r) =>
				!!r.lateReply &&
				!!r.sendAfterExit &&
				lateReplyProblem(r.lateReply) === null &&
				sendAfterExitProblem(r.sendAfterExit) === null,
		),
		nodeIpcParentIsUnsafe: each((r) =>
			CONTROLS.every(([name]) => {
				const run = r.controls.get(name);
				return run !== undefined && controlProblem(name, platform, run) === null;
			}),
		),
		templatePluginServesUnderProductionFlags: each(
			(r) => !!r.template && templateProblem(r.template) === null,
		),
		cfWorkerAndJitlessNeedNoCodegen: each(
			(r) => !!r.validators && validatorProblem(r.validators) === null,
		),
	};
}

function ipcEvidence(
	target: string,
	platform: NodeJS.Platform,
	runs: ReadonlyMap<string, NodeRuns>,
) {
	return {
		target,
		nodes: NODES,
		layout: layout(platform),
		fetchTargets: FETCH_TARGETS.map(({ label, expect }) => ({ label, expect })),
		runs: NODES.map((node) => {
			const r = runs.get(node);
			return {
				node,
				channel: r?.channel ?? null,
				fdAdopt: r?.fdAdopt ?? null,
				fuzz: [...(r?.fuzz ?? new Map()).entries()].map(([mode, run]) => ({ mode, ...run })),
				lateReply: r?.lateReply ?? null,
				sendAfterExit: r?.sendAfterExit ?? null,
				controls: Object.fromEntries(r?.controls ?? new Map()),
				template: r?.template ?? null,
				validators: r?.validators ?? null,
			};
		}),
		findings: ipcFindings(platform, runs),
	};
}

function hostSuite(
	label: string,
	capTag: "windows" | "linux" | "macos",
	platform: NodeJS.Platform,
): void {
	describe(`host channel, broker stub, template plugin (${label})`, () => {
		const bins: Record<string, string> = {};
		let root = "";
		let bundleDir = "";
		let pluginDir = "";
		let dirs = 0;
		const runs = new Map<string, NodeRuns>(
			NODES.map((v) => [v, { fuzz: new Map(), controls: new Map() }]),
		);
		const at = (v: string): NodeRuns => runs.get(v) as NodeRuns;

		beforeAll(async () => {
			if (process.platform !== platform) return;
			for (const v of NODES) bins[v] = await nodeBinary(v, hostTarget());
			root = tempRoot(`dy-s02-ipc-${label}-`);
			bundleDir = bundleTemplatePlugin(path.join(root, "bundle")).dir;
			pluginDir = path.join(root, "plugin");
			fs.cpSync(path.join(spikeDir, "fixtures", "s2b"), pluginDir, { recursive: true });
		}, 180_000);

		afterAll(async () => {
			if (root) fs.rmSync(root, { recursive: true, force: true });
			if (process.platform !== platform) return;
			const data = ipcEvidence(`${platform}-${arch}`, platform, runs);
			const planned = new Map([...runs].filter(([, r]) => r.channel !== undefined));
			await recordEvidence(
				evidenceFile("ipc", `${platform}-${arch}`),
				[...missing("node", NODES, planned), ...unmet(data.findings)],
				data,
			);
		});

		const t = (): { tags: string[] } => ({ tags: [`requires:${capTag}`] });
		const dataDir = (): string => {
			const dir = path.join(root, `data-${dirs++}`);
			fs.mkdirSync(dir, { recursive: true });
			return dir;
		};
		const hub = <T>(v: string, probe: string, mode?: string): Promise<HubRun<T>> =>
			runHubProbe<T>(bins[v] as string, probe, { pluginDir, dataDir: dataDir(), mode });

		it(
			"round-trips JSON-RPC on fd 3; the broker refuses the inspector and hub ports",
			t(),
			async () => {
				for (const v of NODES) {
					const run = await hub<ChannelResult>(v, "channel");
					at(v).channel = run;
					expect(channelProblem(run), v).toBeNull();
				}
			},
		);

		it(
			"denies adopting a non-IPC fd 3 as a socket on Node >= 26.11 (records 26.5.1)",
			t(),
			async () => {
				for (const v of NODES) {
					const fdAdopt = await runFdAdopt(bins[v] as string, pluginDir, dataDir());
					at(v).fdAdopt = fdAdopt;
					if (fdAdopt.gated)
						expect([fdAdopt.outcome, fdAdopt.code], v).toEqual(["denied", "ERR_ACCESS_DENIED"]);
				}
			},
		);

		it("survives every hostile host-channel input and SIGKILLs the plugin", t(), async () => {
			for (const v of NODES) {
				for (const mode of fuzzModes(platform)) {
					const run = await hub<FuzzResult>(v, "fuzz", mode);
					at(v).fuzz.set(mode, run);
					expect(fuzzProblem(mode, platform, run), `${v} ${mode}`).toBeNull();
				}
			}
		});

		it("drops a late reply and a send to a plugin that has exited", t(), async () => {
			for (const v of NODES) {
				const late = await hub<LateReplyResult>(v, "late-reply");
				at(v).lateReply = late;
				const after = await hub<SendAfterExitResult>(v, "send-after-exit");
				at(v).sendAfterExit = after;
				expect(lateReplyProblem(late), v).toBeNull();
				expect(sendAfterExitProblem(after), v).toBeNull();
			}
		});

		it(
			"CONTROL: Node's own stdio 'ipc' parent is what a plugin can crash or hand a handle",
			t(),
			async () => {
				for (const v of NODES) {
					for (const [name, probe] of CONTROLS) {
						const run = await hub<ControlResult>(v, probe);
						at(v).controls.set(name, run);
						expect(controlProblem(name, platform, run), `${v} ${name}`).toBeNull();
					}
				}
			},
		);

		it(
			"serves the template plugin under the production flags (discover, list, call)",
			t(),
			async () => {
				for (const v of NODES) {
					const result = await runTemplatePlugin(bins[v] as string, bundleDir, dataDir());
					at(v).template = result;
					expect(templateProblem(result), v).toBeNull();
				}
			},
		);

		it(
			"CONTROL: the default Ajv validator needs codegen; cf-worker and zod jitless don't",
			t(),
			async () => {
				for (const v of NODES) {
					const result = await runValidatorControl(bins[v] as string, bundleDir, dataDir());
					at(v).validators = result;
					expect(validatorProblem(result), v).toBeNull();
				}
			},
		);
	});
}

hostSuite("windows", "windows", "win32");
hostSuite("linux", "linux", "linux");
hostSuite("macos", "macos", "darwin");

// The same probes in Linux Docker (both Nodes), plus the POSIX paths a Windows host can't take:
// SIGUSR1, a real handle passed to the hub, and the IPC fd's EEXIST. Writes the Docker evidence
// for the IPC, V8 and inspector areas.
interface DockerNode {
	readonly label: string;
	readonly channel: HubRun<ChannelResult>;
	readonly fuzz: { readonly mode: string; readonly run: HubRun<FuzzResult> }[];
	readonly lateReply: HubRun<LateReplyResult>;
	readonly sendAfterExit: HubRun<SendAfterExitResult>;
	readonly controls: Record<ControlName, HubRun<ControlResult>>;
	readonly fdAdopt: FdAdoptResult;
	readonly v8: { readonly production: V8Outcome; readonly control: V8Outcome };
	readonly inspector: { readonly production: InspectorResult; readonly control: InspectorResult };
	readonly template: TemplateResult;
	readonly validators: ValidatorControl;
}

describe("Linux Docker S2b matrix", () => {
	it("runs every S2b probe in Linux on both Nodes", {
		tags: ["requires:docker"],
		timeout: 280_000,
	}, async (ctx: TestContext) => {
		await needDocker(ctx);
		const images = path.resolve(spikeDir, "..", "..", "tools", "fetch-node", "images.json");
		const glibcImage: string = JSON.parse(fs.readFileSync(images, "utf8")).glibc;
		const bins: string[] = [];
		for (const v of NODES) bins.push(await nodeBinary(v, { platform: "linux", arch }));
		using stage = stageForDocker({
			name: "s02-s2b",
			from: spikeDir,
			files: [
				"src",
				"fixtures/s2b",
				"test/s2b.ts",
				"test/memory.ts",
				"test/hub-probes.ts",
				"test/docker-runner-s2b.ts",
			],
		});
		bundleTemplatePlugin(path.join(stage.dir, "bundle"));
		const nodes = NODES.map((label, i) => ({ bin: `/opt/n${i}`, label }));
		const config = { nodes, workRoot: "/tmp/dywork", bundleDir: "/stage/bundle" };
		const result = await runInDocker({
			image: glibcImage,
			network: "none",
			mounts: [
				{ source: stage.dir, target: "/stage" },
				...bins.map((bin, i) => ({ source: bin, target: `/opt/n${i}` })),
			],
			cmd: [
				nodes.at(-1)?.bin as string,
				"/stage/test/docker-runner-s2b.ts",
				"matrix",
				JSON.stringify(config),
			],
			signal: ctx.signal,
			timeoutMs: 240_000,
		});
		expect(result.code, `runner exit ${result.code}; stderr: ${result.stderr.slice(-800)}`).toBe(0);
		const line = result.stdout.split(/\r?\n/).findLast((l) => l.startsWith("##DYS2BMATRIX##"));
		expect(line, `no matrix line; stdout tail: ${result.stdout.slice(-400)}`).toBeDefined();
		const matrix = JSON.parse((line as string).slice("##DYS2BMATRIX##".length)) as {
			nodes: DockerNode[];
		};
		expect(matrix.nodes.map((n) => n.label)).toEqual(NODES);
		const runs = new Map<string, NodeRuns>();
		for (const n of matrix.nodes) {
			expect(channelProblem(n.channel), n.label).toBeNull();
			for (const { mode, run } of n.fuzz)
				expect(fuzzProblem(mode, "linux", run), `${n.label} ${mode}`).toBeNull();
			expect(lateReplyProblem(n.lateReply), n.label).toBeNull();
			expect(sendAfterExitProblem(n.sendAfterExit), n.label).toBeNull();
			for (const [name] of CONTROLS)
				expect(controlProblem(name, "linux", n.controls[name]), `${n.label} ${name}`).toBeNull();
			if (n.fdAdopt.gated) expect(n.fdAdopt.denied, `${n.label}: fd-3 adoption denied`).toBe(true);
			expect(v8Blocked(n.v8.production), `${n.label}: V8 freeze aborts the attack`).toBe(true);
			expect(v8Weakened(n.v8.control), `${n.label}: control weakens V8`).toBe(true);
			expect(inspectorStayedClosed(n.inspector.production), `${n.label}: no inspector`).toBe(true);
			expect(n.inspector.control.hubInspectorOpened, `${n.label}: control opens it`).toBe(true);
			expect(templateProblem(n.template), n.label).toBeNull();
			expect(validatorProblem(n.validators), n.label).toBeNull();
			runs.set(n.label, {
				channel: n.channel,
				fdAdopt: n.fdAdopt,
				fuzz: new Map(n.fuzz.map(({ mode, run }) => [mode, run])),
				lateReply: n.lateReply,
				sendAfterExit: n.sendAfterExit,
				controls: new Map(Object.entries(n.controls) as [ControlName, HubRun<ControlResult>][]),
				template: n.template,
				validators: n.validators,
			});
		}
		const target = `docker-linux-${arch}`;
		const file = (area: string): string => evidenceFile(area, target);
		const ipc = { ...ipcEvidence(target, "linux", runs), image: glibcImage };
		await recordEvidence(file("ipc"), unmet(ipc.findings), ipc);
		const v8 = {
			target,
			nodes: NODES,
			image: glibcImage,
			production: matrix.nodes.map((n) => ({ node: n.label, outcome: n.v8.production })),
			control: matrix.nodes.map((n) => ({ node: n.label, outcome: n.v8.control })),
			findings: {
				productionAbortsTheAttack: matrix.nodes.every((n) => v8Blocked(n.v8.production)),
				weakeningWorksWithoutFreezeFlag: matrix.nodes.every((n) => v8Weakened(n.v8.control)),
			},
		};
		await recordEvidence(file("v8flags"), unmet(v8.findings), v8);
		const inspector = {
			target,
			nodes: NODES,
			image: glibcImage,
			production: matrix.nodes.map((n) => ({ node: n.label, ...n.inspector.production })),
			control: matrix.nodes.map((n) => ({ node: n.label, ...n.inspector.control })),
			findings: {
				noInspectorUnderDisableSigusr1: matrix.nodes.every((n) =>
					inspectorStayedClosed(n.inspector.production),
				),
				controlOpensInspectorWithoutTheFlag: matrix.nodes.every(
					(n) => n.inspector.control.hubInspectorOpened,
				),
			},
		};
		await recordEvidence(file("inspector"), unmet(inspector.findings), inspector);
	});
});
