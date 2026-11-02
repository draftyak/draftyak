import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import type { DatabaseBasis } from "./current-basis.ts";
import {
	DATABASE_OBJECT_LIMITS,
	type DatabaseObjectTree,
	type RawGitObject,
	verifyDatabaseObjectTree,
} from "./database-object-tree.ts";

const HOUR = 3_600_000;
const DEADLINE = 60_000;
const ID = /^[a-f0-9]{40}$/;
const PORTABLE = /^[A-Za-z0-9._-]+$/;
const SOURCE = "https://api.github.com/repos/RustSec/advisory-db/commits/HEAD";
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
let rateLimitedUntil = 0;

export type DatabaseSourceCode =
	| "DATABASE_SOURCE_INVALID"
	| "DATABASE_SOURCE_UNAVAILABLE"
	| "DATABASE_SOURCE_CHANGED"
	| "DATABASE_SOURCE_RATE_LIMIT"
	| "DATABASE_SOURCE_DEADLINE"
	| "DATABASE_SOURCE_STALE"
	| "DATABASE_SOURCE_CLOCK"
	| "DATABASE_SOURCE_TEST_ONLY";
export class DatabaseSourceError extends Error {
	readonly code: DatabaseSourceCode;
	constructor(code: DatabaseSourceCode) {
		super("database source refused");
		this.name = "DatabaseSourceError";
		this.code = code;
	}
}
function refuse(code: DatabaseSourceCode = "DATABASE_SOURCE_INVALID"): never {
	throw new DatabaseSourceError(code);
}
declare const observationBrand: unique symbol;
export interface DatabaseObservation {
	readonly [observationBrand]: true;
}
export interface DatabaseSource {
	observe(): Promise<DatabaseObservation>;
	revalidate(previous: DatabaseObservation): Promise<DatabaseObservation>;
	basis(observation: DatabaseObservation): DatabaseBasis;
}
interface Services {
	readonly native: boolean;
	readonly head: () => Promise<string>;
	readonly clock: () => number;
}
interface Tool {
	readonly file: string;
	readonly identity: string;
	readonly digest: string;
	readonly version: string;
}
interface Receipt {
	readonly owner: DatabaseSource;
	readonly native: boolean;
	readonly commit: string;
	readonly currentCommit: string;
	readonly revision: string;
	readonly observedAt: number;
	readonly completedAt: number;
	readonly tool: string;
}
const receipts = new WeakMap<DatabaseObservation, Receipt>();
interface DirectoryNames {
	readonly identity: string;
	readonly names: readonly string[];
	readonly characters: number;
}
interface DirectoryContext {
	readonly entries: Map<string, DirectoryNames>;
	names: number;
	characters: number;
}
const directoryContexts = new AsyncLocalStorage<DirectoryContext>();
const DIRECTORY_CACHE_LIMITS = { directories: 128, names: 32_768, characters: 1_048_576 } as const;
function withPathChecks<T>(operation: () => Promise<T>): Promise<T> {
	return directoryContexts.run({ entries: new Map(), names: 0, characters: 0 }, operation);
}
function forgetDirectory(context: DirectoryContext, directory: string): void {
	const entry = context.entries.get(directory);
	if (!entry) return;
	context.entries.delete(directory);
	context.names -= entry.names.length;
	context.characters -= entry.characters;
}
async function directoryNames(directory: string): Promise<readonly string[]> {
	const context = directoryContexts.getStore();
	let original: BigIntStats | undefined;
	for (let snapshot = 0; snapshot < 2; snapshot++) {
		const beforeStat = await fs.lstat(directory, { bigint: true });
		const before = identity(beforeStat, false);
		if (original && (beforeStat.dev !== original.dev || beforeStat.ino !== original.ino))
			return refuse("DATABASE_SOURCE_CHANGED");
		original = beforeStat;
		if (snapshot !== 0 && context) forgetDirectory(context, directory);
		let entry = snapshot === 0 ? context?.entries.get(directory) : undefined;
		if (entry && entry.identity !== before) {
			if (context) forgetDirectory(context, directory);
			entry = undefined;
		}
		const names = entry?.names ?? Object.freeze(await fs.readdir(directory));
		if (names.length > 50_000) return refuse();
		const afterStat = await fs.lstat(directory, { bigint: true });
		const after = identity(afterStat, false);
		if (after !== before) {
			if (context) forgetDirectory(context, directory);
			if (snapshot === 0 && afterStat.dev === beforeStat.dev && afterStat.ino === beforeStat.ino)
				continue;
			return refuse("DATABASE_SOURCE_CHANGED");
		}
		if (context) {
			if (entry) {
				context.entries.delete(directory);
				context.entries.set(directory, entry);
			} else {
				const characters = names.reduce((total, name) => total + name.length, 0);
				if (
					names.length <= DIRECTORY_CACHE_LIMITS.names &&
					characters <= DIRECTORY_CACHE_LIMITS.characters
				) {
					while (
						context.entries.size >= DIRECTORY_CACHE_LIMITS.directories ||
						context.names + names.length > DIRECTORY_CACHE_LIMITS.names ||
						context.characters + characters > DIRECTORY_CACHE_LIMITS.characters
					) {
						const oldest = context.entries.keys().next().value;
						if (oldest === undefined) break;
						forgetDirectory(context, oldest);
					}
					context.entries.set(directory, { identity: before, names, characters });
					context.names += names.length;
					context.characters += characters;
				}
			}
		}
		return names;
	}
	return refuse("DATABASE_SOURCE_CHANGED");
}

function clock(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) return refuse("DATABASE_SOURCE_CLOCK");
	return value;
}
function absolute(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > 4096 ||
		!path.isAbsolute(value) ||
		value.startsWith("\\\\") ||
		value.startsWith("//") ||
		[...value].some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) ||
		value.split(/[\\/]/).some((part) => part === "." || part === "..")
	)
		return refuse();
	return path.resolve(value);
}
function identity(stat: BigIntStats, file: boolean, executable = false): string {
	if (
		stat.isSymbolicLink() ||
		stat.ino === 0n ||
		(file
			? !stat.isFile() || stat.nlink < 1n || (!executable && stat.nlink !== 1n)
			: !stat.isDirectory())
	)
		return refuse();
	return JSON.stringify([
		String(stat.dev),
		String(stat.ino),
		String(stat.size),
		String(stat.mode),
		String(stat.nlink),
		String(stat.mtimeNs),
		String(stat.ctimeNs),
	]);
}
async function absent(filename: string): Promise<boolean> {
	try {
		await fs.lstat(filename);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}
async function checked(filename: string, file: boolean, executable = false): Promise<BigIntStats> {
	const full = absolute(filename);
	let current = path.parse(full).root;
	identity(await fs.lstat(current, { bigint: true }), false);
	for (const segment of full.slice(current.length).split(path.sep).filter(Boolean)) {
		const names = await directoryNames(current);
		if (
			names.length > 50_000 ||
			names.filter((name) => name.toLowerCase() === segment.toLowerCase()).length !== 1 ||
			!names.includes(segment)
		)
			return refuse();
		current = path.join(current, segment);
		const stat = await fs.lstat(current, { bigint: true });
		identity(stat, stat.isFile(), executable && current === full);
		if ((await fs.realpath(current)) !== current) return refuse();
	}
	const stat = await fs.lstat(full, { bigint: true });
	identity(stat, file, executable);
	return stat;
}
async function bytes(
	filename: string,
	limit: number,
	executable = false,
): Promise<{ bytes: Buffer; identity: string }> {
	const before = await checked(filename, true, executable);
	if (before.size > BigInt(limit)) return refuse();
	const id = identity(before, true, executable);
	const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (identity(await handle.stat({ bigint: true }), true, executable) !== id)
			return refuse("DATABASE_SOURCE_CHANGED");
		const buffer = Buffer.alloc(Number(before.size) + 1);
		let size = 0;
		for (;;) {
			const read = await handle.read(buffer, size, buffer.length - size, null);
			if (read.bytesRead === 0) break;
			size += read.bytesRead;
			if (size > Number(before.size)) return refuse("DATABASE_SOURCE_CHANGED");
		}
		if (
			size !== Number(before.size) ||
			identity(await handle.stat({ bigint: true }), true, executable) !== id ||
			identity(await checked(filename, true, executable), true, executable) !== id
		)
			return refuse("DATABASE_SOURCE_CHANGED");
		return { bytes: buffer.subarray(0, size), identity: id };
	} finally {
		await handle.close();
	}
}
async function physicalHead(root: string): Promise<string> {
	const head = (await bytes(path.join(root, ".git/HEAD"), 4096)).bytes.toString("utf8");
	if (/^[a-f0-9]{40}\n?$/.test(head)) return head.trim();
	const match = /^ref: (refs\/[A-Za-z0-9._/-]+)\n?$/.exec(head);
	const ref = match?.[1];
	if (!ref || ref.split("/").some((part) => !PORTABLE.test(part) || part === "." || part === ".."))
		return refuse();
	const target = path.join(root, ".git", ...ref.split("/"));
	if (!(await absent(target))) {
		const value = (await bytes(target, 4096)).bytes.toString("utf8");
		if (!/^[a-f0-9]{40}\n?$/.test(value)) return refuse();
		return value.trim();
	}
	const packed = (await bytes(path.join(root, ".git/packed-refs"), 4 * 1024 * 1024)).bytes.toString(
		"utf8",
	);
	const matches = packed.split("\n").filter((line) => line.endsWith(` ${ref}`));
	if (
		matches.length !== 1 ||
		!new RegExp(`^[a-f0-9]{40} ${ref.replaceAll(".", "\\.")}$`).test(matches[0] ?? "")
	)
		return refuse();
	return (matches[0] ?? "").slice(0, 40);
}
async function objectStore(root: string, remaining: () => number): Promise<string> {
	const base = path.join(root, ".git/objects");
	await checked(base, false);
	for (const forbidden of [
		".git/commondir",
		".git/objects/info/alternates",
		".git/objects/info/http-alternates",
	])
		if (!(await absent(path.join(root, forbidden)))) return refuse();
	const rows: string[][] = [];
	async function walk(directory: string, depth: number): Promise<void> {
		remaining();
		if (depth > 4 || rows.length >= 50_000) return refuse();
		const stat = await checked(directory, false);
		rows.push([path.relative(base, directory), identity(stat, false)]);
		const names = await fs.readdir(directory);
		if (names.length > 50_000) return refuse();
		for (const name of names.sort(compare)) {
			remaining();
			if (!PORTABLE.test(name) || name === "." || name === ".." || name.endsWith(".promisor"))
				return refuse();
			const filename = path.join(directory, name);
			const item = await fs.lstat(filename, { bigint: true });
			if (item.isDirectory()) await walk(filename, depth + 1);
			else {
				const checkedFile = await checked(filename, true);
				if (checkedFile.size > 1024n * 1024n * 1024n || rows.length >= 50_000) return refuse();
				rows.push([path.relative(base, filename), identity(checkedFile, true)]);
			}
		}
		if (identity(await checked(directory, false), false) !== identity(stat, false))
			return refuse("DATABASE_SOURCE_CHANGED");
	}
	await walk(base, 0);
	return hash(Buffer.from(JSON.stringify(rows)));
}
function environment(scratch: string, root: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	if (process.platform === "win32") {
		for (const name of [
			"HOMEDRIVE",
			"HOMEPATH",
			"LOGONSERVER",
			"PATH",
			"SYSTEMDRIVE",
			"SYSTEMROOT",
			"TEMP",
			"USERDOMAIN",
			"USERNAME",
			"USERPROFILE",
			"WINDIR",
		])
			env[name] = "";
		if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
	}
	return Object.assign(env, {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: path.join(scratch, "empty"),
		GIT_CONFIG_GLOBAL: path.join(scratch, "empty"),
		GIT_CONFIG_COUNT: "0",
		GIT_OBJECT_DIRECTORY: path.join(root, ".git/objects"),
		GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_NO_LAZY_FETCH: "1",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ALLOW_PROTOCOL: "",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_PAGER: "",
		GIT_EXTERNAL_DIFF: "",
		LC_ALL: "C",
		LANG: "C",
		NO_COLOR: "1",
	});
}
async function command(
	tool: Tool,
	scratch: string,
	root: string,
	args: readonly string[],
	input: Buffer,
	limit: number,
	remaining: () => number,
): Promise<Buffer> {
	const timeout = Math.min(10_000, remaining());
	return new Promise((resolve, reject) => {
		const child = spawn(
			tool.file,
			["--no-optional-locks", "--no-replace-objects", `--git-dir=${scratch}`, ...args],
			{
				cwd: scratch,
				env: environment(scratch, root),
				shell: false,
				windowsHide: true,
				stdio: [input.length === 0 ? "ignore" : "pipe", "pipe", "pipe"],
			},
		);
		const chunks: Buffer[] = [];
		let size = 0,
			errors = 0,
			failed: DatabaseSourceCode | undefined;
		const stop = (code: DatabaseSourceCode): void => {
			failed ??= code;
			child.kill();
		};
		const timer = setTimeout(() => stop("DATABASE_SOURCE_DEADLINE"), timeout);
		child.stdout?.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) stop("DATABASE_SOURCE_INVALID");
			else chunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			errors += chunk.length;
			if (errors > 65_536) stop("DATABASE_SOURCE_INVALID");
		});
		child.stdin?.on("error", () => stop("DATABASE_SOURCE_UNAVAILABLE"));
		child.on("error", () => {
			failed ??= "DATABASE_SOURCE_UNAVAILABLE";
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (failed || code !== 0 || signal !== null || errors !== 0)
				reject(new DatabaseSourceError(failed ?? "DATABASE_SOURCE_UNAVAILABLE"));
			else resolve(Buffer.concat(chunks, size));
		});
		if (
			child.stdout === null ||
			child.stderr === null ||
			(input.length > 0 && child.stdin === null)
		)
			stop("DATABASE_SOURCE_UNAVAILABLE");
		else child.stdin?.end(input);
	});
}
async function discoverGit(): Promise<Omit<Tool, "version">> {
	const candidates =
		process.platform === "win32"
			? ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\mingw64\\bin\\git.exe"]
			: process.platform === "linux" && process.arch === "x64"
				? ["/usr/bin/git"]
				: [];
	for (const candidate of candidates) {
		if (await absent(candidate)) continue;
		const file = await fs.realpath(candidate);
		const observed = await bytes(file, 64 * 1024 * 1024, true);
		if (
			process.platform === "win32"
				? observed.bytes[0] !== 0x4d || observed.bytes[1] !== 0x5a
				: !observed.bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
		)
			return refuse();
		return { file, identity: observed.identity, digest: hash(observed.bytes) };
	}
	return refuse("DATABASE_SOURCE_UNAVAILABLE");
}
async function unchangedTool(tool: Tool): Promise<void> {
	const observed = await bytes(tool.file, 64 * 1024 * 1024, true);
	if (observed.identity !== tool.identity || hash(observed.bytes) !== tool.digest)
		return refuse("DATABASE_SOURCE_CHANGED");
}
function parseObjects(output: Buffer, ids: readonly string[]): RawGitObject[] {
	const result: RawGitObject[] = [];
	let offset = 0,
		total = 0;
	for (const id of ids) {
		const end = output.indexOf(10, offset);
		if (end < 0 || end - offset > 80) return refuse();
		const match = /^([a-f0-9]{40}) (commit|tree|blob) (0|[1-9][0-9]*)$/.exec(
			output.subarray(offset, end).toString("utf8"),
		);
		if (!match || match[1] !== id) return refuse();
		const type = match[2] as RawGitObject["type"],
			size = Number(match[3]);
		if (!Number.isSafeInteger(size) || size > DATABASE_OBJECT_LIMITS[`${type}Bytes`])
			return refuse();
		total += size;
		if (
			total > DATABASE_OBJECT_LIMITS.totalBytes ||
			end + size + 1 >= output.length ||
			output[end + size + 1] !== 10
		)
			return refuse();
		result.push({ id, type, bytes: output.subarray(end + 1, end + size + 1) });
		offset = end + size + 2;
	}
	if (offset !== output.length) return refuse();
	return result;
}
async function closure(
	tool: Tool,
	scratch: string,
	root: string,
	commit: string,
	remaining: () => number,
): Promise<DatabaseObjectTree> {
	const tree = (
		await command(
			tool,
			scratch,
			root,
			["rev-parse", "--verify", `${commit}^{tree}`],
			Buffer.alloc(0),
			128,
			remaining,
		)
	)
		.toString("utf8")
		.trim();
	if (!ID.test(tree)) return refuse();
	const listing = await command(
		tool,
		scratch,
		root,
		["ls-tree", "-r", "-t", "-z", "--full-tree", commit],
		Buffer.alloc(0),
		4 * 1024 * 1024,
		remaining,
	);
	const ids = new Set([commit, tree]);
	const lines = listing.toString("utf8").split("\0");
	if (lines.pop() !== "" || lines.length > DATABASE_OBJECT_LIMITS.entries) return refuse();
	for (const line of lines) {
		const row = /^(?:040000 tree|100644 blob|100755 blob) ([a-f0-9]{40})\t[A-Za-z0-9._/-]+$/.exec(
			line,
		);
		if (!row?.[1]) return refuse();
		ids.add(row[1]);
	}
	if (ids.size > DATABASE_OBJECT_LIMITS.objects) return refuse();
	const order = [...ids].sort(compare);
	const output = await command(
		tool,
		scratch,
		root,
		["cat-file", "--batch"],
		Buffer.from(`${order.join("\n")}\n`),
		DATABASE_OBJECT_LIMITS.totalBytes + 1024 * 1024,
		remaining,
	);
	return verifyDatabaseObjectTree(commit, parseObjects(output, order));
}
async function physical(
	root: string,
	inventory: DatabaseObjectTree,
	remaining: () => number,
): Promise<string> {
	const expected = new Map(inventory.entries.map((entry) => [entry.path, entry]));
	const rows: (string | number)[][] = [];
	const pending = [""];
	while (pending.length) {
		remaining();
		const relative = pending.pop() ?? "";
		const directory = path.join(root, ...relative.split("/").filter(Boolean));
		const before = await checked(directory, false);
		const names = await fs.readdir(directory);
		if (names.length > DATABASE_OBJECT_LIMITS.entries + 1) return refuse();
		for (const name of names.sort(compare)) {
			remaining();
			if (relative === "" && name === ".git") continue;
			const filename = relative ? `${relative}/${name}` : name;
			const entry = expected.get(filename);
			if (!entry) return refuse();
			const full = path.join(root, ...filename.split("/"));
			const stat = await checked(full, entry.type === "blob");
			if (entry.type === "tree") {
				rows.push([filename, entry.mode, 0, ""]);
				pending.push(filename);
			} else {
				if (process.platform === "win32" && entry.mode === "100755")
					return refuse("DATABASE_SOURCE_UNAVAILABLE");
				const mode =
					process.platform === "win32" || (stat.mode & 0o111n) === 0n ? "100644" : "100755";
				if (mode !== entry.mode || stat.size !== BigInt(entry.bytes))
					return refuse("DATABASE_SOURCE_CHANGED");
				const content = await bytes(full, DATABASE_OBJECT_LIMITS.blobBytes);
				const digest = hash(content.bytes);
				if (digest !== entry.contentSha256) return refuse("DATABASE_SOURCE_CHANGED");
				rows.push([filename, mode, content.bytes.length, digest]);
			}
			if (rows.length > DATABASE_OBJECT_LIMITS.entries) return refuse();
		}
		if (identity(await checked(directory, false), false) !== identity(before, false))
			return refuse("DATABASE_SOURCE_CHANGED");
	}
	if (rows.length !== expected.size) return refuse();
	rows.sort((a, b) => compare(String(a[0]), String(b[0])));
	return hash(
		Buffer.from(`draftyak/native-dependency-policy/database-physical/v1\0${JSON.stringify(rows)}`),
	);
}
async function officialHead(): Promise<string> {
	if (Date.now() < rateLimitedUntil) return refuse("DATABASE_SOURCE_RATE_LIMIT");
	return new Promise((resolve, reject) => {
		let done = false;
		const chunks: Buffer[] = [];
		let size = 0;
		const fail = (code: DatabaseSourceCode): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			operation.destroy();
			reject(new DatabaseSourceError(code));
		};
		const operation = request(
			SOURCE,
			{
				method: "GET",
				rejectUnauthorized: true,
				agent: false,
				maxHeaderSize: 16_384,
				headers: {
					accept: "application/vnd.github.sha",
					"x-github-api-version": "2022-11-28",
					"user-agent": "draftyak-native-dependency-policy",
				},
			},
			(response) => {
				if (response.statusCode === 403 || response.statusCode === 429) {
					rateLimitedUntil = Date.now() + 900_000;
					fail("DATABASE_SOURCE_RATE_LIMIT");
					response.destroy();
					return;
				}
				if (
					response.statusCode !== 200 ||
					String(response.headers["content-type"] ?? "")
						.split(";")[0]
						?.trim()
						.toLowerCase() !== "application/vnd.github.sha"
				) {
					fail("DATABASE_SOURCE_UNAVAILABLE");
					response.destroy();
					return;
				}
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > 41) {
						fail("DATABASE_SOURCE_INVALID");
						response.destroy();
					} else chunks.push(chunk);
				});
				response.once("end", () => {
					if (done) return;
					const value = Buffer.concat(chunks, size).toString("utf8");
					if (!response.complete || !/^[a-f0-9]{40}\n?$/.test(value)) {
						fail("DATABASE_SOURCE_INVALID");
						return;
					}
					done = true;
					clearTimeout(timer);
					resolve(value.trim());
				});
				response.once("error", () => fail("DATABASE_SOURCE_UNAVAILABLE"));
				response.once("aborted", () => fail("DATABASE_SOURCE_UNAVAILABLE"));
			},
		);
		const timer = setTimeout(() => fail("DATABASE_SOURCE_DEADLINE"), 10_000);
		operation.once("error", () => fail("DATABASE_SOURCE_UNAVAILABLE"));
		operation.end();
	});
}
async function cleanup(scratch: string): Promise<void> {
	for (const name of ["HEAD", "config", "empty"]) {
		try {
			await fs.unlink(path.join(scratch, name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	for (const name of ["objects", "refs", ""]) {
		try {
			await fs.rmdir(path.join(scratch, name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}
async function collect(root: string, services: Services, owner: DatabaseSource): Promise<Receipt> {
	const startedAt = clock(services.clock()),
		monotonic = performance.now();
	const remaining = (): number => {
		const value = DEADLINE - (performance.now() - monotonic);
		if (value <= 0) return refuse("DATABASE_SOURCE_DEADLINE");
		return value;
	};
	let scratch: string | undefined;
	try {
		const rootId = identity(await checked(root, false), false);
		await checked(path.join(root, ".git"), false);
		const initialHead = await physicalHead(root),
			store = await objectStore(root, remaining),
			found = await discoverGit();
		remaining();
		const commit = await services.head();
		if (!ID.test(commit) || initialHead !== commit) return refuse("DATABASE_SOURCE_CHANGED");
		const sourceAt = clock(services.clock());
		if (sourceAt < startedAt) return refuse("DATABASE_SOURCE_CLOCK");
		const temporary = await fs.realpath(tmpdir());
		scratch = await fs.mkdtemp(path.join(temporary, "draftyak-database-"));
		for (const directory of ["objects", "refs"]) await fs.mkdir(path.join(scratch, directory));
		await fs.writeFile(path.join(scratch, "HEAD"), `${commit}\n`, { flag: "wx" });
		await fs.writeFile(
			path.join(scratch, "config"),
			"[core]\nrepositoryformatversion = 0\nbare = true\n",
			{ flag: "wx" },
		);
		await fs.writeFile(path.join(scratch, "empty"), "", { flag: "wx" });
		const version = (
			await command(
				{ ...found, version: "" },
				scratch,
				root,
				["--version"],
				Buffer.alloc(0),
				256,
				remaining,
			)
		).toString("utf8");
		if (!/^git version [0-9]+\.[0-9]+\.[0-9]+(?:\.windows\.[0-9]+)?\n$/.test(version))
			return refuse("DATABASE_SOURCE_UNAVAILABLE");
		const tool = { ...found, version: version.trim() };
		const inventory = await closure(tool, scratch, root, commit, remaining);
		const firstPhysical = await physical(root, inventory, remaining);
		const currentCommit = await services.head();
		if (!ID.test(currentCommit) || currentCommit !== commit)
			return refuse("DATABASE_SOURCE_CHANGED");
		const currentAt = clock(services.clock());
		if (currentAt < sourceAt) return refuse("DATABASE_SOURCE_CLOCK");
		const lastPhysical = await physical(root, inventory, remaining);
		if (
			lastPhysical !== firstPhysical ||
			(await physicalHead(root)) !== commit ||
			(await objectStore(root, remaining)) !== store ||
			identity(await checked(root, false), false) !== rootId
		)
			return refuse("DATABASE_SOURCE_CHANGED");
		await unchangedTool(tool);
		await cleanup(scratch);
		scratch = undefined;
		remaining();
		const completedAt = clock(services.clock());
		if (currentAt < sourceAt || completedAt < startedAt || completedAt < currentAt)
			return refuse("DATABASE_SOURCE_CLOCK");
		if (completedAt - startedAt >= HOUR) return refuse("DATABASE_SOURCE_STALE");
		const revision = hash(
			Buffer.from(
				`draftyak/native-dependency-policy/database-source/v1\0${JSON.stringify([commit, inventory.digest, lastPhysical])}`,
			),
		);
		return Object.freeze({
			owner,
			native: services.native,
			commit,
			currentCommit,
			revision,
			observedAt: currentAt,
			completedAt,
			tool: `${tool.digest}:${tool.version}`,
		});
	} catch (error) {
		if (error instanceof DatabaseSourceError) throw error;
		return refuse("DATABASE_SOURCE_INVALID");
	} finally {
		if (scratch) await cleanup(scratch).catch(() => undefined);
	}
}
function selected(value: unknown): string {
	if (
		value === null ||
		typeof value !== "object" ||
		types.isProxy(value) ||
		![null, Object.prototype].includes(Object.getPrototypeOf(value))
	)
		return refuse();
	const keys = Reflect.ownKeys(value);
	const descriptor = Object.getOwnPropertyDescriptor(value, "databaseRoot");
	if (keys.length !== 1 || keys[0] !== "databaseRoot" || !descriptor || !("value" in descriptor))
		return refuse();
	return absolute(descriptor.value);
}
function source(root: string, services: Services): DatabaseSource {
	const issue = (receipt: Receipt): DatabaseObservation => {
		const token = Object.freeze({}) as DatabaseObservation;
		receipts.set(token, receipt);
		return token;
	};
	const saved = (observation: DatabaseObservation): Receipt => {
		const value = receipts.get(observation);
		if (!value || value.owner !== result) return refuse();
		const now = clock(services.clock());
		if (now < value.completedAt) return refuse("DATABASE_SOURCE_CLOCK");
		if (now - value.observedAt >= HOUR) return refuse("DATABASE_SOURCE_STALE");
		return value;
	};
	const result: DatabaseSource = Object.freeze({
		observe: async () => issue(await withPathChecks(() => collect(root, services, result))),
		revalidate: async (previous: DatabaseObservation) => {
			const before = saved(previous),
				after = await withPathChecks(() => collect(root, services, result));
			if (
				before.commit !== after.commit ||
				before.revision !== after.revision ||
				before.tool !== after.tool
			)
				return refuse("DATABASE_SOURCE_CHANGED");
			return issue(after);
		},
		basis: (observation: DatabaseObservation) => {
			const value = saved(observation);
			if (!value.native) return refuse("DATABASE_SOURCE_TEST_ONLY");
			return Object.freeze({
				delivery: "independent-current-head",
				commit: value.commit,
				currentCommit: value.currentCommit,
				revision: value.revision,
				observedAt: value.observedAt,
			});
		},
	});
	return result;
}

/** Fixed official SHA-only source and controlled read-only Git. No audit, admission or authority is asserted. */
export function createDatabaseSource(options: { readonly databaseRoot: string }): DatabaseSource {
	return source(selected(options), { native: true, head: officialHead, clock: Date.now });
}

/** Simulated source facts never become a production DatabaseBasis or an authorization grant. */
export const databaseSourceTestInterface: {
	checkedPaths(paths: readonly string[], between?: (index: number) => Promise<void>): Promise<void>;
	create(options: {
		readonly databaseRoot: string;
		readonly head: () => Promise<string>;
		readonly clock?: () => number;
	}): DatabaseSource;
	metadata(
		source: DatabaseSource,
		observation: DatabaseObservation,
	): Readonly<Omit<DatabaseBasis, "delivery"> & { delivery: "test-only" }>;
} = Object.freeze({
	checkedPaths: (paths, between) =>
		withPathChecks(async () => {
			for (let index = 0; index < paths.length; index++) {
				const filename = paths[index];
				if (filename === undefined) return refuse();
				await checked(filename, true);
				if (index + 1 < paths.length) await between?.(index);
			}
		}),
	create: (options) =>
		source(absolute(options.databaseRoot), {
			native: false,
			head: options.head,
			clock: options.clock ?? Date.now,
		}),
	metadata: (owner, observation) => {
		const value = receipts.get(observation);
		if (!value || value.native || value.owner !== owner) return refuse();
		return Object.freeze({
			delivery: "test-only",
			commit: value.commit,
			currentCommit: value.currentCommit,
			revision: value.revision,
			observedAt: value.observedAt,
		});
	},
});
