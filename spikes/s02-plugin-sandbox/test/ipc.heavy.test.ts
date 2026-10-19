import fs from "node:fs";
import net from "node:net";
import os from "node:os";
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
import { openFifoStdio } from "../src/fifo-stdio.ts";
import { MAX_MESSAGE_BYTES } from "../src/host-channel.ts";
import { PLUGIN_CHANNEL_ENV, PLUGIN_STDIO } from "../src/spawn.ts";
import {
	endingCounts,
	type Fallback1RoundTripResult,
	FIFO_MODES,
	type FifoHeldResult,
	type FifoResult,
	fallback1RoundTripProblem,
	fifoHeldProblem,
	fifoHeldSummary,
	fifoProblems,
	fifoSummary,
	HOST_FRAME_TAG,
} from "./fifo.ts";
import { describeFds, fdOf, fifoHolders } from "./hub-probes.ts";
import { evidenceFile, missing, recordEvidence, unmet } from "./record.ts";
import {
	bundleTemplatePlugin,
	type ChannelResult,
	type ControlName,
	type ControlResult,
	channelProblem,
	controlProblem,
	type Fallback1Result,
	type FdAdoptResult,
	FETCH_TARGETS,
	type FuzzResult,
	fallback1Problem,
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

// Fallback 1 on spawn's own pipes, per Node: the hostile reinstate (a plugin that reinstates
// process.send over stdout and passes a handle must not grow the hub's descriptor count) and the
// benign round trip and template plugin. Written to its own file, so it never depends on the fuzz
// finding (which fails on macOS under rule (d)).
interface Fallback1Node {
	hostile?: HubRun<Fallback1Result>;
	roundTrip?: HubRun<Fallback1RoundTripResult>;
	template?: TemplateResult;
}

const FALLBACK1_LAYOUT = {
	stdio:
		"spawn's three pipes (socketpairs on Linux and macOS, named pipes on Windows); no fd 3 and no NODE_CHANNEL_*",
	stdoutParser: "lines tagged as host frames or MCP, each lane json-lines under the fd-3 decoder",
	hostFrameTag: `0x${HOST_FRAME_TAG.toString(16)}`,
};

function fallback1Evidence(
	target: string,
	runs: ReadonlyMap<string, Fallback1Node>,
	nodes: readonly string[],
) {
	const every = (test: (node: Fallback1Node) => boolean): boolean =>
		nodes.every((v) => {
			const node = runs.get(v);
			return node !== undefined && test(node);
		});
	const findings = {
		hubTakesNoDescriptorWithoutAnIpcChannel: every(
			(node) => node.hostile !== undefined && fallback1Problem(node.hostile) === null,
		),
		roundTripsOnSpawnPipes: every(
			(node) => node.roundTrip !== undefined && fallback1RoundTripProblem(node.roundTrip) === null,
		),
		templatePluginServesOnSpawnPipes: every(
			(node) => node.template !== undefined && templateProblem(node.template) === null,
		),
	};
	return {
		data: {
			target,
			nodes,
			layout: FALLBACK1_LAYOUT,
			runs: nodes.map((node) => ({
				node,
				hostile: runs.get(node)?.hostile ?? null,
				roundTrip: runs.get(node)?.roundTrip ?? null,
				template: runs.get(node)?.template ?? null,
			})),
			findings,
		},
		problems: [...missing("fallback1 node", nodes, runs), ...unmet(findings)],
	};
}

interface FifoNode {
	readonly modes: ReadonlyMap<string, HubRun<FifoResult>>;
	readonly template: TemplateResult | undefined;
}

const FIFO_MODE_NAMES = Object.keys(FIFO_MODES);
const SEND_MODES = FIFO_MODE_NAMES.filter((mode) => FIFO_MODES[mode]?.handlesOver != null);
const NODE_LINE_MODES = FIFO_MODE_NAMES.filter((mode) => FIFO_MODES[mode]?.violation === "handle");
const FIFO_LAYOUT = {
	fifos:
		"mkfifo -m 600 in a fresh 0700 temp dir, unlinked once both ends are open: no socket joins hub and plugin",
	stdio: "stdin, stdout and stderr; no fd 3 and no NODE_CHANNEL_* (Fallback 1)",
	fd3: "the stdio layout plus fd 3, a FIFO the plugin writes, with NODE_CHANNEL_FD=3",
	stdoutParser: "lines tagged as host frames or MCP, each lane json-lines under the fd-3 decoder",
	hostFrameTag: `0x${HOST_FRAME_TAG.toString(16)}`,
	maxMessageBytes: MAX_MESSAGE_BYTES,
	handleSends:
		"ten per mode, each ending ENOTSOCK in the plugin, with no byte read by the hub from the FIFO they went over",
	endOfFile:
		"each FIFO the plugin writes ends at end-of-file, through libuv or at its exit through a non-blocking drain until read returns 0, or the hub closes it at a violation",
	modes: FIFO_MODES,
};

// Remedy (f) holds on a target when every FIFO mode and the template plugin pass on every Node;
// written to its own file whatever the fuzz and Fallback-1 findings (which fail on macOS). The
// held-writer control is recorded beside each Node's runs, but no finding depends on it.
function fifoEvidence(
	target: string,
	runs: ReadonlyMap<string, FifoNode>,
	nodes: readonly string[],
	held: ReadonlyMap<string, HubRun<FifoHeldResult>> = new Map(),
) {
	const every = (test: (node: FifoNode) => boolean): boolean =>
		nodes.every((v) => {
			const node = runs.get(v);
			return node !== undefined && test(node);
		});
	const hold =
		(...modes: string[]) =>
		(node: FifoNode): boolean =>
			modes.every((mode) => {
				const run = node.modes.get(mode);
				return run !== undefined && fifoProblems(mode, run).length === 0;
			});
	const findings = {
		roundTripsOnFifoStdio: every(hold("round-trip")),
		templatePluginServesOnFifoStdio: every(
			(node) => node.template !== undefined && templateProblem(node.template) === null,
		),
		fifosUnlinkedBeforeEverySpawn: every((node) =>
			FIFO_MODE_NAMES.every((mode) => {
				const at = node.modes.get(mode)?.result?.beforeSpawn;
				return at?.folderGone === true && at.unlinkedFifos === at.ends;
			}),
		),
		everyHandleSendFailsWithEnotsock: every(hold(...SEND_MODES)),
		decoderKillsNodeMessagesOnFifos: every(hold(...NODE_LINE_MODES)),
		hubDescriptorsHold: every((node) =>
			FIFO_MODE_NAMES.every((mode) => {
				const fds = node.modes.get(mode)?.result?.fds;
				return fds != null && fds.after === fds.before;
			}),
		),
	};
	return {
		data: {
			target,
			nodes,
			layout: FIFO_LAYOUT,
			runs: nodes.map((node) => ({
				node,
				endings: endingCounts(runs.get(node)?.modes.values() ?? []),
				modes: [...(runs.get(node)?.modes ?? new Map())].map(([mode, run]) => ({ mode, ...run })),
				template: runs.get(node)?.template ?? null,
				heldWriter: held.get(node) ?? null,
			})),
			findings,
		},
		problems: [...missing("fifo node", nodes, runs), ...unmet(findings)],
	};
}

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
		const fallback1 = new Map<string, Fallback1Node>();
		const fifo = new Map<string, FifoNode>();
		const held = new Map<string, HubRun<FifoHeldResult>>();
		const at = (v: string): NodeRuns => runs.get(v) as NodeRuns;
		const f1 = (v: string): Fallback1Node => {
			const node = fallback1.get(v) ?? {};
			fallback1.set(v, node);
			return node;
		};

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
			const target = `${platform}-${arch}`;
			const data = ipcEvidence(target, platform, runs);
			const planned = new Map([...runs].filter(([, r]) => r.channel !== undefined));
			await recordEvidence(
				evidenceFile("ipc", target),
				[...missing("node", NODES, planned), ...unmet(data.findings)],
				data,
			);
			const fb = fallback1Evidence(target, fallback1, NODES);
			await recordEvidence(evidenceFile("fallback1", target), fb.problems, fb.data);
			if (platform === "win32") return;
			const f = fifoEvidence(target, fifo, NODES, held);
			await recordEvidence(evidenceFile("fifo", target), f.problems, f.data);
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

		// Every Node and mode runs before the verdict, so one failure can't hide another's result.
		it("survives every hostile host-channel input and SIGKILLs the plugin", t(), async () => {
			const problems: string[] = [];
			for (const v of NODES) {
				for (const mode of fuzzModes(platform)) {
					const run = await hub<FuzzResult>(v, "fuzz", mode);
					at(v).fuzz.set(mode, run);
					const problem = fuzzProblem(mode, platform, run);
					if (problem !== null) problems.push(`${v} ${mode}: ${problem}`);
				}
			}
			expect(problems).toEqual([]);
		});

		// Fallback 1 (the recommended remedy): with no fd 3 and no NODE_CHANNEL_*, a plugin reinstates
		// process.send over stdout and tries to pass a handle; the hub reading stdout as a plain stream
		// must not take the descriptor. Checks the recommended design on every OS, macOS included.
		it(
			"a plugin cannot grow the hub's descriptors without an IPC channel (Fallback 1)",
			t(),
			async () => {
				const problems: string[] = [];
				for (const v of NODES) {
					const run = await hub<Fallback1Result>(v, "fallback1");
					f1(v).hostile = run;
					const problem = fallback1Problem(run);
					if (problem !== null) problems.push(`${v}: ${problem}`);
				}
				expect(problems).toEqual([]);
			},
		);

		// Fallback 1's channel itself on spawn's own pipes (the pipes Windows keeps under remedy (f)):
		// MCP and tagged host frames round-trip with the broker's verdicts, and the template plugin
		// serves, with no fd 3 and no NODE_CHANNEL_*. Every Node runs before the verdict.
		it(
			"Fallback 1 round-trips MCP and host frames on spawn's pipes, and serves the template plugin",
			t(),
			async () => {
				const problems: string[] = [];
				for (const v of NODES) {
					const roundTrip = await hub<Fallback1RoundTripResult>(v, "fallback1-round-trip");
					f1(v).roundTrip = roundTrip;
					const problem = fallback1RoundTripProblem(roundTrip);
					if (problem !== null) problems.push(`${v}: ${problem}`);
					const template = await runTemplatePlugin(
						bins[v] as string,
						bundleDir,
						dataDir(),
						"fallback1",
					);
					f1(v).template = template;
					const served = templateProblem(template);
					if (served !== null) problems.push(`${v} template on spawn's pipes: ${served}`);
				}
				expect(problems).toEqual([]);
			},
		);

		// Remedy (f): the plugin's stdio on FIFOs, which can't carry a descriptor, so every
		// handle-bearing write fails in the plugin, over fd 3 or a stdout or stderr reinstated with
		// _forkChild, and the hub's count holds. Every mode and Node runs before the verdict.
		it(platform === "win32"
			? "FIFO stdio (remedy (f)) is not run on Windows: it has no FIFOs, and its pipes carry no descriptors"
			: "on FIFO stdio no plugin can hand the hub a descriptor, over fd 3 or a reinstated stdout or stderr (remedy (f))", {
			tags: [`requires:${capTag}`, "requires:posix"],
		}, async () => {
			const problems: string[] = [];
			for (const v of NODES) {
				const modes = new Map<string, HubRun<FifoResult>>();
				for (const mode of FIFO_MODE_NAMES) {
					const run = await hub<FifoResult>(v, "fifo", mode);
					modes.set(mode, run);
					for (const problem of fifoProblems(mode, run)) problems.push(`${v} ${mode}: ${problem}`);
				}
				console.log(fifoSummary(v, modes));
				const template = await runTemplatePlugin(bins[v] as string, bundleDir, dataDir(), "fifo");
				fifo.set(v, { modes, template });
				const problem = templateProblem(template);
				if (problem !== null) problems.push(`${v} template on FIFO stdio: ${problem}`);
			}
			expect(problems).toEqual([]);
		});

		// The FIFO diagnostics themselves, end to end: a writer the hub keeps past the plugin's exit
		// must leave the drain with EAGAIN, show among the FIFO's holders, and once closed let the
		// drain end the FIFO. Its own test, so it never decides whether the FIFO control's file is
		// written.
		it(platform === "win32"
			? "CONTROL: the FIFO diagnostics are not run on Windows: it has no FIFOs"
			: "CONTROL: a FIFO writer that outlives the plugin is found by the drain and named among the holders", {
			tags: [`requires:${capTag}`, "requires:posix"],
		}, async () => {
			const problems: string[] = [];
			for (const v of NODES) {
				const run = await hub<FifoHeldResult>(v, "fifo-held");
				held.set(v, run);
				console.log(fifoHeldSummary(v, run));
				const problem = fifoHeldProblem(run);
				if (problem !== null) problems.push(`${v}: ${problem}`);
			}
			expect(problems).toEqual([]);
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

// describeFds names a grown descriptor from lsof on macOS; that branch and parseLsof have no macOS
// coverage otherwise (diagnostics.test.ts is a unit test, which spikes.yml never runs on the runner).
// This self-check runs before the fuzz finding: the hub holds both ends of a connected UNIX socket,
// and describeFds must list them and match each as the other's peer; on a miss the raw lsof shows why.
describe("macOS lsof descriptor diagnostics (self-check)", () => {
	it("lists a connected socket and finds its peer in the hub's own table", {
		tags: ["requires:macos"],
		timeout: 30_000,
	}, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dy-s02-lsof-"));
		const sockPath = path.join(dir, "s.sock");
		const server = net.createServer();
		let client: net.Socket | undefined;
		let accepted: net.Socket | undefined;
		try {
			await new Promise<void>((resolve) => server.listen(sockPath, resolve));
			const incoming = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
			client = net.connect(sockPath);
			await new Promise((resolve) => (client as net.Socket).once("connect", resolve));
			accepted = await incoming;
			const clientFd = fdOf(client);
			const serverFd = fdOf(accepted);
			const labels = new Map([
				[clientFd, "client end"],
				[serverFd, "server end"],
			]);
			const lines = describeFds([clientFd, serverFd], labels);
			const shown = lines.join(" | ");
			expect(shown, shown).not.toMatch(/not listed by lsof/);
			expect(shown, shown).toMatch(/peer fd/);
		} finally {
			client?.destroy();
			accepted?.destroy();
			server.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// The FIFO control lists who holds a FIFO that a writer still holds at the drain (fifoHolders);
	// here the hub holds both ends of one, and lsof must list exactly those two, with their access,
	// matched by inode (macOS's lsof prints no device for a FIFO). On a miss, lsof's own lines for
	// the two descriptors show why.
	it("lists both ends of a FIFO the hub holds, by inode", {
		tags: ["requires:macos"],
		timeout: 60_000,
	}, async () => {
		const fifo = await openFifoStdio(1);
		try {
			const reader = fifo.hubFds[1] ?? -1;
			const writer = fifo.pluginFds[1] ?? -1;
			const { dev, ino } = fs.fstatSync(reader, { bigint: true });
			const { holders, raw } = fifoHolders([{ dev, ino }], [reader, writer]);
			const [found] = holders;
			const shown = `${found?.join(" | ") ?? "not listed"}; lsof: ${raw || "nothing"}`;
			expect(found?.toSorted(), shown).toEqual(
				[`hub fd ${reader} r`, `hub fd ${writer} w`].toSorted(),
			);
		} finally {
			fifo.destroy();
		}
	});
});

// The same probes in Linux Docker (both Nodes), plus the POSIX paths a Windows host can't take:
// SIGUSR1, a real handle passed to the hub, and the IPC fd's EEXIST. Writes the Docker evidence
// for the IPC, V8 and inspector areas.
interface DockerNode {
	readonly label: string;
	readonly channel: HubRun<ChannelResult>;
	readonly fuzz: { readonly mode: string; readonly run: HubRun<FuzzResult> }[];
	readonly fallback1: HubRun<Fallback1Result>;
	readonly fallback1RoundTrip: HubRun<Fallback1RoundTripResult>;
	readonly fallback1Template: TemplateResult;
	readonly lateReply: HubRun<LateReplyResult>;
	readonly sendAfterExit: HubRun<SendAfterExitResult>;
	readonly controls: Record<ControlName, HubRun<ControlResult>>;
	readonly fdAdopt: FdAdoptResult;
	readonly v8: { readonly production: V8Outcome; readonly control: V8Outcome };
	readonly inspector: { readonly production: InspectorResult; readonly control: InspectorResult };
	readonly template: TemplateResult;
	readonly validators: ValidatorControl;
}

// docker-runner-s2b.ts in the images.json glibc image (--network none, a read-only stage with the
// template-plugin bundle), on both Nodes; returns the image and the runner's per-Node results.
async function s2bInDocker<T extends { readonly label: string }>(
	ctx: TestContext,
	mode: "matrix" | "fifo",
): Promise<{ image: string; nodes: T[] }> {
	const images = path.resolve(spikeDir, "..", "..", "tools", "fetch-node", "images.json");
	const image: string = JSON.parse(fs.readFileSync(images, "utf8")).glibc;
	const bins: string[] = [];
	for (const v of NODES) bins.push(await nodeBinary(v, { platform: "linux", arch }));
	using stage = stageForDocker({
		name: `s02-s2b-${mode}`,
		from: spikeDir,
		files: [
			"src",
			"fixtures/s2b",
			"test/s2b.ts",
			"test/memory.ts",
			"test/hub-probes.ts",
			"test/fifo.ts",
			"test/docker-runner-s2b.ts",
		],
	});
	bundleTemplatePlugin(path.join(stage.dir, "bundle"));
	const nodes = NODES.map((label, i) => ({ bin: `/opt/n${i}`, label }));
	const config = { nodes, workRoot: "/tmp/dywork", bundleDir: "/stage/bundle" };
	const result = await runInDocker({
		image,
		network: "none",
		mounts: [
			{ source: stage.dir, target: "/stage" },
			...bins.map((bin, i) => ({ source: bin, target: `/opt/n${i}` })),
		],
		cmd: [
			nodes.at(-1)?.bin as string,
			"/stage/test/docker-runner-s2b.ts",
			mode,
			JSON.stringify(config),
		],
		signal: ctx.signal,
		timeoutMs: 240_000,
	});
	expect(result.code, `runner exit ${result.code}; stderr: ${result.stderr.slice(-800)}`).toBe(0);
	const line = result.stdout.split(/\r?\n/).findLast((l) => l.startsWith("##DYS2BMATRIX##"));
	expect(line, `no ${mode} line; stdout tail: ${result.stdout.slice(-400)}`).toBeDefined();
	const parsed = JSON.parse((line as string).slice("##DYS2BMATRIX##".length)) as { nodes: T[] };
	expect(parsed.nodes.map((n) => n.label)).toEqual(NODES);
	return { image, nodes: parsed.nodes };
}

describe("Linux Docker S2b matrix", () => {
	it("runs every S2b probe in Linux on both Nodes", {
		tags: ["requires:docker"],
		timeout: 280_000,
	}, async (ctx: TestContext) => {
		await needDocker(ctx);
		const { image: glibcImage, nodes } = await s2bInDocker<DockerNode>(ctx, "matrix");
		const matrix = { nodes };
		const runs = new Map<string, NodeRuns>();
		const fallback1 = new Map<string, Fallback1Node>();
		for (const n of matrix.nodes) {
			expect(channelProblem(n.channel), n.label).toBeNull();
			for (const { mode, run } of n.fuzz)
				expect(fuzzProblem(mode, "linux", run), `${n.label} ${mode}`).toBeNull();
			expect(fallback1Problem(n.fallback1), `${n.label} fallback1`).toBeNull();
			expect(
				fallback1RoundTripProblem(n.fallback1RoundTrip),
				`${n.label} fallback1 round trip`,
			).toBeNull();
			expect(templateProblem(n.fallback1Template), `${n.label} fallback1 template`).toBeNull();
			fallback1.set(n.label, {
				hostile: n.fallback1,
				roundTrip: n.fallback1RoundTrip,
				template: n.fallback1Template,
			});
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
		const f1 = fallback1Evidence(target, fallback1, NODES);
		await recordEvidence(file("fallback1"), f1.problems, { ...f1.data, image: glibcImage });
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

// Remedy (f) in Linux Docker on both Nodes: every FIFO mode, then the template plugin on FIFO
// stdio, then the held-writer control. Writes fifo-docker-linux-<arch>.json whenever the modes and
// the template plugin hold; the control is checked after it, apart from the file.
interface DockerFifoNode {
	readonly label: string;
	readonly modes: { readonly mode: string; readonly run: HubRun<FifoResult> }[];
	readonly template: TemplateResult;
	readonly held: HubRun<FifoHeldResult>;
}

describe("Linux Docker FIFO stdio (remedy (f))", () => {
	it("on FIFO stdio no plugin can hand the hub a descriptor, in Linux on both Nodes", {
		tags: ["requires:docker"],
		timeout: 280_000,
	}, async (ctx: TestContext) => {
		await needDocker(ctx);
		const { image, nodes } = await s2bInDocker<DockerFifoNode>(ctx, "fifo");
		const runs = new Map<string, FifoNode>();
		const held = new Map<string, HubRun<FifoHeldResult>>();
		const problems: string[] = [];
		const control: string[] = [];
		for (const n of nodes) {
			const modes = new Map(n.modes.map(({ mode, run }) => [mode, run]));
			for (const [mode, run] of modes) {
				for (const problem of fifoProblems(mode, run))
					problems.push(`${n.label} ${mode}: ${problem}`);
			}
			console.log(fifoSummary(n.label, modes));
			const problem = templateProblem(n.template);
			if (problem !== null) problems.push(`${n.label} template on FIFO stdio: ${problem}`);
			runs.set(n.label, { modes, template: n.template });
			held.set(n.label, n.held);
			console.log(fifoHeldSummary(n.label, n.held));
			const missed = fifoHeldProblem(n.held);
			if (missed !== null) control.push(`${n.label} held-writer control: ${missed}`);
		}
		const target = `docker-linux-${arch}`;
		const f = fifoEvidence(target, runs, NODES, held);
		await recordEvidence(evidenceFile("fifo", target), f.problems, { ...f.data, image });
		expect(problems).toEqual([]);
		expect(control).toEqual([]);
	});
});
