import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import path from "node:path";
import { isProxy } from "node:util/types";

export type BoundedFileCode = "path" | "file" | "bounds" | "ownership";

export class BoundedFileError extends Error {
	readonly code: BoundedFileCode;
	constructor(code: BoundedFileCode) {
		super("Bounded file operation refused.");
		this.name = "BoundedFileError";
		this.code = code;
	}
}

export interface BoundedReadOptions {
	readonly maximum: number;
	readonly minimum?: number;
	readonly expectedSize?: number;
}

const hardMaximum = 512 * 1024 * 1024;

function refuse(code: BoundedFileCode): never {
	throw new BoundedFileError(code);
}

type ResolvedBounds = {
	readonly maximum: number;
	readonly minimum: number;
	readonly expectedSize: number | undefined;
};

function bounds(options: BoundedReadOptions): ResolvedBounds {
	const values = inertRecord(options, ["maximum"], ["minimum", "expectedSize"], "bounds");
	const maximum = values.maximum;
	const minimum = values.minimum === undefined ? 0 : values.minimum;
	const expectedSize = values.expectedSize;
	if (
		typeof maximum !== "number" ||
		!Number.isSafeInteger(maximum) ||
		maximum < 1 ||
		maximum > hardMaximum ||
		typeof minimum !== "number" ||
		!Number.isSafeInteger(minimum) ||
		minimum < 0 ||
		minimum > maximum ||
		(expectedSize !== undefined &&
			(typeof expectedSize !== "number" ||
				!Number.isSafeInteger(expectedSize) ||
				expectedSize < minimum ||
				expectedSize > maximum))
	)
		refuse("bounds");
	return { maximum, minimum, expectedSize };
}

function canonicalName(raw: unknown): string {
	if (
		typeof raw !== "string" ||
		!raw.isWellFormed() ||
		raw.length > 4096 ||
		!path.isAbsolute(raw) ||
		path.resolve(raw) !== raw ||
		(process.platform === "win32" && raw.slice(/^[a-z]:\\/i.test(raw) ? 2 : 0).includes(":")) ||
		/^[/\\]{2}/.test(raw)
	)
		refuse("path");
	return raw;
}

type DirectoryChain = readonly { readonly name: string; readonly stat: BigIntStats }[];

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;
}

function directoryChain(directory: string): DirectoryChain {
	const root = path.parse(directory).root;
	let current = root;
	const names = [
		root,
		...directory
			.slice(root.length)
			.split(path.sep)
			.filter(Boolean)
			.map((part) => (current = path.join(current, part))),
	];
	return names.map((name) => {
		const stat = lstatSync(name, { bigint: true });
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.ino === 0n ||
			realpathSync.native(name) !== name
		)
			refuse("path");
		return { name, stat };
	});
}

function recheckChain(chain: DirectoryChain): void {
	for (const { name, stat } of chain) {
		const next = lstatSync(name, { bigint: true });
		if (
			!next.isDirectory() ||
			next.isSymbolicLink() ||
			!sameIdentity(stat, next) ||
			realpathSync.native(name) !== name
		)
			refuse("path");
	}
}

function regular(stat: BigIntStats): void {
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.ino === 0n)
		refuse("file");
}

function sameSnapshot(a: BigIntStats, b: BigIntStats): boolean {
	return (
		sameIdentity(a, b) &&
		a.nlink === b.nlink &&
		a.mode === b.mode &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs
	);
}

/** Read one bounded canonical regular-file snapshot; no discovery, retries or link following. */
export function readBoundedRegularFile(raw: unknown, options: BoundedReadOptions): Buffer {
	let fd: number | undefined;
	let result: Buffer | undefined;
	let failure: BoundedFileError | undefined;
	try {
		const { maximum, minimum, expectedSize } = bounds(options);
		const name = canonicalName(raw),
			chain = directoryChain(path.dirname(name));
		const before = lstatSync(name, { bigint: true });
		regular(before);
		if (
			before.size < BigInt(minimum) ||
			before.size > BigInt(maximum) ||
			(expectedSize !== undefined && before.size !== BigInt(expectedSize))
		)
			refuse("file");
		if (realpathSync.native(name) !== name) refuse("path");
		fd = openSync(
			name,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
		const opened = fstatSync(fd, { bigint: true });
		regular(opened);
		if (!sameSnapshot(before, opened)) refuse("file");
		const bytes = Buffer.alloc(Number(opened.size));
		let offset = 0;
		while (offset < bytes.length) {
			const wanted = Math.min(64 * 1024, bytes.length - offset);
			const count = readSync(fd, bytes, offset, wanted, offset);
			if (!Number.isSafeInteger(count) || count < 1 || count > wanted) refuse("file");
			offset += count;
		}
		if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) refuse("file");
		const after = fstatSync(fd, { bigint: true }),
			named = lstatSync(name, { bigint: true });
		regular(after);
		regular(named);
		recheckChain(chain);
		if (!sameSnapshot(opened, after) || !sameSnapshot(after, named)) refuse("file");
		if (realpathSync.native(name) !== name) refuse("path");
		result = bytes;
	} catch (error) {
		failure = error instanceof BoundedFileError ? error : new BoundedFileError("file");
	} finally {
		if (fd !== undefined) {
			const closing = fd;
			fd = undefined;
			try {
				closeSync(closing);
			} catch {
				failure = new BoundedFileError("ownership");
			}
		}
	}
	if (failure) throw failure;
	if (result === undefined) refuse("file");
	return result;
}

function inertRecord(
	raw: unknown,
	required: readonly string[],
	optional: readonly string[],
	code: BoundedFileCode,
): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) refuse(code);
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== Object.prototype && prototype !== null) refuse(code);
	const keys = Reflect.ownKeys(raw);
	if (keys.length < required.length || keys.length > required.length + optional.length)
		refuse(code);
	const result = Object.create(null) as Record<string, unknown>;
	for (const key of keys) {
		if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
			refuse(code);
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refuse(code);
		result[key] = descriptor.value;
	}
	for (const key of required) if (!Object.hasOwn(result, key)) refuse(code);
	return result;
}

function positiveLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate portable syntax only; preserve the caller's spelling and selection policy. */
export function portableRelativePath(
	raw: unknown,
	options: Readonly<{
		maximumLength: number;
		maximumComponents: number;
		maximumComponentLength: number;
	}>,
): string {
	const limits = inertRecord(
		options,
		["maximumLength", "maximumComponents", "maximumComponentLength"],
		[],
		"bounds",
	);
	const { maximumLength, maximumComponents, maximumComponentLength } = limits;
	if (
		!positiveLimit(maximumLength) ||
		!positiveLimit(maximumComponents) ||
		!positiveLimit(maximumComponentLength)
	)
		refuse("bounds");
	if (
		typeof raw !== "string" ||
		!raw.isWellFormed() ||
		raw.length === 0 ||
		raw.length > maximumLength ||
		raw.startsWith("/") ||
		/[\p{Cc}\p{Cf}<>:"\\|?*~]/u.test(raw)
	)
		refuse("path");
	const components = raw.split("/");
	if (components.length > maximumComponents) refuse("path");
	for (const component of components) {
		if (
			component.length === 0 ||
			component.length > maximumComponentLength ||
			component === "." ||
			component === ".." ||
			/[. ]$/.test(component) ||
			/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(component)
		)
			refuse("path");
	}
	return raw;
}

/** Check already validated file names without sorting them or invoking caller hooks. */
export function assertPortableFileTree(alreadyCheckedPaths: readonly string[]): void {
	if (
		typeof alreadyCheckedPaths !== "object" ||
		alreadyCheckedPaths === null ||
		isProxy(alreadyCheckedPaths)
	)
		refuse("path");
	if (
		!Array.isArray(alreadyCheckedPaths) ||
		Object.getPrototypeOf(alreadyCheckedPaths) !== Array.prototype
	)
		refuse("path");
	const length = Object.getOwnPropertyDescriptor(alreadyCheckedPaths, "length")?.value;
	if (typeof length !== "number" || Reflect.ownKeys(alreadyCheckedPaths).length !== length + 1)
		refuse("path");
	const seen = new Map<string, { spelling: string; file: boolean }>();
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(alreadyCheckedPaths, String(index));
		if (
			!descriptor ||
			!("value" in descriptor) ||
			!descriptor.enumerable ||
			typeof descriptor.value !== "string"
		)
			refuse("path");
		const components = descriptor.value.split("/");
		let spelling = "";
		for (let part = 0; part < components.length; part++) {
			spelling += (part ? "/" : "") + components[part];
			const key = spelling.toLowerCase();
			const file = part === components.length - 1;
			const previous = seen.get(key);
			if (previous && (previous.spelling !== spelling || previous.file || file)) refuse("path");
			if (!previous) seen.set(key, { spelling, file });
		}
	}
}

/** Admit exactly one inert file metadata record; path syntax and hashes of bytes remain local. */
export function checkedFileRecord(
	raw: unknown,
	options: Readonly<{ byteField: "bytes" | "size"; minimum: number; maximum: number }>,
): Readonly<{ path: string; sha256: string; byteLength: number }> {
	const limits = inertRecord(options, ["byteField", "minimum", "maximum"], [], "bounds");
	const { byteField, minimum, maximum } = limits;
	if (
		(byteField !== "bytes" && byteField !== "size") ||
		typeof minimum !== "number" ||
		typeof maximum !== "number" ||
		!Number.isSafeInteger(minimum) ||
		!Number.isSafeInteger(maximum) ||
		minimum < 0 ||
		maximum < minimum ||
		maximum > hardMaximum
	)
		refuse("bounds");
	const record = inertRecord(raw, ["path", "sha256", byteField], [], "file");
	const name = record.path,
		digest = record.sha256,
		size = record[byteField];
	if (
		typeof name !== "string" ||
		!name.isWellFormed() ||
		typeof digest !== "string" ||
		digest.length !== 64 ||
		!/^[0-9a-f]{64}$/.test(digest) ||
		typeof size !== "number" ||
		!Number.isSafeInteger(size) ||
		size < minimum ||
		size > maximum
	)
		refuse("file");
	return Object.freeze({ path: name, sha256: digest, byteLength: size });
}
