import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface TempFileDirectory {
	open(): unknown;
	read(handle: unknown): { readonly name: string } | null;
	close(handle: unknown): void;
}

interface CompileOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	encoding: "buffer";
	stdio: ["ignore", "pipe", "pipe"];
	timeout: number;
	maxBuffer: number;
	windowsHide: true;
	shell: false;
}
interface CompileResult {
	status: number | null;
	signal: string | null;
	error?: unknown;
	stdout: unknown;
	stderr: unknown;
}
/** Injection is for synthetic build-control tests; the child uses the fixed defaults. */
export interface DirectoryBuildRuntime {
	readonly platform: string;
	readonly arch: string;
	readonly nodeVersion: string;
	readonly execPath: string;
	readonly uid: number | undefined;
	compile(command: string, args: string[], options: CompileOptions): CompileResult;
	load(filename: string): unknown;
}

const defaults: DirectoryBuildRuntime = {
	platform: process.platform,
	arch: process.arch,
	nodeVersion: process.versions.node,
	execPath: process.execPath,
	uid: process.getuid?.(),
	compile: (command, args, options) => spawnSync(command, args, options),
	load: createRequire(import.meta.url),
};
const PINNED_NODE_VERSION = "26.12.0";
const MAX_BUILD_OUTPUT_BYTES = 64 * 1024;
const MAX_ADDON_BYTES = 1024 * 1024;
const HEADER_NAMES = [
	"node_api.h",
	"node_api_types.h",
	"js_native_api.h",
	"js_native_api_types.h",
	"node_version.h",
] as const;
const source = fileURLToPath(new URL("./fixtures/temp-file-directory.c", import.meta.url));

function refuse(): never {
	throw new Error("Temporary-file directory build refused");
}

function pin(
	filename: string,
	maximum: number,
): { readonly identity: string; readonly bytes: Buffer } {
	const before = lstatSync(filename, { bigint: true });
	if (
		!before.isFile() ||
		before.isSymbolicLink() ||
		before.nlink !== 1n ||
		before.size <= 0n ||
		before.size > BigInt(maximum) ||
		realpathSync.native(filename) !== filename
	)
		return refuse();
	const same = (after: typeof before): boolean =>
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.mode === after.mode &&
		before.nlink === after.nlink &&
		before.size === after.size &&
		before.uid === after.uid &&
		before.gid === after.gid &&
		before.mtimeNs === after.mtimeNs &&
		before.ctimeNs === after.ctimeNs;
	const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (!same(fstatSync(fd, { bigint: true }))) return refuse();
		const buffer = Buffer.alloc(maximum + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, length);
			if (!Number.isInteger(count) || count < 0 || count > buffer.length - length) return refuse();
			if (count === 0) break;
			length += count;
		}
		if (
			length > maximum ||
			length !== Number(before.size) ||
			!same(fstatSync(fd, { bigint: true })) ||
			!same(lstatSync(filename, { bigint: true })) ||
			realpathSync.native(filename) !== filename
		)
			return refuse();
		const bytes = buffer.subarray(0, length);
		return {
			identity: `${before.dev}:${before.ino}:${before.mode}:${before.nlink}:${before.size}:${before.mtimeNs}:${before.ctimeNs}:${createHash("sha256").update(bytes).digest("hex")}`,
			bytes,
		};
	} finally {
		closeSync(fd);
	}
}

function value(object: unknown, name: string): unknown {
	if (object === null || (typeof object !== "object" && typeof object !== "function"))
		return refuse();
	const field = Object.getOwnPropertyDescriptor(object, name);
	if (!field || !("value" in field)) return refuse();
	return field.value;
}

function adapter(module: unknown): TempFileDirectory {
	if (module === null || typeof module !== "object") return refuse();
	const fields = Reflect.ownKeys(module).sort();
	if (fields.length !== 3 || fields.join(",") !== "close,open,read") return refuse();
	const open = value(module, "open");
	const read = value(module, "read");
	const close = value(module, "close");
	if (typeof open !== "function" || typeof read !== "function" || typeof close !== "function")
		return refuse();
	return Object.freeze({
		open: () => open(),
		read: (handle: unknown) => {
			const entry: unknown = read(handle);
			if (entry === null) return null;
			const name = value(entry, "name");
			if (
				typeof name !== "string" ||
				name.length === 0 ||
				Buffer.byteLength(name) > 255 ||
				Reflect.ownKeys(entry as object).length !== 1
			)
				return refuse();
			return { name };
		},
		close: (handle: unknown) => {
			if (close(handle) !== undefined) refuse();
		},
	});
}

/** Build only the committed metadata reader; never find or reuse a prebuilt addon. */
export function buildTempFileDirectory(
	root: string,
	runtime: DirectoryBuildRuntime = defaults,
): TempFileDirectory {
	try {
		if (
			runtime.platform !== "darwin" ||
			runtime.nodeVersion !== PINNED_NODE_VERSION ||
			(runtime.arch !== "arm64" && runtime.arch !== "x64") ||
			!Number.isSafeInteger(runtime.uid) ||
			(runtime.uid ?? -1) < 0 ||
			!path.isAbsolute(root) ||
			!path.basename(root).startsWith("draftyak-temp-store-") ||
			realpathSync.native(root) !== root ||
			!lstatSync(root).isDirectory() ||
			lstatSync(root).isSymbolicLink()
		)
			return refuse();
		if (
			!path.isAbsolute(runtime.execPath) ||
			realpathSync.native(runtime.execPath) !== runtime.execPath ||
			path.basename(path.dirname(runtime.execPath)) !== "bin" ||
			!lstatSync(runtime.execPath).isFile()
		)
			return refuse();
		const include = path.resolve(path.dirname(runtime.execPath), "..", "include", "node");
		if (realpathSync.native(include) !== include || !lstatSync(include).isDirectory())
			return refuse();
		const pins = new Map(
			[source, ...HEADER_NAMES.map((name) => path.join(include, name))].map((filename) => [
				filename,
				pin(filename, MAX_ADDON_BYTES),
			]),
		);
		const version = pins.get(path.join(include, "node_version.h"))?.bytes.toString("utf8");
		if (version === undefined) return refuse();
		for (const [name, expected] of [
			["MAJOR", 26],
			["MINOR", 12],
			["PATCH", 0],
		] as const) {
			const matches = [
				...version.matchAll(
					new RegExp(`^#define NODE_${name}_VERSION[ \\t]+([0-9]+)[ \\t]*$`, "gm"),
				),
			];
			if (matches.length !== 1 || Number(matches[0]?.[1]) !== expected) return refuse();
		}
		const build = path.join(root, "descriptor-directory");
		mkdirSync(build, { mode: 0o700 });
		const binary = path.join(build, "directory.node");
		const result = runtime.compile(
			"/usr/bin/clang",
			[
				"-std=c11",
				"-Wall",
				"-Wextra",
				"-Werror",
				"-O2",
				"-bundle",
				"-undefined",
				"dynamic_lookup",
				"-DNAPI_VERSION=8",
				"-arch",
				runtime.arch === "arm64" ? "arm64" : "x86_64",
				"-I",
				include,
				source,
				"-o",
				binary,
			],
			{
				cwd: build,
				env: { TMPDIR: build, LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" },
				encoding: "buffer",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 30_000,
				maxBuffer: MAX_BUILD_OUTPUT_BYTES,
				windowsHide: true,
				shell: false,
			},
		);
		if (
			result.status !== 0 ||
			result.signal !== null ||
			result.error !== undefined ||
			!Buffer.isBuffer(result.stdout) ||
			!Buffer.isBuffer(result.stderr) ||
			result.stdout.length !== 0 ||
			result.stderr.length !== 0
		)
			return refuse();
		for (const [filename, expected] of pins)
			if (pin(filename, MAX_ADDON_BYTES).identity !== expected.identity) return refuse();
		const info = lstatSync(binary, { bigint: true });
		const owner = lstatSync(build, { bigint: true });
		if (
			info.uid !== BigInt(runtime.uid ?? -1) ||
			info.dev !== owner.dev ||
			(info.mode & 0o022n) !== 0n ||
			owner.uid !== info.uid ||
			(owner.mode & 0o077n) !== 0n ||
			realpathSync.native(build) !== build
		)
			return refuse();
		const binaryPin = pin(binary, MAX_ADDON_BYTES).identity;
		const module = adapter(runtime.load(binary));
		if (pin(binary, MAX_ADDON_BYTES).identity !== binaryPin) return refuse();
		return module;
	} catch {
		return refuse();
	}
}
