import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fstatSync, lstatSync, readSync, realpathSync, writeSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { InventoryCacheOperation } from "./inventory-native-operation.ts";
import {
	INVENTORY_NATIVE_REFUSAL_MAX_BYTES,
	type InventoryNativeToolchainRefusal,
	parseInventoryNativeToolchainRefusal,
} from "./inventory-native-refusal.ts";

export type { InventoryNativeToolchainRefusal } from "./inventory-native-refusal.ts";

const verifyRoot = path.resolve(import.meta.dirname, "..");
const repository = path.resolve(verifyRoot, "..", "..");
const cache = path.join(verifyRoot, ".cache", "inventory-native");
const source = path.join(verifyRoot, "native", "directory.cc");
const platformSource = path.join(verifyRoot, "native", "directory-platform.h");
const windowsHelper = path.join(import.meta.dirname, "inventory-native-toolchain.ps1");
const posixHelper = path.join(import.meta.dirname, "inventory-native-posix.mjs");
const cacheHelper = path.join(import.meta.dirname, "inventory-native-cache.ps1");
const policyFile = path.join(repository, "tools", "fetch-node", "fetch-node.mjs");
const headerNames = [
	"node_api.h",
	"node_api_types.h",
	"js_native_api.h",
	"js_native_api_types.h",
	"node_version.h",
] as const;

interface DevelopmentInputs {
	readonly headers: string;
	readonly importLibrary?: string;
	readonly version: string;
	readonly arch: string;
	readonly signer: string;
	readonly sumsSha256: string;
	readonly archiveSha256: string;
	readonly files: Readonly<Record<string, string>>;
	readonly runtimeSha256?: string;
}
interface DistributionPolicy {
	fetchNode(
		request: { version: string; platform: string; arch: string; offline: boolean },
		deps: { cacheDir: string },
	): Promise<{ readonly binary: string }>;
	fetchNodeDevelopment(
		request: { version: string; platform: string; arch: string; offline: boolean },
		deps: { cacheDir: string },
	): Promise<DevelopmentInputs>;
}
interface FileInput {
	readonly path: string;
	readonly sha256: string;
}
interface Toolchain {
	readonly schema: string;
	readonly platform?: string;
	readonly host: string;
	readonly target: string;
	readonly compiler: FileInput;
	readonly linker?: FileInput;
	readonly compilerRuntime: readonly FileInput[];
	readonly includeDirectories: readonly string[];
	readonly frameworkDirectories?: readonly string[];
	readonly libraryDirectories: readonly string[];
	readonly libraryFiles?: readonly FileInput[];
	readonly windowsDirectory?: string;
	readonly sysroot?: string;
	readonly provenance?: { readonly trustedSystemGroups?: readonly number[] };
	readonly inputs: readonly {
		readonly input: string;
		readonly relative: string;
		readonly path?: string;
		readonly sha256: string;
	}[];
}
export interface InventoryNativeClosedCaptures {
	readonly files: readonly string[];
	readonly kind: "command" | "metadata";
	readonly code?: number | null;
	readonly signal?: NodeJS.Signals | null;
	readonly complete: boolean;
	readonly refusal?: InventoryNativeToolchainRefusal;
}
export interface InventoryNativeBuild {
	readonly file: string;
	readonly sha256: string;
	readonly manifestFile: string;
	readonly reused: boolean;
}
export type InventoryNativeKind = "directory" | "link" | "other";
export interface InventoryNativeRoot {
	read(
		components: readonly string[],
	): Promise<readonly { readonly name: string; readonly kind: InventoryNativeKind }[]>;
	stat(components: readonly string[]): Promise<InventoryNativeKind>;
	current(): Promise<boolean>;
	stop(): void;
	close(): Promise<void>;
}
export interface InventoryNativeBinding {
	openRoot(absolutePath: string): Promise<InventoryNativeRoot>;
}
interface Recipe {
	readonly schema: string;
	readonly platform: string;
	readonly arch: string;
	readonly runtimeSha256: string;
	readonly sources: Readonly<Record<string, string>>;
	readonly development: DevelopmentInputs;
	readonly toolchainSha256: string;
}
interface BuildManifest {
	readonly schema: string;
	readonly key: string;
	readonly recipe: Recipe;
	readonly binarySha256: string;
}

function refuse(): never {
	throw new Error("inventory directory backend requires qualified explicit preparation");
}
function requireInput(condition: unknown): asserts condition {
	if (!condition) refuse();
}
const digest = (bytes: Uint8Array | string): string =>
	createHash("sha256").update(bytes).digest("hex");
const key = (value: string): string =>
	process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

async function ordinaryFile(file: string, privateFile = false): Promise<Buffer> {
	const before = await lstat(file);
	requireInput(before.isFile() && !before.isSymbolicLink());
	if (privateFile) {
		requireInput(before.nlink === 1);
		if (process.platform !== "win32")
			requireInput(before.uid === process.getuid?.() && (before.mode & 0o077) === 0);
	}
	requireInput(key(await realpath(file)) === key(file));
	const bytes = await readFile(file),
		after = await lstat(file);
	requireInput(
		after.isFile() &&
			!after.isSymbolicLink() &&
			before.dev === after.dev &&
			before.ino === after.ino &&
			before.size === bytes.length &&
			after.size === bytes.length &&
			before.mtimeMs === after.mtimeMs,
	);
	return bytes;
}
async function ownCache(create: boolean): Promise<void> {
	requireInput(key(await realpath(verifyRoot)) === key(verifyRoot));
	for (const directory of [path.join(verifyRoot, ".cache"), cache]) {
		if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
		let kind = await lstat(directory);
		requireInput(
			kind.isDirectory() &&
				!kind.isSymbolicLink() &&
				key(await realpath(directory)) === key(directory),
		);
		if (process.platform !== "win32") {
			requireInput(kind.uid === process.getuid?.());
			if (create && kind.mode & 0o077) {
				await chmod(directory, 0o700);
				kind = await lstat(directory);
			}
			requireInput((kind.mode & 0o077) === 0);
		}
	}
}
async function distributionPolicy(): Promise<DistributionPolicy> {
	const module: unknown = await import(
		new URL("../../fetch-node/fetch-node.mjs", import.meta.url).href
	);
	requireInput(typeof module === "object" && module !== null);
	const record = module as Record<string, unknown>;
	requireInput(
		typeof record.fetchNode === "function" && typeof record.fetchNodeDevelopment === "function",
	);
	return module as DistributionPolicy;
}

/** Explicit signed acquisition; offline by default. Import and loading never acquire inputs. */
export async function acquireInventoryNativeNodeInputs(
	options: { readonly offline?: boolean } = {},
): Promise<DevelopmentInputs> {
	return cacheOperation((operation) => acquireNodeInputs(operation, options));
}
async function acquireNodeInputs(
	operation: InventoryCacheOperation,
	options: { readonly offline?: boolean },
): Promise<DevelopmentInputs> {
	await ownCache(true);
	await qualifyAcquisitionNamespace(operation, true);
	const pins = JSON.parse(
		(await ordinaryFile(path.join(repository, "tools", "fetch-node", "versions.json"))).toString(
			"utf8",
		),
	) as Record<string, unknown>;
	requireInput(
		[pins.minimum, pins.bundled].includes(process.versions.node) &&
			["win32", "linux", "darwin"].includes(process.platform) &&
			["x64", "arm64"].includes(process.arch),
	);
	const platform = process.platform === "win32" ? "win" : process.platform;
	const request = {
		version: process.versions.node,
		platform,
		arch: process.arch,
		offline: options.offline ?? true,
	};
	const storage = { cacheDir: path.join(cache, "distribution") },
		policy = await distributionPolicy();
	let runtime: Awaited<ReturnType<DistributionPolicy["fetchNode"]>>;
	try {
		runtime = await policy.fetchNode(request, storage);
	} catch (error) {
		operation.retain();
		throw error;
	}
	const runtimeSha256 = digest(await ordinaryFile(runtime.binary));
	requireInput(digest(await ordinaryFile(process.execPath)) === runtimeSha256);
	await qualifyAcquisitionNamespace(operation, false);
	let inputs: DevelopmentInputs;
	try {
		inputs = await policy.fetchNodeDevelopment(request, storage);
	} catch (error) {
		operation.retain();
		throw error;
	}
	await qualifyAcquisitionNamespace(operation, false);
	requireInput(inputs.version === process.versions.node && inputs.arch === process.arch);
	const output = path.join(
		cache,
		"distribution",
		"node-development",
		inputs.version,
		`${platform}-${process.arch}`,
	);
	requireInput(key(inputs.headers) === key(path.join(output, "include")));
	for (const name of headerNames)
		requireInput(
			digest(await ordinaryFile(path.join(inputs.headers, name))) ===
				inputs.files[`include/${name}`],
		);
	if (platform === "win") {
		requireInput(inputs.importLibrary === path.join(output, "node.lib"));
		requireInput(digest(await ordinaryFile(inputs.importLibrary)) === inputs.files["node.lib"]);
	}
	return { ...inputs, runtimeSha256 };
}

async function cacheOperation<T>(
	work: (operation: InventoryCacheOperation) => Promise<T>,
): Promise<T> {
	const operation = await InventoryCacheOperation.begin();
	let primaryFailed = false;
	try {
		return await work(operation);
	} catch (error) {
		primaryFailed = true;
		operation.noteFailure(error);
		throw error;
	} finally {
		await operation.finish(primaryFailed);
	}
}
async function* cacheStages<T>(
	work: (
		operation: InventoryCacheOperation,
	) => AsyncGenerator<InventoryNativeClosedCaptures, T, void>,
): AsyncGenerator<InventoryNativeClosedCaptures, T, void> {
	const operation = await InventoryCacheOperation.begin();
	let primaryFailed = false;
	try {
		return yield* work(operation);
	} catch (error) {
		primaryFailed = true;
		operation.noteFailure(error);
		throw error;
	} finally {
		await operation.finish(primaryFailed);
	}
}

// Returns CLOSED files and fixed lifecycle values, never stdout text. Preparation yields them
// before their reader continues into diagnostic or provenance parsing.
async function runOwned(
	operation: InventoryCacheOperation,
	command: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	stem: string,
): Promise<InventoryNativeClosedCaptures> {
	requireInput(path.isAbsolute(command) && !/\.(?:cmd|bat|ps1)$/i.test(command));
	const stdoutFile = path.join(cwd, `${stem}.stdout.log`),
		stderrFile = path.join(cwd, `${stem}.stderr.log`);
	const out = operation.openFile(stdoutFile, "wx");
	let err: ReturnType<InventoryCacheOperation["openFile"]> | undefined,
		child: ReturnType<typeof spawn> | undefined,
		terminal: ReturnType<InventoryCacheOperation["watchChild"]> | undefined,
		failed = false,
		code: number | null = null,
		signal: NodeJS.Signals | null = null;
	try {
		err = operation.openFile(stderrFile, "wx");
		const started = spawn(command, [...args], {
			cwd,
			env,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		child = started;
		terminal = operation.watchChild(started, [out, err]);
		started.on("error", () => {
			failed = true;
		});
		for (const [stream, fd] of [
			[started.stdout, out.fd],
			[started.stderr, err.fd],
		] as const) {
			let count = 0;
			stream.on("data", (bytes: Buffer) => {
				count += bytes.length;
				if (count > 8 * 1024 * 1024) {
					failed = true;
					return;
				}
				try {
					let offset = 0;
					while (offset < bytes.length) {
						const wrote = writeSync(fd, bytes, offset, bytes.length - offset);
						requireInput(wrote > 0);
						offset += wrote;
					}
				} catch {
					failed = true;
				}
			});
			stream.on("error", () => {
				failed = true;
			});
		}
		const ending = await terminal;
		code = ending.code;
		signal = ending.signal;
	} finally {
		if (terminal !== undefined) await terminal;
		if (child !== undefined && !operation.childClosed(child)) {
			operation.retainChildRegistration(child, err === undefined ? [out] : [out, err]);
		} else {
			for (const original of [out, err])
				if (original !== undefined) {
					try {
						operation.syncFile(original);
					} catch {
						failed = true;
					}
					try {
						operation.closeFile(original);
					} catch {
						failed = true;
					}
				}
		}
	}
	return { files: [stdoutFile, stderrFile], kind: "command", code, signal, complete: !failed };
}
async function sealMetadata(
	operation: InventoryCacheOperation,
	files: readonly string[],
): Promise<InventoryNativeClosedCaptures> {
	for (const file of files) {
		const info = await lstat(file);
		requireInput(
			info.isFile() && !info.isSymbolicLink() && key(await realpath(file)) === key(file),
		);
		const original = operation.openFile(file, "r+");
		let failed = false,
			failure: unknown;
		try {
			operation.syncFile(original);
		} catch (error) {
			failed = true;
			failure = error;
		}
		try {
			operation.closeFile(original);
		} catch (error) {
			if (!failed) {
				failed = true;
				failure = error;
			}
		}
		if (failed) throw failure;
	}
	return { files, kind: "metadata", complete: true };
}
function commandSucceeded(capture: InventoryNativeClosedCaptures): void {
	requireInput(capture.complete && capture.code === 0 && capture.signal === null);
}
function systemEnvironment(directory: string): NodeJS.ProcessEnv {
	return process.platform === "win32"
		? { SystemRoot: process.env.SystemRoot, TEMP: directory, TMP: directory }
		: { PATH: "/usr/bin:/bin:/usr/sbin", LANG: "C", LC_ALL: "C", TMPDIR: directory };
}
function powershell(): string {
	const root = process.env.SystemRoot;
	requireInput(typeof root === "string" && path.isAbsolute(root));
	return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function qualifyAcquisitionNamespace(
	operation: InventoryCacheOperation,
	prepare: boolean,
): Promise<void> {
	if (process.platform !== "win32") return;
	const directory = await mkdtemp(path.join(cache, "acquisition-access-"));
	const captured = await runOwned(
		operation,
		powershell(),
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-File",
			cacheHelper,
			"-Mode",
			prepare ? "PrepareAcquisition" : "CheckAcquisition",
		],
		directory,
		systemEnvironment(directory),
		"cache-access",
	);
	commandSucceeded(captured);
	// Fixed OS-check control protocol only, as in cache loading. Diagnostics stay in
	// retained CLOSED captures; no exception/path/identity values are decoded or surfaced.
	requireInput(
		(await readFile(captured.files[0] ?? "")).equals(Buffer.from("INVENTORY_PRIVATE_CACHE_V1\n")),
	);
}

async function* privateCache(
	operation: InventoryCacheOperation,
	directory: string,
): AsyncGenerator<InventoryNativeClosedCaptures, void, void> {
	if (process.platform !== "win32") return;
	const captured = await runOwned(
		operation,
		powershell(),
		["-NoLogo", "-NoProfile", "-NonInteractive", "-File", cacheHelper, "-Mode", "Prepare"],
		directory,
		systemEnvironment(directory),
		"cache-access",
	);
	yield captured;
	commandSucceeded(captured);
	requireInput(
		(await readFile(captured.files[0] ?? "")).equals(Buffer.from("INVENTORY_PRIVATE_CACHE_V1\n")),
	);
}
function closedToolchainRefusal(
	operation: InventoryCacheOperation,
	directory: string,
	captured: InventoryNativeClosedCaptures,
	helper: "posix" | "windows",
): InventoryNativeToolchainRefusal | undefined {
	if (
		captured.kind !== "command" ||
		captured.complete !== true ||
		captured.code !== 1 ||
		captured.signal !== null ||
		captured.files.length !== 2 ||
		captured.files[0] !== path.join(directory, "toolchain.stdout.log") ||
		captured.files[1] !== path.join(directory, "toolchain.stderr.log")
	)
		return undefined;
	const file = path.join(directory, "toolchain.stdout.log");
	let original: ReturnType<InventoryCacheOperation["openFile"]> | undefined;
	let bytes: Buffer | undefined,
		failed = false;
	try {
		const named = lstatSync(file, { bigint: true });
		requireInput(
			named.isFile() &&
				!named.isSymbolicLink() &&
				named.nlink === 1n &&
				key(realpathSync(file)) === key(file),
		);
		original = operation.openFile(file, "r");
		const before = fstatSync(original.fd, { bigint: true });
		requireInput(
			before.isFile() &&
				before.nlink === 1n &&
				before.dev === named.dev &&
				before.ino === named.ino &&
				before.size >= 0n &&
				before.size <= BigInt(INVENTORY_NATIVE_REFUSAL_MAX_BYTES),
		);
		bytes = Buffer.alloc(Number(before.size));
		for (let position = 0; position < bytes.length; ) {
			const count = readSync(original.fd, bytes, position, bytes.length - position, position);
			requireInput(count > 0);
			position += count;
		}
		requireInput(readSync(original.fd, Buffer.alloc(1), 0, 1, bytes.length) === 0);
		const after = fstatSync(original.fd, { bigint: true }),
			final = lstatSync(file, { bigint: true });
		for (const current of [after, final])
			requireInput(
				current.isFile() &&
					!current.isSymbolicLink() &&
					current.nlink === 1n &&
					current.dev === before.dev &&
					current.ino === before.ino &&
					current.size === before.size &&
					current.mtimeNs === before.mtimeNs &&
					current.ctimeNs === before.ctimeNs,
			);
	} catch {
		failed = true;
	}
	if (original) {
		try {
			operation.closeFile(original);
		} catch {
			failed = true;
		}
	}
	if (failed || bytes === undefined) return undefined;
	return parseInventoryNativeToolchainRefusal(helper, captured, bytes);
}
async function* inspect(
	operation: InventoryCacheOperation,
	directory: string,
): AsyncGenerator<
	InventoryNativeClosedCaptures,
	{ value: Toolchain; sha256: string; bytes: Buffer },
	void
> {
	const windows = process.platform === "win32";
	requireInput(
		windows
			? process.arch === "x64"
			: ["linux", "darwin"].includes(process.platform) && ["x64", "arm64"].includes(process.arch),
	);
	const captured = await runOwned(
		operation,
		windows ? powershell() : process.execPath,
		windows
			? [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-File",
					windowsHelper,
					"-OutputDirectory",
					directory,
				]
			: [posixHelper, "--output", directory],
		directory,
		systemEnvironment(directory),
		"toolchain",
	);
	const refusal = closedToolchainRefusal(
		operation,
		directory,
		captured,
		windows ? "windows" : "posix",
	);
	yield refusal === undefined ? captured : { ...captured, refusal };
	commandSucceeded(captured);
	const response = JSON.parse((await readFile(captured.files[0] ?? "")).toString("utf8")) as Record<
		string,
		unknown
	>;
	const receiptFile = path.join(
		directory,
		windows ? "windows-toolchain.json" : "posix-toolchain.json",
	);
	requireInput(
		response.status ===
			(windows ? "verified-installed-windows-toolchain" : "verified-installed-posix-toolchain") &&
			response.receipt === receiptFile,
	);
	const metadataFiles = windows
		? [receiptFile]
		: [receiptFile, path.join(directory, "closed-metadata-captures.json")];
	yield await sealMetadata(operation, metadataFiles);
	if (!windows) {
		const nested = JSON.parse((await readFile(metadataFiles[1] ?? "")).toString("utf8")) as unknown;
		requireInput(
			Array.isArray(nested) &&
				nested.every(
					(file: unknown) =>
						typeof file === "string" &&
						path.dirname(file) === directory &&
						/^metadata-\d+\.(?:stdout|stderr)\.log$/.test(path.basename(file)),
				),
		);
		if (nested.length) yield await sealMetadata(operation, nested as string[]);
	}
	const bytes = await ordinaryFile(receiptFile, true);
	requireInput(digest(bytes) === response.sha256);
	const value = JSON.parse(bytes.toString("utf8")) as Toolchain;
	requireInput(
		value.schema ===
			(windows ? "inventory-windows-toolchain-v1" : "inventory-posix-toolchain-v1") &&
			value.host === process.arch &&
			value.target === process.arch,
	);
	if (!windows)
		requireInput(value.platform === process.platform && path.isAbsolute(value.sysroot ?? ""));
	requireInput(
		path.isAbsolute(value.compiler.path) &&
			digest(await ordinaryFile(value.compiler.path)) === value.compiler.sha256,
	);
	return { value, sha256: digest(bytes), bytes };
}

/** Yield each closed capture before continuing into its metadata result. */
export async function* inspectInventoryNativeToolchain(): AsyncGenerator<
	InventoryNativeClosedCaptures,
	{ readonly receiptFile: string; readonly sha256: string },
	void
> {
	return yield* cacheStages(inspectToolchain);
}
async function* inspectToolchain(
	operation: InventoryCacheOperation,
): AsyncGenerator<
	InventoryNativeClosedCaptures,
	{ readonly receiptFile: string; readonly sha256: string },
	void
> {
	await ownCache(true);
	const directory = await mkdtemp(path.join(cache, "toolchain-"));
	yield* privateCache(operation, directory);
	const result = yield* inspect(operation, directory);
	return {
		receiptFile: path.join(
			directory,
			process.platform === "win32" ? "windows-toolchain.json" : "posix-toolchain.json",
		),
		sha256: result.sha256,
	};
}
async function sourceHashes(): Promise<Record<string, string>> {
	const files = [
		source,
		platformSource,
		windowsHelper,
		path.join(import.meta.dirname, "inventory-native-query.ps1"),
		posixHelper,
		path.join(import.meta.dirname, "inventory-release-expiry.ts"),
		cacheHelper,
		path.join(import.meta.dirname, "inventory-native-operation.ts"),
		path.join(import.meta.dirname, "inventory-native-refusal.ts"),
		policyFile,
		path.join(import.meta.dirname, "inventory-native-build.ts"),
		path.join(repository, "tools", "fetch-node", "versions.json"),
		path.join(repository, "tools", "fetch-node", "keys", "keys.json"),
		path.join(repository, "tools", "fetch-node", "keys", "pubring.kbx"),
	];
	const result: Record<string, string> = {};
	for (const file of files)
		result[path.relative(repository, file).replaceAll(path.sep, "/")] = digest(
			await ordinaryFile(file),
		);
	return result;
}
async function developmentUnchanged(inputs: DevelopmentInputs): Promise<void> {
	const platform = process.platform === "win32" ? "win" : process.platform;
	const expected = path.join(
		cache,
		"distribution",
		"node-development",
		process.versions.node,
		`${platform}-${process.arch}`,
	);
	requireInput(
		inputs.version === process.versions.node &&
			inputs.arch === process.arch &&
			key(inputs.headers) === key(path.join(expected, "include")),
	);
	requireInput(inputs.runtimeSha256 === digest(await ordinaryFile(process.execPath)));
	for (const name of headerNames)
		requireInput(
			digest(await ordinaryFile(path.join(expected, "include", name))) ===
				inputs.files[`include/${name}`],
		);
	if (process.platform === "win32")
		requireInput(
			inputs.importLibrary === path.join(expected, "node.lib") &&
				digest(await ordinaryFile(inputs.importLibrary)) === inputs.files["node.lib"],
		);
}
async function existing(recipe?: Recipe): Promise<InventoryNativeBuild> {
	await ownCache(false);
	// Explicit preparation requests its own recipe, independently of the current pointer.
	// Thus A -> B -> A reuses immutable artifact A instead of compiling over its directory.
	const requested = recipe
		? digest(JSON.stringify(recipe))
		: (
				JSON.parse(
					(await ordinaryFile(path.join(cache, "current.json"), true)).toString("utf8"),
				) as { key?: unknown }
			).key;
	requireInput(typeof requested === "string" && /^[a-f0-9]{64}$/.test(requested));
	const directory = path.join(cache, "artifacts", requested),
		manifestFile = path.join(directory, "build.json");
	const manifest = JSON.parse(
		(await ordinaryFile(manifestFile, true)).toString("utf8"),
	) as BuildManifest;
	requireInput(
		manifest.schema === "inventory-native-build-v2" &&
			manifest.key === requested &&
			digest(JSON.stringify(manifest.recipe)) === requested,
	);
	const actual = manifest.recipe;
	requireInput(
		actual.schema === "inventory-native-recipe-v2" &&
			actual.platform === process.platform &&
			actual.arch === process.arch &&
			actual.runtimeSha256 === digest(await ordinaryFile(process.execPath)),
	);
	requireInput(JSON.stringify(actual.sources) === JSON.stringify(await sourceHashes()));
	if (recipe) requireInput(JSON.stringify(actual) === JSON.stringify(recipe));
	await developmentUnchanged(actual.development);
	const toolchainBytes = await ordinaryFile(path.join(directory, "toolchain.json"), true);
	// The private receipt binds actual pre/post-build toolchain qualification. Installed
	// SDK changes cannot change this already compiled binary and require no scan at load.
	requireInput(digest(toolchainBytes) === actual.toolchainSha256);
	const file = path.join(directory, "inventory-directory.node"),
		sha256 = digest(await ordinaryFile(file, true));
	requireInput(sha256 === manifest.binarySha256);
	return { file, sha256, manifestFile, reused: true };
}
async function pointCurrent(
	operation: InventoryCacheOperation,
	directory: string,
	recipeKey: string,
): Promise<void> {
	requireInput(/^[a-f0-9]{64}$/.test(recipeKey));
	const index = path.join(directory, "current.json");
	operation.writeFile(index, JSON.stringify({ key: recipeKey }) + "\n");
	try {
		await rename(index, path.join(cache, "current.json"));
	} catch (error) {
		operation.retain();
		throw error;
	}
}

/** Explicit offline preparation outside the inventory worker deadline; one lock per worktree. */
export async function* prepareInventoryNativeBuild(): AsyncGenerator<
	InventoryNativeClosedCaptures,
	InventoryNativeBuild,
	void
> {
	return yield* cacheStages(prepareBuild);
}
async function* prepareBuild(
	operation: InventoryCacheOperation,
): AsyncGenerator<InventoryNativeClosedCaptures, InventoryNativeBuild, void> {
	await ownCache(true);
	const work = await mkdtemp(path.join(cache, "prepare-"));
	yield* privateCache(operation, work);
	const lock = operation.openPreparationLock();
	let primaryFailed = false;
	try {
		const sources = await sourceHashes(),
			development = await acquireNodeInputs(operation, {});
		const beforeDirectory = path.join(work, "before");
		await mkdir(beforeDirectory, { mode: 0o700 });
		const before = yield* inspect(operation, beforeDirectory);
		const recipe: Recipe = {
			schema: "inventory-native-recipe-v2",
			platform: process.platform,
			arch: process.arch,
			runtimeSha256: digest(await ordinaryFile(process.execPath)),
			sources,
			development,
			toolchainSha256: before.sha256,
		};
		let reusable: InventoryNativeBuild | undefined;
		try {
			reusable = await existing(recipe);
		} catch {
			/* A cache miss never authorizes loading; prepare from qualified inputs. */
		}
		if (reusable) {
			await pointCurrent(operation, work, digest(JSON.stringify(recipe)));
			return reusable;
		}
		// An occupied but unqualified recipe path is a refusal, never rebuild authority.
		try {
			await lstat(path.join(cache, "artifacts", digest(JSON.stringify(recipe))));
			refuse();
		} catch (error) {
			requireInput(error instanceof Error && "code" in error && error.code === "ENOENT");
		}
		const chain = before.value,
			file = path.join(work, "inventory-directory.node");
		let args: string[], env: NodeJS.ProcessEnv;
		if (process.platform === "win32") {
			requireInput(development.importLibrary && chain.windowsDirectory);
			args = [
				"/nologo",
				"/std:c++17",
				"/EHsc",
				"/MT",
				"/LD",
				"/O2",
				"/X",
				"/DNAPI_VERSION=8",
				"/DNODE_GYP_MODULE_NAME=inventory_directory",
				"/D_WIN32_WINNT=0x0602",
				"/DWIN32_LEAN_AND_MEAN",
				"/DNOMINMAX",
				...[development.headers, ...chain.includeDirectories].map((include) => `/I${include}`),
				`/Fo${path.join(work, "directory.obj")}`,
				`/Fd${path.join(work, "directory.pdb")}`,
				source,
				"/link",
				`/OUT:${file}`,
				`/IMPLIB:${path.join(work, "directory.lib")}`,
				...chain.libraryDirectories.map((library) => `/LIBPATH:${library}`),
				development.importLibrary,
				"kernel32.lib",
				"ntdll.lib",
			];
			env = {
				SystemRoot: chain.windowsDirectory,
				TEMP: work,
				TMP: work,
				PATH: [
					path.dirname(chain.compiler.path),
					path.join(chain.windowsDirectory, "System32"),
				].join(path.delimiter),
			};
		} else {
			requireInput(chain.sysroot);
			args = [
				"-std=c++17",
				"-fPIC",
				"-pthread",
				"-O2",
				"-fexceptions",
				"-DNAPI_VERSION=8",
				"-DNODE_GYP_MODULE_NAME=inventory_directory",
				"-D_POSIX_C_SOURCE=200809L",
				"-nostdinc",
				"-nostdinc++",
				"-I",
				development.headers,
				...chain.includeDirectories.flatMap((include) => ["-isystem", include]),
				...(chain.frameworkDirectories ?? []).flatMap((framework) => ["-iframework", framework]),
				...(process.platform === "darwin"
					? [
							"-D_DARWIN_C_SOURCE",
							"-arch",
							process.arch === "x64" ? "x86_64" : "arm64",
							"-isysroot",
							chain.sysroot,
							"-bundle",
							"-undefined",
							"dynamic_lookup",
						]
					: ["-D_DEFAULT_SOURCE", `--sysroot=${chain.sysroot}`, "-shared", "-Wl,-z,relro,-z,now"]),
				...chain.libraryDirectories.flatMap((library) => ["-L", library]),
				source,
				"-o",
				file,
			];
			env = {
				...systemEnvironment(work),
				PATH: [...new Set(chain.compilerRuntime.map((entry) => path.dirname(entry.path)))].join(
					path.delimiter,
				),
			};
		}
		const compilation = await runOwned(operation, chain.compiler.path, args, work, env, "compile");
		yield compilation;
		commandSucceeded(compilation);
		const afterDirectory = path.join(work, "after");
		await mkdir(afterDirectory, { mode: 0o700 });
		const after = yield* inspect(operation, afterDirectory);
		requireInput(
			before.sha256 === after.sha256 &&
				JSON.stringify(sources) === JSON.stringify(await sourceHashes()),
		);
		await developmentUnchanged(development);
		const sha256 = digest(await ordinaryFile(file)),
			recipeKey = digest(JSON.stringify(recipe));
		const artifacts = path.join(cache, "artifacts");
		await mkdir(artifacts, { recursive: true, mode: 0o700 });
		requireInput(key(await realpath(artifacts)) === key(artifacts));
		const staging = path.join(work, "artifact");
		await mkdir(staging, { mode: 0o700 });
		operation.writeFile(path.join(staging, "inventory-directory.node"), await ordinaryFile(file));
		operation.writeFile(path.join(staging, "toolchain.json"), before.bytes);
		const manifest: BuildManifest = {
			schema: "inventory-native-build-v2",
			key: recipeKey,
			recipe,
			binarySha256: sha256,
		};
		operation.writeFile(path.join(staging, "build.json"), JSON.stringify(manifest));
		yield await sealMetadata(operation, [
			path.join(staging, "build.json"),
			path.join(staging, "toolchain.json"),
		]);
		const destination = path.join(artifacts, recipeKey);
		try {
			await rename(staging, destination);
		} catch (error) {
			operation.retain();
			throw error;
		}
		await pointCurrent(operation, work, recipeKey);
		return {
			file: path.join(destination, "inventory-directory.node"),
			sha256,
			manifestFile: path.join(destination, "build.json"),
			reused: false,
		};
	} catch (error) {
		primaryFailed = true;
		throw error;
	} finally {
		await operation.releasePreparationLock(lock, primaryFailed);
	}
}

async function checkWindowsCache(
	operation: InventoryCacheOperation,
	artifactKey?: string,
): Promise<void> {
	if (process.platform !== "win32") return;
	const directory = await mkdtemp(path.join(cache, "access-check-"));
	const capture = await runOwned(
		operation,
		powershell(),
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-File",
			cacheHelper,
			"-Mode",
			"Check",
			...(artifactKey ? ["-ArtifactKey", artifactKey] : []),
		],
		directory,
		systemEnvironment(directory),
		"cache-access",
	);
	commandSucceeded(capture);
	// This is an exact fixed control frame from the reviewed ACL helper, not diagnostic intake.
	// Unexpected output is neither decoded nor surfaced; its closed captures remain for the operator.
	requireInput(
		(await readFile(capture.files[0] ?? "")).equals(Buffer.from("INVENTORY_PRIVATE_CACHE_V1\n")),
	);
}
let bindingPromise: Promise<InventoryNativeBinding> | undefined;
/** One lazy Promise per process; no compilation, download, compiler discovery or caller path. */
export function loadInventoryNativeBinding(): Promise<InventoryNativeBinding> {
	if (bindingPromise === undefined)
		bindingPromise = cacheOperation(async (operation) => {
			await ownCache(false);
			await checkWindowsCache(operation);
			const built = await existing();
			await checkWindowsCache(operation, path.basename(path.dirname(built.file)));
			requireInput(digest(await ordinaryFile(built.file, true)) === built.sha256);
			let loaded: unknown;
			try {
				loaded = createRequire(import.meta.url)(built.file);
			} catch (error) {
				operation.retain();
				throw error;
			}
			requireInput(
				typeof loaded === "object" && loaded !== null && Object.keys(loaded).length === 1,
			);
			const openRoot = Object.getOwnPropertyDescriptor(loaded, "openRoot")?.value as unknown;
			requireInput(typeof openRoot === "function");
			return Object.freeze({ openRoot }) as InventoryNativeBinding;
		}).catch(() => refuse());
	return bindingPromise;
}
