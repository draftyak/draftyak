// Shared escape-matrix logic, used by the host test (Windows or POSIX) and, staged into a Linux
// container, by docker-runner.ts. It imports only node: built-ins and the spike's own src/, never the
// kit, so it runs unchanged inside the container. The host test adds the kit (node binaries, evidence,
// Docker). Fixtures run AS the sandboxed plugin; this parent code is unpermissioned.

import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildArgv, buildExecArgv } from "../src/argv.ts";
import { execArgvFor, RefusedSpawnError, scrubEnv, spawnPlugin } from "../src/spawn.ts";

export type Variant = "A" | "B";
export const VARIANTS: readonly Variant[] = ["A", "B"];

export interface Fixture {
	readonly name: string;
	readonly file: string;
	readonly win: boolean;
	readonly posix: boolean;
	// Needs the privilege to create symlinks (Windows: Developer Mode or an elevated runner).
	readonly symlinkPriv?: boolean;
}

// Every hostile fixture, one attempt each (plan §15 S2, §9.2 sandbox-escape row).
export const FIXTURES: readonly Fixture[] = [
	{ name: "read-mk", file: "read-mk.mjs", win: true, posix: true },
	{ name: "read-fake-profile", file: "read-fake-profile.mjs", win: true, posix: true },
	{ name: "prefix-sibling", file: "prefix-sibling.mjs", win: true, posix: true },
	{ name: "data-sibling", file: "data-sibling.mjs", win: true, posix: true },
	{ name: "write-startup", file: "write-startup.mjs", win: true, posix: true },
	{ name: "write-bashrc", file: "write-bashrc.mjs", win: true, posix: true },
	{
		name: "runtime-symlink",
		file: "runtime-symlink.mjs",
		win: true,
		posix: true,
		symlinkPriv: true,
	},
	{ name: "runtime-hardlink", file: "runtime-hardlink.mjs", win: true, posix: true },
	{ name: "runtime-junction", file: "runtime-junction.mjs", win: true, posix: false },
	{ name: "child-process", file: "child-process.mjs", win: true, posix: true },
	{ name: "worker", file: "worker.mjs", win: true, posix: true },
	{ name: "addons", file: "addons.mjs", win: true, posix: true },
	{ name: "wasi", file: "wasi.mjs", win: true, posix: true },
	{ name: "inspector", file: "inspector.mjs", win: true, posix: true },
	{ name: "ffi", file: "ffi.mjs", win: true, posix: true },
	{ name: "openssl-store", file: "openssl-store.mjs", win: true, posix: true },
	{ name: "sqlite-attach", file: "sqlite-attach.mjs", win: true, posix: true },
	{ name: "vfs-mount", file: "vfs-mount.mjs", win: true, posix: true },
	{ name: "net-tcp", file: "net-tcp.mjs", win: true, posix: true },
	{ name: "net-pipe", file: "net-pipe.mjs", win: true, posix: false },
	{ name: "net-unix", file: "net-unix.mjs", win: false, posix: true },
];

export const PRESPAWN_LINKS = ["symlink", "junction", "hardlink"] as const;
export type PrespawnLinkKind = (typeof PRESPAWN_LINKS)[number];

// The canary bytes a successful read would return; kept out of evidence and never emitted by a
// fixture (fixtures compare against it and report a boolean).
export const MK_CANARY = "DRAFTYAK-MK-STANDIN-DO-NOT-LEAK";
export const SQLITE_CANARY = "DRAFTYAK-SQLITE-STANDIN-DO-NOT-LEAK";

export interface Canaries {
	readonly root: string;
	readonly pluginDir: string;
	readonly dataDir: string;
	readonly fakeDir: string;
	readonly mk: string;
	readonly fakeFile: string;
	readonly fakeStartupDir: string;
	readonly fakeRc: string;
	readonly sibling: string;
	readonly siblingDir: string;
	readonly dataSibling: string;
	readonly dataSiblingDir: string;
	readonly vaultDb: string;
	readonly pem: string;
	readonly realStartup: string;
	readonly realRc: string;
}

// Builds a fresh fake profile outside every grant, plus the plugin and data dirs. `fixtureSource` is
// the hostile fixtures dir, copied (link-free) into the plugin dir so the grant covers it.
export function setupCanaries(
	root: string,
	fixtureSource: string,
	realEnv: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): Canaries {
	const pluginDir = path.join(root, "plugin");
	const dataDir = path.join(root, "data");
	const fakeDir = path.join(root, "fake");
	const fakeStartupDir = path.join(fakeDir, "Startup");
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(dataDir, { recursive: true });
	fs.mkdirSync(fakeStartupDir, { recursive: true });
	fs.cpSync(fixtureSource, pluginDir, { recursive: true, dereference: true });
	const mk = path.join(fakeDir, "mk.key");
	const fakeFile = path.join(fakeDir, "profile.txt");
	const fakeRc = path.join(fakeDir, ".bashrc");
	fs.writeFileSync(mk, MK_CANARY);
	fs.writeFileSync(fakeFile, "fake profile secret\n");
	fs.writeFileSync(fakeRc, "# fake rc\n");
	// A real SQLite database outside every grant, holding a canary row (the node:sqlite ATTACH target).
	const vaultDb = path.join(fakeDir, "vault.db");
	const db = new DatabaseSync(vaultDb);
	db.exec("CREATE TABLE s(v TEXT)");
	db.prepare("INSERT INTO s VALUES (?)").run(SQLITE_CANARY);
	db.close();
	// A real private-key PEM outside every grant (the OpenSSL-store file: URL target).
	const pem = path.join(fakeDir, "key.pem");
	fs.writeFileSync(
		pem,
		generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
	);
	// Prefix siblings of the read grants: same string prefix, not covered by the grant.
	const sibling = `${pluginDir}-evil.txt`;
	const siblingDir = `${pluginDir}-evil`;
	fs.writeFileSync(sibling, "prefix sibling secret\n");
	fs.mkdirSync(siblingDir, { recursive: true });
	fs.writeFileSync(path.join(siblingDir, "secret.txt"), "sibling dir secret\n");
	const dataSibling = `${dataDir}-evil.txt`;
	const dataSiblingDir = `${dataDir}-evil`;
	fs.writeFileSync(dataSibling, "data sibling secret\n");
	fs.mkdirSync(dataSiblingDir, { recursive: true });
	const home =
		realEnv.HOME ?? realEnv.USERPROFILE ?? (platform === "win32" ? "C:\\Users\\x" : "/root");
	const realStartup =
		platform === "win32"
			? path.join(
					realEnv.APPDATA ?? path.join(home, "AppData", "Roaming"),
					"Microsoft",
					"Windows",
					"Start Menu",
					"Programs",
					"Startup",
				)
			: platform === "darwin"
				? path.join(home, "Library", "LaunchAgents")
				: path.join(home, ".config", "autostart");
	const realRc = path.join(home, ".bashrc");
	return {
		root,
		pluginDir,
		dataDir,
		fakeDir,
		mk,
		fakeFile,
		fakeStartupDir,
		fakeRc,
		sibling,
		siblingDir,
		dataSibling,
		dataSiblingDir,
		vaultDb,
		pem,
		realStartup,
		realRc,
	};
}

export interface Listeners {
	readonly tcpPort: number;
	readonly pipePath: string;
	readonly unixPath: string;
	hits(): number;
	close(): Promise<void>;
}

// Live servers the net fixtures aim at: a TCP listener and, per OS, a named pipe (Windows) or a UNIX
// socket (POSIX). A grant would both connect here and register a hit, so the suite asserts 0 hits.
export async function startListeners(platform: NodeJS.Platform, root: string): Promise<Listeners> {
	let hits = 0;
	const onConn = (s: net.Socket): void => {
		hits++;
		s.destroy();
	};
	const tcp = net.createServer(onConn);
	await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
	const named = net.createServer(onConn);
	const pipePath = platform === "win32" ? `\\\\.\\pipe\\dy-s02-parent-${process.pid}` : "";
	const unixPath = platform === "win32" ? "" : path.join(root, `parent-${process.pid}.sock`);
	const namedAddr = platform === "win32" ? pipePath : unixPath;
	await new Promise<void>((r) => named.listen(namedAddr, r));
	const port = (tcp.address() as net.AddressInfo).port;
	return {
		tcpPort: port,
		pipePath,
		unixPath,
		hits: () => hits,
		close: async () => {
			await new Promise<void>((r) => tcp.close(() => r()));
			await new Promise<void>((r) => named.close(() => r()));
		},
	};
}

function fixtureConfig(canaries: Canaries, listeners: Listeners): Record<string, string | number> {
	return {
		pluginDir: canaries.pluginDir,
		dataDir: canaries.dataDir,
		fakeDir: canaries.fakeDir,
		mk: canaries.mk,
		fakeFile: canaries.fakeFile,
		fakeStartupDir: canaries.fakeStartupDir,
		fakeRc: canaries.fakeRc,
		sibling: canaries.sibling,
		siblingDir: canaries.siblingDir,
		dataSibling: canaries.dataSibling,
		dataSiblingDir: canaries.dataSiblingDir,
		vaultDb: canaries.vaultDb,
		pem: canaries.pem,
		sqliteCanary: SQLITE_CANARY,
		mkCanary: MK_CANARY,
		realStartup: canaries.realStartup,
		realRc: canaries.realRc,
		tcpPort: listeners.tcpPort,
		pipePath: listeners.pipePath,
		unixPath: listeners.unixPath,
	};
}

export interface FixtureOutcome {
	readonly name: string;
	readonly node: string;
	readonly variant: Variant;
	readonly outcome: "denied" | "escaped" | "no-report";
	readonly codes: readonly string[];
	readonly crashed?: boolean;
	readonly canarySeen?: boolean;
	readonly realWriteAllowed?: boolean;
	readonly realpathOracle?: Readonly<Record<string, string | boolean>>;
}

// The production refusal codes each fixture may report, by Node (verified against 26.5.1 and
// 26.12.0). Anything else, a crash, or a leaked canary is a failure, so a Node bump that turned a
// denial into ECONNREFUSED, a TypeError or a different access path is caught instead of passing.
const isMinimum = (node: string): boolean => node.startsWith("26.5.");
const EXPECTED: Readonly<Record<string, (node: string) => readonly string[]>> = {
	addons: () => ["ERR_DLOPEN_DISABLED"],
	"sqlite-attach": () => ["ERR_UNKNOWN_BUILTIN_MODULE"],
	"vfs-mount": () => ["ERR_UNKNOWN_BUILTIN_MODULE"],
	ffi: (node) => (isMinimum(node) ? ["ERR_UNKNOWN_BUILTIN_MODULE"] : ["ERR_ACCESS_DENIED"]),
	"openssl-store": (node) => (isMinimum(node) ? ["ERR_INVALID_ARG_TYPE"] : ["ERR_ACCESS_DENIED"]),
};
const DEFAULT_CODES: readonly string[] = ["ERR_ACCESS_DENIED"];

export function expectedCodes(name: string, node: string): readonly string[] {
	return EXPECTED[name]?.(node) ?? DEFAULT_CODES;
}

// null when the fixture denied cleanly with only expected codes and leaked no canary; else why not.
export function denialProblem(r: FixtureOutcome): string | null {
	const allowed = expectedCodes(r.name, r.node);
	const unexpected = r.codes.filter((c) => !allowed.includes(c));
	const label = `${r.name} ${r.node} ${r.variant}`;
	if (r.outcome !== "denied") return `${label}: ${r.outcome} [${r.codes.join(", ")}]`;
	if (r.crashed) return `${label}: crashed [${r.codes.join(", ")}]`;
	if (r.codes.length === 0) return `${label}: no refusal code`;
	if (unexpected.length > 0)
		return `${label}: unexpected [${unexpected.join(", ")}] not ⊆ [${allowed.join(", ")}]`;
	if (r.canarySeen) return `${label}: canary appeared in output`;
	return null;
}

function collect(
	child: ChildProcess,
	timeoutMs: number,
): Promise<{ stdout: string; code: number }> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`fixture timed out after ${timeoutMs} ms: ${stderr.slice(-200)}`));
		}, timeoutMs);
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout, code: code ?? -1 });
		});
	});
}

function parseReport(stdout: string): Record<string, unknown> | null {
	const line = stdout
		.split(/\r?\n/)
		.reverse()
		.find((l) => l.startsWith("##DY##"));
	return line ? (JSON.parse(line.slice(6)) as Record<string, unknown>) : null;
}

// Spawns one fixture under one Node and one variant, exactly as the hub spawns a plugin.
export async function runFixture(
	nodeBin: string,
	nodeLabel: string,
	canaries: Canaries,
	listeners: Listeners,
	fixture: Fixture,
	variant: Variant,
	timeoutMs = 20_000,
): Promise<FixtureOutcome> {
	const child = spawnPlugin({
		nodeBin,
		pluginDir: canaries.pluginDir,
		dataDir: canaries.dataDir,
		grantData: variant === "B",
		pluginId: "s02-escape",
		instanceId: `${fixture.name}-${variant}`,
		entry: path.join(canaries.pluginDir, fixture.file),
		entryArgs: [JSON.stringify(fixtureConfig(canaries, listeners))],
	});
	const { stdout } = await collect(child, timeoutMs);
	const canarySeen = stdout.includes(MK_CANARY) || stdout.includes(SQLITE_CANARY);
	const report = parseReport(stdout);
	if (report === null) {
		return {
			name: fixture.name,
			node: nodeLabel,
			variant,
			outcome: "no-report",
			codes: [],
			canarySeen,
		};
	}
	return {
		name: fixture.name,
		node: nodeLabel,
		variant,
		outcome: report.outcome as FixtureOutcome["outcome"],
		codes: (report.codes as string[]) ?? [],
		crashed: report.crashed === true,
		canarySeen,
		...(typeof report.realWriteAllowed === "boolean"
			? { realWriteAllowed: report.realWriteAllowed }
			: {}),
		...(report.realpathOracle && typeof report.realpathOracle === "object"
			? { realpathOracle: report.realpathOracle as Record<string, string | boolean> }
			: {}),
	};
}

export interface ArgvReport {
	readonly node: string;
	readonly variant: Variant;
	readonly nodeOptionsInherited: boolean;
	readonly argvMatchesAllowlist: boolean;
	readonly childSpawned: boolean;
}

// Runs the argv-report fixture with a parent env that carries NODE_OPTIONS, and checks the child's
// own execArgv equals the §4 allowlist exactly, NODE_OPTIONS did not reach it, and no child spawned.
export async function runArgvReport(
	nodeBin: string,
	nodeLabel: string,
	canaries: Canaries,
	listeners: Listeners,
	variant: Variant,
	timeoutMs = 20_000,
): Promise<ArgvReport> {
	const spec = {
		nodeBin,
		pluginDir: canaries.pluginDir,
		dataDir: canaries.dataDir,
		grantData: variant === "B",
		pluginId: "s02-escape",
		instanceId: `argv-${variant}`,
		entry: path.join(canaries.pluginDir, "argv-report.mjs"),
		entryArgs: [JSON.stringify(fixtureConfig(canaries, listeners))],
		parentEnv: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096 --title=dy-leak" },
	};
	const child = spawnPlugin(spec);
	const { stdout } = await collect(child, timeoutMs);
	const report = parseReport(stdout);
	const expected = buildExecArgv(execArgvFor(spec));
	const actual = Array.isArray(report?.execArgv) ? (report?.execArgv as string[]) : [];
	return {
		node: nodeLabel,
		variant,
		nodeOptionsInherited: report?.nodeOptions != null,
		argvMatchesAllowlist: actual.join("\u0000") === expected.join("\u0000"),
		childSpawned: report?.childSpawned === true,
	};
}

export function argvReportProblem(r: ArgvReport): string | null {
	const label = `argv-report ${r.node} ${r.variant}`;
	if (!r.argvMatchesAllowlist) return `${label}: exec argv does not equal the §4 allowlist`;
	if (r.nodeOptionsInherited) return `${label}: NODE_OPTIONS reached the child`;
	if (r.childSpawned) return `${label}: the child spawned a process`;
	return null;
}

export interface PrespawnOutcome {
	readonly kind: PrespawnLinkKind;
	readonly node: string;
	readonly variant: Variant;
	readonly refused: boolean;
	readonly findingKind?: string;
	// Control: with the scan disabled, does the Node permission model alone read the secret through
	// the planted link? (It does; that is why the pre-spawn scan is load-bearing.)
	readonly controlEscaped: boolean;
}

function plantLink(dir: string, kind: PrespawnLinkKind, canaries: Canaries): string {
	const name = `pre_${kind}`;
	const linkPath = path.join(dir, name);
	if (kind === "hardlink") fs.linkSync(canaries.mk, linkPath);
	else if (kind === "junction") fs.symlinkSync(canaries.fakeDir, linkPath, "junction");
	else fs.symlinkSync(canaries.mk, linkPath, "file");
	return name;
}

function readPlantedConfig(
	canaries: Canaries,
	listeners: Listeners,
	linkBase: string,
	pluginDir: string,
	kind: PrespawnLinkKind,
	linkName: string,
): string {
	return JSON.stringify({
		...fixtureConfig(canaries, listeners),
		pluginDir,
		linkBase,
		linkName,
		...(kind === "junction" ? { linkInner: path.basename(canaries.mk) } : {}),
	});
}

// Plants a link inside a fresh copy of the plugin bundle and confirms spawnPlugin refuses it, in both
// variants. Then, with the scan bypassed, confirms the Node model alone would follow the link.
export async function runPrespawnLink(
	nodeBin: string,
	nodeLabel: string,
	canaries: Canaries,
	listeners: Listeners,
	kind: PrespawnLinkKind,
	variant: Variant,
	timeoutMs = 20_000,
): Promise<PrespawnOutcome> {
	const pluginDir = path.join(canaries.root, `plugin-pre-${kind}-${variant}`);
	fs.rmSync(pluginDir, { recursive: true, force: true });
	fs.cpSync(canaries.pluginDir, pluginDir, { recursive: true, dereference: true });
	const linkName = plantLink(pluginDir, kind, canaries);
	const spec = {
		nodeBin,
		pluginDir,
		dataDir: canaries.dataDir,
		grantData: variant === "B",
		pluginId: "s02-escape",
		instanceId: `pre-${kind}-${variant}`,
		entry: path.join(pluginDir, "read-planted-link.mjs"),
		entryArgs: [readPlantedConfig(canaries, listeners, pluginDir, pluginDir, kind, linkName)],
	};
	let refused = false;
	let findingKind: string | undefined;
	try {
		spawnPlugin(spec).kill();
	} catch (error) {
		if (error instanceof RefusedSpawnError) {
			refused = true;
			findingKind = error.finding.kind;
		} else {
			throw error;
		}
	}
	// Control: build the same argv but spawn without the pre-spawn scan.
	const argv = buildArgv(execArgvFor(spec), spec.entry, spec.entryArgs);
	const control = spawn(nodeBin, argv, {
		env: scrubEnv({ pluginId: spec.pluginId, instanceId: spec.instanceId, dataDir: spec.dataDir }),
		cwd: pluginDir,
		stdio: ["pipe", "pipe", "pipe", "ipc"],
		windowsHide: true,
	});
	const controlEscaped =
		parseReport((await collect(control, timeoutMs)).stdout)?.outcome === "escaped";
	fs.rmSync(pluginDir, { recursive: true, force: true });
	return {
		kind,
		node: nodeLabel,
		variant,
		refused,
		controlEscaped,
		...(findingKind ? { findingKind } : {}),
	};
}

export function prespawnProblem(p: PrespawnOutcome): string | null {
	const label = `pre-spawn ${p.kind} ${p.node} ${p.variant}`;
	if (!p.refused) return `${label}: spawn was not refused`;
	if (!p.controlEscaped) return `${label}: control did not prove the scan is load-bearing`;
	return null;
}

export interface DataDirLinkOutcome {
	readonly kind: PrespawnLinkKind;
	readonly node: string;
	// A pre-existing link planted in the writable data dir (which the bundle scan does not cover) is
	// followed by the permission model: the plugin reads the secret through it. Documented, not fixed:
	// only a same-user process could plant it, which guardrail 9 already places out of scope.
	readonly followed: boolean;
}

// Variant B. Plants a pre-existing link in a fresh data dir, spawns the plugin normally (the bundle
// scan passes; the data dir is not scanned), and records that the plugin reads the secret through it.
export async function runDataDirLink(
	nodeBin: string,
	nodeLabel: string,
	canaries: Canaries,
	listeners: Listeners,
	kind: PrespawnLinkKind,
	timeoutMs = 20_000,
): Promise<DataDirLinkOutcome> {
	const dataDir = path.join(canaries.root, `data-link-${kind}`);
	fs.rmSync(dataDir, { recursive: true, force: true });
	fs.mkdirSync(dataDir, { recursive: true });
	const linkName = plantLink(dataDir, kind, canaries);
	const child = spawnPlugin({
		nodeBin,
		pluginDir: canaries.pluginDir,
		dataDir,
		grantData: true,
		pluginId: "s02-escape",
		instanceId: `datalink-${kind}`,
		entry: path.join(canaries.pluginDir, "read-planted-link.mjs"),
		entryArgs: [
			readPlantedConfig(canaries, listeners, dataDir, canaries.pluginDir, kind, linkName),
		],
	});
	const followed = parseReport((await collect(child, timeoutMs)).stdout)?.outcome === "escaped";
	fs.rmSync(dataDir, { recursive: true, force: true });
	return { kind, node: nodeLabel, followed };
}

export interface ControlOutcome {
	readonly kind: "sqlite" | "vfs";
	readonly node: string;
	readonly fields: Readonly<Record<string, unknown>>;
}

// Runs a control fixture with the matching never-listed experimental flag ADDED to the §4 argv, to
// show what that flag would open — i.e. why it is never-listed. sqlite: node:sqlite ATTACH reads a
// database outside every grant (the permission model does not gate ATTACH). vfs: node:vfs loads and
// constructs, but mounting is still gated by --allow-fs-vfs.
export async function runControl(
	nodeBin: string,
	nodeLabel: string,
	canaries: Canaries,
	listeners: Listeners,
	kind: "sqlite" | "vfs",
	timeoutMs = 20_000,
): Promise<ControlOutcome> {
	const base = buildExecArgv(
		execArgvFor({
			nodeBin,
			pluginDir: canaries.pluginDir,
			dataDir: canaries.dataDir,
			grantData: true,
			pluginId: "s02-escape",
			instanceId: `control-${kind}`,
			entry: "",
		}),
	);
	const execArgv =
		kind === "sqlite"
			? base.map((f) => (f === "--no-experimental-sqlite" ? "--experimental-sqlite" : f))
			: [...base, "--experimental-vfs"];
	const entry = path.join(canaries.pluginDir, `control-${kind}.mjs`);
	const argv = [...execArgv, entry, JSON.stringify(fixtureConfig(canaries, listeners))];
	const control = spawn(nodeBin, argv, {
		env: scrubEnv({
			pluginId: "s02-escape",
			instanceId: `control-${kind}`,
			dataDir: canaries.dataDir,
		}),
		cwd: canaries.pluginDir,
		stdio: ["pipe", "pipe", "pipe", "ipc"],
		windowsHide: true,
	});
	const report = parseReport((await collect(control, timeoutMs)).stdout) ?? {};
	return { kind, node: nodeLabel, fields: report };
}

export function controlProblem(c: ControlOutcome): string | null {
	const label = `control-${c.kind} ${c.node}`;
	if (c.kind === "sqlite") {
		if (c.fields.moduleLoaded !== true)
			return `${label}: node:sqlite did not load under --experimental-sqlite`;
		if (c.fields.attachRead !== true)
			return `${label}: ATTACH no longer reads outside the grant (re-review for ADR 0003)`;
		return null;
	}
	if (c.fields.moduleLoaded !== true)
		return `${label}: node:vfs did not load under --experimental-vfs`;
	if (c.fields.mountCode === "mounted")
		return `${label}: mount succeeded without --allow-fs-vfs (re-review for ADR 0003)`;
	return null;
}

// The out-of-grant secrets must be byte-unchanged and the fake Startup folder empty after a run.
export function canariesIntactProblem(canaries: Canaries): string | null {
	if (fs.readFileSync(canaries.mk, "utf8") !== MK_CANARY) return "mk.key was modified";
	if (fs.readFileSync(canaries.fakeRc, "utf8").includes("owned")) return "fake .bashrc was written";
	if (fs.readdirSync(canaries.fakeStartupDir).length > 0) return "fake Startup folder was written";
	if (fs.readFileSync(canaries.vaultDb).includes(Buffer.from(MK_CANARY)))
		return "vault.db was tampered";
	return null;
}
