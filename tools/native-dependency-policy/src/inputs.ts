import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import type { CargoPackagePaths, ValidatedCargoPaths } from "./cargo-graph.ts";

const MEMBERS = [
	["crates/draftyak-protocol/Cargo.toml", "draftyak-protocol"],
	["crates/draftyak-desktop-pairing/Cargo.toml", "draftyak-desktop-pairing"],
	["crates/draftyak-transport/Cargo.toml", "draftyak-transport"],
	["apps/app/src-tauri/Cargo.toml", "draftyak-desktop"],
] as const;
const RAW = ["crates/Cargo.toml", "crates/Cargo.lock", "crates/deny.toml", "rust-toolchain.toml"];
const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
const DOMAIN = "draftyak/native-dependency-policy/inputs/v1\0";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const OMIT = new Set(["target", "node_modules", ".cache", ".git", ".cargo"]);
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
type FileRow = readonly [string, string | null];

export type NativeInputsCode = "INPUTS_INVALID" | "INPUTS_CHANGED" | "CONFIGURATION_UNSUPPORTED";
export class NativeInputsError extends Error {
	readonly code: NativeInputsCode;
	constructor(code: NativeInputsCode = "INPUTS_INVALID") {
		super("native dependency inputs refused");
		this.name = "NativeInputsError";
		this.code = code;
	}
}

declare const snapshotBrand: unique symbol;
export interface NativeInputsSnapshot {
	readonly inputDigest: string;
	readonly lockDigest: string;
	readonly [snapshotBrand]: true;
}
interface Capture {
	readonly inputDigest: string;
	readonly lockDigest: string;
	readonly identities: Map<string, string>;
	readonly rustPaths: Set<string>;
}
interface State {
	readonly repository: string;
	readonly cargoHome: string;
	readonly capture: Capture;
	phase: "captured" | "binding" | "bound";
}
const snapshots = new WeakMap<NativeInputsSnapshot, State>();
const refuse = (code: NativeInputsCode = "INPUTS_INVALID"): never => {
	throw new NativeInputsError(code);
};
function controls(value: string): boolean {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code < 32 || code === 127) return true;
	}
	return false;
}

function absolute(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > 4096 ||
		controls(value) ||
		!path.isAbsolute(value) ||
		value.startsWith("\\\\") ||
		value.startsWith("//")
	)
		return refuse();
	return path.resolve(value);
}
function relative(value: string): string {
	if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value)) return refuse();
	if (value.split("/").some((part) => part === "." || part === "..")) return refuse();
	return value;
}
const slash = (value: string): string => value.split(path.sep).join("/");
function within(root: string, filename: string): string {
	const rel = path.relative(root, filename);
	if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
		return refuse();
	return relative(slash(rel));
}
function identity(stat: BigIntStats): string {
	if (stat.isSymbolicLink() || stat.ino === 0n) return refuse();
	if (stat.isDirectory()) return JSON.stringify(["directory", String(stat.dev), String(stat.ino)]);
	if (!stat.isFile() || stat.nlink !== 1n) return refuse();
	return JSON.stringify([
		"file",
		String(stat.dev),
		String(stat.ino),
		String(stat.size),
		String(stat.mtimeNs),
		String(stat.ctimeNs),
	]);
}
async function optionalStat(filename: string): Promise<BigIntStats | undefined> {
	try {
		return await fs.lstat(filename, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
/** No links, short-name aliases, case aliases or noncanonical component spelling. */
async function checked(filename: string, kind: "file" | "directory"): Promise<BigIntStats> {
	const full = absolute(filename);
	const volume = path.parse(full).root;
	let current = volume;
	const rootStat = await fs.lstat(volume, { bigint: true });
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return refuse();
	for (const segment of full.slice(volume.length).split(path.sep).filter(Boolean)) {
		const names = await fs.readdir(current);
		const matches = names.filter((name) => name.toLowerCase() === segment.toLowerCase());
		if (matches.length !== 1 || matches[0] !== segment) return refuse();
		current = path.join(current, segment);
		const stat = await fs.lstat(current, { bigint: true });
		identity(stat);
		if ((await fs.realpath(current)) !== current) return refuse();
	}
	const result = await fs.lstat(full, { bigint: true });
	if (kind === "file" ? !result.isFile() : !result.isDirectory()) return refuse();
	identity(result);
	return result;
}
async function fileHash(filename: string, initial: BigIntStats): Promise<string> {
	if (initial.size > BigInt(MAX_FILE_BYTES)) return refuse();
	const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (identity(await file.stat({ bigint: true })) !== identity(initial))
			return refuse("INPUTS_CHANGED");
		const digest = createHash("sha256");
		const buffer = Buffer.alloc(65_536);
		let total = 0;
		while (true) {
			const { bytesRead } = await file.read(
				buffer,
				0,
				Math.min(buffer.length, MAX_FILE_BYTES + 1 - total),
			);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > MAX_FILE_BYTES) return refuse();
			digest.update(buffer.subarray(0, bytesRead));
		}
		if (
			BigInt(total) !== initial.size ||
			identity(await file.stat({ bigint: true })) !== identity(initial)
		)
			return refuse("INPUTS_CHANGED");
		return digest.digest("hex");
	} finally {
		await file.close();
	}
}
function configDirectories(): string[] {
	const dirs = new Set<string>([""]);
	for (const [manifest] of MEMBERS) {
		let directory = path.posix.dirname(manifest);
		while (directory !== ".") {
			dirs.add(directory);
			directory = path.posix.dirname(directory);
		}
	}
	return [...dirs].sort(compare);
}
async function outsideConfiguration(repository: string, cargoHome: string): Promise<void> {
	// Check presence only: owner/global configuration contents are never opened.
	await checked(cargoHome, "directory");
	const candidates = [path.join(cargoHome, "config"), path.join(cargoHome, "config.toml")];
	let ancestor = path.dirname(repository);
	while (true) {
		const folder = await optionalStat(path.join(ancestor, ".cargo"));
		if (folder?.isSymbolicLink()) return refuse("CONFIGURATION_UNSUPPORTED");
		candidates.push(
			path.join(ancestor, ".cargo/config"),
			path.join(ancestor, ".cargo/config.toml"),
		);
		const parent = path.dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	for (const filename of candidates) {
		if (await optionalStat(filename)) return refuse("CONFIGURATION_UNSUPPORTED");
	}
}
async function capture(repository: string, cargoHome: string): Promise<Capture> {
	const identities = new Map<string, string>();
	const track = async (filename: string, kind: "file" | "directory"): Promise<BigIntStats> => {
		const stat = await checked(filename, kind);
		identities.set(filename, identity(stat));
		return stat;
	};
	await track(repository, "directory");
	await track(path.join(repository, "crates"), "directory");
	await track(cargoHome, "directory");
	await outsideConfiguration(repository, cargoHome);
	const files: FileRow[] = [];
	let bytes = 0n;
	for (const name of [...RAW, ...MEMBERS.map(([manifest]) => manifest)]) {
		const filename = path.join(repository, name);
		const stat = await track(filename, "file");
		bytes += stat.size;
		if (bytes > BigInt(MAX_TOTAL_BYTES)) return refuse();
		files.push([name, await fileHash(filename, stat)]);
	}
	for (const directory of configDirectories()) {
		const folder = path.join(repository, directory, ".cargo");
		const folderNames = (await fs.readdir(path.dirname(folder))).filter(
			(name) => name.toLowerCase() === ".cargo",
		);
		if (folderNames.length > 1 || (folderNames.length === 1 && folderNames[0] !== ".cargo"))
			return refuse();
		if (await optionalStat(folder)) await track(folder, "directory");
		else identities.set(folder, "absent");
		let found = 0;
		for (const name of ["config", "config.toml"]) {
			const filename = path.join(folder, name);
			const rel = slash(path.relative(repository, filename));
			if (await optionalStat(folder)) {
				const matches = (await fs.readdir(folder)).filter(
					(candidate) => candidate.toLowerCase() === name,
				);
				if (matches.length > 1 || (matches.length === 1 && matches[0] !== name)) return refuse();
			}
			const stat = await optionalStat(filename);
			if (stat) {
				found++;
				await track(filename, "file");
				if (stat.size !== 0n) return refuse("CONFIGURATION_UNSUPPORTED");
				files.push([rel, await fileHash(filename, stat)]);
			} else {
				identities.set(filename, "absent");
				files.push([rel, null]);
			}
		}
		if (found > 1) return refuse("CONFIGURATION_UNSUPPORTED");
	}
	const rustPaths = new Set<string>();
	let visited = 0;
	const walk = async (directory: string, depth: number): Promise<void> => {
		if (depth > 24) return refuse();
		await track(directory, "directory");
		const names = await fs.readdir(directory);
		const folded = new Set<string>();
		for (const name of names.sort(compare)) {
			if (++visited > MAX_ENTRIES || folded.has(name.toLowerCase())) return refuse();
			folded.add(name.toLowerCase());
			const filename = path.join(directory, name);
			const stat = await fs.lstat(filename, { bigint: true });
			if (stat.isSymbolicLink()) return refuse();
			if (stat.isDirectory()) {
				if (!OMIT.has(name)) await walk(filename, depth + 1);
			} else if (name.endsWith(".rs")) {
				const rel = within(repository, filename);
				await track(filename, "file");
				rustPaths.add(rel);
			}
		}
	};
	for (const [manifest] of MEMBERS)
		await walk(path.join(repository, path.posix.dirname(manifest)), 0);
	const ordered = files.sort(([a], [b]) => compare(a, b));
	const payload = ["inputs", 1, ordered, [...rustPaths].sort(compare), true];
	const lockDigest = ordered.find(([name]) => name === "crates/Cargo.lock")?.[1];
	if (!lockDigest) return refuse();
	return {
		inputDigest: createHash("sha256")
			.update(DOMAIN)
			.update(JSON.stringify(payload), "utf8")
			.digest("hex"),
		lockDigest,
		identities,
		rustPaths,
	};
}
function same(before: Capture, after: Capture): boolean {
	return (
		before.inputDigest === after.inputDigest &&
		before.identities.size === after.identities.size &&
		[...before.identities].every(([name, id]) => after.identities.get(name) === id)
	);
}
function state(snapshot: NativeInputsSnapshot): State {
	const value = snapshots.get(snapshot);
	if (!value) return refuse();
	return value;
}
async function unchanged(value: State): Promise<void> {
	if (!same(value.capture, await capture(value.repository, value.cargoHome)))
		return refuse("INPUTS_CHANGED");
}
function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value))
		return refuse();
	if (![null, Object.prototype].includes(Object.getPrototypeOf(value))) return refuse();
	if (Object.getOwnPropertySymbols(value).length) return refuse();
	const result: Record<string, unknown> = Object.create(null);
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if (!Object.hasOwn(descriptor, "value")) return refuse();
		result[key] = descriptor.value;
	}
	return result;
}
function list(value: unknown): unknown[] {
	if (!Array.isArray(value) || types.isProxy(value) || value.length > MAX_ENTRIES) return refuse();
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		Object.getOwnPropertySymbols(value).length ||
		Object.keys(descriptors).length !== value.length + 1
	)
		return refuse();
	return Array.from({ length: value.length }, (_, index) => {
		const descriptor = descriptors[String(index)];
		if (!descriptor || !Object.hasOwn(descriptor, "value")) return refuse();
		return descriptor.value;
	});
}
function text(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 16_384 || controls(value))
		return refuse();
	return value;
}
async function guarded<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (error) {
		if (error instanceof NativeInputsError) throw error;
		return refuse();
	}
}

/** A live, module-owned capture. Serialized data cannot substitute for this object. */
export async function captureNativeInputs(
	repositoryRoot: string,
	cargoHome: string,
): Promise<NativeInputsSnapshot> {
	return guarded(async () => {
		const repository = absolute(repositoryRoot);
		const home = absolute(cargoHome);
		const captured = await capture(repository, home);
		const result = Object.freeze({
			inputDigest: captured.inputDigest,
			lockDigest: captured.lockDigest,
		}) as NativeInputsSnapshot;
		snapshots.set(result, { repository, cargoHome: home, capture: captured, phase: "captured" });
		return result;
	});
}

/** Called only with fresh strict-parsed metadata from the fixed locked native command. */
export async function bindNativeCargoPaths(
	snapshot: NativeInputsSnapshot,
	metadata: unknown,
): Promise<ValidatedCargoPaths> {
	return guarded(async () => {
		const value = state(snapshot);
		if (value.phase !== "captured") return refuse();
		value.phase = "binding";
		await unchanged(value);
		const input = object(metadata);
		if (absolute(input.workspace_root) !== path.join(value.repository, "crates")) return refuse();
		const paths: CargoPackagePaths[] = [];
		const local = new Map(
			MEMBERS.map(([manifest, name]) => [
				path.join(value.repository, manifest),
				{ manifest, name },
			]),
		);
		const packages = list(input.packages).map(object);
		for (const pkg of packages) {
			if (pkg.source !== null && pkg.source !== REGISTRY) return refuse();
			for (const dependency of list(pkg.dependencies).map(object)) {
				if (dependency.source !== null && dependency.source !== REGISTRY) return refuse();
				if (dependency.registry !== null) return refuse();
				if (Object.hasOwn(dependency, "path")) {
					const directory = absolute(dependency.path);
					if (!local.has(path.join(directory, "Cargo.toml"))) return refuse();
					await checked(directory, "directory");
				} else if (dependency.source === null) return refuse();
			}
			if (pkg.source !== null) continue;
			const manifest = absolute(pkg.manifest_path);
			const member = local.get(manifest);
			if (
				!member ||
				pkg.name !== member.name ||
				paths.some((p) => p.manifestPath === member.manifest)
			)
				return refuse();
			await checked(manifest, "file");
			const targets = [];
			const seen = new Set<string>();
			for (const target of list(pkg.targets).map(object)) {
				const filename = absolute(target.src_path);
				within(path.dirname(manifest), filename);
				const rel = within(value.repository, filename);
				if (!value.capture.rustPaths.has(rel)) return refuse();
				const stat = await checked(filename, "file");
				if (identity(stat) !== value.capture.identities.get(filename))
					return refuse("INPUTS_CHANGED");
				const kinds = list(target.kind).map(text).sort(compare);
				if (!kinds.length || new Set(kinds).size !== kinds.length) return refuse();
				const name = text(target.name);
				const key = JSON.stringify([name, kinds, rel]);
				if (seen.has(key)) return refuse();
				seen.add(key);
				targets.push(
					Object.freeze({
						name,
						kinds: Object.freeze(kinds),
						sourcePath: text(target.src_path),
						relativePath: rel,
					}),
				);
			}
			if (!targets.length) return refuse();
			paths.push(
				Object.freeze({
					id: text(pkg.id),
					manifestPath: member.manifest,
					targets: Object.freeze(targets),
				}),
			);
		}
		if (paths.length !== MEMBERS.length) return refuse();
		const members = list(input.workspace_members).map(text);
		const roots = paths.map((p) => p.id).sort(compare);
		if (
			new Set(roots).size !== roots.length ||
			members.length !== roots.length ||
			new Set(members).size !== members.length ||
			members.some((id) => !roots.includes(id))
		)
			return refuse();
		value.phase = "bound";
		return Object.freeze({
			workspacePackages: Object.freeze(
				paths.sort((a, b) => compare(a.manifestPath, b.manifestPath)),
			),
			rootIds: Object.freeze(roots),
		});
	});
}

/** Call again after audit; this is not an atomic filesystem/Cargo read attestation. */
export async function assertNativeInputsUnchanged(snapshot: NativeInputsSnapshot): Promise<void> {
	return guarded(async () => {
		const value = state(snapshot);
		if (value.phase !== "bound") return refuse();
		await unchanged(value);
	});
}
