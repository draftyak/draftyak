import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

const CHILD = "advisory-db-3157b0e258782691";
const UPSTREAM = "https://github.com/RustSec/advisory-db";
const DEADLINE_MS = 300_000;
const CLOSE_MS = 5_000;
const OUTPUT_LIMIT = 65_536;
const retainedFiles = new Set<fs.FileHandle>();
const retainedChildren = new Set<ChildProcess>();
let operationActive = false;
let uncertainty = false;

export type DatabaseMaterializationCode =
	| "DATABASE_MATERIALIZATION_PATH"
	| "DATABASE_MATERIALIZATION_TOOL"
	| "DATABASE_MATERIALIZATION_CHANGED"
	| "DATABASE_MATERIALIZATION_IO"
	| "DATABASE_MATERIALIZATION_PROCESS"
	| "DATABASE_MATERIALIZATION_UNCONFIRMED"
	| "DATABASE_MATERIALIZATION_DEADLINE"
	| "DATABASE_MATERIALIZATION_OUTPUT";

export class DatabaseMaterializationError extends Error {
	readonly code: DatabaseMaterializationCode;
	constructor(code: DatabaseMaterializationCode) {
		super("database materialization refused");
		this.name = "DatabaseMaterializationError";
		this.code = code;
	}
}

function refuse(code: DatabaseMaterializationCode): never {
	throw new DatabaseMaterializationError(code);
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
		value.split(/[\\/]/u).some((part) => part === "." || part === ".." || /[. ]$/u.test(part))
	)
		return refuse("DATABASE_MATERIALIZATION_PATH");
	return path.resolve(value);
}

function sameDirectory(before: BigIntStats, after: BigIntStats): boolean {
	return (
		before.isDirectory() &&
		after.isDirectory() &&
		!before.isSymbolicLink() &&
		!after.isSymbolicLink() &&
		before.ino !== 0n &&
		before.dev === after.dev &&
		before.ino === after.ino
	);
}

async function directory(file: string): Promise<BigIntStats> {
	const stat = await fs.lstat(file, { bigint: true });
	if (!sameDirectory(stat, stat) || (await fs.realpath(file)) !== file)
		return refuse("DATABASE_MATERIALIZATION_PATH");
	return stat;
}

async function checkedDirectory(file: string): Promise<BigIntStats> {
	let current = path.parse(file).root;
	await directory(current);
	for (const segment of file.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		await directory(current);
	}
	return directory(file);
}

function within(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	);
}

function fileIdentity(stat: BigIntStats): string {
	if (!stat.isFile() || stat.isSymbolicLink() || stat.ino === 0n || stat.nlink < 1n)
		return refuse("DATABASE_MATERIALIZATION_TOOL");
	return [stat.dev, stat.ino, stat.size, stat.mode, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(
		":",
	);
}

async function close(handle: fs.FileHandle): Promise<void> {
	// A rejecting close leaves this exact object retained; never retry a numeric descriptor.
	try {
		await handle.close();
		retainedFiles.delete(handle);
	} catch (error) {
		uncertainty = true;
		throw error;
	}
}

async function executable(file: string): Promise<string> {
	await checkedDirectory(path.dirname(file));
	const before = await fs.lstat(file, { bigint: true });
	const identity = fileIdentity(before);
	if ((await fs.realpath(file)) !== file || before.size < 4n || before.size > 64n * 1024n * 1024n)
		return refuse("DATABASE_MATERIALIZATION_TOOL");
	const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	retainedFiles.add(handle);
	try {
		if (fileIdentity(await handle.stat({ bigint: true })) !== identity)
			return refuse("DATABASE_MATERIALIZATION_CHANGED");
		const bytes = Buffer.alloc(Number(before.size) + 1);
		let size = 0;
		for (;;) {
			const read = await handle.read(bytes, size, bytes.length - size, null);
			if (read.bytesRead === 0) break;
			size += read.bytesRead;
			if (size > Number(before.size)) return refuse("DATABASE_MATERIALIZATION_CHANGED");
		}
		if (
			size !== Number(before.size) ||
			fileIdentity(await handle.stat({ bigint: true })) !== identity ||
			fileIdentity(await fs.lstat(file, { bigint: true })) !== identity ||
			(await fs.realpath(file)) !== file
		)
			return refuse("DATABASE_MATERIALIZATION_CHANGED");
		if (
			process.platform === "win32"
				? bytes[0] !== 0x4d || bytes[1] !== 0x5a
				: !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
		)
			return refuse("DATABASE_MATERIALIZATION_TOOL");
		return `${identity}:${createHash("sha256").update(bytes.subarray(0, size)).digest("hex")}`;
	} finally {
		await close(handle);
	}
}

async function git(): Promise<{ file: string; identity: string }> {
	const candidates =
		process.platform === "win32"
			? ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\mingw64\\bin\\git.exe"]
			: process.platform === "linux" && process.arch === "x64"
				? ["/usr/bin/git"]
				: [];
	for (const candidate of candidates) {
		try {
			const file = await fs.realpath(candidate);
			return { file, identity: await executable(file) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return refuse("DATABASE_MATERIALIZATION_TOOL");
}

function environment(parent: string): NodeJS.ProcessEnv {
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
		const systemRoot = process.env.SystemRoot;
		if (!systemRoot || !path.isAbsolute(systemRoot)) return refuse("DATABASE_MATERIALIZATION_TOOL");
		env.SYSTEMROOT = systemRoot;
	}
	return Object.assign(env, {
		HOME: path.join(parent, "home"),
		USERPROFILE: path.join(parent, "home"),
		XDG_CONFIG_HOME: path.join(parent, "home"),
		TEMP: path.join(parent, "temporary"),
		TMP: path.join(parent, "temporary"),
		TMPDIR: path.join(parent, "temporary"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: path.join(parent, "empty"),
		GIT_CONFIG_GLOBAL: path.join(parent, "empty"),
		GIT_CONFIG_COUNT: "0",
		GIT_TEMPLATE_DIR: path.join(parent, "templates"),
		GIT_ATTR_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ALLOW_PROTOCOL: "https",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_NO_LAZY_FETCH: "1",
		GIT_PAGER: "",
		GIT_EXTERNAL_DIFF: "",
		LC_ALL: "C",
		LANG: "C",
		NO_COLOR: "1",
	});
}

function track(child: ChildProcess): void {
	retainedChildren.add(child);
	child.once("close", () => retainedChildren.delete(child));
}

function stop(child: ChildProcess, env: NodeJS.ProcessEnv): Promise<boolean> {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve(true);
	if (process.platform !== "win32") {
		try {
			process.kill(-child.pid, "SIGKILL");
			return Promise.resolve(true);
		} catch {
			return Promise.resolve(false);
		}
	}
	const root = env.SYSTEMROOT;
	if (!root) return Promise.resolve(false);
	return new Promise((resolve) => {
		try {
			const killer = spawn(
				path.join(root, "System32", "taskkill.exe"),
				["/PID", String(child.pid), "/T", "/F"],
				{ env, shell: false, windowsHide: true, stdio: "ignore" },
			);
			track(killer);
			let failed = false;
			killer.once("error", () => {
				failed = true;
			});
			const timer = setTimeout(() => {
				failed = true;
				if (retainedChildren.has(killer)) killer.kill();
			}, CLOSE_MS);
			killer.once("close", (code, signal) => {
				clearTimeout(timer);
				resolve(!failed && code === 0 && signal === null);
			});
		} catch {
			resolve(false);
		}
	});
}

async function clone(
	file: string,
	args: readonly string[],
	parent: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(file, [...args], {
				cwd: parent,
				env,
				shell: false,
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			reject(new DatabaseMaterializationError("DATABASE_MATERIALIZATION_PROCESS"));
			return;
		}
		track(child);
		let failed: DatabaseMaterializationCode | undefined;
		let stopping = false,
			stopFinished = true;
		let closed = false,
			streams = 0,
			settled = false;
		let grace: ReturnType<typeof setTimeout> | undefined;
		const finish = (): void => {
			if (settled || !closed || streams !== 2 || !stopFinished) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(grace);
			if (failed) reject(new DatabaseMaterializationError(failed));
			else resolve();
		};
		const waitForClose = (): void => {
			grace ??= setTimeout(() => {
				if (settled) return;
				settled = true;
				uncertainty = true;
				clearTimeout(timer);
				reject(new DatabaseMaterializationError("DATABASE_MATERIALIZATION_UNCONFIRMED"));
			}, CLOSE_MS);
		};
		const fail = (code: DatabaseMaterializationCode): void => {
			failed ??= code;
			if (!stopping) {
				stopping = true;
				stopFinished = false;
				void stop(child, env).then((confirmed) => {
					stopFinished = true;
					if (!confirmed) {
						uncertainty = true;
						failed = "DATABASE_MATERIALIZATION_UNCONFIRMED";
					}
					finish();
				});
			}
			waitForClose();
			finish();
		};
		const timer = setTimeout(() => fail("DATABASE_MATERIALIZATION_DEADLINE"), DEADLINE_MS);
		const drain = (stream: Readable | null): void => {
			if (!stream) {
				fail("DATABASE_MATERIALIZATION_PROCESS");
				return;
			}
			let size = 0;
			stream.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > OUTPUT_LIMIT) fail("DATABASE_MATERIALIZATION_OUTPUT");
			});
			stream.once("error", () => fail("DATABASE_MATERIALIZATION_PROCESS"));
			stream.once("close", () => {
				streams++;
				finish();
			});
		};
		drain(child.stdout);
		drain(child.stderr);
		child.once("error", () => fail("DATABASE_MATERIALIZATION_PROCESS"));
		child.once("close", (code, signal) => {
			closed = true;
			if (code !== 0 || signal !== null) fail("DATABASE_MATERIALIZATION_PROCESS");
			else if (streams !== 2) waitForClose();
			finish();
		});
	});
}

/** Produces only fresh database files. The genuine database reader must independently validate them. */
export async function materializeAdvisoryDatabase(databaseRoot: string): Promise<void> {
	if (operationActive || uncertainty || retainedFiles.size !== 0 || retainedChildren.size !== 0)
		return refuse("DATABASE_MATERIALIZATION_UNCONFIRMED");
	operationActive = true;
	try {
		const root = absolute(databaseRoot),
			parent = path.dirname(root),
			ancestor = path.dirname(parent);
		const repository = await fs.realpath(path.resolve(import.meta.dirname, "../../.."));
		if (path.basename(root) !== CHILD || within(repository, parent) || within(parent, repository))
			return refuse("DATABASE_MATERIALIZATION_PATH");
		const ancestorIdentity = await checkedDirectory(ancestor);
		const tool = await git();
		await fs.mkdir(parent, { mode: 0o700 }); // EEXIST always refuses, including an empty cache.
		const parentIdentity = await directory(parent);
		if (!sameDirectory(ancestorIdentity, await directory(ancestor)))
			return refuse("DATABASE_MATERIALIZATION_CHANGED");
		const controls = new Map<string, BigIntStats>();
		for (const name of ["home", "temporary", "templates", "hooks"]) {
			const file = path.join(parent, name);
			await fs.mkdir(file, { mode: 0o700 });
			controls.set(file, await directory(file));
		}
		const empty = path.join(parent, "empty");
		const handle = await fs.open(
			empty,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		retainedFiles.add(handle);
		let emptyIdentity: string;
		try {
			emptyIdentity = fileIdentity(await handle.stat({ bigint: true }));
		} finally {
			await close(handle);
		}
		const env = environment(parent);
		const args = [
			"-c",
			"gc.auto=0",
			"-c",
			"maintenance.auto=false",
			"-c",
			"core.autocrlf=false",
			"-c",
			"core.eol=lf",
			"-c",
			`core.attributesFile=${empty}`,
			"-c",
			`core.hooksPath=${path.join(parent, "hooks")}`,
			"-c",
			"credential.helper=",
			"-c",
			"http.followRedirects=false",
			"-c",
			"http.sslVerify=true",
			"clone",
			"--quiet",
			"--no-hardlinks",
			"--",
			UPSTREAM,
			root,
		];
		if (
			(await executable(tool.file)) !== tool.identity ||
			!sameDirectory(parentIdentity, await directory(parent)) ||
			fileIdentity(await fs.lstat(empty, { bigint: true })) !== emptyIdentity
		)
			return refuse("DATABASE_MATERIALIZATION_CHANGED");
		await clone(tool.file, args, parent, env);
		if (
			(await executable(tool.file)) !== tool.identity ||
			!sameDirectory(parentIdentity, await directory(parent))
		)
			return refuse("DATABASE_MATERIALIZATION_CHANGED");
		await directory(root);
		await directory(path.join(root, ".git"));
		if (fileIdentity(await fs.lstat(empty, { bigint: true })) !== emptyIdentity)
			return refuse("DATABASE_MATERIALIZATION_CHANGED");
		await fs.unlink(empty);
		for (const [file, identity] of controls) {
			if (!sameDirectory(identity, await directory(file)))
				return refuse("DATABASE_MATERIALIZATION_CHANGED");
			await fs.rmdir(file); // Never recurse through Git output or unknown files.
		}
		if (!sameDirectory(parentIdentity, await directory(parent)))
			return refuse("DATABASE_MATERIALIZATION_CHANGED");
		const names = await fs.readdir(parent);
		if (names.length !== 1 || names[0] !== CHILD) return refuse("DATABASE_MATERIALIZATION_CHANGED");
		if (retainedFiles.size !== 0 || retainedChildren.size !== 0 || uncertainty)
			return refuse("DATABASE_MATERIALIZATION_UNCONFIRMED");
	} catch (error) {
		// Failed/uncertain trees remain in their exclusive parent; never adopt or retry them.
		if (error instanceof DatabaseMaterializationError) throw error;
		return refuse("DATABASE_MATERIALIZATION_IO");
	} finally {
		operationActive = false;
	}
}
