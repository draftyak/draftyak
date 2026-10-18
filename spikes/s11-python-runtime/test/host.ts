// Host-side preparation for the S11b suites (never staged into the container, so it may use the kit).
// Builds the dy-hostile and py-hello bundles, the runtime copy and the canary profile, and exposes the
// connection watcher the audit run uses on Windows and macOS (Linux uses Docker --network none).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostTarget, nodeBinary, nodeVersions } from "@draftyak/spike-kit";
import { fetchRuntime, type RuntimeLock, spikeDir } from "../scripts/fetch-runtime.ts";
import { copyRuntime, SHIM } from "../src/runtime.ts";
import { buildBundle } from "./bundle.ts";
import { type CanaryArgs, HOME_CANARY, MK_CANARY, OFF_PROFILE, type PluginSpec } from "./suite.ts";

export const AUDIT_PRELOAD = "audit-preload.mjs";
export const arch: "x64" | "arm64" = hostTarget().arch;

// spikes-run's DRAFTYAK_NODES (M0.8): both (also when unset), minimum or bundled.
export function selectedNodes(env: NodeJS.ProcessEnv = process.env): string[] {
	const { minimum, bundled } = nodeVersions();
	const value = env.DRAFTYAK_NODES || "both";
	if (value === "both") return [...new Set([minimum, bundled])];
	if (value === "minimum") return [minimum];
	if (value === "bundled") return [bundled];
	throw new Error(`DRAFTYAK_NODES is both, minimum or bundled, not "${value}"`);
}

// As S1 does: DRAFTYAK_RECORD_EVIDENCE=1 records, 0 doesn't; unset, only CI records.
export function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (!["", "0", "1"].includes(value)) {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1" || (value === "" && !!env.CI);
}

export interface Prepared {
	readonly lock: RuntimeLock;
	readonly work: string;
	readonly runtimeDir: string;
	readonly hostilePluginDir: string;
	readonly auditPluginDir: string;
	readonly fakeDir: string;
	readonly canaries: CanaryArgs;
	readonly sources: { pyodideDir: string; wsDir: string; shim: string };
}

// Builds everything the drivers need under one fresh temp dir and verifies the runtime copy.
export async function prepareHost(): Promise<Prepared> {
	const { lock, pyodideDir, wsDir, shim } = await fetchRuntime();
	const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dy-s11b-")));
	const shimFile = path.join(work, SHIM);
	fs.writeFileSync(shimFile, shim);
	const wheels = path.join(cacheWheels());
	const hostilePluginDir = path.join(work, "dy-hostile");
	buildBundle({
		fixtureDir: path.join(spikeDir, "fixtures", "hostile-py"),
		target: hostilePluginDir,
		lock,
		wheelsDir: wheels,
		requires: [],
	});
	const auditPluginDir = path.join(work, "py-hello");
	buildBundle({
		fixtureDir: path.join(spikeDir, "fixtures", "py-hello"),
		target: auditPluginDir,
		lock,
		wheelsDir: wheels,
		requires: ["requests", "typing-extensions"],
	});
	// The audit instrument is loaded with --import from inside the (granted) plugin dir. The clean
	// audit runs from py-hello; the net positive control runs from the hostile bundle, so both dirs
	// hold a copy.
	const preloadSrc = path.join(spikeDir, "fixtures", "audit", AUDIT_PRELOAD);
	fs.copyFileSync(preloadSrc, path.join(auditPluginDir, AUDIT_PRELOAD));
	fs.copyFileSync(preloadSrc, path.join(hostilePluginDir, AUDIT_PRELOAD));
	const runtimeDir = path.join(work, "runtime");
	const sources = { pyodideDir, wsDir, shim: shimFile };
	copyRuntime(runtimeDir, lock.files, sources);
	const fakeDir = path.join(work, "fake");
	fs.mkdirSync(fakeDir);
	fs.writeFileSync(path.join(fakeDir, "mk.key"), MK_CANARY);
	fs.writeFileSync(path.join(fakeDir, ".bashrc"), HOME_CANARY);
	const canaries: CanaryArgs = {
		fakeDir,
		pluginDir: hostilePluginDir,
		runtimeDir,
		canaries: [
			{ name: "mk.key", marker: MK_CANARY },
			{ name: ".bashrc", marker: HOME_CANARY },
		],
		offProfileUrl: OFF_PROFILE,
	};
	return { lock, work, runtimeDir, hostilePluginDir, auditPluginDir, fakeDir, canaries, sources };
}

function cacheWheels(): string {
	const root =
		process.env.DRAFTYAK_CACHE_DIR ||
		(process.platform === "win32"
			? "C:/dev/.draftyak-cache"
			: path.join(os.homedir(), ".cache", "draftyak"));
	return path.join(root, "pyodide", "314.0.7", "wheels");
}

export async function nodeBin(version: string): Promise<string> {
	return nodeBinary(version);
}

export function specFor(prepared: Prepared, nodeBinary: string): PluginSpec {
	return {
		nodeBin: nodeBinary,
		runtimeDir: prepared.runtimeDir,
		files: prepared.lock.files,
		abi: prepared.lock.abi,
		dataDir: path.join(prepared.work, "data"),
	};
}

// The audit connection watcher on this host: Windows Get-NetTCPConnection, macOS lsof; Linux uses
// Docker --network none, so there is no host watcher there. Returns the count of TCP sockets the
// plugin process owns (0 is the clean result). It FAILS CLOSED: a spawn error, a non-zero exit, a
// timeout or an unparseable result returns -1 (inconclusive), which auditProblem treats as a failure
// rather than reading a timed-out watcher as "0 connections, clean". The diagnostics-channel net
// count is the primary net detector on both Nodes; this watcher is a secondary check.
const WATCHER_INCONCLUSIVE = -1;

export function hostTcpWatcher(): ((pid: number) => Promise<number>) | undefined {
	if (process.platform === "win32") {
		return async (pid: number) => {
			const result = spawnSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`@(Get-NetTCPConnection -OwningProcess ${pid} -ErrorAction SilentlyContinue).Count`,
				],
				{ encoding: "utf8", timeout: 20_000 },
			);
			if (result.error !== undefined || result.status !== 0) return WATCHER_INCONCLUSIVE;
			const text = typeof result.stdout === "string" ? result.stdout.trim() : "";
			const count = Number.parseInt(text, 10);
			return Number.isNaN(count) ? WATCHER_INCONCLUSIVE : count;
		};
	}
	if (process.platform === "darwin") {
		return async (pid: number) => {
			const result = spawnSync("lsof", ["-nP", "-p", String(pid), "-iTCP"], {
				encoding: "utf8",
				timeout: 20_000,
			});
			// lsof exits non-zero when the process owns no matching files, so an empty stdout with a
			// non-zero status is a legitimate 0; only a spawn error or a timeout is inconclusive.
			if (result.error !== undefined) return WATCHER_INCONCLUSIVE;
			if (typeof result.stdout !== "string") return WATCHER_INCONCLUSIVE;
			return result.stdout.split(/\r?\n/).filter((line) => /ESTABLISHED|SYN_SENT|->/.test(line))
				.length;
		};
	}
	return undefined;
}
