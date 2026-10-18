// S11b (plan §9.2 Python rows; §15 S11 (b), (e), (f), (h)). The authoritative suite: on this host and
// in a Linux container, on the selected Nodes, it runs every hostile Python attempt (0 escapes), the
// contract check after the grants drop, the 10k print/​input fuzz, the busy-loop timeout kill and
// clean restart, the --permission-audit run (0 forbidden events, network blocked), and the runtime
// tamper cases, writing escape-<target>.json and escape-docker-linux-<arch>.json. The focused
// audit/prints/timeout suites re-run one concern each for quick signal; this file is the matrix.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type Fingerprint,
	fingerprint,
	needDocker,
	nodeBinary,
	runInDocker,
	stageForDocker,
	writeEvidence,
} from "@draftyak/spike-kit";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { installedDir, spikeDir } from "../scripts/fetch-runtime.ts";
import { SHIM } from "../src/runtime.ts";
import {
	AUDIT_PRELOAD,
	arch,
	hostTcpWatcher,
	nodeBin,
	type Prepared,
	prepareHost,
	recording,
	selectedNodes,
	specFor,
} from "./host.ts";
import {
	ATTACKS,
	type AttackResult,
	type AuditResult,
	auditProblem,
	type ContractResult,
	contractProblem,
	hostileProblem,
	type NetControlResult,
	netControlProblem,
	type PrintsResult,
	printsProblem,
	runAudit,
	runAuditNetControl,
	runContract,
	runHostile,
	runPrints,
	runTamper,
	runTimeout,
	type TamperKind,
	type TamperResult,
	type TimeoutResult,
	tamperProblem,
	timeoutProblem,
} from "./suite.ts";

const NODES = selectedNodes();
const glibcImage = (
	JSON.parse(
		fs.readFileSync(path.join(spikeDir, "..", "..", "tools", "fetch-node", "images.json"), "utf8"),
	) as { glibc: string }
).glibc;

interface Results {
	attacks: AttackResult[];
	contract: ContractResult[];
	prints: PrintsResult[];
	timeout: TimeoutResult[];
	audit: AuditResult[];
	netControl: NetControlResult[];
	tamper: TamperResult[];
}

const empty = (): Results => ({
	attacks: [],
	contract: [],
	prints: [],
	timeout: [],
	audit: [],
	netControl: [],
	tamper: [],
});

// Every non-attack section passed, so evidence is never recorded from a partially-failing run
// (M0.33 handoff: committed evidence must come from a fully-passing clean tree).
function allCasesPassed(results: Results): boolean {
	return (
		results.attacks.every((a) => hostileProblem(a) === null) &&
		results.contract.every((c) => contractProblem(c) === null) &&
		results.prints.every((p) => printsProblem(p) === null) &&
		results.timeout.every((t) => timeoutProblem(t) === null) &&
		results.audit.every((a) => auditProblem(a) === null) &&
		results.netControl.every((n) => netControlProblem(n) === null) &&
		results.tamper.every((t) => tamperProblem(t) === null)
	);
}

// Content-free evidence: outcomes, codes, counts, booleans; never a path, a canary or a host name.
function evidenceData(target: string, runtime: object, results: Results) {
	return {
		target,
		runtime,
		nodes: NODES,
		auditFlag: {
			name: "--permission-audit",
			present: true,
			note: "present on 26.5.1 and 26.12.0; on 26.5.1 it also enforces, on 26.12.0 it observes only",
		},
		escapes: results.attacks.filter((a) => a.escaped).length,
		attacks: results.attacks.map((a) => ({
			name: a.name,
			node: a.node,
			outcome: a.outcome,
			code: a.code,
			escaped: a.escaped,
			denied: a.denied,
			permissionDenied: a.permissionDenied,
			canaryLeak: a.canaryLeak,
			hostFileCreated: a.hostFileCreated,
			netTested: a.netTested,
			netConnected: a.netConnected,
		})),
		contract: results.contract,
		prints: results.prints,
		timeout: results.timeout,
		audit: results.audit.map((a) => ({
			node: a.node,
			forbiddenEvents: a.forbiddenEvents,
			fsWriteEvents: a.fsWriteEvents,
			fsReadEvents: a.fsReadEvents,
			counts: a.counts,
			brokerRequestCount: a.brokerRequestCount,
			offBrokerRequest: a.offBrokerRequest,
			tcpConnections: a.tcpConnections,
			complete: a.complete,
		})),
		netControl: results.netControl,
		tamper: results.tamper,
	};
}

const pyodideRuntime = (prepared: Prepared) => ({
	pyodide: prepared.lock.pyodide,
	abi: prepared.lock.abi,
	python: prepared.lock.info.python,
	shimSha256: prepared.lock.files[SHIM] ?? null,
});

// One fingerprint before any evidence is written: the host file lands before the Docker test runs, and
// the tree is clean only until then (M0.33 handoff: committed evidence must be clean).
let print: Fingerprint | undefined;
beforeAll(async () => {
	if (recording()) print = await fingerprint({ cwd: spikeDir });
});

// Hard links need no symlink privilege on Windows, so the same-content hard link (which only the
// nlink > 1 check can catch) always runs. Symlink cases carry requires:symlink-privilege; junction is
// requires:windows.
const TAMPER_ALWAYS: TamperKind[] = ["extra", "modified", "hardlink", "hardlink-samecontent"];

function hostSuite(
	label: string,
	capTag: "windows" | "linux" | "macos",
	platform: NodeJS.Platform,
): void {
	describe(`S11b host matrix (${label})`, () => {
		let prepared: Prepared | undefined;
		const bins = new Map<string, string>();
		const results = empty();
		const t = (extra: string[] = []): { tags: string[] } => ({
			tags: [`requires:${capTag}`, ...extra],
		});

		beforeAll(async () => {
			if (process.platform !== platform) return;
			prepared = await prepareHost();
			for (const node of NODES) bins.set(node, await nodeBin(node));
		}, 900_000);

		afterAll(async () => {
			if (prepared === undefined) return;
			// Record only a complete, fully-passing run: every section present for every Node, every
			// case passing its classifier. A failure in any suite (not just the attacks) records nothing.
			const present =
				results.attacks.length === ATTACKS.length * NODES.length &&
				results.contract.length === NODES.length &&
				results.prints.length === NODES.length &&
				results.timeout.length === NODES.length &&
				results.audit.length === NODES.length &&
				results.netControl.length === NODES.length &&
				results.tamper.length >= TAMPER_ALWAYS.length * NODES.length;
			const ran = recording() && present && allCasesPassed(results);
			if (ran) {
				const target = `${platform}-${arch}`;
				const runtime = { ...pyodideRuntime(prepared), kernelVersion: os.release() };
				const file = path.join(spikeDir, "evidence", `escape-${target}.json`);
				console.log(
					`evidence: ${await writeEvidence(file, evidenceData(target, runtime, results), { fingerprint: print })}`,
				);
			} else if (recording()) {
				console.log(
					`evidence not recorded: present=${present}, allPassed=${allCasesPassed(results)}`,
				);
			}
			fs.rmSync(prepared.work, { recursive: true, force: true });
		});

		it("denies every hostile Python attempt with 0 escapes (both Nodes)", t(), async () => {
			const p = prepared as Prepared;
			for (const node of NODES) {
				const spec = specFor(p, bins.get(node) as string);
				for (const name of ATTACKS) {
					const r = await runHostile(spec, p.hostilePluginDir, node, name, p.canaries);
					results.attacks.push(r);
					expect(hostileProblem(r), `${name} ${node}`).toBeNull();
				}
			}
			expect(results.attacks.filter((a) => a.escaped)).toEqual([]);
		});

		it("still answers the contract after the read grants drop (both Nodes)", t(), async () => {
			const p = prepared as Prepared;
			for (const node of NODES) {
				const r = await runContract(specFor(p, bins.get(node) as string), p.hostilePluginDir, node);
				results.contract.push(r);
				expect(contractProblem(r), node).toBeNull();
			}
		});

		it("keeps 10k JSON-RPC-shaped prints and input() off fds 0/1 (both Nodes)", t(), async () => {
			const p = prepared as Prepared;
			for (const node of NODES) {
				const r = await runPrints(specFor(p, bins.get(node) as string), p.hostilePluginDir, node);
				results.prints.push(r);
				expect(printsProblem(r), node).toBeNull();
			}
		});

		it("kills a busy-loop handler and restarts the plugin cleanly (both Nodes)", t(), async () => {
			const p = prepared as Prepared;
			for (const node of NODES) {
				const r = await runTimeout(specFor(p, bins.get(node) as string), p.hostilePluginDir, node);
				results.timeout.push(r);
				expect(timeoutProblem(r), node).toBeNull();
			}
		});

		it(
			"shows no forbidden permission events and no network under --permission-audit (both Nodes)",
			t(),
			async () => {
				const p = prepared as Prepared;
				const watch = hostTcpWatcher();
				for (const node of NODES) {
					const spec = specFor(p, bins.get(node) as string);
					const r = await runAudit(spec, p.auditPluginDir, AUDIT_PRELOAD, node, watch);
					results.audit.push(r);
					expect(auditProblem(r), node).toBeNull();
					expect(r.fsReadEvents, `${node}: fs-read positive control`).toBeGreaterThan(0);
					// Positive control: a net attempt under audit must raise a net event, so the clean
					// run's net === 0 is a measurement and not a silently dropped channel.
					const control = await runAuditNetControl(spec, p.hostilePluginDir, AUDIT_PRELOAD, node);
					results.netControl.push(control);
					expect(netControlProblem(control), node).toBeNull();
					expect(control.netEvents, `${node}: net channel observed`).toBeGreaterThan(0);
				}
			},
		);

		it(
			"refuses to spawn when a runtime file is extra, modified or hard-linked (both Nodes)",
			t(),
			() => {
				const p = prepared as Prepared;
				for (const node of NODES) {
					const spec = specFor(p, bins.get(node) as string);
					for (const kind of TAMPER_ALWAYS) {
						const r = runTamper(spec, p.sources, p.work, p.hostilePluginDir, node, kind);
						results.tamper.push(r);
						expect(tamperProblem(r), `${kind} ${node}`).toBeNull();
					}
				}
			},
		);

		it("refuses a junction runtime file", t(["requires:windows"]), () => {
			const p = prepared as Prepared;
			const node = NODES[0] as string;
			const r = runTamper(
				specFor(p, bins.get(node) as string),
				p.sources,
				p.work,
				p.hostilePluginDir,
				node,
				"junction",
			);
			results.tamper.push(r);
			expect(tamperProblem(r), "junction").toBeNull();
		});

		it(
			"refuses a symlinked runtime file (different and same content)",
			t(["requires:symlink-privilege"]),
			() => {
				const p = prepared as Prepared;
				const node = NODES[0] as string;
				for (const kind of ["symlink", "symlink-samecontent"] as const) {
					const r = runTamper(
						specFor(p, bins.get(node) as string),
						p.sources,
						p.work,
						p.hostilePluginDir,
						node,
						kind,
					);
					results.tamper.push(r);
					expect(tamperProblem(r), kind).toBeNull();
				}
			},
		);
	});
}

hostSuite("windows", "windows", "win32");
hostSuite("linux", "linux", "linux");
hostSuite("macos", "macos", "darwin");

describe("S11b Linux Docker matrix (glibc, --network none)", () => {
	it("denies every attempt, keeps fds clean, kills the busy loop, and audits clean in a container", {
		tags: ["requires:docker"],
		timeout: 290_000,
	}, async (ctx: TestContext) => {
		await needDocker(ctx);
		const prepared = await prepareHost();
		const linux = { platform: "linux", arch } as const;
		const nodes: { bin: string; label: string }[] = [];
		const mounts: { source: string; target: string }[] = [];
		for (const [index, node] of NODES.entries()) {
			mounts.push({ source: await nodeBinary(node, linux), target: `/opt/n${index}` });
			nodes.push({ bin: `/opt/n${index}`, label: node });
		}
		using spike = stageForDocker({
			name: "s11b-stage",
			from: spikeDir,
			packages: ["pyodide", "ws"],
			files: [
				"src",
				"test/suite.ts",
				"test/channel.ts",
				"test/bundle.ts",
				"test/runner-m034.mjs",
				"runtime.lock.json",
			],
		});
		using sandbox = stageForDocker({
			name: "s11b-s02",
			from: installedDir("@draftyak/spike-s02-plugin-sandbox"),
			files: ["package.json", "src"],
		});
		let bundleStage: ReturnType<typeof stageForDocker>;
		try {
			bundleStage = stageForDocker({
				name: "s11b-bundle",
				from: prepared.work,
				files: [SHIM, "dy-hostile", "py-hello", "fake"],
			});
		} finally {
			fs.rmSync(prepared.work, { recursive: true, force: true });
		}
		using bundles = bundleStage;
		mounts.push(
			{ source: spike.dir, target: "/stage" },
			{ source: sandbox.dir, target: "/s02" },
			{ source: bundles.dir, target: "/bundle" },
		);
		const result = await runInDocker({
			image: glibcImage,
			network: "none",
			platform: `linux/${arch === "x64" ? "amd64" : "arm64"}`,
			mounts,
			cmd: [nodes.at(-1)?.bin as string, "/stage/test/runner-m034.mjs", JSON.stringify({ nodes })],
			signal: ctx.signal,
			timeoutMs: 280_000,
		});
		const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith("##DYM034##"));
		expect(line, `exit ${result.code}; stderr: ${result.stderr.slice(-1_500)}`).toBeDefined();
		const parsed = JSON.parse((line as string).slice("##DYM034##".length)) as {
			runtime: Record<string, string>;
			results: Results;
		};
		expect(result.stdout.includes("DRAFTYAK-MK-STANDIN"), "no canary in container output").toBe(
			false,
		);
		for (const a of parsed.results.attacks)
			expect(hostileProblem(a), `${a.name} ${a.node}`).toBeNull();
		expect(
			parsed.results.attacks.filter((a) => a.escaped),
			"0 escapes",
		).toEqual([]);
		expect(parsed.results.attacks).toHaveLength(ATTACKS.length * NODES.length);
		for (const c of parsed.results.contract) expect(contractProblem(c), c.node).toBeNull();
		for (const pr of parsed.results.prints) expect(printsProblem(pr), pr.node).toBeNull();
		for (const to of parsed.results.timeout) expect(timeoutProblem(to), to.node).toBeNull();
		for (const au of parsed.results.audit) {
			expect(auditProblem(au), au.node).toBeNull();
			expect(au.fsReadEvents, `${au.node}: fs-read positive control`).toBeGreaterThan(0);
		}
		for (const nc of parsed.results.netControl) {
			expect(netControlProblem(nc), nc.node).toBeNull();
			expect(nc.netEvents, `${nc.node}: net channel observed`).toBeGreaterThan(0);
		}
		for (const ta of parsed.results.tamper)
			expect(tamperProblem(ta), `${ta.kind} ${ta.node}`).toBeNull();
		const complete =
			parsed.results.attacks.length === ATTACKS.length * NODES.length &&
			parsed.results.contract.length === NODES.length &&
			parsed.results.prints.length === NODES.length &&
			parsed.results.timeout.length === NODES.length &&
			parsed.results.audit.length === NODES.length &&
			parsed.results.netControl.length === NODES.length &&
			parsed.results.tamper.length >= TAMPER_ALWAYS.length * NODES.length;
		if (recording() && complete && allCasesPassed(parsed.results)) {
			const target = `docker-linux-${arch}`;
			const runtime = { ...pyodideRuntime(prepared), ...parsed.runtime, image: glibcImage };
			const file = path.join(spikeDir, "evidence", `escape-${target}.json`);
			console.log(
				`evidence: ${await writeEvidence(file, evidenceData(target, runtime, parsed.results), { fingerprint: print })}`,
			);
		}
		expect(result.code).toBe(0);
	});
});
