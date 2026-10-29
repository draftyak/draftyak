import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	opendirSync,
	openSync,
	realpathSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import path from "node:path";
import { isProxy } from "node:util/types";
import { readBoundedRegularFile } from "@draftyak/bounded-files";

const GENERIC_REFUSAL = "MCP bundle input or output refused.";
/** @type {WeakMap<object, string>} */
const diagnostics = new WeakMap();
export class McpbError extends Error {
	constructor() {
		super(GENERIC_REFUSAL);
		this.name = "McpbError";
	}
}
/** @param {unknown} error */
function classifiedMessage(error) {
	return error !== null && (typeof error === "object" || typeof error === "function")
		? diagnostics.get(error)
		: undefined;
}
/** @param {unknown} error */
export function diagnosticMessage(error) {
	return classifiedMessage(error) ?? GENERIC_REFUSAL;
}
/** @param {unknown} error */
export function wrapMcpbError(error) {
	return classifiedMessage(error) === undefined
		? new McpbError()
		: /** @type {McpbError} */ (error);
}
/** @param {"path" | "plan" | "artifact" | "output-exists" | "output-folder"} [reason]
 * @param {number} [artifactNumber]
 * @returns {never}
 */
export function refuse(reason, artifactNumber) {
	const error = new McpbError();
	let message;
	switch (reason) {
		case "path":
			message = "MCP bundle path is not a canonical absolute path.";
			break;
		case "plan":
			message = "MCP bundle plan must be strict UTF-8 JSON without a BOM.";
			break;
		case "output-exists":
			message = "MCP bundle output already exists.";
			break;
		case "output-folder":
			message = "MCP bundle output folder is not canonical.";
			break;
		case "artifact":
			if (
				typeof artifactNumber === "number" &&
				Number.isSafeInteger(artifactNumber) &&
				artifactNumber >= 1 &&
				artifactNumber <= 128
			)
				message = `MCP bundle artifact ${artifactNumber} failed its size, hash, encoding or read check.`;
	}
	if (message !== undefined) diagnostics.set(error, message);
	throw error;
}
// A throwing numeric-fd close may already have taken effect. Never retry it.
let writerOwnershipUncertain = false;
function requireWriterOwnership() {
	if (writerOwnershipUncertain) refuse();
}
const reserved = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
/** @param {string} value */
function component(value) {
	if (
		!value ||
		value.length > 128 ||
		value === "." ||
		value === ".." ||
		/^\.env/i.test(value) ||
		/[<>:"|?*~\p{Cc}\p{Cf}]/u.test(value) ||
		/[. ]$/.test(value) ||
		reserved.test(value)
	)
		refuse();
}
/** @param {unknown} raw */
export function absolutePath(raw) {
	try {
		if (
			typeof raw !== "string" ||
			!raw.isWellFormed() ||
			raw.length > 4096 ||
			/^\/(?:dev|proc|sys)(?:\/|$)/.test(raw) ||
			!path.isAbsolute(raw) ||
			path.resolve(raw) !== raw ||
			/^[/\\]{2}/.test(raw)
		)
			refuse();
		for (const part of raw.slice(path.parse(raw).root.length).split(path.sep)) component(part);
		return raw;
	} catch {
		refuse("path");
	}
}
/** @param {unknown} raw */
export function bundleOutputPath(raw) {
	const target = absolutePath(raw);
	if (!/\.mcpb$/.test(path.basename(target))) refuse("path");
	return target;
}
/** @param {unknown} raw */
function payloadPath(raw) {
	if (typeof raw !== "string" || raw.length > 512 || raw.includes("\\")) refuse();
	const parts = raw.split("/");
	if (parts.length > 8) refuse();
	for (const part of parts) {
		component(part);
		if (!/^[A-Za-z0-9_@][A-Za-z0-9_.@-]*$/.test(part)) refuse();
	}
	return raw;
}
/** @param {unknown} raw */
export function artifactPath(raw) {
	const name = payloadPath(raw);
	if (!/\.(?:mjs|js|d\.(?:ts|mts))$/.test(name) && path.posix.basename(name) !== "package.json")
		refuse();
	return name;
}
/** @param {unknown} raw */
export function emptyDirectoryPath(raw) {
	return payloadPath(raw);
}
/** One portable spelling and one role per case-insensitive file/directory prefix.
 * @param {readonly string[]} names
 */
export function portableTree(names) {
	if (names.length > 133) refuse();
	const prefixes = new Map();
	for (const name of names) {
		if (
			typeof name !== "string" ||
			name.length > 512 ||
			!/^[A-Za-z0-9_@][A-Za-z0-9_@./-]*$/.test(name)
		)
			refuse();
		const directory = name.endsWith("/"),
			parts = (directory ? name.slice(0, -1) : name).split("/");
		if (parts.length > 10) refuse();
		let prefix = "";
		for (const [at, part] of parts.entries()) {
			component(part);
			prefix = prefix ? `${prefix}/${part}` : part;
			const key = prefix.toLowerCase(),
				file = !directory && at === parts.length - 1,
				prior = prefixes.get(key);
			if (prior && (prior.name !== prefix || prior.file || file)) refuse();
			prefixes.set(key, { name: prefix, file });
		}
	}
}
/** @param {import("node:fs").BigIntStats} a @param {import("node:fs").BigIntStats} b */
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;
/** @param {string} directory */
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
/** @param {ReturnType<typeof directoryChain>} chain */
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
/** Capture only an explicitly reviewed empty directory, with bounded enumeration.
 * @param {unknown} raw
 */
export function snapshotEmptyDirectory(raw) {
	const chain = directoryChain(absolutePath(raw)),
		target = chain.at(-1);
	if (!target) refuse();
	const check = () => {
		/** @type {import("node:fs").Dir | undefined} */
		let directory;
		/** @type {McpbError | undefined} */
		let failure;
		try {
			recheckChain(chain);
			directory = opendirSync(target.name, { bufferSize: 1 });
			recheckChain(chain);
			if (directory.readSync() !== null) refuse();
		} catch (error) {
			failure = wrapMcpbError(error);
		} finally {
			if (directory !== undefined) {
				const closing = directory;
				directory = undefined;
				try {
					closing.closeSync();
				} catch {
					failure = new McpbError();
				}
			}
		}
		if (failure) throw failure;
		try {
			recheckChain(chain);
			const after = lstatSync(target.name, { bigint: true });
			if (
				!after.isDirectory() ||
				after.isSymbolicLink() ||
				!same(target.stat, after) ||
				after.size !== target.stat.size ||
				after.mtimeNs !== target.stat.mtimeNs ||
				after.ctimeNs !== target.stat.ctimeNs
			)
				refuse();
		} catch (error) {
			throw wrapMcpbError(error);
		}
	};
	check();
	return check;
}
/** @param {import("node:fs").BigIntStats} stat */
function regular(stat) {
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.ino === 0n) refuse();
}
/** Explicit bounded regular-file snapshot; no recursive discovery or link following.
 * @param {unknown} raw
 * @param {number} maximum
 * @param {number} [expectedSize]
 */
export function readLocalFile(raw, maximum, expectedSize) {
	try {
		return readBoundedRegularFile(absolutePath(raw), { minimum: 1, maximum, expectedSize });
	} catch (error) {
		throw wrapMcpbError(error);
	}
}
/** @param {number} fd */
function closeOwned(fd) {
	try {
		closeSync(fd);
	} catch {
		writerOwnershipUncertain = true;
		refuse();
	}
}
/** @param {string} scratch @param {import("node:fs").BigIntStats} created @param {ReturnType<typeof directoryChain>} chain */
function unlinkOwnedScratch(scratch, created, chain) {
	recheckChain(chain);
	const named = lstatSync(scratch, { bigint: true });
	if (
		!named.isFile() ||
		named.isSymbolicLink() ||
		!same(named, created) ||
		realpathSync.native(scratch) !== scratch
	)
		refuse();
	unlinkSync(scratch);
}
/** @param {ReturnType<typeof directoryChain>} chain */
function syncDirectory(chain) {
	if (process.platform === "win32") return;
	const parent = chain.at(-1);
	if (!parent) refuse();
	recheckChain(chain);
	requireWriterOwnership();
	const fd = openSync(
		parent.name,
		constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
	);
	try {
		const opened = fstatSync(fd, { bigint: true });
		if (!opened.isDirectory() || !same(opened, parent.stat)) refuse();
		recheckChain(chain);
		fsyncSync(fd);
	} finally {
		closeOwned(fd);
	}
}
/** Publish complete synced bytes without overwriting; cleanup touches only the owned scratch.
 * @param {unknown} raw
 * @param {Buffer} bytes
 */
export function writeLocalBundle(raw, bytes) {
	requireWriterOwnership();
	let fd,
		created,
		scratch,
		chain,
		failed = false,
		failure = new McpbError();
	try {
		const target = bundleOutputPath(raw);
		try {
			chain = directoryChain(path.dirname(target));
		} catch {
			refuse("output-folder");
		}
		scratch = path.join(path.dirname(target), `.draftyak-mcpb-${randomUUID()}.tmp`);
		requireWriterOwnership();
		fd = openSync(
			scratch,
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
			named = lstatSync(scratch, { bigint: true });
		regular(after);
		regular(named);
		recheckChain(chain);
		if (
			!same(created, after) ||
			!same(after, named) ||
			after.size !== BigInt(bytes.length) ||
			realpathSync.native(scratch) !== scratch
		)
			refuse();
		const closing = fd;
		fd = undefined;
		closeOwned(closing);
		recheckChain(chain);
		const ready = lstatSync(scratch, { bigint: true });
		regular(ready);
		if (
			!same(created, ready) ||
			ready.size !== BigInt(bytes.length) ||
			realpathSync.native(scratch) !== scratch
		)
			refuse();
		requireWriterOwnership();
		try {
			linkSync(scratch, target);
		} catch (error) {
			if (error !== null && typeof error === "object" && !isProxy(error)) {
				const code = Object.getOwnPropertyDescriptor(error, "code");
				if (code && Object.hasOwn(code, "value") && code.value === "EEXIST")
					refuse("output-exists");
			}
			throw wrapMcpbError(error);
		}
		recheckChain(chain);
		const published = lstatSync(target, { bigint: true });
		if (
			!published.isFile() ||
			published.isSymbolicLink() ||
			!same(created, published) ||
			published.size !== BigInt(bytes.length) ||
			published.nlink !== 2n ||
			realpathSync.native(target) !== target
		)
			refuse();
		unlinkOwnedScratch(scratch, created, chain);
		scratch = undefined;
		syncDirectory(chain);
	} catch (error) {
		failed = true;
		failure = wrapMcpbError(error);
	} finally {
		if (fd !== undefined) {
			const closing = fd;
			fd = undefined;
			try {
				closeOwned(closing);
			} catch {
				failed = true;
				failure = new McpbError();
			}
		}
		if (scratch && created && chain && !writerOwnershipUncertain) {
			try {
				unlinkOwnedScratch(scratch, created, chain);
			} catch {
				// Unprovable scratch ownership is retained; the final path is never removed.
				failed = true;
				failure = new McpbError();
			}
		}
	}
	if (failed) throw failure;
}
