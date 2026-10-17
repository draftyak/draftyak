import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	hostTarget,
	needDocker,
	nodeBinary,
	nodeVersions,
	runInDocker,
	stageForDocker,
	writeEvidence,
} from "@draftyak/spike-kit";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import {
	type ArgvReport,
	argvReportProblem,
	type Canaries,
	type ControlOutcome,
	canariesIntactProblem,
	controlProblem,
	type DataDirLinkOutcome,
	denialProblem,
	FIXTURES,
	type FixtureOutcome,
	type Listeners,
	PRESPAWN_LINKS,
	type PrespawnOutcome,
	prespawnProblem,
	runArgvReport,
	runControl,
	runDataDirLink,
	runFixture,
	runPrespawnLink,
	setupCanaries,
	startListeners,
	VARIANTS,
} from "./escape-matrix.ts";

const spikeDir = path.resolve(import.meta.dirname, "..");
const hostileDir = path.join(spikeDir, "fixtures", "hostile");
const { minimum, bundled } = nodeVersions();
const NODES = [minimum, bundled];
const arch = hostTarget().arch;
const glibcImage: string = JSON.parse(
	fs.readFileSync(path.resolve(spikeDir, "..", "..", "tools", "fetch-node", "images.json"), "utf8"),
).glibc;

interface Aggregate {
	readonly cases: FixtureOutcome[];
	readonly prespawn: PrespawnOutcome[];
	readonly dataDirLinks: DataDirLinkOutcome[];
	readonly controls: ControlOutcome[];
	readonly argvReports: ArgvReport[];
}

function newAggregate(): Aggregate {
	return { cases: [], prespawn: [], dataDirLinks: [], controls: [], argvReports: [] };
}

function nodeIdentity(
	bin: string,
	label: string,
): { label: string; nodeVersion: string; v8Version: string } {
	const r = spawnSync(
		bin,
		["-e", "process.stdout.write(process.versions.node+' '+process.versions.v8)"],
		{
			encoding: "utf8",
		},
	);
	const [nodeVersion = label, v8Version = ""] = r.stdout.trim().split(" ");
	return { label, nodeVersion, v8Version };
}

function aggregateProblems(agg: Aggregate): string[] {
	return [
		...agg.cases.map(denialProblem),
		...agg.prespawn.map(prespawnProblem),
		...agg.argvReports.map(argvReportProblem),
		...agg.controls.map(controlProblem),
	].filter((p): p is string => p !== null);
}

function evidenceData(
	osLabel: string,
	runtime: Readonly<Record<string, unknown>>,
	agg: Aggregate,
): Readonly<Record<string, unknown>> {
	const probe = (name: string): boolean | null =>
		agg.cases.find((c) => c.name === name)?.realWriteAllowed ?? null;
	const oracle =
		agg.cases.find((c) => c.name === "read-mk" && c.realpathOracle)?.realpathOracle ?? null;
	const sqliteControl = agg.controls.find((c) => c.kind === "sqlite");
	return {
		os: osLabel,
		runtime,
		nodes: NODES,
		variants: VARIANTS,
		caseCount: agg.cases.length,
		escapes: agg.cases.filter((c) => c.outcome !== "denied").length,
		cases: agg.cases.map((c) => ({
			name: c.name,
			node: c.node,
			variant: c.variant,
			outcome: c.outcome,
			codes: c.codes,
		})),
		prespawn: agg.prespawn.map((p) => ({
			kind: p.kind,
			node: p.node,
			variant: p.variant,
			refused: p.refused,
			controlEscaped: p.controlEscaped,
		})),
		dataDirLinks: agg.dataDirLinks.map((d) => ({
			kind: d.kind,
			node: d.node,
			followed: d.followed,
		})),
		controls: agg.controls.map((c) => ({ kind: c.kind, node: c.node, ...c.fields })),
		argvReports: agg.argvReports.map((a) => ({
			node: a.node,
			variant: a.variant,
			nodeOptionsInherited: a.nodeOptionsInherited,
			argvMatchesAllowlist: a.argvMatchesAllowlist,
			childSpawned: a.childSpawned,
		})),
		realPathProbes: {
			startupWriteAllowed: probe("write-startup"),
			rcWriteAllowed: probe("write-bashrc"),
		},
		realpathOracle: oracle,
		findings: {
			// The Node permission model alone follows a pre-existing link out of the grant, so the
			// pre-spawn link scan is the load-bearing defense (plan §4 "Before every spawn").
			nodeModelFollowsPrespawnLinks:
				agg.prespawn.length > 0 && agg.prespawn.every((p) => p.controlEscaped),
			// A link already in the writable data dir at spawn is followed too (guardrail 9 scope).
			dataDirLinkFollowed: agg.dataDirLinks.length > 0 && agg.dataDirLinks.every((d) => d.followed),
			// node:sqlite ATTACH ignores the permission model, so --no-experimental-sqlite is the defense.
			sqliteAttachBypassesPermissionModel: sqliteControl?.fields.attachRead === true,
			vfsDeniedUnderProductionArgv:
				agg.cases.some((c) => c.name === "vfs-mount") &&
				agg.cases.filter((c) => c.name === "vfs-mount").every((c) => c.outcome === "denied"),
			nodeOptionsNotInherited:
				agg.argvReports.length > 0 && agg.argvReports.every((a) => !a.nodeOptionsInherited),
			argvEqualsAllowlist:
				agg.argvReports.length > 0 && agg.argvReports.every((a) => a.argvMatchesAllowlist),
		},
	};
}

// One host-native describe per OS, gated by an exact platform tag (requires:windows|linux|macos) so a
// non-matching host routed-skips it rather than running it without setup. osKind picks the fixture set
// (Windows- vs POSIX-only cases); all three run the same matrix through the real spawn path.
function hostSuite(
	label: string,
	capTag: "windows" | "linux" | "macos",
	osKind: "windows" | "posix",
	platform: NodeJS.Platform,
): void {
	describe(`host escape matrix (${label})`, () => {
		const bins: Record<string, string> = {};
		let canaries: Canaries | null = null;
		let listeners: Listeners | null = null;
		const agg = newAggregate();

		beforeAll(async () => {
			if (process.platform !== platform) return;
			for (const v of NODES) {
				bins[v] = await nodeBinary(
					v,
					osKind === "windows" ? { platform: "win", arch } : hostTarget(),
				);
			}
			const root = fs.mkdtempSync(path.join(os.tmpdir(), `dy-s02-${osKind}-`));
			canaries = setupCanaries(root, hostileDir, process.env, platform);
			listeners = await startListeners(platform, root);
		}, 180_000);

		afterAll(async () => {
			if (listeners) await listeners.close();
			if (canaries) fs.rmSync(canaries.root, { recursive: true, force: true });
		});

		const here = (): { canaries: Canaries; listeners: Listeners } => ({
			canaries: canaries as Canaries,
			listeners: listeners as Listeners,
		});
		const t = (extra: string[] = []): { tags: string[] } => ({
			tags: [`requires:${capTag}`, ...extra],
		});
		const plainFixtures = FIXTURES.filter(
			(f) => (osKind === "windows" ? f.win : f.posix) && !f.symlinkPriv,
		);
		const symlinkFixtures = FIXTURES.filter(
			(f) => (osKind === "windows" ? f.win : f.posix) && f.symlinkPriv,
		);

		it("denies every non-symlink fixture (both Nodes, both variants)", t(), async () => {
			const { canaries: c, listeners: l } = here();
			for (const fx of plainFixtures) {
				for (const v of NODES) {
					for (const variant of VARIANTS) {
						const r = await runFixture(bins[v] as string, v, c, l, fx, variant);
						agg.cases.push(r);
						expect(denialProblem(r), `${fx.name}`).toBeNull();
						if (fx.name.startsWith("write-")) {
							expect(r.realWriteAllowed, `${fx.name}: real-path write stays denied`).toBe(false);
						}
					}
				}
			}
		});

		it(
			"denies the symlink fixtures (both Nodes, both variants)",
			t(["requires:symlink-privilege"]),
			async () => {
				const { canaries: c, listeners: l } = here();
				for (const fx of symlinkFixtures) {
					for (const v of NODES) {
						for (const variant of VARIANTS) {
							const r = await runFixture(bins[v] as string, v, c, l, fx, variant);
							agg.cases.push(r);
							expect(denialProblem(r), `${fx.name}`).toBeNull();
						}
					}
				}
			},
		);

		it("does not inherit NODE_OPTIONS and spawns the exact allowlist argv", t(), async () => {
			const { canaries: c, listeners: l } = here();
			for (const v of NODES) {
				for (const variant of VARIANTS) {
					const r = await runArgvReport(bins[v] as string, v, c, l, variant);
					agg.argvReports.push(r);
					expect(argvReportProblem(r), `${v} ${variant}`).toBeNull();
				}
			}
		});

		for (const kind of PRESPAWN_LINKS.filter((k) =>
			osKind === "windows" ? k !== "symlink" : k === "hardlink",
		)) {
			it(`refuses a pre-spawn ${kind} in the bundle (both variants)`, t(), async () => {
				const { canaries: c, listeners: l } = here();
				for (const v of NODES) {
					for (const variant of VARIANTS) {
						const r = await runPrespawnLink(bins[v] as string, v, c, l, kind, variant);
						agg.prespawn.push(r);
						expect(prespawnProblem(r), `${kind} ${v} ${variant}`).toBeNull();
					}
				}
			});
		}

		it(
			"refuses a pre-spawn symlink in the bundle (both variants)",
			t(["requires:symlink-privilege"]),
			async () => {
				const { canaries: c, listeners: l } = here();
				for (const v of NODES) {
					for (const variant of VARIANTS) {
						const r = await runPrespawnLink(bins[v] as string, v, c, l, "symlink", variant);
						agg.prespawn.push(r);
						expect(prespawnProblem(r), `symlink ${v} ${variant}`).toBeNull();
					}
				}
			},
		);

		it(
			"records that a pre-existing data-dir link is followed (hardlink/junction control)",
			t(),
			async () => {
				const { canaries: c, listeners: l } = here();
				const kinds =
					osKind === "windows" ? (["hardlink", "junction"] as const) : (["hardlink"] as const);
				for (const v of NODES) {
					for (const kind of kinds) {
						const r = await runDataDirLink(bins[v] as string, v, c, l, kind);
						agg.dataDirLinks.push(r);
						expect(
							r.followed,
							`data-dir ${kind} ${v}: control must show the model follows it`,
						).toBe(true);
					}
				}
			},
		);

		it(
			"records that a pre-existing data-dir symlink is followed (control)",
			t(["requires:symlink-privilege"]),
			async () => {
				const { canaries: c, listeners: l } = here();
				for (const v of NODES) {
					const r = await runDataDirLink(bins[v] as string, v, c, l, "symlink");
					agg.dataDirLinks.push(r);
					expect(r.followed, `data-dir symlink ${v}: control must show the model follows it`).toBe(
						true,
					);
				}
			},
		);

		it(
			"controls: node:sqlite ATTACH bypasses the model; node:vfs mount stays gated",
			t(),
			async () => {
				const { canaries: c, listeners: l } = here();
				for (const v of NODES) {
					for (const kind of ["sqlite", "vfs"] as const) {
						const r = await runControl(bins[v] as string, v, c, l, kind);
						agg.controls.push(r);
						expect(controlProblem(r), `control-${kind} ${v}`).toBeNull();
					}
				}
			},
		);

		it("leaves the out-of-grant canaries intact and records zero escapes", t(), async () => {
			const { canaries: c } = here();
			expect(canariesIntactProblem(c), "canaries").toBeNull();
			expect(agg.cases.length).toBeGreaterThan(0);
			expect(aggregateProblems(agg)).toEqual([]);
			expect(agg.cases.filter((r) => r.outcome !== "denied")).toEqual([]);
			const runtime = {
				platform,
				arch,
				kernelVersion: os.release(),
				nodes: NODES.map((v) => nodeIdentity(bins[v] as string, v)),
			};
			await writeEvidence(
				path.join(spikeDir, "evidence", `escape-${platform}-${arch}.json`),
				evidenceData(`${platform}-${arch}`, runtime, agg),
			);
		});
	});
}

hostSuite("windows", "windows", "windows", "win32");
hostSuite("linux", "linux", "posix", "linux");
hostSuite("macos", "macos", "posix", "darwin");

describe("Linux Docker escape matrix", () => {
	it("denies every fixture and refuses pre-spawn links (both Nodes, both variants)", {
		tags: ["requires:docker"],
		timeout: 280_000,
	}, async (ctx: TestContext) => {
		await needDocker(ctx);
		const bins: string[] = [];
		for (const v of NODES) bins.push(await nodeBinary(v, { platform: "linux", arch }));
		using stage = stageForDocker({
			name: "s02-escape",
			from: spikeDir,
			files: ["src", "fixtures/hostile", "test/escape-matrix.ts", "test/docker-runner.ts"],
		});
		const nodes = NODES.map((label, i) => ({ bin: `/opt/n${i}`, label }));
		const config = { nodes, fixtureSource: "/stage/fixtures/hostile", workRoot: "/tmp/dywork" };
		const mounts = [
			{ source: stage.dir, target: "/stage" },
			...bins.map((b, i) => ({ source: b, target: `/opt/n${i}` })),
		];
		const result = await runInDocker({
			image: glibcImage,
			network: "none",
			mounts,
			cmd: [
				nodes[nodes.length - 1]?.bin as string,
				"/stage/test/docker-runner.ts",
				JSON.stringify(config),
			],
			signal: ctx.signal,
			timeoutMs: 240_000,
		});
		expect(result.code, `runner exit ${result.code}; stderr: ${result.stderr.slice(-800)}`).toBe(0);
		expect(result.stdout.includes("DRAFTYAK-MK-STANDIN"), "no canary in container output").toBe(
			false,
		);
		const line = result.stdout
			.split(/\r?\n/)
			.reverse()
			.find((l) => l.startsWith("##DYMATRIX##"));
		expect(line, `no matrix line; stdout tail: ${result.stdout.slice(-400)}`).toBeDefined();
		const matrix = JSON.parse((line as string).slice("##DYMATRIX##".length)) as Aggregate & {
			runtime: Record<string, unknown>;
		};
		const agg: Aggregate = {
			cases: matrix.cases,
			prespawn: matrix.prespawn,
			dataDirLinks: matrix.dataDirLinks,
			controls: matrix.controls,
			argvReports: matrix.argvReports,
		};
		const posix = FIXTURES.filter((f) => f.posix).length;
		expect(agg.cases.length, "every posix fixture × 2 nodes × 2 variants").toBe(
			posix * NODES.length * VARIANTS.length,
		);
		expect(aggregateProblems(agg)).toEqual([]);
		expect(
			agg.dataDirLinks.every((d) => d.followed),
			"data-dir links followed (control)",
		).toBe(true);
		for (const name of ["write-startup", "write-bashrc"]) {
			for (const r of agg.cases.filter((f) => f.name === name)) {
				expect(r.realWriteAllowed, `${name}: real-path write must stay denied`).toBe(false);
			}
		}
		await writeEvidence(
			path.join(spikeDir, "evidence", `escape-docker-linux-${arch}.json`),
			evidenceData(`docker-linux-${arch}`, { ...matrix.runtime, image: glibcImage }, agg),
		);
	});
});
