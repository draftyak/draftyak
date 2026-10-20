import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, mkdtemp, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const STDOUT_LIMIT: number = 16 * 1024 * 1024;
export const STDERR_LIMIT: number = 4 * 1024 * 1024;
export type CaptureFailure =
	| "INVALID_INPUT"
	| "EVIDENCE_REFUSED"
	| "CAPTURE_IO"
	| "STDOUT_LIMIT"
	| "STDERR_LIMIT"
	| "TIMED_OUT"
	| "SPAWN_FAILED"
	| "COMPLETION_INVALID"
	| "TREE_UNCONFIRMED";

export class CaptureError extends Error {
	readonly code: CaptureFailure;
	constructor(code: CaptureFailure) {
		super("native process capture refused");
		this.name = "CaptureError";
		this.code = code;
	}
}
export interface EvidenceDirectory {
	readonly runId: string;
}
export interface CaptureFile {
	readonly file: string;
	readonly bytes: number;
	readonly sha256: string;
}
export interface NativeCaptureResult {
	readonly runId: string;
	readonly id: string;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly failure: CaptureFailure | null;
	readonly stdout: CaptureFile;
	readonly stderr: CaptureFile;
}
export type Completion = Pick<NativeCaptureResult, "exitCode" | "signal" | "failure">;
interface Identity {
	readonly dev: bigint;
	readonly ino: bigint;
}
interface EvidenceState {
	readonly directory: string;
	readonly checkout: string;
	readonly identity: Identity;
	readonly ids: Set<string>;
}
interface CapturedState {
	readonly evidence: EvidenceState;
	readonly stdout: Identity;
	readonly stderr: Identity;
}
const directories = new WeakMap<EvidenceDirectory, EvidenceState>();
const captures = new WeakMap<NativeCaptureResult, CapturedState>();
const sessions = new WeakSet<CaptureSession>();
const noFollow = constants.O_NOFOLLOW ?? 0;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const lengthGetter = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const refuse = (code: CaptureFailure = "EVIDENCE_REFUSED"): never => {
	throw new CaptureError(code);
};
const same = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;
const inside = (root: string, candidate: string): boolean => {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	);
};

function absolute(value: unknown): string {
	if (
		typeof value !== "string" ||
		!path.isAbsolute(value) ||
		value.includes("\0") ||
		value.startsWith("\\\\") ||
		value.startsWith("//")
	)
		return refuse();
	if (
		value
			.split(/[\\/]/)
			.some(
				(part) =>
					part === "." || part === ".." || (process.platform === "win32" && /[. ]$/.test(part)),
			)
	)
		return refuse();
	return path.resolve(value);
}
async function existingDirectory(value: string): Promise<string> {
	let current = path.parse(value).root;
	for (const part of path.relative(current, value).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		const info = await lstat(current, { bigint: true });
		if (info.isSymbolicLink() || !info.isDirectory()) return refuse();
	}
	return realpath(value);
}
async function checkDirectory(state: EvidenceState): Promise<void> {
	if ((await existingDirectory(state.checkout)) !== state.checkout) return refuse();
	const directory = await existingDirectory(state.directory);
	const info = await lstat(directory, { bigint: true });
	if (
		directory !== state.directory ||
		!same(info, state.identity) ||
		inside(state.checkout, directory)
	)
		return refuse();
	await outsideCheckouts(directory);
}
async function outsideCheckouts(directory: string): Promise<void> {
	let current = directory;
	while (true) {
		try {
			await lstat(path.join(current, ".git"));
			return refuse();
		} catch (error) {
			if (error instanceof CaptureError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}
function stateOf(evidence: EvidenceDirectory): EvidenceState {
	const state = directories.get(evidence);
	return state ?? refuse();
}

/** Creates an exclusive external directory. No existing directory can become a new run. */
export async function createEvidenceDirectory(options: {
	readonly checkoutRoot: string;
	readonly directory?: string;
}): Promise<EvidenceDirectory> {
	try {
		const checkout = await existingDirectory(absolute(options.checkoutRoot));
		const runId = randomUUID();
		let directory: string;
		if (options.directory === undefined) {
			const parent = await existingDirectory(absolute(os.tmpdir()));
			if (inside(checkout, parent)) return refuse();
			await outsideCheckouts(parent);
			directory = await mkdtemp(path.join(parent, `draftyak-native-${runId}-`));
		} else {
			const requested = absolute(options.directory);
			const parent = await existingDirectory(path.dirname(requested));
			directory = path.join(parent, path.basename(requested));
			if (inside(checkout, directory)) return refuse();
			await outsideCheckouts(parent);
			await mkdir(directory, { mode: 0o700 });
		}
		directory = await existingDirectory(directory);
		const identity = await lstat(directory, { bigint: true });
		const state: EvidenceState = { directory, checkout, identity, ids: new Set() };
		await checkDirectory(state);
		const evidence = Object.freeze({ runId });
		directories.set(evidence, state);
		return evidence;
	} catch (error) {
		if (error instanceof CaptureError) throw error;
		return refuse();
	}
}

class CaptureWriter {
	readonly file: string;
	readonly identity: Identity;
	private readonly handle: FileHandle;
	private readonly state: EvidenceState;
	private readonly limit: number;
	private readonly limitCode: CaptureFailure;
	private readonly hash = createHash("sha256");
	private count = 0;
	private closed = false;
	private writing = false;
	private metadata: CaptureFile | undefined;
	constructor(
		handle: FileHandle,
		state: EvidenceState,
		file: string,
		identity: Identity,
		limit: number,
		limitCode: CaptureFailure,
	) {
		this.handle = handle;
		this.state = state;
		this.file = file;
		this.identity = identity;
		this.limit = limit;
		this.limitCode = limitCode;
	}
	async append(chunk: unknown): Promise<void> {
		if (
			this.closed ||
			this.writing ||
			!Buffer.isBuffer(chunk) ||
			!lengthGetter ||
			!bufferGetter ||
			!offsetGetter
		)
			return refuse("CAPTURE_IO");
		const length = Reflect.apply(lengthGetter, chunk, []) as number;
		if (length > this.limit - this.count) return refuse(this.limitCode);
		this.writing = true;
		try {
			await checkDirectory(this.state);
			const bytes = new Uint8Array(
				Reflect.apply(bufferGetter, chunk, []),
				Reflect.apply(offsetGetter, chunk, []),
				length,
			);
			let offset = 0;
			while (offset < length) {
				const { bytesWritten } = await this.handle.write(bytes, offset, length - offset);
				if (bytesWritten <= 0 || bytesWritten > length - offset) return refuse("CAPTURE_IO");
				this.hash.update(bytes.subarray(offset, offset + bytesWritten));
				this.count += bytesWritten;
				offset += bytesWritten;
			}
		} finally {
			this.writing = false;
		}
	}
	async finish(): Promise<CaptureFile> {
		if (this.metadata) return this.metadata;
		this.closed = true;
		await this.handle.close();
		await checkDirectory(this.state);
		const info = await lstat(path.join(this.state.directory, this.file), { bigint: true });
		if (
			info.isSymbolicLink() ||
			!info.isFile() ||
			info.nlink !== 1n ||
			!same(info, this.identity) ||
			info.size !== BigInt(this.count)
		)
			return refuse();
		this.metadata = Object.freeze({
			file: this.file,
			bytes: this.count,
			sha256: this.hash.digest("hex"),
		});
		return this.metadata;
	}
	async close(): Promise<void> {
		this.closed = true;
		await this.handle.close().catch(() => undefined);
	}
}
export interface CaptureSession {
	readonly evidence: EvidenceDirectory;
	readonly id: string;
	readonly stdout: CaptureWriter;
	readonly stderr: CaptureWriter;
}
/** Internal producer boundary; the CLI obtains captures only through captureNativeProcess. */
export async function beginCapture(
	evidence: EvidenceDirectory,
	id: string,
): Promise<CaptureSession> {
	const state = stateOf(evidence);
	try {
		await checkDirectory(state);
		if (
			typeof id !== "string" ||
			!/^[a-z][a-z0-9-]{0,47}(?![\s\S])/.test(id) ||
			state.ids.has(id) ||
			state.ids.size >= 32
		)
			return refuse();
		state.ids.add(id);
		const writer = async (stream: "stdout" | "stderr"): Promise<CaptureWriter> => {
			const file = `capture-${id}.${stream}.bin`;
			const handle = await open(
				path.join(state.directory, file),
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
				0o600,
			);
			try {
				const info = await handle.stat({ bigint: true });
				if (!info.isFile() || info.nlink !== 1n) return refuse();
				await checkDirectory(state);
				return new CaptureWriter(
					handle,
					state,
					file,
					info,
					stream === "stdout" ? STDOUT_LIMIT : STDERR_LIMIT,
					stream === "stdout" ? "STDOUT_LIMIT" : "STDERR_LIMIT",
				);
			} catch (error) {
				await handle.close();
				throw error;
			}
		};
		const stdout = await writer("stdout");
		try {
			const session = { evidence, id, stdout, stderr: await writer("stderr") };
			sessions.add(session);
			return session;
		} catch (error) {
			await stdout.close();
			throw error;
		}
	} catch (error) {
		if (error instanceof CaptureError) throw error;
		return refuse();
	}
}
export async function sealCapture(
	session: CaptureSession,
	completion: Completion,
): Promise<NativeCaptureResult> {
	if (!sessions.has(session)) return refuse();
	sessions.delete(session);
	try {
		const stdout = await session.stdout.finish();
		const stderr = await session.stderr.finish();
		const result = Object.freeze({
			runId: session.evidence.runId,
			id: session.id,
			...completion,
			stdout,
			stderr,
		});
		captures.set(result, {
			evidence: stateOf(session.evidence),
			stdout: session.stdout.identity,
			stderr: session.stderr.identity,
		});
		return result;
	} catch (error) {
		if (error instanceof CaptureError) throw error;
		return refuse("CAPTURE_IO");
	} finally {
		await Promise.all([session.stdout.close(), session.stderr.close()]);
	}
}

/** Reads only a fresh capture issued for this handle, with its original identity and digest. */
export async function readCapturedBytes(
	evidence: EvidenceDirectory,
	result: NativeCaptureResult,
	stream: "stdout" | "stderr",
): Promise<Uint8Array> {
	let handle: FileHandle | undefined;
	try {
		const state = stateOf(evidence);
		const recorded = captures.get(result);
		if (
			!recorded ||
			recorded.evidence !== state ||
			result.runId !== evidence.runId ||
			result.failure !== null ||
			!["stdout", "stderr"].includes(stream)
		)
			return refuse();
		await checkDirectory(state);
		const metadata = result[stream];
		const expected = recorded[stream];
		const limit = stream === "stdout" ? STDOUT_LIMIT : STDERR_LIMIT;
		const file = path.join(state.directory, metadata.file);
		const before = await lstat(file, { bigint: true });
		if (
			before.isSymbolicLink() ||
			!before.isFile() ||
			before.nlink !== 1n ||
			!same(before, expected) ||
			before.size !== BigInt(metadata.bytes) ||
			metadata.bytes > limit
		)
			return refuse();
		handle = await open(file, constants.O_RDONLY | noFollow);
		if (!same(await handle.stat({ bigint: true }), expected)) return refuse();
		const bytes = Buffer.alloc(metadata.bytes);
		let offset = 0;
		while (offset < bytes.length) {
			const read = await handle.read(bytes, offset, bytes.length - offset);
			if (read.bytesRead === 0) return refuse();
			offset += read.bytesRead;
		}
		const extra = await handle.read(Buffer.alloc(1), 0, 1);
		const after = await handle.stat({ bigint: true });
		if (
			extra.bytesRead !== 0 ||
			after.size !== before.size ||
			after.nlink !== 1n ||
			!same(after, expected) ||
			createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
		)
			return refuse();
		await checkDirectory(state);
		if (!same(await lstat(file, { bigint: true }), expected)) return refuse();
		return bytes;
	} catch (error) {
		if (error instanceof CaptureError) throw error;
		return refuse();
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/**
 * Privileged producer-only bridge for a native tool's fixed metadata-file argument.
 * The private path is not a result field. Recheck the same live capture after use.
 */
export async function withCapturedFile<T>(
	evidence: EvidenceDirectory,
	result: NativeCaptureResult,
	stream: "stdout" | "stderr",
	use: (filename: string) => Promise<T>,
): Promise<T> {
	if (typeof use !== "function") return refuse();
	await readCapturedBytes(evidence, result, stream);
	const state = stateOf(evidence);
	const filename = path.join(state.directory, result[stream].file);
	try {
		return await use(filename);
	} finally {
		await readCapturedBytes(evidence, result, stream);
	}
}
