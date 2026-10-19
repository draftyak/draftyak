import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import path from "node:path";

export class McpbError extends Error {
	constructor() {
		super("MCP bundle input or output refused.");
		this.name = "McpbError";
	}
}
export const refuse = () => {
	throw new McpbError();
};
// A throwing numeric-fd close may already have taken effect. Never retry it.
let ownershipUncertain = false;
function requireFileOwnership() {
	if (ownershipUncertain) refuse();
}
const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
function component(value) {
	if (
		!value ||
		value.length > 128 ||
		value === "." ||
		value === ".." ||
		/[<>:"|?*~\p{Cc}\p{Cf}]/u.test(value) ||
		/[. ]$/.test(value) ||
		reserved.test(value)
	)
		refuse();
}
export function absolutePath(raw) {
	if (
		typeof raw !== "string" ||
		!raw.isWellFormed() ||
		raw.length > 4096 ||
		!path.isAbsolute(raw) ||
		path.resolve(raw) !== raw ||
		/^[/\\]{2}/.test(raw)
	)
		refuse();
	for (const part of raw.slice(path.parse(raw).root.length).split(path.sep)) component(part);
	return raw;
}
export function artifactPath(raw) {
	if (typeof raw !== "string" || raw.length > 512 || raw.includes("\\")) refuse();
	const parts = raw.split("/");
	if (parts.length > 8 || !/\.(?:mjs|js)$/.test(raw)) refuse();
	for (const part of parts) {
		component(part);
		if (!/^[A-Za-z0-9_@][A-Za-z0-9_.@-]*$/.test(part)) refuse();
	}
	return raw;
}
/** One portable spelling and one role per case-insensitive file/directory prefix. */
export function portableTree(names) {
	if (names.length > 130) refuse();
	const prefixes = new Map();
	for (const name of names) {
		if (
			typeof name !== "string" ||
			name.length > 512 ||
			!/^[A-Za-z0-9_@][A-Za-z0-9_@./-]*$/.test(name)
		)
			refuse();
		const parts = name.split("/");
		if (parts.length > 10) refuse();
		let prefix = "";
		for (const [at, part] of parts.entries()) {
			component(part);
			prefix = prefix ? `${prefix}/${part}` : part;
			const key = prefix.toLowerCase(),
				file = at === parts.length - 1,
				prior = prefixes.get(key);
			if (prior && (prior.name !== prefix || prior.file || file)) refuse();
			prefixes.set(key, { name: prefix, file });
		}
	}
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;
function directoryChain(directory) {
	const root = path.parse(directory).root,
		parts = directory.slice(root.length).split(path.sep).filter(Boolean);
	let current = root;
	return [root, ...parts.map((part) => (current = path.join(current, part)))].map((name) => {
		const stat = lstatSync(name, { bigint: true });
		if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(name) !== name)
			refuse();
		return { name, stat };
	});
}
function recheckChain(chain) {
	for (const { name, stat } of chain) {
		const next = lstatSync(name, { bigint: true });
		if (
			!next.isDirectory() ||
			next.isSymbolicLink() ||
			!same(stat, next) ||
			realpathSync.native(name) !== name
		)
			refuse();
	}
}
function regular(stat) {
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.ino === 0n) refuse();
}
/** Explicit bounded regular-file snapshot; no recursive discovery or link following. */
export function readLocalFile(raw, maximum, expectedSize) {
	requireFileOwnership();
	let fd,
		result,
		failed = false;
	try {
		const name = absolutePath(raw),
			chain = directoryChain(path.dirname(name)),
			before = lstatSync(name, { bigint: true });
		regular(before);
		if (
			before.size < 1n ||
			before.size > BigInt(maximum) ||
			(expectedSize !== undefined && before.size !== BigInt(expectedSize)) ||
			realpathSync.native(name) !== name
		)
			refuse();
		requireFileOwnership();
		fd = openSync(
			name,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
		const opened = fstatSync(fd, { bigint: true });
		regular(opened);
		if (
			!same(before, opened) ||
			before.size !== opened.size ||
			before.mtimeNs !== opened.mtimeNs ||
			before.ctimeNs !== opened.ctimeNs
		)
			refuse();
		const bytes = Buffer.alloc(Number(before.size) + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (!count) break;
			length += count;
		}
		const after = fstatSync(fd, { bigint: true }),
			named = lstatSync(name, { bigint: true });
		regular(after);
		regular(named);
		recheckChain(chain);
		if (
			!same(opened, after) ||
			!same(after, named) ||
			after.size !== before.size ||
			after.mtimeNs !== before.mtimeNs ||
			after.ctimeNs !== before.ctimeNs ||
			length !== Number(before.size) ||
			realpathSync.native(name) !== name
		)
			refuse();
		result = bytes.subarray(0, length);
	} catch {
		failed = true;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				ownershipUncertain = true;
				failed = true;
			}
		}
	}
	if (failed) throw new McpbError();
	return result;
}
/** Exclusive output, never overwrites an existing file and never removes a directory. */
export function writeLocalBundle(raw, bytes) {
	requireFileOwnership();
	let fd,
		created,
		target,
		chain,
		failed = false;
	try {
		target = absolutePath(raw);
		if (!/\.mcpb$/.test(path.basename(target))) refuse();
		chain = directoryChain(path.dirname(target));
		requireFileOwnership();
		fd = openSync(
			target,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		created = fstatSync(fd, { bigint: true });
		regular(created);
		let offset = 0;
		while (offset < bytes.length) {
			const count = writeSync(fd, bytes, offset, bytes.length - offset);
			if (count < 1) refuse();
			offset += count;
		}
		fsyncSync(fd);
		const after = fstatSync(fd, { bigint: true }),
			named = lstatSync(target, { bigint: true });
		regular(after);
		regular(named);
		recheckChain(chain);
		if (
			!same(created, after) ||
			!same(after, named) ||
			after.size !== BigInt(bytes.length) ||
			realpathSync.native(target) !== target
		)
			refuse();
	} catch {
		// Cleanup only the exact inode this invocation created, never a replacement or parent.
		if (created && target && chain) {
			try {
				recheckChain(chain);
				const named = lstatSync(target, { bigint: true });
				if (
					named.isFile() &&
					!named.isSymbolicLink() &&
					same(named, created) &&
					realpathSync.native(target) === target
				)
					unlinkSync(target);
			} catch {
				/* An unprovable partial output is retained. */
			}
		}
		failed = true;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				ownershipUncertain = true;
				failed = true;
			}
		}
	}
	if (failed) throw new McpbError();
}
