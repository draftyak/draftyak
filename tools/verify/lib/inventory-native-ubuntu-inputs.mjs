import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { createGunzip } from "node:zlib";

const cache = path.resolve(import.meta.dirname, "..", ".cache", "inventory-native");
const provenance = path.join(cache, "ubuntu-provenance");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAX_RELEASE = 2 * 1024 * 1024;
const MAX_PACKAGES = 128 * 1024 * 1024;
const MAX_DEB = 256 * 1024 * 1024;
const MAX_TAR = 256 * 1024 * 1024;
const ownRefusalCodes = new WeakMap();
const ownSystemPermissionContexts = new WeakMap();
const INVENTORY_UBUNTU_PERMISSION_ROLES = new Set([
	"os-metadata",
	"dpkg-executable",
	"dpkg-query-executable",
	"dpkg-deb-executable",
	"gpgv-executable",
	"xz-executable",
	"package-metadata",
	"archive-keyring",
	"compiler",
	"compiler-program-directory",
	"compiler-subprogram",
	"include-directory",
	"linker-input",
	"public-header",
	"cxx-header",
	"selected-file-recheck",
	"os-metadata-recheck",
	"archive-keyring-recheck",
]);
const INVENTORY_UBUNTU_REFUSAL_CODES = new Set([
	"ubuntu-acquisition-already-active",
	"ubuntu-acquisition-options",
	"ubuntu-bootstrap-lock-release",
	"ubuntu-cache-alias",
	"ubuntu-cache-bootstrap-parent-changed",
	"ubuntu-cache-bootstrap-unconfirmed",
	"ubuntu-cache-bootstrap-unqualified",
	"ubuntu-cache-cleanup-exclusivity",
	"ubuntu-cache-close",
	"ubuntu-cache-directory",
	"ubuntu-cache-existing-kind-or-link",
	"ubuntu-cache-existing-mismatch",
	"ubuntu-cache-lock-changed",
	"ubuntu-cache-lock-unqualified",
	"ubuntu-cache-path",
	"ubuntu-cache-prior-publication-changed",
	"ubuntu-cache-repository-alias",
	"ubuntu-cache-repository-changed",
	"ubuntu-cache-repository-owner",
	"ubuntu-cache-sync",
	"ubuntu-compiler-changed",
	"ubuntu-compiler-include-bound",
	"ubuntu-compiler-include-path",
	"ubuntu-compiler-include-search",
	"ubuntu-compiler-includes-unavailable",
	"ubuntu-compiler-link-input",
	"ubuntu-compiler-program-name",
	"ubuntu-compiler-program-path",
	"ubuntu-compiler-program-search",
	"ubuntu-compiler-program-unavailable",
	"ubuntu-compiler-target",
	"ubuntu-control-bound",
	"ubuntu-control-character",
	"ubuntu-control-duplicate-field",
	"ubuntu-control-field",
	"ubuntu-control-line",
	"ubuntu-control-line-bound",
	"ubuntu-control-orphan-continuation",
	"ubuntu-cross-sysroot-refused",
	"ubuntu-deb-checksum",
	"ubuntu-deb-size",
	"ubuntu-deb-tar-bounds",
	"ubuntu-deb-tar-checksum",
	"ubuntu-deb-tar-dangling-metadata",
	"ubuntu-deb-tar-duplicate-longlink",
	"ubuntu-deb-tar-duplicate-longname",
	"ubuntu-deb-tar-format-unsupported",
	"ubuntu-deb-tar-global-pax-unsupported",
	"ubuntu-deb-tar-header-bounds",
	"ubuntu-deb-tar-link-metadata",
	"ubuntu-deb-tar-longname-bounds",
	"ubuntu-deb-tar-longname-format",
	"ubuntu-deb-tar-member-duplicate",
	"ubuntu-deb-tar-member-missing",
	"ubuntu-deb-tar-member-not-regular",
	"ubuntu-deb-tar-metadata-count",
	"ubuntu-deb-tar-metadata-mix-unsupported",
	"ubuntu-deb-tar-number",
	"ubuntu-deb-tar-number-bounds",
	"ubuntu-deb-tar-path",
	"ubuntu-deb-tar-pax-bounds",
	"ubuntu-deb-tar-pax-count",
	"ubuntu-deb-tar-pax-duplicate",
	"ubuntu-deb-tar-pax-encoding-unsupported",
	"ubuntu-deb-tar-pax-name-bounds",
	"ubuntu-deb-tar-pax-record",
	"ubuntu-deb-tar-pax-size",
	"ubuntu-deb-tar-pax-size-bounds",
	"ubuntu-deb-tar-pax-unsupported",
	"ubuntu-deb-tar-payload-bounds",
	"ubuntu-deb-tar-special-size-unsupported",
	"ubuntu-deb-tar-star-unsupported",
	"ubuntu-deb-tar-string-padding",
	"ubuntu-deb-tar-targets",
	"ubuntu-deb-tar-terminator-missing",
	"ubuntu-deb-tar-text",
	"ubuntu-deb-tar-trailing-data",
	"ubuntu-deb-tar-type-unsupported",
	"ubuntu-decimal-bound",
	"ubuntu-decimal-field",
	"ubuntu-download-buffer",
	"ubuntu-download-content-encoding",
	"ubuntu-download-content-length",
	"ubuntu-download-create",
	"ubuntu-download-headers",
	"ubuntu-download-limit",
	"ubuntu-download-network",
	"ubuntu-download-origin",
	"ubuntu-download-overflow",
	"ubuntu-download-redirect-limit",
	"ubuntu-download-redirect-origin",
	"ubuntu-download-status",
	"ubuntu-download-timeout",
	"ubuntu-download-truncated",
	"ubuntu-download-url",
	"ubuntu-field-spelling",
	"ubuntu-gzip-buffer",
	"ubuntu-gzip-create",
	"ubuntu-gzip-input",
	"ubuntu-gzip-overflow",
	"ubuntu-gzip-size",
	"ubuntu-gzip-stream",
	"ubuntu-gzip-timeout",
	"ubuntu-host-architecture",
	"ubuntu-host-metadata-changed",
	"ubuntu-index-compression",
	"ubuntu-input-acquisition-refused",
	"ubuntu-input-changed",
	"ubuntu-input-close",
	"ubuntu-input-encoding",
	"ubuntu-input-owner-or-kind",
	"ubuntu-input-size",
	"ubuntu-installed-file-not-authentic-payload",
	"ubuntu-installed-package-integrity",
	"ubuntu-installed-version-not-in-signed-index",
	"ubuntu-keyring-changed",
	"ubuntu-libstdcxx-include-unavailable",
	"ubuntu-lock-release",
	"ubuntu-offline-authenticated-deb-missing",
	"ubuntu-offline-packages-missing",
	"ubuntu-offline-release-missing",
	"ubuntu-original-closure-unconfirmed",
	"ubuntu-original-file-close-unconfirmed",
	"ubuntu-original-handle-unowned",
	"ubuntu-os-command-close-unconfirmed",
	"ubuntu-os-command-pipes",
	"ubuntu-os-command-refused",
	"ubuntu-os-release-format",
	"ubuntu-package-architecture",
	"ubuntu-package-duplicate-record",
	"ubuntu-package-identity",
	"ubuntu-package-integrity-format",
	"ubuntu-package-integrity-unavailable",
	"ubuntu-package-owner-unavailable",
	"ubuntu-package-path",
	"ubuntu-package-payload-record",
	"ubuntu-package-record-conflict",
	"ubuntu-package-stanza-bound",
	"ubuntu-package-state",
	"ubuntu-packages-checksum",
	"ubuntu-packages-compressed-checksum",
	"ubuntu-packages-compressed-size",
	"ubuntu-packages-empty",
	"ubuntu-packages-record-bound",
	"ubuntu-packages-size",
	"ubuntu-parser-byte-bound",
	"ubuntu-parser-control",
	"ubuntu-parser-newline",
	"ubuntu-parser-utf8",
	"ubuntu-process-input",
	"ubuntu-process-input-changed",
	"ubuntu-process-input-checksum",
	"ubuntu-publication-destination-bytes",
	"ubuntu-publication-exclusivity",
	"ubuntu-publication-output-identity",
	"ubuntu-publication-parent-changed",
	"ubuntu-publication-stage-bytes",
	"ubuntu-publication-stage-unowned",
	"ubuntu-publication-unconfirmed",
	"ubuntu-release-armor-headers",
	"ubuntu-release-checksum-bound",
	"ubuntu-release-checksum-row",
	"ubuntu-release-clear-sign-header",
	"ubuntu-release-compressed-index",
	"ubuntu-release-context",
	"ubuntu-release-context-value",
	"ubuntu-release-dash-escape",
	"ubuntu-release-expired",
	"ubuntu-release-hash-header",
	"ubuntu-release-identity",
	"ubuntu-release-multiple-signature-boundaries",
	"ubuntu-release-packages-index",
	"ubuntu-release-scope",
	"ubuntu-release-signature",
	"ubuntu-release-signature-armor-base64",
	"ubuntu-release-signature-armor-body",
	"ubuntu-release-signature-armor-data",
	"ubuntu-release-signature-armor-header",
	"ubuntu-release-signature-boundary",
	"ubuntu-release-time-bound",
	"ubuntu-release-time-calendar",
	"ubuntu-release-time-format",
	"ubuntu-required-field",
	"ubuntu-retained-publication-or-cleanup-debt",
	"ubuntu-scalar-field",
	"ubuntu-selected-input-changed",
	"ubuntu-stage-cleanup",
	"ubuntu-stage-close",
	"ubuntu-stage-ownership-changed",
	"ubuntu-stage-ownership-unqualified",
	"ubuntu-stage-size",
	"ubuntu-system-kind",
	"ubuntu-system-owner",
	"ubuntu-system-parent-kind",
	"ubuntu-system-path",
	"ubuntu-system-permissions",
	"ubuntu-unsupported-distribution",
	"ubuntu-unsupported-host",
]);

class Refusal extends Error {
	constructor(code, additional = []) {
		const failures = [...new Set([code, ...additional])].slice(0, 16);
		super(failures.join(";"));
		this.name = "InventoryUbuntuInputRefusal";
		this.code = code;
		this.failures = failures;
		this.stack = `${this.name}: ${this.message}`;
	}
}
function issueRefusal(code, additional = []) {
	const error = new Refusal(code, additional);
	ownRefusalCodes.set(error, code);
	return error;
}

/** @returns {boolean} */
export function isInventoryUbuntuRefusalCode(value) {
	return typeof value === "string" && INVENTORY_UBUNTU_REFUSAL_CODES.has(value);
}

/** @returns {string | undefined} */
export function getInventoryUbuntuRefusalCode(error) {
	const code = ownRefusalCodes.get(error);
	return isInventoryUbuntuRefusalCode(code) ? code : undefined;
}

/** @returns {Readonly<{role: string, lexical: "target" | "ancestor", write: "group-write" | "other-write" | "both"}> | undefined} */
export function getInventoryUbuntuPermissionContext(error) {
	return ownSystemPermissionContexts.get(error);
}

function requireLexicalSystemPermissions(mode, callerRole, lexicalTarget) {
	try {
		need((mode & 0o022) === 0, "ubuntu-system-permissions");
	} catch (error) {
		if (
			ownRefusalCodes.get(error) === "ubuntu-system-permissions" &&
			typeof callerRole === "string" &&
			INVENTORY_UBUNTU_PERMISSION_ROLES.has(callerRole) &&
			typeof lexicalTarget === "boolean" &&
			Number.isInteger(mode) &&
			mode >= 0 &&
			mode <= 0xffffffff
		) {
			const groupWrite = (mode & 0o020) !== 0;
			const otherWrite = (mode & 0o002) !== 0;
			const write =
				groupWrite && otherWrite
					? "both"
					: groupWrite
						? "group-write"
						: otherWrite
							? "other-write"
							: undefined;
			if (write !== undefined) {
				ownSystemPermissionContexts.set(
					error,
					Object.freeze({
						role: callerRole,
						lexical: lexicalTarget ? "target" : "ancestor",
						write,
					}),
				);
			}
		}
		throw error;
	}
}

const need = (condition, code) => {
	if (!condition) throw issueRefusal(code);
};
let activeOperation;

function fixedFailure(error) {
	return error instanceof Refusal ? error : issueRefusal("ubuntu-input-acquisition-refused");
}

function combinedFailure(primary, code) {
	const first = primary ? fixedFailure(primary) : issueRefusal(code);
	const result = new Refusal(first.code, [...first.failures, code]);
	const ownCode = ownRefusalCodes.get(first);
	if (ownCode !== undefined) ownRefusalCodes.set(result, ownCode);
	const permissionContext = ownSystemPermissionContexts.get(first);
	if (ownCode === "ubuntu-system-permissions" && permissionContext !== undefined)
		ownSystemPermissionContexts.set(result, permissionContext);
	return result;
}

function ownHandle(handle) {
	activeOperation.handles.set(handle, {
		original: handle,
		closePromise: null,
		closeRejected: false,
	});
	return handle;
}

async function closeHandle(handle) {
	const record = activeOperation.handles.get(handle);
	need(record, "ubuntu-original-handle-unowned");
	try {
		record.closePromise = handle.close();
		await record.closePromise;
		activeOperation.handles.delete(handle);
	} catch {
		// Keep the SAME original, its close promise and the admission lock. A
		// rejected close is neither a close receipt nor permission to retry/reset.
		record.closeRejected = true;
		activeOperation.retained = true;
		throw issueRefusal("ubuntu-original-file-close-unconfirmed");
	}
}

// Acquisition is explicit. This module performs no I/O or subprocess work at import.

function decodeUtf8(bytes) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw issueRefusal("ubuntu-input-encoding");
	}
}

function sameFile(a, b) {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs
	);
}

async function ownedSystem(file, directory = false, callerRole) {
	need(path.isAbsolute(file) && !file.includes("\0"), "ubuntu-system-path");
	// Check lexical ancestors as well as the resolved target. System symlinks such
	// as merged-/usr and the selected g++ alias remain part of the installed OS.
	for (let current = file; ; current = path.dirname(current)) {
		const entry = await lstat(current);
		need(entry.uid === 0, "ubuntu-system-owner");
		if (!entry.isSymbolicLink())
			requireLexicalSystemPermissions(entry.mode, callerRole, current === file);
		if (path.dirname(current) === current) break;
	}
	const canonical = await realpath(file);
	for (let current = canonical; ; current = path.dirname(current)) {
		const entry = await lstat(current);
		need(
			entry.uid === 0 && !entry.isSymbolicLink() && (entry.mode & 0o022) === 0,
			"ubuntu-system-owner",
		);
		if (current === canonical)
			need(directory ? entry.isDirectory() : entry.isFile(), "ubuntu-system-kind");
		else need(entry.isDirectory(), "ubuntu-system-parent-kind");
		if (path.dirname(current) === current) break;
	}
	return canonical;
}

async function readStableRecord(file, limit, owner, expectedIdentity) {
	let handle, bytes, identity, failure;
	try {
		handle = ownHandle(await open(file, constants.O_RDONLY | constants.O_NOFOLLOW));
		const before = await handle.stat({ bigint: true });
		need(
			before.isFile() && before.uid === BigInt(owner) && (before.mode & 0o022n) === 0n,
			"ubuntu-input-owner-or-kind",
		);
		if (expectedIdentity)
			for (const field of [
				"dev",
				"ino",
				"nlink",
				"uid",
				"gid",
				"mode",
				"size",
				"mtimeNs",
				"ctimeNs",
			]) {
				if (Object.hasOwn(expectedIdentity, field))
					need(before[field] === expectedIdentity[field], "ubuntu-publication-output-identity");
			}
		need(before.size >= 0n && before.size <= BigInt(limit), "ubuntu-input-size");
		const parts = [];
		let total = 0;
		for (;;) {
			const chunk = Buffer.alloc(Math.min(65536, limit - total + 1));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			total += bytesRead;
			need(total <= limit, "ubuntu-input-size");
			parts.push(chunk.subarray(0, bytesRead));
		}
		bytes = Buffer.concat(parts, total);
		const after = await handle.stat({ bigint: true });
		const named = await lstat(file, { bigint: true });
		need(
			sameFile(before, after) &&
				sameFile(after, named) &&
				before.nlink === after.nlink &&
				after.nlink === named.nlink &&
				BigInt(total) === after.size &&
				!named.isSymbolicLink(),
			"ubuntu-input-changed",
		);
		identity = after; // The original opened descriptor, never just a pathname observation.
	} catch (error) {
		failure = error;
	}
	if (handle) {
		try {
			await closeHandle(handle);
		} catch {
			failure = combinedFailure(failure, "ubuntu-input-close");
		}
	}
	if (failure) throw failure;
	return { bytes, identity };
}

async function readStable(file, limit, owner, expectedIdentity) {
	return (await readStableRecord(file, limit, owner, expectedIdentity)).bytes;
}

async function systemBytes(file, limit = MAX_DEB, callerRole) {
	const canonical = await ownedSystem(file, false, callerRole);
	return { path: canonical, bytes: await readStable(canonical, limit, 0) };
}

async function privateDirectory(directory, create = false) {
	if (create) {
		try {
			await mkdir(directory, { mode: 0o700 });
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		}
	}
	const info = await lstat(directory);
	need(
		info.isDirectory() &&
			!info.isSymbolicLink() &&
			info.uid === process.getuid() &&
			(info.mode & 0o077) === 0,
		"ubuntu-cache-directory",
	);
	need((await realpath(directory)) === directory, "ubuntu-cache-alias");
}

async function syncDirectory(directory) {
	const handle = ownHandle(
		await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
	);
	let failure;
	try {
		await handle.sync();
	} catch {
		failure = issueRefusal("ubuntu-cache-sync");
	}
	try {
		await closeHandle(handle);
	} catch {
		failure = combinedFailure(failure, "ubuntu-cache-close");
	}
	if (failure) throw failure;
}

async function exclusiveFile(file, bytes, created = () => {}) {
	const handle = ownHandle(
		await open(
			file,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		),
	);
	let identity, failure;
	const record = { path: file, identity: null, removed: false };
	// Record successful exclusive creation before any fallible stat/write/sync.
	created(record);
	try {
		identity = await handle.stat({ bigint: true });
		record.identity = identity;
		await handle.writeFile(bytes);
		await handle.sync();
		identity = await handle.stat({ bigint: true });
		need(identity.isFile() && identity.size === BigInt(bytes.length), "ubuntu-stage-size");
	} catch (error) {
		failure = error;
	}
	try {
		await closeHandle(handle);
	} catch {
		failure = combinedFailure(failure, "ubuntu-stage-close");
	}
	if (failure) throw failure;
	record.identity = identity;
	return record;
}

async function removeOwned(record) {
	need(record.identity !== null, "ubuntu-stage-ownership-unqualified");
	const named = await lstat(record.path, { bigint: true });
	need(
		!named.isSymbolicLink() &&
			named.dev === record.identity.dev &&
			named.ino === record.identity.ino,
		"ubuntu-stage-ownership-changed",
	);
	await unlink(record.path);
	record.removed = true;
}

async function assertOwnedLock(record) {
	need(record?.identity && !record.removed, "ubuntu-cache-lock-unqualified");
	const current = await lstat(record.path, { bigint: true });
	need(
		current.isFile() &&
			!current.isSymbolicLink() &&
			sameFile(current, record.identity) &&
			current.nlink === 1n &&
			current.uid === BigInt(process.getuid()) &&
			(current.mode & 0o077n) === 0n,
		"ubuntu-cache-lock-changed",
	);
}

async function assertBootstrapLock() {
	const workspace = activeOperation.workspace;
	need(workspace?.verifyIdentity, "ubuntu-cache-bootstrap-unqualified");
	need((await realpath(workspace.verify)) === workspace.verify, "ubuntu-cache-repository-alias");
	const current = await lstat(workspace.verify, { bigint: true });
	need(
		current.isDirectory() &&
			!current.isSymbolicLink() &&
			current.dev === workspace.verifyIdentity.dev &&
			current.ino === workspace.verifyIdentity.ino &&
			current.uid === workspace.verifyIdentity.uid &&
			current.mode === workspace.verifyIdentity.mode,
		"ubuntu-cache-repository-changed",
	);
	await assertOwnedLock(workspace.bootstrap);
}

async function prepareCacheNamespace() {
	const records = [path.dirname(cache), cache].map((directory) => ({
		path: directory,
		identity: null,
		created: false,
	}));
	activeOperation.workspace.cacheDirectories = records;
	try {
		let missing = false;
		// Inspect the entire reachable existing bootstrap plan before cache writes.
		for (const record of records) {
			if (missing) continue;
			try {
				await privateDirectory(record.path);
				record.identity = await lstat(record.path, { bigint: true });
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
				missing = true;
			}
		}
		for (const record of records) {
			await assertBootstrapLock();
			for (const existing of records) {
				if (existing.identity === null) continue;
				await privateDirectory(existing.path);
				const current = await lstat(existing.path, { bigint: true });
				need(
					current.dev === existing.identity.dev &&
						current.ino === existing.identity.ino &&
						current.uid === existing.identity.uid &&
						current.mode === existing.identity.mode,
					"ubuntu-cache-bootstrap-parent-changed",
				);
			}
			if (record.identity !== null) continue;
			await mkdir(record.path, { mode: 0o700 }); // Unexpected EEXIST is never adopted.
			record.created = true;
			await privateDirectory(record.path);
			record.identity = await lstat(record.path, { bigint: true });
		}
		await assertBootstrapLock();
	} catch (error) {
		activeOperation.retained = true;
		throw combinedFailure(error, "ubuntu-cache-bootstrap-unconfirmed");
	}
}

async function withWorkspace(offline, work) {
	// Only fixed repository-relative cache locations are writable. No stale lock
	// is reclaimed, and cleanup never traverses an unrecognised directory tree.
	const verify = path.dirname(path.dirname(cache));
	need((await realpath(verify)) === verify, "ubuntu-cache-repository-alias");
	for (let current = verify; ; current = path.dirname(current)) {
		const info = await lstat(current);
		need(
			info.isDirectory() &&
				!info.isSymbolicLink() &&
				(info.uid === process.getuid() || info.uid === 0) &&
				(info.mode & 0o022) === 0,
			"ubuntu-cache-repository-owner",
		);
		if (path.dirname(current) === current) break;
	}
	let bootstrap,
		lock,
		stage,
		stageCreated = false,
		stageIdentity,
		result,
		failure;
	const owned = [];
	activeOperation.workspace = {
		verify,
		verifyIdentity: await lstat(verify, { bigint: true }),
		bootstrap: null,
		cacheDirectories: [],
		owned,
		lock: null,
		stage: null,
		stageCreated: false,
		stageIdentity: null,
	};
	try {
		// Every cooperating mutating writer must use this SAME fixed namespace/version
		// bootstrap key, including namespace creation. The inner key alone is insufficient.
		bootstrap = await exclusiveFile(
			path.join(verify, ".inventory-native-ubuntu-inputs-v1.lock"),
			Buffer.from("inventory-ubuntu-inputs-bootstrap-v1\n"),
			(record) => {
				bootstrap = record;
				activeOperation.workspace.bootstrap = record;
			},
		);
		await assertBootstrapLock();
		await prepareCacheNamespace();
		lock = await exclusiveFile(
			path.join(cache, ".ubuntu-inputs.lock"),
			Buffer.from("inventory-ubuntu-inputs-v1\n"),
			(record) => {
				lock = record;
				activeOperation.workspace.lock = record;
			},
		);
		await assertOwnedLock(lock);
		stage = path.join(cache, `.ubuntu-inputs-${randomBytes(16).toString("hex")}`);
		await mkdir(stage, { mode: 0o700 });
		stageCreated = true;
		activeOperation.workspace.stage = stage;
		activeOperation.workspace.stageCreated = true;
		await privateDirectory(stage);
		stageIdentity = await lstat(stage, { bigint: true });
		activeOperation.workspace.stageIdentity = stageIdentity;
		const context = {
			offline,
			stage,
			owned,
			async stageBytes(bytes) {
				const record = await exclusiveFile(
					path.join(stage, randomBytes(16).toString("hex")),
					bytes,
					(created) => owned.push(created),
				);
				return record.path;
			},
		};
		result = await work(context);
		const current = await lstat(stage, { bigint: true });
		need(
			current.dev === stageIdentity.dev && current.ino === stageIdentity.ino,
			"ubuntu-stage-ownership-changed",
		);
	} catch (error) {
		failure = fixedFailure(error);
	}
	if (activeOperation.handles.size > 0 || activeOperation.children.size > 0) {
		activeOperation.retained = true;
		throw combinedFailure(failure, "ubuntu-original-closure-unconfirmed");
	}
	if (activeOperation.retained)
		throw combinedFailure(failure, "ubuntu-retained-publication-or-cleanup-debt");
	try {
		if (bootstrap) await assertBootstrapLock();
		if (lock) await assertOwnedLock(lock);
	} catch {
		activeOperation.retained = true;
		throw combinedFailure(failure, "ubuntu-cache-cleanup-exclusivity");
	}
	for (const record of [...owned].reverse()) {
		try {
			await removeOwned(record);
		} catch {
			failure = combinedFailure(failure, "ubuntu-stage-cleanup");
			activeOperation.retained = true;
		}
	}
	if (stageCreated && !stageIdentity) {
		failure = combinedFailure(failure, "ubuntu-stage-ownership-unqualified");
		activeOperation.retained = true;
	}
	if (stageIdentity && !activeOperation.retained) {
		try {
			const current = await lstat(stage, { bigint: true });
			need(
				current.dev === stageIdentity.dev &&
					current.ino === stageIdentity.ino &&
					!current.isSymbolicLink(),
				"ubuntu-stage-ownership-changed",
			);
			await rmdir(stage);
		} catch {
			failure = combinedFailure(failure, "ubuntu-stage-cleanup");
			activeOperation.retained = true;
		}
	}
	if (lock && !activeOperation.retained) {
		try {
			// Close the final directory descriptor BEFORE releasing admission. A
			// crash may leave a stale lock; this module never takes it over.
			await assertBootstrapLock();
			await assertOwnedLock(lock);
			await syncDirectory(cache);
			await removeOwned(lock);
		} catch {
			failure = combinedFailure(failure, "ubuntu-lock-release");
			activeOperation.retained = true;
		}
	}
	if (bootstrap && !activeOperation.retained) {
		try {
			// No fallible descriptor work follows final admission release. An already
			// removed inner lock is recorded as removed, never recreated on failure.
			await assertBootstrapLock();
			await syncDirectory(verify);
			await removeOwned(bootstrap);
		} catch {
			failure = combinedFailure(failure, "ubuntu-bootstrap-lock-release");
			activeOperation.retained = true;
		}
	}
	if (failure) throw failure;
	return result;
}

function retainProcessInput(specification) {
	if (specification === undefined) return undefined;
	const { bytes, size, sha256 } = specification;
	need(
		Buffer.isBuffer(bytes) &&
			Number.isSafeInteger(size) &&
			size > 0 &&
			size <= MAX_DEB &&
			bytes.length === size &&
			typeof sha256 === "string" &&
			/^[a-f0-9]{64}$/.test(sha256),
		"ubuntu-process-input",
	);
	const snapshot = Buffer.from(bytes);
	need(snapshot.length === size && sha(snapshot) === sha256, "ubuntu-process-input-checksum");
	return { bytes: snapshot, size, sha256 };
}

async function runSystem(
	command,
	args,
	context,
	limit = 1024 * 1024,
	inputSpecification,
	callerRole,
) {
	// Snapshot/check before the first await. Neither a staged pathname nor a
	// caller's mutable Buffer is subsequently reopened as authenticated input.
	const input = retainProcessInput(inputSpecification);
	command = await ownedSystem(command, false, callerRole);
	const child = spawn(command, args, {
		cwd: context.stage,
		shell: false,
		stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
		env: {
			PATH: "/usr/bin:/bin:/usr/sbin",
			LANG: "C",
			LC_ALL: "C",
			HOME: context.stage,
			GNUPGHOME: context.stage,
			TMPDIR: context.stage,
			TEMP: context.stage,
			TMP: context.stage,
		},
	});
	const custody = { original: child, input, closed: false, streams: [], closePromise: null };
	activeOperation.children.add(custody);
	let failed = false,
		stopping = false;
	const output = [],
		diagnostics = [];
	let outputSize = 0,
		diagnosticsSize = 0;
	let timer;
	const stop = () => {
		failed = true;
		if (stopping) return;
		stopping = true;
		try {
			child.kill("SIGKILL");
		} catch {
			/* Still join the original process and pipes. */
		}
		if (input && child.stdin) {
			try {
				child.stdin.destroy();
			} catch {
				/* Still await this original pipe's close. */
			}
		}
	};
	// Install original process custody before any fallible pipe/setup work.
	custody.closePromise = new Promise((resolve) =>
		child.once("close", (code, signal) => {
			custody.closed = true;
			resolve({ code, signal });
		}),
	);
	child.once("error", () => {
		failed = true;
	});
	try {
		const streams = [child.stdout, child.stderr, ...(input ? [child.stdin] : [])];
		for (const original of streams) {
			if (original === null || original === undefined) {
				failed = true;
				continue;
			}
			const record = {
				original,
				input: input !== undefined && original === child.stdin,
				finished: false,
				closed: false,
				closePromise: null,
			};
			custody.streams.push(record);
			record.closePromise = new Promise((resolve) =>
				original.once("close", () => {
					record.closed = true;
					if (record.input && !record.finished) stop();
					resolve();
				}),
			);
			original.once("error", stop);
			if (record.input)
				original.once("finish", () => {
					record.finished = true;
				});
		}
		need(custody.streams.length === (input ? 3 : 2), "ubuntu-os-command-pipes");
		child.stdout.on("data", (bytes) => {
			outputSize += bytes.length;
			if (outputSize > limit) stop();
			else output.push(bytes);
		});
		child.stderr.on("data", (bytes) => {
			diagnosticsSize += bytes.length;
			if (diagnosticsSize > 4 * 1024 * 1024) stop();
			else diagnostics.push(bytes);
		});
		timer = setTimeout(stop, 120000);
		if (input)
			child.stdin.end(input.bytes, (error) => {
				if (error) stop();
			});
	} catch {
		stop();
	}
	// Setup failures take this SAME join path; no workspace cleanup can overtake it.
	const terminal = await custody.closePromise;
	await Promise.all(custody.streams.map((record) => record.closePromise));
	clearTimeout(timer);
	need(
		custody.closed && custody.streams.every((record) => record.closed),
		"ubuntu-os-command-close-unconfirmed",
	);
	activeOperation.children.delete(custody);
	need(
		!failed &&
			terminal.code === 0 &&
			terminal.signal === null &&
			custody.streams.every((record) => !record.input || record.finished),
		"ubuntu-os-command-refused",
	);
	if (input)
		need(
			input.bytes.length === input.size && sha(input.bytes) === input.sha256,
			"ubuntu-process-input-changed",
		);
	// This is the exact private snapshot supplied to the original child's pipe.
	// Pipe finish is write completion; tool success and cryptographic checks are
	// separately required by each caller before these bytes are accepted.
	return { stdout: Buffer.concat(output), stderr: Buffer.concat(diagnostics), input: input?.bytes };
}

async function commandText(command, args, context, callerRole) {
	return decodeUtf8(
		(await runSystem(command, args, context, undefined, undefined, callerRole)).stdout,
	).trim();
}

async function assertPublicationParents(records) {
	await assertBootstrapLock();
	for (const record of records) {
		if (record.identity === null) continue;
		await privateDirectory(record.path);
		const now = await lstat(record.path, { bigint: true });
		need(
			now.dev === record.identity.dev &&
				now.ino === record.identity.ino &&
				now.uid === record.identity.uid &&
				now.mode === record.identity.mode,
			"ubuntu-publication-parent-changed",
		);
	}
	const workspace = activeOperation.workspace;
	need(workspace?.lock?.identity && workspace.stageIdentity, "ubuntu-publication-exclusivity");
	const lock = await lstat(workspace.lock.path, { bigint: true });
	const stage = await lstat(workspace.stage, { bigint: true });
	need(
		!lock.isSymbolicLink() &&
			lock.isFile() &&
			sameFile(lock, workspace.lock.identity) &&
			lock.nlink === 1n &&
			lock.uid === BigInt(process.getuid()) &&
			(lock.mode & 0o077n) === 0n &&
			!stage.isSymbolicLink() &&
			stage.isDirectory() &&
			stage.dev === workspace.stageIdentity.dev &&
			stage.ino === workspace.stageIdentity.ino &&
			stage.uid === workspace.stageIdentity.uid &&
			stage.mode === workspace.stageIdentity.mode,
		"ubuntu-publication-exclusivity",
	);
}

async function publish(context, file, bytes, expectedHash, expectedSize) {
	const snapshot = retainProcessInput({ bytes, size: expectedSize, sha256: expectedHash }).bytes;
	const relative = path.relative(provenance, file);
	const portable = relative.split(path.sep).join("/");
	need(
		path.join(provenance, relative) === file &&
			/^(?:packages\/[a-f0-9]{64}\.deb|[a-z]+(?:-(?:updates|security))?\/(?:InRelease|main\/binary-(?:amd64|arm64)\/Packages))$/.test(
				portable,
			),
		"ubuntu-cache-path",
	);
	const directoryPaths = [path.dirname(cache), cache, provenance];
	let directory = provenance;
	for (const segment of path
		.dirname(relative)
		.split(path.sep)
		.filter((part) => part !== ".")) {
		need(/^[A-Za-z0-9._+-]+$/.test(segment), "ubuntu-cache-path");
		directory = path.join(directory, segment);
		directoryPaths.push(directory);
	}
	const publication = {
		file,
		expectedHash,
		expectedSize,
		input: snapshot,
		directories: [],
		prior: null,
		staged: null,
		linked: false,
		verified: false,
		outputIdentity: null,
	};
	activeOperation.publications.push(publication);
	try {
		// Validate the complete lexical plan and every pre-existing component before
		// creating any publication directory/file. These observations are not a
		// physical directory lease; replacements must be refused when detected.
		let missing = false;
		for (const planned of directoryPaths) {
			const record = { path: planned, identity: null, created: false };
			publication.directories.push(record);
			if (missing) continue;
			try {
				await privateDirectory(planned);
				record.identity = await lstat(planned, { bigint: true });
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
				missing = true;
			}
		}
		try {
			publication.prior = await lstat(file, { bigint: true });
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		const earlier = activeOperation.publications.find(
			(candidate) => candidate !== publication && candidate.file === file && candidate.verified,
		);
		if (earlier)
			need(
				publication.prior &&
					earlier.outputIdentity &&
					sameFile(publication.prior, earlier.outputIdentity) &&
					publication.prior.nlink === earlier.outputIdentity.nlink,
				"ubuntu-cache-prior-publication-changed",
			);
		if (publication.prior) {
			let expectedLinks = 1n;
			if (earlier?.linked) {
				// A package can own several selected files. Until workspace cleanup,
				// its first verified publication still has its one original stage link.
				const original = earlier.staged;
				need(
					original?.identity &&
						earlier.expectedHash === expectedHash &&
						earlier.expectedSize === expectedSize,
					"ubuntu-cache-prior-publication-changed",
				);
				const stage = await lstat(original.path, { bigint: true });
				need(
					!stage.isSymbolicLink() &&
						stage.isFile() &&
						stage.dev === original.identity.dev &&
						stage.ino === original.identity.ino &&
						stage.nlink === 2n &&
						publication.prior.dev === original.identity.dev &&
						publication.prior.ino === original.identity.ino,
					"ubuntu-cache-prior-publication-changed",
				);
				expectedLinks = 2n;
			}
			need(
				!missing &&
					publication.prior.isFile() &&
					!publication.prior.isSymbolicLink() &&
					publication.prior.nlink === expectedLinks,
				"ubuntu-cache-existing-kind-or-link",
			);
			const prior = await readStable(file, expectedSize, process.getuid(), publication.prior);
			need(
				prior.length === expectedSize && sha(prior) === expectedHash && prior.equals(snapshot),
				"ubuntu-cache-existing-mismatch",
			);
		}
		await assertPublicationParents(publication.directories);
		for (const record of publication.directories) {
			if (record.identity !== null) continue;
			await assertPublicationParents(publication.directories);
			// An unexpectedly appeared component is lost exclusivity, never an
			// invitation to adopt a path selected by a concurrent writer.
			await mkdir(record.path, { mode: 0o700 });
			record.created = true;
			await privateDirectory(record.path);
			record.identity = await lstat(record.path, { bigint: true });
		}
		let expectedIdentity = publication.prior;
		if (!expectedIdentity) {
			const staged = await context.stageBytes(snapshot);
			const original = context.owned.find((record) => record.path === staged);
			need(original?.identity, "ubuntu-publication-stage-unowned");
			publication.staged = original;
			const stagedBytes = await readStable(staged, expectedSize, process.getuid(), {
				...original.identity,
				nlink: 1n,
			});
			need(
				stagedBytes.length === expectedSize &&
					sha(stagedBytes) === expectedHash &&
					stagedBytes.equals(snapshot),
				"ubuntu-publication-stage-bytes",
			);
			await assertPublicationParents(publication.directories);
			await link(staged, file); // Exclusive CAS: never overwrite or follow an output.
			publication.linked = true;
			// link intentionally changes ctime. Keep every other original field and
			// require exactly the one known stage/output pair, not an arbitrary alias.
			const { dev, ino, uid, gid, mode, size, mtimeNs } = original.identity;
			expectedIdentity = { dev, ino, uid, gid, mode, size, mtimeNs, nlink: 2n };
		}
		await syncDirectory(directory);
		await assertPublicationParents(publication.directories);
		// Authenticate the ACTUAL opened destination, not the pathname or DTO. A
		// replacement may briefly occupy a lexical name: this ordinary mechanism
		// makes no atomic-namespace or future authenticity/permission assertion.
		const actual = await readStableRecord(file, expectedSize, process.getuid(), expectedIdentity);
		need(
			actual.bytes.length === expectedSize &&
				sha(actual.bytes) === expectedHash &&
				actual.bytes.equals(snapshot),
			"ubuntu-publication-destination-bytes",
		);
		await assertPublicationParents(publication.directories);
		publication.verified = true;
		publication.outputIdentity = actual.identity;
		publication.input = undefined; // Successful publications need no retained payload copies.
	} catch (error) {
		activeOperation.retained = true;
		throw combinedFailure(error, "ubuntu-publication-unconfirmed");
	}
}

async function cached(file, limit) {
	for (let current = path.dirname(file); current !== cache; current = path.dirname(current)) {
		need(current.startsWith(cache + path.sep), "ubuntu-cache-path");
		try {
			await privateDirectory(current);
		} catch (error) {
			if (error?.code === "ENOENT") return undefined;
			throw error;
		}
	}
	try {
		return await readStable(file, limit, process.getuid());
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

function parseOsRelease(bytes) {
	const values = new Map();
	for (const line of decodeUtf8(bytes).split(/\r?\n/)) {
		if (!line || line.startsWith("#")) continue;
		const row = /^([A-Z_]+)=(?:"([^"\\]*)"|'([^'\\]*)'|([A-Za-z0-9._+-]+))$/.exec(line);
		need(row && !values.has(row[1]), "ubuntu-os-release-format");
		values.set(row[1], row[2] ?? row[3] ?? row[4]);
	}
	need(
		values.get("ID") === "ubuntu" &&
			/^[a-z]+$/.test(values.get("VERSION_CODENAME") ?? "") &&
			/^\d{2}\.\d{2}$/.test(values.get("VERSION_ID") ?? ""),
		"ubuntu-unsupported-distribution",
	);
	return { codename: values.get("VERSION_CODENAME"), version: values.get("VERSION_ID") };
}

function archiveBase(host, version, security) {
	const release = Number(version.replace(".", ""));
	// Ubuntu 25.10 moved arm64 into the main archive. Older native arm64
	// releases use the official ports archive for every pocket.
	if (host === "arm64" && release < 2510) return "https://ports.ubuntu.com/ubuntu-ports/";
	return security ? "https://security.ubuntu.com/ubuntu/" : "https://archive.ubuntu.com/ubuntu/";
}

async function installedPackage(file, context) {
	need(!/[[\]*?\0\n\r]/.test(file), "ubuntu-package-path");
	let binary;
	for (const spelling of [file, ...(file.startsWith("/usr/") ? [file.slice(4)] : [])]) {
		let answer;
		try {
			answer = await commandText(
				"/usr/bin/dpkg-query",
				["--search", spelling],
				context,
				"dpkg-query-executable",
			);
		} catch {
			continue;
		}
		const rows = answer.split("\n").filter((line) => line.endsWith(`: ${spelling}`));
		if (rows.length === 1) {
			binary = rows[0].slice(0, rows[0].lastIndexOf(": "));
			break;
		}
	}
	need(
		/^[a-z0-9][a-z0-9+.-]*(?::(?:amd64|arm64))?$/.test(binary ?? ""),
		"ubuntu-package-owner-unavailable",
	);
	const query = await commandText(
		"/usr/bin/dpkg-query",
		[
			"--show",
			"--showformat=${binary:Package}\t${Version}\t${Architecture}\t${db:Status-Status}",
			binary,
		],
		context,
		"dpkg-query-executable",
	);
	const fields = query.split("\t");
	need(
		fields.length === 4 &&
			fields[3] === "installed" &&
			/^[a-z0-9][a-z0-9+.-]*(?::(?:amd64|arm64))?$/.test(fields[0]) &&
			/^[A-Za-z0-9.+:~_-]+$/.test(fields[1]) &&
			/^(?:amd64|arm64|all)$/.test(fields[2]),
		"ubuntu-package-state",
	);
	return {
		name: fields[0].split(":")[0],
		binary: fields[0],
		version: fields[1],
		architecture: fields[2],
	};
}

async function installedIntegrity(file, context, callerRole) {
	const checked = await systemBytes(file, MAX_DEB, callerRole);
	const pkg = await installedPackage(checked.path, context);
	let database;
	for (const name of [...new Set([pkg.binary, pkg.name])]) {
		try {
			database = await systemBytes(
				`/var/lib/dpkg/info/${name}.md5sums`,
				16 * 1024 * 1024,
				"package-metadata",
			);
			break;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	need(database, "ubuntu-package-integrity-unavailable");
	const sums = new Map();
	for (const line of decodeUtf8(database.bytes).split("\n")) {
		if (!line) continue;
		const row = /^([a-f0-9]{32}) {2}([^\0\r\n]+)$/.exec(line);
		need(
			row && !row[2].startsWith("/") && !row[2].split("/").includes("..") && !sums.has(row[2]),
			"ubuntu-package-integrity-format",
		);
		sums.set(row[2], row[1]);
	}
	const names = [
		checked.path.slice(1),
		...(checked.path.startsWith("/usr/") ? [checked.path.slice(5)] : []),
	];
	const expected = names.map((name) => sums.get(name)).find((value) => value !== undefined);
	need(
		expected && createHash("md5").update(checked.bytes).digest("hex") === expected,
		"ubuntu-installed-package-integrity",
	);
	// This is installed-OS integrity only. Publisher authentication below binds
	// selected files to SHA256-qualified .deb bytes from authenticated indices.
	return { ...checked, pkg, sha256: sha(checked.bytes) };
}

async function releaseInput(context, os, architecture, suite, keyring) {
	const base = archiveBase(process.arch, os.version, suite.endsWith("-security"));
	const folder = path.join(provenance, suite);
	const releasePath = path.join(folder, "InRelease");
	let release = await cached(releasePath, MAX_RELEASE);
	if (!release) {
		need(!context.offline, "ubuntu-offline-release-missing");
		release = await fetchOfficialBytes(new URL(`dists/${suite}/InRelease`, base).href, MAX_RELEASE);
	}
	const result = await runSystem(
		"/usr/bin/gpgv",
		["--status-fd", "1", "--keyring", keyring.path, "--"],
		context,
		1024 * 1024,
		{ bytes: release, size: release.length, sha256: sha(release) },
		"gpgv-executable",
	);
	const status = decodeUtf8(result.stdout);
	need(
		/^\[GNUPG:\] VALIDSIG [A-Fa-f0-9]+ /m.test(status) &&
			!/^\[GNUPG:\] (?:BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|NO_PUBKEY|ERROR|FAILURE)\b/m.test(
				status,
			),
		"ubuntu-release-signature",
	);
	release = result.input;
	const parsed = parseRelease(release, {
		codename: os.codename,
		suite,
		architecture,
		nowMs: Date.now(),
	});
	// Match the verifier: an absent signed bound is null, never a freshness claim.
	// A present expired bound is always refused, with no caller policy override.
	const indexPath = path.join(folder, ...parsed.indexPath.split("/"));
	need(parsed.indexSize <= MAX_PACKAGES, "ubuntu-packages-size");
	let packages = await cached(indexPath, MAX_PACKAGES);
	if (!packages) {
		need(!context.offline, "ubuntu-offline-packages-missing");
		if (parsed.compressed) {
			need(parsed.compressed.size <= MAX_PACKAGES, "ubuntu-packages-compressed-size");
			const packed = await fetchOfficialBytes(
				new URL(`dists/${suite}/${parsed.compressed.path}`, base).href,
				parsed.compressed.size,
			);
			need(
				packed.length === parsed.compressed.size && sha(packed) === parsed.compressed.sha256,
				"ubuntu-packages-compressed-checksum",
			);
			if (parsed.compressed.path.endsWith(".gz"))
				packages = await gunzipBounded(packed, parsed.indexSize);
			else {
				need(parsed.compressed.path.endsWith(".xz"), "ubuntu-index-compression");
				await installedIntegrity("/usr/bin/xz", context, "xz-executable");
				packages = (
					await runSystem(
						"/usr/bin/xz",
						["--decompress", "--stdout", "--memlimit-decompress=256MiB", "--"],
						context,
						parsed.indexSize,
						{ bytes: packed, size: parsed.compressed.size, sha256: parsed.compressed.sha256 },
						"xz-executable",
					)
				).stdout;
			}
		} else {
			packages = await fetchOfficialBytes(
				new URL(`dists/${suite}/${parsed.indexPath}`, base).href,
				parsed.indexSize,
			);
		}
	}
	need(
		packages.length === parsed.indexSize && sha(packages) === parsed.indexSha256,
		"ubuntu-packages-checksum",
	);
	const records = parsePackages(packages);
	if (!context.offline) {
		await publish(context, releasePath, release, sha(release), release.length);
		await publish(context, indexPath, packages, parsed.indexSha256, parsed.indexSize);
	}
	return {
		records,
		base,
		suite,
		releasePath,
		indexPath,
		validUntil: parsed.validUntil,
		releaseSha256: sha(release),
		packagesSha256: parsed.indexSha256,
	};
}

async function authenticatedFile(file, state, callerRole) {
	const checked = await installedIntegrity(file, state.context, callerRole);
	const { pkg } = checked;
	need(
		pkg.architecture === state.architecture || pkg.architecture === "all",
		"ubuntu-package-architecture",
	);
	const id = `${pkg.name}\t${pkg.version}\t${pkg.architecture}`;
	const record = state.records.get(id);
	need(record, "ubuntu-installed-version-not-in-signed-index");
	need(record.size <= MAX_DEB, "ubuntu-deb-size");
	const debPath = path.join(provenance, "packages", `${record.sha256}.deb`);
	let bytes = await cached(debPath, MAX_DEB);
	if (!bytes) {
		need(!state.context.offline, "ubuntu-offline-authenticated-deb-missing");
		bytes = await fetchOfficialBytes(new URL(record.filename, record.base).href, record.size);
	}
	need(bytes.length === record.size && sha(bytes) === record.sha256, "ubuntu-deb-checksum");
	// dpkg-deb is an integrity-checked installed-OS bootstrap utility, not the
	// selected compiler. Even offline, decompression uses only authenticated bytes.
	const extracted = await runSystem(
		"/usr/bin/dpkg-deb",
		["--fsys-tarfile", "-"],
		state.context,
		MAX_TAR,
		{ bytes, size: record.size, sha256: record.sha256 },
		"dpkg-deb-executable",
	);
	bytes = extracted.input;
	const tar = extracted.stdout;
	const names = [
		checked.path.slice(1),
		...(checked.path.startsWith("/usr/") ? [checked.path.slice(5)] : []),
	];
	const member = readDebTarMember(tar, names);
	need(member.equals(checked.bytes), "ubuntu-installed-file-not-authentic-payload");
	if (!state.context.offline)
		await publish(state.context, debPath, bytes, record.sha256, record.size);
	state.packages.set(id, {
		name: pkg.name,
		version: pkg.version,
		architecture: pkg.architecture,
		filename: record.filename,
		sha256: record.sha256,
		size: record.size,
		path: debPath,
		suite: record.suite,
	});
	const selected = {
		path: checked.path,
		size: checked.bytes.length,
		sha256: checked.sha256,
		package: pkg.binary,
		packageName: pkg.name,
		version: pkg.version,
		architecture: pkg.architecture,
	};
	state.selected.set(selected.path, selected);
	return selected;
}

async function compilerQuery(compiler, args, context, verbose = false) {
	const before = await systemBytes(compiler.path, MAX_DEB, "compiler");
	need(sha(before.bytes) === compiler.sha256, "ubuntu-compiler-changed");
	const result = await runSystem(compiler.path, args, context, undefined, undefined, "compiler");
	const after = await systemBytes(compiler.path, MAX_DEB, "compiler");
	need(sha(after.bytes) === compiler.sha256, "ubuntu-compiler-changed");
	return verbose ? decodeUtf8(result.stderr) : decodeUtf8(result.stdout).trim();
}

async function acquire(context) {
	const osInput = await systemBytes("/etc/os-release", 65536, "os-metadata");
	const os = parseOsRelease(osInput.bytes);
	const architecture = process.arch === "x64" ? "amd64" : "arm64";
	for (const [utility, callerRole] of [
		["/usr/bin/dpkg", "dpkg-executable"],
		["/usr/bin/dpkg-query", "dpkg-query-executable"],
		["/usr/bin/dpkg-deb", "dpkg-deb-executable"],
		["/usr/bin/gpgv", "gpgv-executable"],
	])
		await installedIntegrity(utility, context, callerRole);
	need(
		(await commandText("/usr/bin/dpkg", ["--print-architecture"], context, "dpkg-executable")) ===
			architecture,
		"ubuntu-host-architecture",
	);
	const keyring = await installedIntegrity(
		"/usr/share/keyrings/ubuntu-archive-keyring.gpg",
		context,
		"archive-keyring",
	);
	const releases = [];
	const records = new Map();
	for (const suite of [os.codename, `${os.codename}-updates`, `${os.codename}-security`]) {
		const release = await releaseInput(context, os, architecture, suite, keyring);
		releases.push(release);
		for (const [id, record] of release.records) {
			const previous = records.get(id);
			need(
				!previous ||
					(previous.sha256 === record.sha256 &&
						previous.size === record.size &&
						previous.filename === record.filename),
				"ubuntu-package-record-conflict",
			);
			if (!previous) records.set(id, { ...record, base: release.base, suite });
		}
	}
	const state = { context, architecture, records, packages: new Map(), selected: new Map() };
	const compiler = await authenticatedFile(
		await ownedSystem("/usr/bin/g++", false, "compiler"),
		state,
		"compiler",
	);
	// No selected compiler query precedes its signed-payload byte comparison.
	const triple = await compilerQuery(compiler, ["-dumpmachine"], context);
	need(
		triple === (process.arch === "x64" ? "x86_64-linux-gnu" : "aarch64-linux-gnu"),
		"ubuntu-compiler-target",
	);
	const sysroot = await compilerQuery(compiler, ["-print-sysroot"], context);
	need(sysroot === "" || sysroot === "/", "ubuntu-cross-sysroot-refused");
	const search = await compilerQuery(compiler, ["-print-search-dirs"], context);
	const programs = /^programs: =(.*)$/m.exec(search)?.[1].split(":").filter(Boolean);
	need(programs?.length > 0 && programs.length <= 256, "ubuntu-compiler-program-search");
	const programDirectories = [];
	for (const directory of programs) {
		need(path.isAbsolute(directory), "ubuntu-compiler-program-path");
		try {
			programDirectories.push(await ownedSystem(directory, true, "compiler-program-directory"));
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	for (const name of ["cc1plus", "collect2", "as", "ld"]) {
		const reported = await compilerQuery(compiler, [`-print-prog-name=${name}`], context);
		let selected;
		if (path.isAbsolute(reported))
			selected = await ownedSystem(reported, false, "compiler-subprogram");
		else {
			need(reported === name, "ubuntu-compiler-program-name");
			for (const directory of programDirectories) {
				try {
					selected = await ownedSystem(
						path.join(directory, reported),
						false,
						"compiler-subprogram",
					);
					break;
				} catch (error) {
					if (error?.code !== "ENOENT") throw error;
				}
			}
		}
		need(selected, "ubuntu-compiler-program-unavailable");
		await authenticatedFile(selected, state, "compiler-subprogram");
	}
	const verbose = await compilerQuery(
		compiler,
		["-E", "-x", "c++", "-v", "/dev/null"],
		context,
		true,
	);
	const includeBlock = /#include <\.\.\.> search starts here:\n([\s\S]*?)End of search list\./.exec(
		verbose,
	);
	need(includeBlock, "ubuntu-compiler-include-search");
	const includeDirectories = [];
	const lines = includeBlock[1].trim().split("\n");
	need(lines.length <= 256, "ubuntu-compiler-include-bound");
	for (const line of lines) {
		const reported = line.trim();
		need(path.isAbsolute(reported), "ubuntu-compiler-include-path");
		if (
			reported === "/usr/include" ||
			reported.startsWith("/usr/include/") ||
			reported.startsWith("/usr/lib/gcc/")
		)
			includeDirectories.push(await ownedSystem(reported, true, "include-directory"));
	}
	need(includeDirectories.length > 0, "ubuntu-compiler-includes-unavailable");
	let math;
	for (const name of [
		"libstdc++.so",
		"libgcc_s.so.1",
		"libc.so",
		"libc.so.6",
		"libc_nonshared.a",
		"libm.so",
		"libm.so.6",
		"crtbeginS.o",
		"crtendS.o",
		"crti.o",
		"crtn.o",
	]) {
		const reported = await compilerQuery(compiler, [`-print-file-name=${name}`], context);
		need(path.isAbsolute(reported), "ubuntu-compiler-link-input");
		const selected = await authenticatedFile(reported, state, "linker-input");
		if (name === "libm.so") math = selected;
	}
	if (
		math &&
		(await systemBytes(math.path, MAX_DEB, "linker-input")).bytes.includes(
			Buffer.from("libmvec.so"),
		)
	) {
		const reported = await compilerQuery(compiler, ["-print-file-name=libmvec.so.1"], context);
		need(path.isAbsolute(reported), "ubuntu-compiler-link-input");
		await authenticatedFile(reported, state, "linker-input");
	}
	for (const file of ["/usr/include/dirent.h", "/usr/include/fcntl.h", "/usr/include/unistd.h"])
		await authenticatedFile(file, state, "public-header");
	const cpp = includeDirectories.find((directory) => /\/c\+\+\/\d+(?:\.\d+)*$/.test(directory));
	need(cpp, "ubuntu-libstdcxx-include-unavailable");
	await authenticatedFile(path.join(cpp, "vector"), state, "cxx-header");
	// Refuse an OS/package upgrade across acquisition rather than describing a
	// mixture of installed versions as a current selected closure.
	for (const file of state.selected.values()) {
		const current = await installedIntegrity(file.path, context, "selected-file-recheck");
		need(
			current.sha256 === file.sha256 &&
				current.pkg.binary === file.package &&
				current.pkg.name === file.packageName &&
				current.pkg.version === file.version &&
				current.pkg.architecture === file.architecture,
			"ubuntu-selected-input-changed",
		);
	}
	const currentOs = await systemBytes("/etc/os-release", 65536, "os-metadata-recheck");
	need(
		currentOs.path === osInput.path &&
			sha(currentOs.bytes) === sha(osInput.bytes) &&
			(await commandText("/usr/bin/dpkg", ["--print-architecture"], context, "dpkg-executable")) ===
				architecture,
		"ubuntu-host-metadata-changed",
	);
	need(
		sha((await systemBytes(keyring.path, MAX_DEB, "archive-keyring-recheck")).bytes) ===
			keyring.sha256,
		"ubuntu-keyring-changed",
	);
	for (const release of releases)
		need(release.validUntil === null || release.validUntil > Date.now(), "ubuntu-release-expired");
	return {
		schema: "inventory-ubuntu-input-acquisition-v1",
		platform: "linux",
		host: process.arch,
		codename: os.codename,
		version: os.version,
		architecture,
		offline: context.offline,
		cache,
		targetTriple: triple,
		releases: releases.map(
			({ suite, releasePath, indexPath, releaseSha256, packagesSha256, validUntil }) => ({
				suite,
				releasePath,
				indexPath,
				releaseSha256,
				packagesSha256,
				validUntil,
			}),
		),
		packages: [...state.packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
		selectedFiles: [...state.selected.values()].sort((a, b) => a.path.localeCompare(b.path)),
	};
}

export async function acquireInventoryUbuntuInputs(options = {}) {
	let operation;
	try {
		// Actual-operation precondition: the allowed owner/root/administrators maintain
		// this private topology, and every cooperating mutating writer honors the fixed
		// bootstrap key. If that context is unknown, the operator must not invoke this
		// operation. Canonical paths, permission observations and locks are ordinary
		// mechanism checks; they do not certify that precondition or exclude adversaries.
		need(
			process.platform === "linux" &&
				["x64", "arm64"].includes(process.arch) &&
				typeof process.getuid === "function",
			"ubuntu-unsupported-host",
		);
		need(
			options !== null && Object.getPrototypeOf(options) === Object.prototype,
			"ubuntu-acquisition-options",
		);
		const descriptors = Object.getOwnPropertyDescriptors(options);
		need(
			Reflect.ownKeys(descriptors).every((name) => name === "offline") &&
				(!descriptors.offline ||
					(Object.hasOwn(descriptors.offline, "value") &&
						(descriptors.offline.value === undefined ||
							typeof descriptors.offline.value === "boolean"))),
			"ubuntu-acquisition-options",
		);
		const offline = descriptors.offline?.value ?? true;
		need(activeOperation === undefined, "ubuntu-acquisition-already-active");
		operation = {
			handles: new Map(),
			children: new Set(),
			publications: [],
			retained: false,
			workspace: null,
			failure: null,
		};
		activeOperation = operation;
		const result = await withWorkspace(offline, acquire);
		// Recheck after all awaited cleanup, immediately before this successful return.
		// A later consumer/toolchain observation still needs its own timing check.
		const returnCheck = Date.now();
		for (const release of result.releases)
			need(
				release.validUntil === null || release.validUntil > returnCheck,
				"ubuntu-release-expired",
			);
		return result;
	} catch (error) {
		// Never disclose subprocess prose, downloaded bodies or private paths.
		const failure = fixedFailure(error);
		if (operation) operation.failure = failure;
		throw failure;
	} finally {
		if (
			operation &&
			!operation.retained &&
			operation.handles.size === 0 &&
			operation.children.size === 0 &&
			activeOperation === operation
		)
			activeOperation = undefined;
	}
}

function ubuntuParserHasControl(text) {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (
			(code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
			(code >= 0x7f && code <= 0x9f)
		)
			return true;
	}
	return false;
}

function ubuntuParserText(bytes, limit) {
	need(
		Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= limit,
		"ubuntu-parser-byte-bound",
	);
	const text = bytes.toString("utf8");
	need(Buffer.from(text, "utf8").equals(bytes), "ubuntu-parser-utf8");
	need(!text.startsWith("\uFEFF") && !ubuntuParserHasControl(text), "ubuntu-parser-control");
	need(!/\r(?!\n)/.test(text), "ubuntu-parser-newline");
	return text.replaceAll("\r\n", "\n");
}

function ubuntuParserField(fields, wanted, required = true) {
	let value;
	for (const [name, candidate] of fields)
		if (name.toLowerCase() === wanted.toLowerCase()) {
			// The downstream verifier uses exact Map keys; never publish bytes whose
			// critical field spelling it would reinterpret as an absent signed bound.
			need(name === wanted, "ubuntu-field-spelling");
			value = candidate;
		}
	need(!required || value !== undefined, "ubuntu-required-field");
	return value;
}

function ubuntuParserSingle(fields, wanted, required = true) {
	const value = ubuntuParserField(fields, wanted, required);
	if (value === undefined) return undefined;
	need(value.length > 0 && !/[\n\t]/.test(value) && value === value.trim(), "ubuntu-scalar-field");
	return value;
}

function ubuntuParserDecimal(value, positive = false) {
	need(typeof value === "string" && /^[0-9]{1,16}$/.test(value), "ubuntu-decimal-field");
	const number = Number(value);
	need(Number.isSafeInteger(number) && number >= (positive ? 1 : 0), "ubuntu-decimal-bound");
	return number;
}

function ubuntuParserRelative(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 4096 &&
		/^[A-Za-z0-9+._~:/-]+$/.test(value) &&
		!value.startsWith("/") &&
		value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
	);
}

function parseControlFields(text) {
	need(
		typeof text === "string" &&
			text.isWellFormed() &&
			Buffer.byteLength(text, "utf8") <= 4 * 1024 * 1024,
		"ubuntu-control-bound",
	);
	need(
		!text.startsWith("\uFEFF") && !ubuntuParserHasControl(text) && !/\r(?!\n)/.test(text),
		"ubuntu-control-character",
	);
	const normalized = text.replaceAll("\r\n", "\n");
	const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
	need(lines.length > 0 && lines.length <= 100000, "ubuntu-control-line-bound");
	const entries = [],
		names = new Set();
	let current;
	for (const line of lines) {
		need(line.length > 0 && line.length <= 1024 * 1024, "ubuntu-control-line");
		if (/^[ \t]/.test(line)) {
			need(current !== undefined, "ubuntu-control-orphan-continuation");
			current.parts.push(line.slice(1));
			continue;
		}
		const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,127}):[ \t]*(.*)$/.exec(line);
		need(match && entries.length < 200, "ubuntu-control-field");
		const folded = match[1].toLowerCase();
		need(!names.has(folded), "ubuntu-control-duplicate-field");
		names.add(folded);
		current = { name: match[1], parts: [match[2]] };
		entries.push(current);
	}
	return new Map(entries.map(({ name, parts }) => [name, parts.join("\n")]));
}

function ubuntuParserClearSigned(bytes) {
	const text = ubuntuParserText(bytes, 4 * 1024 * 1024);
	const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
	need(lines[0] === "-----BEGIN PGP SIGNED MESSAGE-----", "ubuntu-release-clear-sign-header");
	const separator = lines.indexOf("", 1);
	need(separator >= 2 && separator <= 8, "ubuntu-release-armor-headers");
	const headers = parseControlFields(lines.slice(1, separator).join("\n"));
	const hashHeader = ubuntuParserSingle(headers, "Hash");
	need(
		headers.size === 1 && /^[A-Z0-9-]+(?:,[ \t]*[A-Z0-9-]+)*$/.test(hashHeader),
		"ubuntu-release-hash-header",
	);
	const signature = lines.indexOf("-----BEGIN PGP SIGNATURE-----", separator + 1);
	need(
		signature > separator + 1 && lines.at(-1) === "-----END PGP SIGNATURE-----",
		"ubuntu-release-signature-boundary",
	);
	need(
		lines.lastIndexOf("-----BEGIN PGP SIGNATURE-----") === signature &&
			lines.indexOf("-----END PGP SIGNATURE-----") === lines.length - 1,
		"ubuntu-release-multiple-signature-boundaries",
	);
	let signatureBody = signature + 1;
	while (signatureBody < lines.length - 1 && lines[signatureBody] !== "") {
		need(
			/^[A-Za-z0-9-]+: [\x20-\x7E]*$/.test(lines[signatureBody]),
			"ubuntu-release-signature-armor-header",
		);
		signatureBody++;
	}
	need(signatureBody < lines.length - 2, "ubuntu-release-signature-armor-body");
	const armor = lines.slice(signatureBody + 1, -1);
	if (/^=[A-Za-z0-9+/]{4}$/.test(armor.at(-1) ?? "")) armor.pop();
	need(
		armor.length > 0 && armor.every((line) => /^[A-Za-z0-9+/=]{1,76}$/.test(line)),
		"ubuntu-release-signature-armor-data",
	);
	need(
		/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(armor.join("")),
		"ubuntu-release-signature-armor-base64",
	);
	const body = lines.slice(separator + 1, signature).map((line) => {
		if (!line.startsWith("-")) return line;
		need(line.startsWith("- "), "ubuntu-release-dash-escape");
		return line.slice(2);
	});
	return body.join("\n");
}

function ubuntuParserTimestamp(value) {
	const match =
		/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([0-9]{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) (?:UTC|GMT|\+0000)$/.exec(
			value,
		);
	need(match, "ubuntu-release-time-format");
	const months = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec",
	];
	const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const day = Number(match[2]),
		month = months.indexOf(match[3]),
		year = Number(match[4]);
	const hour = Number(match[5]),
		minute = Number(match[6]),
		second = Number(match[7]);
	need(
		year >= 1970 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59,
		"ubuntu-release-time-bound",
	);
	const result = Date.UTC(year, month, day, hour, minute, second),
		date = new Date(result);
	need(
		Number.isFinite(result) &&
			date.getUTCFullYear() === year &&
			date.getUTCMonth() === month &&
			date.getUTCDate() === day &&
			date.getUTCHours() === hour &&
			date.getUTCMinutes() === minute &&
			date.getUTCSeconds() === second &&
			weekdays[date.getUTCDay()] === match[1],
		"ubuntu-release-time-calendar",
	);
	return result;
}

function parseRelease(bytes, options) {
	need(
		options !== null &&
			typeof options === "object" &&
			!Array.isArray(options) &&
			Object.keys(options).length === 4 &&
			["codename", "suite", "architecture", "nowMs"].every((key) => Object.hasOwn(options, key)),
		"ubuntu-release-context",
	);
	const { codename, suite, architecture, nowMs } = options;
	need(
		typeof codename === "string" &&
			/^[a-z]{1,32}$/.test(codename) &&
			[codename, `${codename}-updates`, `${codename}-security`].includes(suite) &&
			(architecture === "amd64" || architecture === "arm64") &&
			Number.isSafeInteger(nowMs) &&
			nowMs >= 0,
		"ubuntu-release-context-value",
	);
	const fields = parseControlFields(ubuntuParserClearSigned(bytes));
	need(
		ubuntuParserSingle(fields, "Origin") === "Ubuntu" &&
			ubuntuParserSingle(fields, "Codename") === codename &&
			ubuntuParserSingle(fields, "Suite") === suite,
		"ubuntu-release-identity",
	);
	for (const [field, required] of [
		["Architectures", architecture],
		["Components", "main"],
	]) {
		const values = ubuntuParserSingle(fields, field).split(/ +/);
		need(
			values.every((value) => /^[a-z0-9-]+$/.test(value)) &&
				new Set(values).size === values.length &&
				values.includes(required),
			"ubuntu-release-scope",
		);
	}
	const until = ubuntuParserSingle(fields, "Valid-Until", false);
	// Null is an ABSENT signed bound, never a manufactured expiry or freshness claim.
	// Absence is preserved as null; the verifier makes no expiry-bound claim.
	const validUntil = until === undefined ? null : ubuntuParserTimestamp(until);
	need(validUntil === null || validUntil > nowMs, "ubuntu-release-expired");
	const table = ubuntuParserField(fields, "SHA256"),
		sums = new Map();
	const rows = table.split("\n");
	if (rows[0] === "") rows.shift();
	need(rows.length > 0 && rows.length <= 100000, "ubuntu-release-checksum-bound");
	for (const row of rows) {
		const match = /^[ \t]*([a-f0-9]{64})[ \t]+([0-9]+)[ \t]+([^ \t]+)$/.exec(row);
		need(
			match && ubuntuParserRelative(match[3]) && !sums.has(match[3]),
			"ubuntu-release-checksum-row",
		);
		sums.set(match[3], { path: match[3], size: ubuntuParserDecimal(match[2]), sha256: match[1] });
	}
	const indexPath = `main/binary-${architecture}/Packages`,
		index = sums.get(indexPath);
	need(index && index.size > 0 && index.size <= 256 * 1024 * 1024, "ubuntu-release-packages-index");
	// Deterministic representation metadata preference only, not a decompressor grant.
	const compressed = sums.get(`${indexPath}.gz`) ?? sums.get(`${indexPath}.xz`) ?? null;
	need(compressed === null || compressed.size > 0, "ubuntu-release-compressed-index");
	return {
		fields,
		indexPath,
		indexSize: index.size,
		indexSha256: index.sha256,
		compressed,
		validUntil,
	};
}

function parsePackages(bytes) {
	const text = ubuntuParserText(bytes, 256 * 1024 * 1024),
		records = new Map();
	let position = 0,
		stanza = [],
		stanzaBytes = 0,
		count = 0;
	const finish = () => {
		if (stanza.length === 0) return;
		need(++count <= 200000, "ubuntu-packages-record-bound");
		const fields = parseControlFields(stanza.join("\n"));
		stanza = [];
		stanzaBytes = 0;
		const name = ubuntuParserSingle(fields, "Package"),
			version = ubuntuParserSingle(fields, "Version");
		const architecture = ubuntuParserSingle(fields, "Architecture"),
			filename = ubuntuParserSingle(fields, "Filename");
		const sum = ubuntuParserSingle(fields, "SHA256"),
			size = ubuntuParserDecimal(ubuntuParserSingle(fields, "Size"), true);
		need(
			/^[a-z0-9][a-z0-9+.-]{0,199}$/.test(name) &&
				/^[0-9][A-Za-z0-9.+:~_-]{0,511}$/.test(version) &&
				/^(?:amd64|arm64|all)$/.test(architecture),
			"ubuntu-package-identity",
		);
		need(
			ubuntuParserRelative(filename) &&
				filename.startsWith("pool/main/") &&
				filename.endsWith(".deb") &&
				filename.split("/").length >= 5 &&
				/^[a-f0-9]{64}$/.test(sum),
			"ubuntu-package-payload-record",
		);
		const key = `${name}\t${version}\t${architecture}`;
		need(!records.has(key), "ubuntu-package-duplicate-record");
		records.set(key, { name, version, architecture, filename, sha256: sum, size });
	};
	while (position < text.length) {
		const end = text.indexOf("\n", position),
			stop = end === -1 ? text.length : end;
		const line = text.slice(position, stop);
		position = end === -1 ? text.length : end + 1;
		if (line === "") {
			finish();
			continue;
		}
		stanzaBytes += Buffer.byteLength(line, "utf8") + 1;
		need(stanzaBytes <= 4 * 1024 * 1024 && stanza.length < 100000, "ubuntu-package-stanza-bound");
		stanza.push(line);
	}
	finish();
	need(records.size > 0, "ubuntu-packages-empty");
	return records;
}

const UBUNTU_TRANSFER_MAX = 256 * 1024 * 1024;
const UBUNTU_INFLATED_MAX = 512 * 1024 * 1024;
const UBUNTU_TRANSFER_MS = 120_000;
const UBUNTU_HEADERS_MS = 30_000;
const UBUNTU_HEADER_BYTES = 16 * 1024;
const UBUNTU_HEADER_PAIRS = 64;
const UBUNTU_TRANSFER_CHUNKS = 65_536;
const UBUNTU_REDIRECT_BYTES = 16 * 1024;

function ubuntuTransferUrl(raw, base) {
	need(
		typeof raw === "string" && raw.length > 0 && raw.length <= 2048 && /^[\x21-\x7e]+$/.test(raw),
		"ubuntu-download-url",
	);
	let parsed;
	try {
		parsed = base === undefined ? new URL(raw) : new URL(raw, base);
	} catch {
		throw issueRefusal("ubuntu-download-url");
	}
	need(
		parsed.protocol === "https:" &&
			(parsed.port === "" || parsed.port === "443") &&
			parsed.username === "" &&
			parsed.password === "" &&
			parsed.search === "" &&
			parsed.hash === "",
		"ubuntu-download-url",
	);
	const prefix = parsed.hostname === "ports.ubuntu.com" ? "/ubuntu-ports/" : "/ubuntu/";
	need(
		(parsed.hostname === "archive.ubuntu.com" ||
			parsed.hostname === "security.ubuntu.com" ||
			parsed.hostname === "ports.ubuntu.com") &&
			parsed.pathname.startsWith(prefix),
		"ubuntu-download-origin",
	);
	if (base !== undefined) need(parsed.origin === base.origin, "ubuntu-download-redirect-origin");
	return parsed;
}

function ubuntuTransferHeaders(rawHeaders) {
	need(
		Array.isArray(rawHeaders) &&
			rawHeaders.length % 2 === 0 &&
			rawHeaders.length <= UBUNTU_HEADER_PAIRS * 2,
		"ubuntu-download-headers",
	);
	const selected = new Map();
	let size = 0;
	for (let index = 0; index < rawHeaders.length; index += 2) {
		const name = rawHeaders[index],
			value = rawHeaders[index + 1];
		need(typeof name === "string" && typeof value === "string", "ubuntu-download-headers");
		size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
		need(size <= UBUNTU_HEADER_BYTES, "ubuntu-download-headers");
		const lower = name.toLowerCase();
		if (
			lower === "location" ||
			lower === "content-length" ||
			lower === "content-encoding" ||
			lower === "transfer-encoding"
		) {
			need(!selected.has(lower), "ubuntu-download-headers");
			selected.set(lower, value);
		}
	}
	return selected;
}

async function fetchOfficialBytes(url, limit) {
	need(
		Number.isSafeInteger(limit) && limit > 0 && limit <= UBUNTU_TRANSFER_MAX,
		"ubuntu-download-limit",
	);
	let current = ubuntuTransferUrl(url);
	const deadline = performance.now() + UBUNTU_TRANSFER_MS;
	const seen = new Set();
	for (let redirects = 0; ; redirects += 1) {
		need(redirects <= 3 && !seen.has(current.href), "ubuntu-download-redirect-limit");
		seen.add(current.href);
		const remaining = deadline - performance.now();
		need(Number.isFinite(remaining) && remaining > 0, "ubuntu-download-timeout");
		const result = await new Promise((resolve, reject) => {
			let request, response;
			let requestClosed = false,
				requestFinished = false,
				responseClosed = false,
				responseEnded = false;
			let failure,
				settled = false,
				nextUrl,
				expectedLength;
			let total = 0,
				chunkCount = 0,
				informational = 0;
			const chunks = [],
				sockets = new Map();
			let totalTimer, headerTimer;
			const finish = () => {
				if (
					settled ||
					!requestClosed ||
					(response !== undefined && !responseClosed) ||
					[...sockets.values()].some((state) => !state.closed)
				)
					return;
				if (
					failure === undefined &&
					(!requestFinished ||
						response === undefined ||
						!responseEnded ||
						(expectedLength !== undefined && expectedLength !== total))
				)
					failure = "ubuntu-download-truncated";
				if (failure === undefined && performance.now() >= deadline)
					failure = "ubuntu-download-timeout";
				settled = true;
				clearTimeout(totalTimer);
				clearTimeout(headerTimer);
				if (failure !== undefined) {
					reject(issueRefusal(failure));
					return;
				}
				if (nextUrl !== undefined) {
					resolve({ nextUrl });
					return;
				}
				try {
					resolve({ bytes: Buffer.concat(chunks, total) });
				} catch {
					reject(issueRefusal("ubuntu-download-buffer"));
				}
			};
			const stop = (code) => {
				if (failure === undefined) failure = code;
				chunks.length = 0;
				// A destroy request or throw is not a close receipt. Keep each original listener.
				if (response !== undefined && !responseClosed) {
					try {
						response.destroy();
					} catch {
						/* Await original close. */
					}
				}
				if (request !== undefined && !requestClosed) {
					try {
						request.destroy();
					} catch {
						/* Await original close. */
					}
				}
				for (const [socket, state] of sockets)
					if (!state.closed) {
						try {
							socket.destroy();
						} catch {
							/* Await original close. */
						}
					}
				finish();
			};
			const ownSocket = (socket) => {
				if (sockets.has(socket)) return;
				const state = { closed: false };
				sockets.set(socket, state);
				socket.on("error", () => stop("ubuntu-download-network"));
				socket.once("close", () => {
					state.closed = true;
					finish();
				});
				if (failure !== undefined) {
					try {
						socket.destroy();
					} catch {
						/* Keep original custody. */
					}
				}
			};
			const ownResponse = (original) => {
				response = original;
				response.on("error", () => stop("ubuntu-download-network"));
				response.once("aborted", () => stop("ubuntu-download-truncated"));
				response.once("end", () => {
					responseEnded = true;
					finish();
				});
				response.once("close", () => {
					responseClosed = true;
					if (!responseEnded && failure === undefined) failure = "ubuntu-download-truncated";
					finish();
				});
				if (response.socket !== null) ownSocket(response.socket);
			};
			try {
				totalTimer = setTimeout(() => stop("ubuntu-download-timeout"), remaining);
				headerTimer = setTimeout(
					() => stop("ubuntu-download-timeout"),
					Math.min(remaining, UBUNTU_HEADERS_MS),
				);
				request = https.request({
					protocol: "https:",
					hostname: current.hostname,
					port: 443,
					path: current.pathname,
					method: "GET",
					agent: false,
					rejectUnauthorized: true,
					minVersion: "TLSv1.2",
					maxHeaderSize: UBUNTU_HEADER_BYTES,
					insecureHTTPParser: false,
					headers: { "Accept-Encoding": "identity", Connection: "close" },
				});
				// Preserve complete raw headers within maxHeaderSize, then refuse the
				// actual pair overflow explicitly instead of accepting a truncated list.
				request.maxHeadersCount = 0;
				request.once("socket", ownSocket);
				request.on("error", () => stop("ubuntu-download-network"));
				request.once("finish", () => {
					requestFinished = true;
					finish();
				});
				request.once("close", () => {
					requestClosed = true;
					if (response === undefined && failure === undefined) failure = "ubuntu-download-network";
					finish();
				});
				request.on("information", (info) => {
					try {
						informational += 1;
						need(informational <= 4, "ubuntu-download-headers");
						ubuntuTransferHeaders(info.rawHeaders);
					} catch {
						stop("ubuntu-download-headers");
					}
				});
				request.once("upgrade", (original, socket) => {
					ownSocket(socket);
					ownResponse(original);
					stop("ubuntu-download-status");
				});
				request.once("response", (original) => {
					ownResponse(original);
					clearTimeout(headerTimer);
					if (failure !== undefined) {
						stop(failure);
						return;
					}
					try {
						const headers = ubuntuTransferHeaders(response.rawHeaders);
						need(performance.now() < deadline, "ubuntu-download-timeout");
						const status = response.statusCode;
						need(
							status === 200 ||
								status === 301 ||
								status === 302 ||
								status === 303 ||
								status === 307 ||
								status === 308,
							"ubuntu-download-status",
						);
						if (status !== 200) {
							need(redirects < 3 && headers.has("location"), "ubuntu-download-redirect-limit");
							nextUrl = ubuntuTransferUrl(headers.get("location"), current);
						}
						const bodyLimit = nextUrl === undefined ? limit : UBUNTU_REDIRECT_BYTES;
						const encoding = headers.get("content-encoding");
						need(
							encoding === undefined || encoding.toLowerCase() === "identity",
							"ubuntu-download-content-encoding",
						);
						const length = headers.get("content-length");
						if (length !== undefined) {
							need(
								length.length <= String(bodyLimit).length && /^[0-9]+$/.test(length),
								"ubuntu-download-content-length",
							);
							expectedLength = Number(length);
							need(
								Number.isSafeInteger(expectedLength) && expectedLength <= bodyLimit,
								"ubuntu-download-content-length",
							);
						}
						const transfer = headers.get("transfer-encoding");
						need(
							transfer === undefined ||
								(length === undefined && transfer.toLowerCase() === "chunked"),
							"ubuntu-download-headers",
						);
						response.on("data", (chunk) => {
							if (failure !== undefined) return;
							chunkCount += 1;
							if (
								!Buffer.isBuffer(chunk) ||
								chunkCount > UBUNTU_TRANSFER_CHUNKS ||
								chunk.length > bodyLimit - total
							) {
								stop("ubuntu-download-overflow");
								return;
							}
							if (performance.now() >= deadline) {
								stop("ubuntu-download-timeout");
								return;
							}
							total += chunk.length;
							// Redirect bodies are bounded/discarded without decoding or rendering their text.
							if (nextUrl === undefined) chunks.push(chunk);
						});
					} catch (error) {
						stop(error instanceof Refusal ? error.code : "ubuntu-download-headers");
					}
				});
				request.end();
			} catch {
				if (request === undefined) {
					clearTimeout(totalTimer);
					clearTimeout(headerTimer);
					settled = true;
					reject(issueRefusal("ubuntu-download-create"));
				} else stop("ubuntu-download-network");
			}
		});
		if (result.nextUrl === undefined) return result.bytes;
		current = result.nextUrl;
	}
}

async function gunzipBounded(bytes, expectedSize) {
	need(
		Buffer.isBuffer(bytes) &&
			bytes.length > 0 &&
			bytes.length <= UBUNTU_TRANSFER_MAX &&
			Number.isSafeInteger(expectedSize) &&
			expectedSize > 0 &&
			expectedSize <= UBUNTU_INFLATED_MAX,
		"ubuntu-gzip-input",
	);
	let input;
	try {
		input = Buffer.from(bytes);
	} catch {
		throw issueRefusal("ubuntu-gzip-input");
	}
	return new Promise((resolve, reject) => {
		let original,
			closed = false,
			ended = false,
			finished = false,
			settled = false,
			failure;
		let total = 0,
			chunkCount = 0,
			timer;
		const chunks = [];
		const deadline = performance.now() + UBUNTU_TRANSFER_MS;
		const complete = () => {
			if (settled || !closed) return;
			if (failure === undefined && (!ended || !finished || total !== expectedSize))
				failure = "ubuntu-gzip-size";
			if (failure === undefined && performance.now() >= deadline) failure = "ubuntu-gzip-timeout";
			settled = true;
			clearTimeout(timer);
			if (failure !== undefined) {
				reject(issueRefusal(failure));
				return;
			}
			try {
				resolve(Buffer.concat(chunks, total));
			} catch {
				reject(issueRefusal("ubuntu-gzip-buffer"));
			}
		};
		const stop = (code) => {
			if (failure === undefined) failure = code;
			chunks.length = 0;
			try {
				original.destroy();
			} catch {
				/* Retain original and await its close. */
			}
			complete();
		};
		try {
			original = createGunzip({ chunkSize: 64 * 1024, autoDestroy: true, emitClose: true });
			original.on("error", () => stop("ubuntu-gzip-stream"));
			original.once("finish", () => {
				finished = true;
				complete();
			});
			original.once("end", () => {
				ended = true;
				complete();
			});
			original.once("close", () => {
				closed = true;
				complete();
			});
			original.on("data", (chunk) => {
				if (failure !== undefined) return;
				chunkCount += 1;
				if (
					!Buffer.isBuffer(chunk) ||
					chunkCount > UBUNTU_TRANSFER_CHUNKS ||
					chunk.length > expectedSize - total
				) {
					stop("ubuntu-gzip-overflow");
					return;
				}
				if (performance.now() >= deadline) {
					stop("ubuntu-gzip-timeout");
					return;
				}
				total += chunk.length;
				chunks.push(chunk);
			});
			timer = setTimeout(() => stop("ubuntu-gzip-timeout"), UBUNTU_TRANSFER_MS);
			original.end(input);
		} catch {
			if (original === undefined) {
				clearTimeout(timer);
				settled = true;
				reject(issueRefusal("ubuntu-gzip-create"));
			} else stop("ubuntu-gzip-stream");
		}
	});
}

function ubuntuTarHasPathControl(text) {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 0x5c || code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function readDebTarMember(bytes, names) {
	const maximum = 256 * 1024 * 1024;
	need(
		Buffer.isBuffer(bytes) &&
			bytes.length >= 1024 &&
			bytes.length <= maximum &&
			bytes.length % 512 === 0,
		"ubuntu-deb-tar-bounds",
	);
	need(Array.isArray(names) && names.length > 0 && names.length <= 8, "ubuntu-deb-tar-targets");
	const zero = (value) => value.every((byte) => byte === 0);
	const utf8 = (value) => {
		try {
			const text = decodeUtf8(value);
			need(typeof text === "string" && !text.includes("\0"), "ubuntu-deb-tar-text");
			return text;
		} catch {
			need(false, "ubuntu-deb-tar-text");
		}
	};
	const canonical = (value, directory = false) => {
		need(
			typeof value === "string" &&
				value !== "" &&
				!value.startsWith("/") &&
				Buffer.byteLength(value, "utf8") <= 4096 &&
				!ubuntuTarHasPathControl(value),
			"ubuntu-deb-tar-path",
		);
		let result = value;
		while (result.startsWith("./")) result = result.slice(2);
		if (directory) while (result.endsWith("/")) result = result.slice(0, -1);
		if (directory && (result === "" || result === ".")) return ""; // The ordinary ./ root directory.
		need(
			result !== "" &&
				!result.startsWith("/") &&
				result.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
			"ubuntu-deb-tar-path",
		);
		return result;
	};
	const wanted = new Set();
	for (const name of names) {
		need(canonical(name) === name && !wanted.has(name), "ubuntu-deb-tar-targets");
		wanted.add(name); // Only the explicit canonical and merged-/usr aliases are considered.
	}
	const numeric = (field, binary) => {
		let value = 0n;
		if (field[0] & 0x80) {
			need(binary && !(field[0] & 0x40), "ubuntu-deb-tar-number");
			value = BigInt(field[0] & 0x7f);
			for (let index = 1; index < field.length; index++)
				value = (value << 8n) | BigInt(field[index]);
		} else {
			let start = 0,
				end = field.length;
			while (start < end && (field[start] === 0 || field[start] === 32)) start++;
			while (end > start && (field[end - 1] === 0 || field[end - 1] === 32)) end--;
			for (let index = start; index < end; index++) {
				need(field[index] >= 48 && field[index] <= 55, "ubuntu-deb-tar-number");
				value = value * 8n + BigInt(field[index] - 48);
			}
		}
		need(value <= BigInt(maximum), "ubuntu-deb-tar-number-bounds");
		return Number(value);
	};
	const fieldText = (header, start, width) => {
		const field = header.subarray(start, start + width);
		const nul = field.indexOf(0);
		if (nul < 0) return utf8(field);
		need(zero(field.subarray(nul)), "ubuntu-deb-tar-string-padding");
		return utf8(field.subarray(0, nul));
	};
	let paxRecords = 0;
	const pax = (payload) => {
		need(payload.length > 0 && payload.length <= 65536, "ubuntu-deb-tar-pax-bounds");
		const result = new Map();
		let position = 0,
			count = 0;
		while (position < payload.length) {
			need(++count <= 256 && ++paxRecords <= 65536, "ubuntu-deb-tar-pax-count");
			const space = payload.indexOf(32, position);
			need(space > position && space - position <= 6, "ubuntu-deb-tar-pax-record");
			const digits = payload.subarray(position, space);
			need(
				digits.every((byte) => byte >= 48 && byte <= 57) && digits[0] !== 48,
				"ubuntu-deb-tar-pax-record",
			);
			const length = Number(digits.toString("ascii"));
			const end = position + length;
			need(
				end <= payload.length && end > space + 2 && payload[end - 1] === 10,
				"ubuntu-deb-tar-pax-record",
			);
			const equal = payload.indexOf(61, space + 1);
			need(equal > space + 1 && equal < end - 1, "ubuntu-deb-tar-pax-record");
			const key = utf8(payload.subarray(space + 1, equal));
			const value = utf8(payload.subarray(equal + 1, end - 1));
			need(/^[A-Za-z0-9_.-]+$/.test(key) && !result.has(key), "ubuntu-deb-tar-pax-duplicate");
			need(
				[
					"path",
					"size",
					"linkpath",
					"mtime",
					"atime",
					"ctime",
					"uid",
					"gid",
					"uname",
					"gname",
					"hdrcharset",
				].includes(key),
				"ubuntu-deb-tar-pax-unsupported",
			);
			if (key === "hdrcharset")
				need(
					value === "" || value === "UTF-8" || value === "ISO-IR 10646 2000 UTF-8",
					"ubuntu-deb-tar-pax-encoding-unsupported",
				);
			if (key === "path" || key === "linkpath")
				need(Buffer.byteLength(value, "utf8") <= 4096, "ubuntu-deb-tar-pax-name-bounds");
			result.set(key, value);
			position = end;
		}
		return result;
	};
	const longText = (payload) => {
		need(payload.length > 1 && payload.length <= 4096, "ubuntu-deb-tar-longname-bounds");
		const nul = payload.indexOf(0);
		need(nul > 0 && zero(payload.subarray(nul)), "ubuntu-deb-tar-longname-format");
		return utf8(payload.subarray(0, nul));
	};
	let offset = 0,
		headers = 0,
		metadata = 0;
	let pendingPax = null,
		pendingName = null,
		pendingLink = null;
	let selectedStart = -1,
		selectedEnd = -1,
		terminated = false;
	while (offset < bytes.length) {
		need(offset + 512 <= bytes.length && ++headers <= 524288, "ubuntu-deb-tar-header-bounds");
		const header = bytes.subarray(offset, offset + 512);
		if (zero(header)) {
			need(
				offset + 1024 <= bytes.length && zero(bytes.subarray(offset + 512)),
				"ubuntu-deb-tar-trailing-data",
			);
			need(
				pendingPax === null && pendingName === null && pendingLink === null,
				"ubuntu-deb-tar-dangling-metadata",
			);
			terminated = true;
			break;
		}
		let checksum = 0;
		for (let index = 0; index < 512; index++)
			checksum += index >= 148 && index < 156 ? 32 : header[index];
		need(numeric(header.subarray(148, 156), false) === checksum, "ubuntu-deb-tar-checksum");
		const magic = header.subarray(257, 265).toString("latin1");
		const ustar = magic === "ustar\0" + "00";
		need(
			ustar || magic === "ustar  \0" || zero(header.subarray(257, 265)),
			"ubuntu-deb-tar-format-unsupported",
		);
		need(
			header.subarray(508, 512).toString("latin1") !== "tar\0",
			"ubuntu-deb-tar-star-unsupported",
		);
		const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
		need(type !== "g", "ubuntu-deb-tar-global-pax-unsupported");
		need("0123456xLK".includes(type), "ubuntu-deb-tar-type-unsupported");
		const rawSize = numeric(header.subarray(124, 136), true);
		let size = rawSize;
		if (type !== "x" && type !== "L" && type !== "K" && pendingPax?.get("size")) {
			const value = pendingPax.get("size");
			need(/^(0|[1-9][0-9]*)$/.test(value), "ubuntu-deb-tar-pax-size");
			const exactSize = BigInt(value);
			need(exactSize <= BigInt(maximum), "ubuntu-deb-tar-pax-size-bounds");
			size = Number(exactSize);
		}
		const start = offset + 512,
			end = start + size;
		const next = start + Math.ceil(size / 512) * 512;
		need(
			end <= bytes.length && next <= bytes.length && zero(bytes.subarray(end, next)),
			"ubuntu-deb-tar-payload-bounds",
		);
		const payload = bytes.subarray(start, end);
		if (type === "x" || type === "L" || type === "K") {
			need(++metadata <= 16384, "ubuntu-deb-tar-metadata-count");
			if (type === "x") {
				need(
					pendingPax === null && pendingName === null && pendingLink === null,
					"ubuntu-deb-tar-metadata-mix-unsupported",
				);
				pendingPax = pax(payload);
			} else {
				need(pendingPax === null, "ubuntu-deb-tar-metadata-mix-unsupported");
				if (type === "L") {
					need(pendingName === null, "ubuntu-deb-tar-duplicate-longname");
					pendingName = longText(payload);
				} else {
					need(pendingLink === null, "ubuntu-deb-tar-duplicate-longlink");
					pendingLink = longText(payload);
				}
			}
			offset = next;
			continue;
		}
		let name = pendingPax?.get("path") || pendingName;
		if (name === null || name === undefined || name === "") {
			const leaf = fieldText(header, 0, 100),
				prefix = ustar ? fieldText(header, 345, 155) : "";
			name = prefix ? prefix + "/" + leaf : leaf;
		}
		name = canonical(name, type === "5");
		const linkOverride = pendingPax?.get("linkpath") || pendingLink;
		if (linkOverride) need(type === "1" || type === "2", "ubuntu-deb-tar-link-metadata");
		if (type !== "0") need(size === 0, "ubuntu-deb-tar-special-size-unsupported");
		if (wanted.has(name)) {
			need(selectedStart < 0, "ubuntu-deb-tar-member-duplicate");
			need(type === "0", "ubuntu-deb-tar-member-not-regular");
			selectedStart = start;
			selectedEnd = end;
		}
		pendingPax = null;
		pendingName = null;
		pendingLink = null;
		offset = next;
	}
	need(terminated, "ubuntu-deb-tar-terminator-missing");
	need(selectedStart >= 0, "ubuntu-deb-tar-member-missing");
	return Buffer.from(bytes.subarray(selectedStart, selectedEnd));
}
