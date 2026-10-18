// Spawns a python plugin the way the hub does (plan §4): the runtime copy and the bundle are checked
// first, then M0.11's spawnPlugin runs `node <production flags> --allow-fs-read=<runtimeDir>
// --wasm-max-mem-pages=8192 <runtimeDir>/shim.mjs <pluginDir>` with the scrubbed env and the IPC
// host channel on fd 3. Imports only node: built-ins and M0.11's files, so it also runs in containers.
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { preSpawnLinkScan, spawnPlugin } from "@draftyak/spike-s02-plugin-sandbox/src/spawn.ts";
import { RuntimeRefusedError, SHIM, verifyRuntime } from "./runtime.ts";

export interface PythonSpawnSpec {
	readonly nodeBin: string;
	readonly runtimeDir: string;
	// The runtime copy's hash list (runtime.lock.json's files).
	readonly expected: Readonly<Record<string, string>>;
	// The ABI of the runtime's Pyodide, as the manifest names it: pyemscripten_<abi_version>.
	readonly abi: string;
	readonly pluginDir: string;
	readonly dataDir: string;
	readonly pluginId: string;
	readonly instanceId: string;
	readonly signal?: AbortSignal;
}

export class BundleRefusedError extends Error {
	override name = "BundleRefusedError";
	readonly code = "DY_REFUSED_SPAWN";
}

interface LockEntry {
	readonly name: string;
	readonly file_name: string;
	readonly sha256: string;
}

// The bundle rules of plan §4 Python runtime, checked before every spawn because Pyodide ignores
// wheel integrity in Node: the manifest's ABI and the lock's equal the runtime's, every lock entry has
// its wheel with a matching sha256, nothing else sits in wheels/, and the lock omits micropip. Links
// are refused before any file is read (M0.11's rule), and a refusal never quotes file contents.
export function checkBundle(pluginDir: string, abi: string): void {
	const refuse = (why: string): never => {
		throw new BundleRefusedError(`refusing to spawn: ${why}`);
	};
	const link = preSpawnLinkScan([pluginDir]);
	if (link !== null) refuse(`${link.kind} in the plugin bundle (${link.path})`);
	const read = (name: string): unknown => {
		try {
			return JSON.parse(fs.readFileSync(path.join(pluginDir, name), "utf8"));
		} catch {
			return refuse(`${name} is unreadable or not JSON`);
		}
	};
	const manifest = read("draftyak.plugin.json") as { runtime?: string; python?: { abi?: string } };
	if (manifest?.runtime !== "python" || manifest.python?.abi !== abi)
		refuse("manifest runtime or ABI");
	const lock = read("pyodide-lock.json") as {
		info?: { abi_version?: string };
		packages?: Record<string, LockEntry>;
	};
	if (`pyemscripten_${lock?.info?.abi_version}` !== abi) refuse("lock ABI");
	const entries = Object.values(lock?.packages ?? {});
	const fields = (entry: LockEntry): boolean =>
		[entry?.name, entry?.file_name, entry?.sha256].every((value) => typeof value === "string");
	if (!entries.every(fields)) refuse("a lock entry without name, file_name or sha256");
	if (entries.some((entry) => /^micropip$/i.test(entry.name))) refuse("micropip in the lock");
	const wheels = path.join(pluginDir, "wheels");
	let present: string[] = [];
	try {
		present = fs.readdirSync(wheels).toSorted();
	} catch {
		refuse("wheels/ is unreadable");
	}
	const listed = entries.map((entry) => entry.file_name).toSorted();
	if (present.join("\n") !== listed.join("\n")) refuse("wheels/ differs from the lock");
	for (const entry of entries) {
		const file = path.join(wheels, path.basename(entry.file_name));
		let sha256 = "";
		try {
			sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
		} catch {
			refuse(`${entry.file_name} is unreadable`);
		}
		if (sha256 !== entry.sha256) refuse(`${entry.file_name} doesn't match the lock`);
	}
}

export function spawnPythonPlugin(spec: PythonSpawnSpec): ChildProcess {
	const finding = verifyRuntime(spec.runtimeDir, spec.expected);
	if (finding !== null) throw new RuntimeRefusedError(finding);
	checkBundle(spec.pluginDir, spec.abi);
	return spawnPlugin({
		nodeBin: spec.nodeBin,
		runtime: "python",
		pluginDir: spec.pluginDir,
		dataDir: spec.dataDir,
		runtimeDir: spec.runtimeDir,
		pluginId: spec.pluginId,
		instanceId: spec.instanceId,
		entry: path.join(spec.runtimeDir, SHIM),
		entryArgs: [spec.pluginDir],
		signal: spec.signal,
	});
}
