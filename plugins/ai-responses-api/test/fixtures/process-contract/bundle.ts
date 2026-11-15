import {createHash} from "node:crypto";
import {isBuiltin} from "node:module";
import {tmpdir} from "node:os";
import path from "node:path";
import {lstat, mkdtemp, open, readdir, realpath, rmdir, unlink} from "node:fs/promises";
import type {BigIntStats} from "node:fs";
import {fileURLToPath} from "node:url";
import {build, type InlineConfig, type TsdownHandle} from "tsdown";
import {createPlugin} from "@draftyak/ai-responses-api/plugin";
import type {ProcessPluginFiles} from "@draftyak/plugin-testkit";
import type {MockPlugin} from "@draftyak/plugin-testkit/types";
import manifest from "../../../draftyak.plugin.json" with {type: "json"};

export const plugin: MockPlugin = {manifest, entry: createPlugin("api-key")};

const MAX_FILES = 128;
const MAX_FILE_BYTES = 16 * 1024 ** 2;
const MAX_TOTAL_BYTES = 32 * 1024 ** 2;
const ENTRY = "entry.mjs";
const unavailable = () => new Error("Process fixture unavailable");
const identity = (value: BigIntStats) => `${value.dev}:${value.ino}`;
const memberStamp = (value: BigIntStats) =>
	`${identity(value)}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
const memberName = (value: string) =>
	value.length <= 256 && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value);

interface Member {
	name: string;
	bytes: number;
	stamp: string;
	sha256: string;
}

async function readMember(directory: string, name: string, limit = MAX_FILE_BYTES): Promise<Member> {
	if (!memberName(name)) throw unavailable();
	const target = path.join(directory, name);
	const named = await lstat(target, {bigint: true});
	if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n ||
		named.size < 1n || named.size > BigInt(Math.min(limit, MAX_FILE_BYTES))) throw unavailable();
	const file = await open(target, "r");
	try {
		const before = await file.stat({bigint: true});
		if (memberStamp(before) !== memberStamp(named)) throw unavailable();
		const bytes = Buffer.alloc(Number(before.size));
		let offset = 0;
		while (offset < bytes.length) {
			const read = await file.read(bytes, offset, bytes.length - offset, offset);
			if (!read.bytesRead) throw unavailable();
			offset += read.bytesRead;
		}
		const extra = await file.read(Buffer.alloc(1), 0, 1, offset);
		const after = await file.stat({bigint: true});
		const current = await lstat(target, {bigint: true});
		if (extra.bytesRead || memberStamp(after) !== memberStamp(before) ||
			memberStamp(current) !== memberStamp(before) || current.isSymbolicLink()) throw unavailable();
		return {name, bytes: bytes.length, stamp: memberStamp(before), sha256: createHash("sha256").update(bytes).digest("hex")};
	} finally {
		await file.close();
	}
}

async function inventory(directory: string): Promise<Member[]> {
	const names = await readdir(directory);
	if (!names.length || names.length > MAX_FILES || names.some((name) => !memberName(name)))
		throw unavailable();
	let total = 0n;
	for (const name of names) {
		const value = await lstat(path.join(directory, name), {bigint: true});
		if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n) throw unavailable();
		total += value.size;
		if (total > BigInt(MAX_TOTAL_BYTES)) throw unavailable();
	}
	const result: Member[] = [];
	let readBytes = 0;
	for (const name of names.sort()) {
		const member = await readMember(directory, name, MAX_TOTAL_BYTES - readBytes);
		readBytes += member.bytes;
		result.push(member);
	}
	return result;
}

function emittedNames(handle: TsdownHandle, directory: string): string[] {
	if (handle.bundles.length !== 1) throw unavailable();
	const names = new Set<string>();
	const dependencies: string[] = [];
	let entries = 0;
	for (const bundle of handle.bundles) {
		for (const chunk of bundle.chunks) {
			if (path.resolve(chunk.outDir) !== directory || !memberName(chunk.fileName) ||
				names.has(chunk.fileName) || names.size >= MAX_FILES) throw unavailable();
			names.add(chunk.fileName);
			if (chunk.type === "chunk") {
				if (chunk.isEntry) {
					if (chunk.fileName !== ENTRY) throw unavailable();
					entries++;
				}
				dependencies.push(...chunk.imports, ...chunk.dynamicImports);
			}
		}
	}
	if (entries !== 1) throw unavailable();
	for (const dependency of dependencies) {
		if (isBuiltin(dependency)) continue;
		const local = dependency.startsWith("./") ? dependency.slice(2) : dependency;
		if (!memberName(local) || !names.has(local)) throw unavailable();
	}
	return [...names].sort();
}

async function releaseBuild(handle: TsdownHandle): Promise<void> {
	let failed = false;
	for (const bundle of handle.bundles) {
		try {
			await bundle[Symbol.asyncDispose]();
		} catch {
			failed = true;
		}
	}
	if (failed) throw unavailable();
}

async function prepareFiles(): Promise<{
	source: ProcessPluginFiles;
	dispose(): Promise<void>;
}> {
	const base = await realpath(tmpdir());
	const baseIdentity = identity(await lstat(base, {bigint: true}));
	const directory = await mkdtemp(path.join(base, "draftyak-ai-process-"));
	const basename = path.basename(directory);
	const directoryIdentity = identity(await lstat(directory, {bigint: true}));
	const verifyDirectory = async () => {
		if (!path.isAbsolute(directory) || path.dirname(directory) !== base ||
			path.join(base, basename) !== directory || !basename.startsWith("draftyak-ai-process-"))
			throw unavailable();
		const parent = await lstat(base, {bigint: true});
		const current = await lstat(directory, {bigint: true});
		if (!parent.isDirectory() || parent.isSymbolicLink() || identity(parent) !== baseIdentity ||
			!current.isDirectory() || current.isSymbolicLink() || identity(current) !== directoryIdentity ||
			await realpath(base) !== base || await realpath(directory) !== directory) throw unavailable();
	};
	const packageDirectory = fileURLToPath(new URL("../../../", import.meta.url));
	const config: InlineConfig = {
		config: false,
		define: {"import.meta.main": "false"},
		cwd: packageDirectory,
		entry: {entry: fileURLToPath(new URL("./entry.mjs", import.meta.url))},
		outDir: directory,
		format: "esm",
		platform: "node",
		target: "node26",
		unbundle: false,
		deps: {alwaysBundle: (id) => !isBuiltin(id)},
		outputOptions: {
			entryFileNames: ENTRY,
			chunkFileNames: "chunk-[hash].mjs",
			assetFileNames: "asset-[hash][extname]",
		},
		fixedExtension: true,
		nodeProtocol: true,
		tsconfig: false,
		sourcemap: false,
		dts: false,
		clean: false,
		write: true,
		watch: false,
		publint: false,
		attw: false,
		unused: false,
		exports: false,
		report: false,
		devtools: false,
		exe: false,
		logLevel: "silent",
		failOnWarn: true,
	};
	let names: string[];
	try {
		await verifyDirectory();
		const handle = await build(config);
		try {
			names = emittedNames(handle, directory);
		} finally {
			await releaseBuild(handle);
		}
	} catch {
		// Failed or uncertain build cleanup leaves this directory intact.
		throw unavailable();
	}
	await verifyDirectory();
	const members = await inventory(directory);
	if (members.map((member) => member.name).join("\n") !== names.join("\n")) throw unavailable();
	const source: ProcessPluginFiles = Object.freeze({
		directory,
		entry: ENTRY,
		files: Object.freeze([...names]),
	});
	let closing: Promise<void> | undefined;
	const dispose = (): Promise<void> => {
		closing ??= (async () => {
			try {
				await verifyDirectory();
				const current = await inventory(directory);
				if (JSON.stringify(current) !== JSON.stringify(members)) throw unavailable();
				for (const member of members) {
					await verifyDirectory();
					const actual = await readMember(directory, member.name);
					if (JSON.stringify(actual) !== JSON.stringify(member)) throw unavailable();
					await unlink(path.join(directory, member.name));
				}
				await verifyDirectory();
				await rmdir(directory);
			} catch {
				// A partial or uncertain cleanup is terminal for this fixture.
				throw unavailable();
			}
		})();
		return closing;
	};
	return {source, dispose};
}

export async function prepareProcessContractFiles(): Promise<{
	source: ProcessPluginFiles;
	dispose(): Promise<void>;
}> {
	try {
		return await prepareFiles();
	} catch {
		throw unavailable();
	}
}
