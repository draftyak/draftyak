// Builds what python plugins run from, at build time only (plan §4 Python runtime): Pyodide's core
// from npm pyodide@314.0.7 and ws@8.22.0 as pnpm installed them (pnpm-lock.yaml's sha512 pins the
// bytes), the shim bundle (build-shim.ts), and only the wheels the S11 fixtures need, downloaded from
// the pinned Pyodide index and checked against pyodide-lock.json's SHA-256. runtime.lock.json records
// every hash; the wheels are cached under $DRAFTYAK_CACHE_DIR/pyodide/. Plugin processes never reach
// the network.
//   node scripts/fetch-runtime.ts                     check the install, fetch missing wheels
//   node scripts/fetch-runtime.ts --write [name ...]  rewrite runtime.lock.json (a deliberate step),
//                                                     adding the named packages to its list
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cacheDir } from "@draftyak/spike-kit";
import { SHIM, sha256File } from "../src/runtime.ts";
import { buildShim } from "./build-shim.ts";

export const spikeDir: string = path.resolve(import.meta.dirname, "..");
export const LOCK_FILE: string = path.join(spikeDir, "runtime.lock.json");
export const PYODIDE = "314.0.7";
export const WS = "8.22.0";
export const INDEX: string = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE}/full/`;
// What loadPyodide reads in Node; the .d.ts, maps, HTML consoles and the lock stay out.
export const CORE_FILES: readonly string[] = [
	"pyodide.mjs",
	"pyodide.asm.mjs",
	"pyodide.asm.wasm",
	"python_stdlib.zip",
];

export interface LockInfo {
	readonly abi_version: string;
	readonly arch: string;
	readonly platform: string;
	readonly python: string;
}

export interface WheelEntry {
	readonly name: string;
	readonly version: string;
	readonly file_name: string;
	readonly install_dir: string;
	readonly sha256: string;
	readonly package_type: string;
	readonly imports: readonly string[];
	readonly depends: readonly string[];
}

export interface RuntimeLock {
	readonly pyodide: string;
	readonly ws: string;
	readonly index: string;
	readonly abi: string;
	readonly info: LockInfo;
	readonly lockSha256: string;
	readonly packages: readonly string[];
	readonly files: Readonly<Record<string, string>>;
	readonly wheels: Readonly<Record<string, WheelEntry>>;
}

interface PyodideLock {
	readonly info: LockInfo;
	readonly packages: Readonly<Record<string, WheelEntry>>;
}

export const canonical = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

export function readRuntimeLock(file: string = LOCK_FILE): RuntimeLock {
	return JSON.parse(fs.readFileSync(file, "utf8")) as RuntimeLock;
}

// Node's directory lookup from the spike, resolved through pnpm's links to the store copy.
export function installedDir(name: string, from: string = spikeDir): string {
	for (let dir = from; ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", name);
		if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
		if (path.dirname(dir) === dir) throw new Error(`${name} isn't installed: run pnpm install`);
	}
}

const version = (dir: string): string =>
	(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string })
		.version;

// Code-unit order, so runtime.lock.json is written the same in every locale.
const sortedByKey = <T>(record: Record<string, T>): Record<string, T> =>
	Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// The runtime's hash list: Pyodide's core, every file of the ws package under node_modules/ws/, and
// the shim bundle.
export function hashRuntime(
	pyodideDir: string,
	wsDir: string,
	shim: Uint8Array,
): Record<string, string> {
	const files: Record<string, string> = { [SHIM]: sha256(shim) };
	for (const name of CORE_FILES) files[name] = sha256File(path.join(pyodideDir, name));
	const entries = fs.readdirSync(wsDir, { recursive: true, withFileTypes: true });
	for (const entry of entries.filter((item) => item.isFile())) {
		const full = path.join(entry.parentPath, entry.name);
		const rel = path.relative(wsDir, full).split(path.sep).join("/");
		if (!rel.startsWith("node_modules/")) files[`node_modules/ws/${rel}`] = sha256File(full);
	}
	return sortedByKey(files);
}

// Every requested package plus its dependencies, from Pyodide's own lock.
export function resolveWheels(
	lock: PyodideLock,
	names: readonly string[],
): Record<string, WheelEntry> {
	const byName = new Map(
		Object.entries(lock.packages).map(([key, entry]) => [canonical(key), entry]),
	);
	const found: Record<string, WheelEntry> = {};
	const visit = (name: string): void => {
		const key = canonical(name);
		if (found[key] !== undefined) return;
		const entry = byName.get(key);
		if (entry === undefined) throw new Error(`${name} isn't in Pyodide ${PYODIDE}'s lock`);
		if (key === "micropip") throw new Error("micropip never ships in a plugin bundle");
		const { name: own, version: v, file_name, install_dir, sha256, package_type } = entry;
		if (!/^[\w.+-]+\.whl$/.test(file_name)) throw new Error(`unexpected file name ${file_name}`);
		found[key] = {
			name: own,
			version: v,
			file_name,
			install_dir,
			sha256,
			package_type,
			imports: entry.imports,
			depends: entry.depends,
		};
		for (const dependency of entry.depends) visit(dependency);
	};
	for (const name of names) visit(name);
	return sortedByKey(found);
}

// The installed packages and the built shim must be byte-identical to runtime.lock.json's record.
export function checkInstalled(
	lock: RuntimeLock,
	pyodideDir: string,
	wsDir: string,
	shim: Uint8Array,
): string[] {
	const problems: string[] = [];
	if (version(pyodideDir) !== lock.pyodide)
		problems.push(`pyodide ${version(pyodideDir)} installed`);
	if (version(wsDir) !== lock.ws) problems.push(`ws ${version(wsDir)} installed`);
	const actual = hashRuntime(pyodideDir, wsDir, shim);
	for (const rel of new Set([...Object.keys(actual), ...Object.keys(lock.files)])) {
		if (actual[rel] !== lock.files[rel]) problems.push(`${rel} differs from runtime.lock.json`);
	}
	return problems;
}

export function wheelsDir(cache: string = cacheDir()): string {
	return path.join(cache, "pyodide", PYODIDE, "wheels");
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// Every wheel of the lock in the cache, each verified against its SHA-256 on every run; a missing
// one is downloaded from the pinned index, never from anywhere else.
export async function ensureWheels(
	lock: RuntimeLock,
	dir: string = wheelsDir(),
	fetchImpl: Fetch = fetch,
): Promise<{ readonly dir: string; readonly downloaded: readonly string[] }> {
	if (lock.index !== INDEX) throw new Error(`runtime.lock.json names another index: ${lock.index}`);
	fs.mkdirSync(dir, { recursive: true });
	const downloaded: string[] = [];
	for (const wheel of Object.values(lock.wheels)) {
		const file = path.join(dir, wheel.file_name);
		if (fs.existsSync(file) && sha256File(file) === wheel.sha256) continue;
		const url = `${INDEX}${wheel.file_name}`;
		let bytes: Uint8Array;
		try {
			const response = await fetchImpl(url, {
				redirect: "error",
				signal: AbortSignal.timeout(300_000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			bytes = new Uint8Array(await response.arrayBuffer());
		} catch (error) {
			const cause = (error as { cause?: { code?: unknown } }).cause?.code;
			const why = typeof cause === "string" ? cause : (error as Error).message;
			throw new Error(`${wheel.file_name} from ${url}: ${why}`);
		}
		if (sha256(bytes) !== wheel.sha256) throw new Error(`${wheel.file_name}: SHA-256 mismatch`);
		const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			fs.writeFileSync(temp, bytes);
			fs.renameSync(temp, file);
		} finally {
			fs.rmSync(temp, { force: true });
		}
		downloaded.push(wheel.file_name);
	}
	return { dir, downloaded };
}

// The runtime ready for a spawn: the install and the shim bundle match the lock, and every wheel is
// in the cache.
export async function fetchRuntime(
	options: { readonly cache?: string; readonly fetchImpl?: Fetch } = {},
): Promise<{
	readonly lock: RuntimeLock;
	readonly pyodideDir: string;
	readonly wsDir: string;
	readonly shim: Buffer;
	readonly wheels: string;
}> {
	const lock = readRuntimeLock();
	const pyodideDir = installedDir("pyodide");
	const wsDir = installedDir("ws");
	const shim = await buildShim();
	const problems = checkInstalled(lock, pyodideDir, wsDir, shim);
	if (problems.length > 0) {
		throw new Error(
			`the runtime doesn't match runtime.lock.json (after a deliberate change, run node scripts/fetch-runtime.ts --write): ${problems.join("; ")}`,
		);
	}
	const { dir } = await ensureWheels(lock, wheelsDir(options.cache), options.fetchImpl);
	return { lock, pyodideDir, wsDir, shim, wheels: dir };
}

// Re-records every hash, keeping the packages already listed and adding the given names. To drop a
// package, remove it from runtime.lock.json's packages first.
export async function writeRuntimeLock(
	names: readonly string[] = [],
	file: string = LOCK_FILE,
): Promise<RuntimeLock> {
	const pyodideDir = installedDir("pyodide");
	const wsDir = installedDir("ws");
	if (version(pyodideDir) !== PYODIDE || version(wsDir) !== WS) {
		throw new Error(`install pyodide ${PYODIDE} and ws ${WS} first`);
	}
	const lockPath = path.join(pyodideDir, "pyodide-lock.json");
	const pyodideLock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as PyodideLock;
	const previous = fs.existsSync(file) ? readRuntimeLock(file).packages : [];
	const packages = [...new Set([...previous, ...names].map(canonical))].toSorted();
	const lock: RuntimeLock = {
		pyodide: PYODIDE,
		ws: WS,
		index: INDEX,
		abi: `pyemscripten_${pyodideLock.info.abi_version}`,
		info: pyodideLock.info,
		lockSha256: sha256File(lockPath),
		packages,
		files: hashRuntime(pyodideDir, wsDir, await buildShim()),
		wheels: resolveWheels(pyodideLock, packages),
	};
	fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
	return lock;
}

if (import.meta.main) {
	const args = process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--");
	try {
		if (args[0] === "--write") {
			const lock = await writeRuntimeLock(args.slice(1));
			console.log(
				`runtime.lock.json: ${Object.keys(lock.files).length} files, wheels ${Object.keys(lock.wheels).join(", ") || "none"}`,
			);
		} else if (args.length > 0) {
			throw new Error("usage: node scripts/fetch-runtime.ts [--write [package ...]]");
		}
		const { wheels } = await fetchRuntime();
		console.log(`fetch-runtime: Pyodide ${PYODIDE} runtime checked; wheels in ${wheels}`);
	} catch (error) {
		console.error(`fetch-runtime: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
