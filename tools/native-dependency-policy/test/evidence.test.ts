import { createHash } from "node:crypto";
import {
	type FileHandle,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as evidenceReaders from "../src/evidence.ts";
import {
	CaptureError,
	type CaptureSession,
	createEvidenceDirectory,
	type EvidenceDirectory,
	type NativeCaptureResult,
	readCapturedBytes,
	STDERR_LIMIT,
	STDOUT_LIMIT,
	sealCapture,
	beginCapture as startCapture,
	withCapturedFile,
} from "../src/evidence.ts";

const readerHook = vi.hoisted(() => ({
	file: undefined as string | undefined,
	install: undefined as ((handle: FileHandle) => void) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			if (args[0] === readerHook.file) readerHook.install?.(handle);
			return handle;
		},
	};
});

interface OwnedReader {
	readonly handle: FileHandle;
	readonly nativeClose: () => Promise<void>;
	readonly restore: () => void;
	closeCalls: number;
	failures: number;
	closed: boolean;
}
const ownedReaders: OwnedReader[] = [];
function gate(): { promise: Promise<void>; release: () => void } {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
type Gate = ReturnType<typeof gate>;
type ReadObservation = { ok: true; bytes: Uint8Array } | { ok: false; error: unknown };
const readObservations = new Set<Promise<ReadObservation>>();
const gates = new Set<Gate>();
function observeRead(
	owner: EvidenceDirectory,
	result: NativeCaptureResult,
): Promise<ReadObservation> {
	const observed = readCapturedBytes(owner, result, "stdout").then(
		(bytes) => ({ ok: true, bytes }) as const,
		(error: unknown) => ({ ok: false, error }) as const,
	);
	readObservations.add(observed);
	void observed.then(() => readObservations.delete(observed));
	return observed;
}
function expectReadRefusal(observed: ReadObservation): void {
	expect(observed.ok).toBe(false);
	if (observed.ok) return;
	expect(observed.error instanceof CaptureError).toBe(true);
	expect((observed.error as CaptureError).code).toBe("EVIDENCE_REFUSED");
	expect(Object.hasOwn(observed.error as object, "cause")).toBe(false);
}
async function reached(entered: Gate, observed: Promise<ReadObservation>): Promise<void> {
	await Promise.race([
		entered.promise,
		observed.then(() => {
			throw new Error("Reader settled before its owned gate");
		}),
	]);
}
function failReaderClose(
	result: NativeCaptureResult,
	failures: number,
	control: {
		readGate?: Gate;
		readEntered?: Gate;
		closeGate?: Gate;
		closeEntered?: Gate;
		onFirstRead?: () => void;
	} = {},
): void {
	for (const value of Object.values(control)) if (typeof value === "object") gates.add(value);
	readerHook.file = path.join(directory, result.stdout.file);
	readerHook.install = (handle) => {
		const nativeRead = handle.read;
		const closeDescriptor = Object.getOwnPropertyDescriptor(handle, "close");
		const readDescriptor = Object.getOwnPropertyDescriptor(handle, "read");
		const record: OwnedReader = {
			handle,
			nativeClose: handle.close.bind(handle),
			restore: () => {
				if (closeDescriptor) Object.defineProperty(handle, "close", closeDescriptor);
				else Reflect.deleteProperty(handle, "close");
				if (readDescriptor) Object.defineProperty(handle, "read", readDescriptor);
				else Reflect.deleteProperty(handle, "read");
			},
			closeCalls: 0,
			failures,
			closed: false,
		};
		ownedReaders.push(record);
		let readStarted = false;
		Object.defineProperty(handle, "read", {
			configurable: true,
			value: async (...args: unknown[]) => {
				if (!readStarted) {
					readStarted = true;
					control.readEntered?.release();
					control.onFirstRead?.();
					await control.readGate?.promise;
				}
				return Reflect.apply(nativeRead, handle, args);
			},
		});
		Object.defineProperty(handle, "close", {
			configurable: true,
			value: async () => {
				record.closeCalls++;
				control.closeEntered?.release();
				await control.closeGate?.promise;
				if (record.failures > 0) {
					record.failures--;
					throw new Error("synthetic reader close failure");
				}
				await record.nativeClose();
				record.closed = true;
			},
		});
	};
}
async function disposeReaders(): Promise<void> {
	readerHook.file = undefined;
	readerHook.install = undefined;
	for (const value of gates) value.release();
	gates.clear();
	await Promise.all(readObservations);
	await Promise.allSettled(
		ownedReaders.map(async (record) => {
			record.failures = 0;
			await record.nativeClose();
			record.closed = true;
		}),
	);
	try {
		if (typeof evidenceReaders.closeRetainedEvidenceReaders === "function")
			await evidenceReaders.closeRetainedEvidenceReaders().catch(() => undefined);
	} finally {
		for (const record of ownedReaders) record.restore();
		ownedReaders.length = 0;
	}
}

let root: string;
let checkout: string;
let directory: string;
let evidence: EvidenceDirectory;
let sessions: CaptureSession[];
const completed = { exitCode: 0, signal: null, failure: null } as const;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function initializeEvidence(parent: string): Promise<{
	checkout: string;
	directory: string;
	evidence: EvidenceDirectory;
}> {
	const canonicalParent = await realpath(parent);
	const checkout = path.join(canonicalParent, "checkout");
	const directory = path.join(canonicalParent, "evidence");
	await mkdir(checkout);
	const evidence = await createEvidenceDirectory({ checkoutRoot: checkout, directory });
	return { checkout, directory, evidence };
}

beforeEach(async () => {
	sessions = [];
	root = await mkdtemp(path.join(os.tmpdir(), "draftyak-evidence-test-"));
	({ checkout, directory, evidence } = await initializeEvidence(root));
});
afterEach(async () => {
	await disposeReaders();
	await Promise.all(
		sessions.flatMap((session) => [session.stdout.close(), session.stderr.close()]),
	);
	expect(path.basename(root)).toMatch(/^draftyak-evidence-test-/);
	expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
	await rm(root, { recursive: true, force: true });
});
async function beginCapture(handle: EvidenceDirectory, id: string): Promise<CaptureSession> {
	const session = await startCapture(handle, id);
	sessions.push(session);
	return session;
}
async function capture(
	id = "metadata",
	value = "synthetic-output",
	owner = evidence,
): Promise<NativeCaptureResult> {
	const session = await beginCapture(owner, id);
	await session.stdout.append(Buffer.from(value));
	await session.stderr.append(Buffer.from("synthetic-diagnostic"));
	return sealCapture(session, completed);
}
async function refuses(promise: Promise<unknown>, code = "EVIDENCE_REFUSED"): Promise<void> {
	await expect(promise).rejects.toMatchObject({
		name: "CaptureError",
		code,
		message: "native process capture refused",
	});
}

describe("owned evidence reader lifetime", () => {
	it("canonicalizes genuine fixture aliases before matching owned reader handles", async () => {
		const target = await mkdtemp(path.join(root, "reader-alias-"));
		let alias: string;
		if (process.platform === "win32") alias = target.toUpperCase();
		else {
			alias = path.join(root, "reader-alias-link");
			await symlink(target, alias, "dir");
		}
		expect((await realpath(alias)) === (await realpath(target))).toBe(true);
		({ checkout, directory, evidence } = await initializeEvidence(alias));
		const result = await capture("aliased");
		failReaderClose(result, 1);
		try {
			expectReadRefusal(await observeRead(evidence, result));
			expect(ownedReaders).toHaveLength(1);
			const reader = ownedReaders[0];
			if (!reader) throw new Error("Owned alias reader was not observed");
			expect(reader.closeCalls).toBe(1);
			expect((await reader.handle.stat()).isFile()).toBe(true);
			expect(evidenceReaders.evidenceReaderStatus(evidence)).toEqual({ active: 0, pending: 1 });
			expect(await evidenceReaders.closeEvidenceReaders(evidence)).toEqual({
				attempted: 1,
				closed: 1,
				active: 0,
				pending: 0,
			});
			expect(reader.closeCalls).toBe(2);
			expect(reader.handle.fd).toBe(-1);
		} finally {
			await disposeReaders();
		}
	});
	it("refuses a successful read when its actual reader close rejects and retains it for explicit retry", async () => {
		const result = await capture();
		failReaderClose(result, 1);
		try {
			let failure: unknown;
			try {
				await readCapturedBytes(evidence, result, "stdout");
			} catch (error) {
				failure = error;
			}
			expect(failure instanceof CaptureError).toBe(true);
			expect((failure as CaptureError).code).toBe("EVIDENCE_REFUSED");
			expect(ownedReaders).toHaveLength(1);
			const reader = ownedReaders[0];
			if (!reader) throw new Error("Owned reader was not observed");
			expect(reader.closeCalls).toBe(1);
			expect((await reader.handle.stat()).isFile()).toBe(true);
			const status = evidenceReaders.evidenceReaderStatus(evidence);
			expect(status).toEqual({ active: 0, pending: 1 });
			expect(Object.isFrozen(status)).toBe(true);
			expect(evidenceReaders.retainedEvidenceReaderStatus()).toEqual({ active: 0, pending: 1 });
			const closed = await evidenceReaders.closeEvidenceReaders(evidence);
			expect(closed).toEqual({ attempted: 1, closed: 1, active: 0, pending: 0 });
			expect(Object.isFrozen(closed)).toBe(true);
			expect(reader.closeCalls).toBe(2);
			expect(reader.closed).toBe(true);
			expect(reader.handle.fd).toBe(-1);
			await refuses(readCapturedBytes(evidence, result, "stdout"));
			expect(ownedReaders).toHaveLength(1);
		} finally {
			await disposeReaders();
		}
	});
	it("keeps an unsuccessful retry pending and permits resource-only global cleanup", async () => {
		const result = await capture();
		failReaderClose(result, 2);
		try {
			expectReadRefusal(await observeRead(evidence, result));
			const reader = ownedReaders[0];
			if (!reader) throw new Error("Owned reader was not observed");
			expect(await evidenceReaders.closeEvidenceReaders(evidence)).toEqual({
				attempted: 1,
				closed: 0,
				active: 0,
				pending: 1,
			});
			expect(reader.closeCalls).toBe(2);
			expect(reader.closed).toBe(false);
			expect((await reader.handle.stat()).isFile()).toBe(true);
			expect(evidenceReaders.retainedEvidenceReaderStatus()).toEqual({ active: 0, pending: 1 });
			const closed = await evidenceReaders.closeRetainedEvidenceReaders();
			expect(closed).toEqual({ attempted: 1, closed: 1, active: 0, pending: 0 });
			expect(Object.isFrozen(closed)).toBe(true);
			expect(reader.closeCalls).toBe(3);
			expect(reader.handle.fd).toBe(-1);
			expect(evidenceReaders.retainedEvidenceReaderStatus()).toEqual({ active: 0, pending: 0 });
		} finally {
			await disposeReaders();
		}
	});
	it("joins an active read before cleanup settles and fences new reader admission", async () => {
		const result = await capture();
		const reading = gate(),
			entered = gate();
		failReaderClose(result, 0, { readGate: reading, readEntered: entered });
		const read = observeRead(evidence, result);
		try {
			await reached(entered, read);
			expect(evidenceReaders.evidenceReaderStatus(evidence)).toEqual({ active: 1, pending: 1 });
			let settled = false;
			const close = evidenceReaders.closeEvidenceReaders(evidence);
			void close.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			const concurrent = evidenceReaders.closeEvidenceReaders(evidence);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			expect(ownedReaders[0]?.closeCalls).toBe(0);
			expectReadRefusal(await observeRead(evidence, result));
			expect(ownedReaders).toHaveLength(1);
			reading.release();
			expectReadRefusal(await read);
			const expected = { attempted: 1, closed: 1, active: 0, pending: 0 };
			expect(await close).toEqual(expected);
			expect(await concurrent).toEqual(expected);
			expect(ownedReaders[0]?.closeCalls).toBe(1);
			expect(ownedReaders[0]?.handle.fd).toBe(-1);
		} finally {
			await disposeReaders();
		}
	});
	it("keeps a finally-close active and prevents duplicate concurrent cleanup closes", async () => {
		const result = await capture();
		const closing = gate(),
			entered = gate();
		failReaderClose(result, 0, { closeGate: closing, closeEntered: entered });
		const read = observeRead(evidence, result);
		try {
			await reached(entered, read);
			expect(evidenceReaders.evidenceReaderStatus(evidence)).toEqual({ active: 1, pending: 1 });
			let settled = false;
			const close = evidenceReaders.closeEvidenceReaders(evidence);
			void close.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			const concurrent = evidenceReaders.closeEvidenceReaders(evidence);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			expect(ownedReaders[0]?.closeCalls).toBe(1);
			expectReadRefusal(await observeRead(evidence, result));
			closing.release();
			expectReadRefusal(await read);
			const expected = { attempted: 1, closed: 1, active: 0, pending: 0 };
			expect(await close).toEqual(expected);
			expect(await concurrent).toEqual(expected);
			expect(ownedReaders[0]?.closeCalls).toBe(1);
			expect(ownedReaders[0]?.handle.fd).toBe(-1);
		} finally {
			await disposeReaders();
		}
	});
	it("joins a failed active close once and requires a later explicit retry", async () => {
		const result = await capture();
		const closing = gate(),
			entered = gate();
		failReaderClose(result, 1, { closeGate: closing, closeEntered: entered });
		const read = observeRead(evidence, result);
		try {
			await reached(entered, read);
			const close = evidenceReaders.closeEvidenceReaders(evidence);
			void close.catch(() => undefined);
			closing.release();
			expectReadRefusal(await read);
			expect(await close).toEqual({ attempted: 1, closed: 0, active: 0, pending: 1 });
			expect(ownedReaders[0]?.closeCalls).toBe(1);
			expect(await evidenceReaders.closeEvidenceReaders(evidence)).toEqual({
				attempted: 1,
				closed: 1,
				active: 0,
				pending: 0,
			});
			expect(ownedReaders[0]?.closeCalls).toBe(2);
		} finally {
			await disposeReaders();
		}
	});
	it("refuses forged reader owners and capture identities without fencing the genuine owner", async () => {
		const result = await capture();
		let traps = 0;
		const forged = { ...evidence };
		const proxy = new Proxy(evidence, {
			get: () => {
				traps++;
				throw new Error("Unexpected owner trap");
			},
		});
		for (const owner of [forged, proxy]) {
			expect(() => evidenceReaders.evidenceReaderStatus(owner)).toThrow(CaptureError);
			await refuses(evidenceReaders.closeEvidenceReaders(owner));
			await refuses(readCapturedBytes(owner, result, "stdout"));
		}
		await refuses(readCapturedBytes(evidence, { ...result }, "stdout"));
		const other = await createEvidenceDirectory({
			checkoutRoot: checkout,
			directory: path.join(root, "other-reader-evidence"),
		});
		await refuses(readCapturedBytes(other, result, "stdout"));
		expect(traps).toBe(0);
		expect(evidenceReaders.retainedEvidenceReaderStatus()).toEqual({ active: 0, pending: 0 });
		expect(Buffer.from(await readCapturedBytes(evidence, result, "stdout")).toString()).toBe(
			"synthetic-output",
		);
		expect(evidenceReaders.evidenceReaderStatus(evidence)).toEqual({ active: 0, pending: 0 });
	});
	it("reserves at most 32 readers and retains failed handles against global admission capacity", async () => {
		const result = await capture();
		const reading = gate(),
			entered = gate();
		let arrivals = 0;
		failReaderClose(result, 1, {
			readGate: reading,
			onFirstRead: () => {
				if (++arrivals === 32) entered.release();
			},
		});
		const reads = Array.from({ length: 32 }, () => observeRead(evidence, result));
		try {
			await Promise.race([
				entered.promise,
				...reads.map((read) =>
					read.then(() => {
						throw new Error("Reader settled before capacity gates");
					}),
				),
			]);
			expect(evidenceReaders.retainedEvidenceReaderStatus()).toEqual({ active: 32, pending: 32 });
			expectReadRefusal(await observeRead(evidence, result));
			expect(ownedReaders).toHaveLength(32);
			reading.release();
			for (const observed of await Promise.all(reads)) expectReadRefusal(observed);
			expect(evidenceReaders.retainedEvidenceReaderStatus()).toEqual({ active: 0, pending: 32 });
			const other = await createEvidenceDirectory({
				checkoutRoot: checkout,
				directory: path.join(root, "capacity-evidence"),
			});
			const another = await capture("other", "synthetic-other", other);
			expectReadRefusal(await observeRead(other, another));
			expect(await evidenceReaders.closeRetainedEvidenceReaders()).toEqual({
				attempted: 32,
				closed: 32,
				active: 0,
				pending: 0,
			});
			expect(
				ownedReaders.every((reader) => reader.closeCalls === 2 && reader.handle.fd === -1),
			).toBe(true);
			expect(Buffer.from(await readCapturedBytes(other, another, "stdout")).toString()).toBe(
				"synthetic-other",
			);
		} finally {
			await disposeReaders();
		}
	});
});

describe("native metadata file bridge", () => {
	it("uses the live private file and returns only the consumer's result", async () => {
		const result = await capture();
		const observed = await withCapturedFile(evidence, result, "stdout", async (filename) => {
			expect(filename).toBe(await realpath(path.join(directory, result.stdout.file)));
			return (await readFile(filename)).toString();
		});
		expect(observed).toBe("synthetic-output");
	});
	it("refuses a serialized capture before calling the consumer", async () => {
		const result = await capture();
		let called = false;
		await refuses(
			withCapturedFile(evidence, { ...result }, "stdout", async () => {
				called = true;
			}),
		);
		expect(called).toBe(false);
	});
	it.each([false, true])("rechecks bytes after an awaited consumer, thrown=%s", async (throws) => {
		const result = await capture();
		await refuses(
			withCapturedFile(evidence, result, "stdout", async (filename) => {
				await writeFile(filename, "changed-after-capture");
				if (throws) throw new Error("synthetic private consumer failure");
				return "ignored";
			}),
		);
	});
});

describe("exclusive external evidence", () => {
	it("creates a private fresh run and separate bounded digest records", async () => {
		const result = await capture();
		expect(Object.isFrozen(evidence)).toBe(true);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.stdout)).toBe(true);
		expect(result.runId).toBe(evidence.runId);
		expect(result.stdout).toEqual({
			file: "capture-metadata.stdout.bin",
			bytes: 16,
			sha256: digest(Buffer.from("synthetic-output")),
		});
		expect(Buffer.from(await readCapturedBytes(evidence, result, "stdout")).toString()).toBe(
			"synthetic-output",
		);
		expect(Buffer.from(await readCapturedBytes(evidence, result, "stderr")).toString()).toBe(
			"synthetic-diagnostic",
		);
		expect(JSON.stringify(result)).not.toContain(directory);
		expect(JSON.stringify(result)).not.toContain("synthetic-output");
		if (process.platform !== "win32") {
			expect((await lstat(directory)).mode & 0o777).toBe(0o700);
			expect((await lstat(path.join(directory, result.stdout.file))).mode & 0o777).toBe(0o600);
		}
	});
	it("refuses an existing directory without changing its content", async () => {
		await writeFile(path.join(directory, "preserved"), "synthetic-original");
		await refuses(createEvidenceDirectory({ checkoutRoot: checkout, directory }));
		expect(await readFile(path.join(directory, "preserved"), "utf8")).toBe("synthetic-original");
	});
	it("refuses checkout containment, including another checkout", async () => {
		await refuses(
			createEvidenceDirectory({
				checkoutRoot: checkout,
				directory: path.join(checkout, "captures"),
			}),
		);
		const other = path.join(root, "other");
		await mkdir(other);
		await writeFile(path.join(other, ".git"), "synthetic checkout marker");
		await refuses(
			createEvidenceDirectory({ checkoutRoot: checkout, directory: path.join(other, "captures") }),
		);
	});
	it("refuses ambiguous, relative and traversal paths", async () => {
		for (const candidate of [
			"relative",
			`${root + path.sep}..${path.sep}escape`,
			`${root + path.sep}.${path.sep}escape`,
			"//synthetic/remote/capture",
			`${root}\0ignored`,
		]) {
			await refuses(createEvidenceDirectory({ checkoutRoot: checkout, directory: candidate }));
		}
	});
	it("refuses a directory link and a linked ancestor", async () => {
		const alias = path.join(root, "alias");
		await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
		await refuses(createEvidenceDirectory({ checkoutRoot: checkout, directory: alias }));
		await refuses(
			createEvidenceDirectory({ checkoutRoot: checkout, directory: path.join(alias, "child") }),
		);
	});
	it("refuses replacement of a registered evidence directory", async () => {
		await rename(directory, `${directory}-old`);
		await mkdir(directory);
		await refuses(beginCapture(evidence, "metadata"));
	});
	it("does not overwrite a preexisting capture file", async () => {
		const file = path.join(directory, "capture-metadata.stdout.bin");
		await writeFile(file, "synthetic-original");
		await refuses(beginCapture(evidence, "metadata"));
		expect(await readFile(file, "utf8")).toBe("synthetic-original");
	});
	it("does not reuse an ID, even when the previous capture completed", async () => {
		await capture();
		await refuses(beginCapture(evidence, "metadata"));
	});
	it("rejects path syntax and all final line terminators in capture IDs", async () => {
		for (const id of [
			"",
			"../metadata",
			"a/b",
			"A",
			"-a",
			"a".repeat(49),
			"metadata\n",
			"metadata\r",
			"metadata\u2028",
			"metadata\u2029",
		]) {
			await refuses(beginCapture(evidence, id));
		}
	});
	it("bounds the number of captures", async () => {
		for (let index = 0; index < 32; index++) {
			await sealCapture(await beginCapture(evidence, `item-${index}`), completed);
		}
		await refuses(beginCapture(evidence, "overflow"));
	});
	it("does not accept a fabricated run handle", async () => {
		await refuses(beginCapture({ runId: evidence.runId }, "metadata"));
	});
});

describe("bounded capture bytes", () => {
	it.each(["stdout", "stderr"] as const)(
		"accepts the exact %s cap and refuses cap plus one before writing",
		async (stream) => {
			const limit = stream === "stdout" ? STDOUT_LIMIT : STDERR_LIMIT;
			const code = stream === "stdout" ? "STDOUT_LIMIT" : "STDERR_LIMIT";
			const session = await beginCapture(evidence, "boundary");
			await session[stream].append(Buffer.alloc(limit, 0x61));
			await refuses(session[stream].append(Buffer.from("b")), code);
			const result = await sealCapture(session, completed);
			expect(result[stream].bytes).toBe(limit);
			expect((await lstat(path.join(directory, result[stream].file))).size).toBe(limit);
			expect(await readCapturedBytes(evidence, result, stream)).toHaveLength(limit);
		},
	);
	it("uses actual Buffer extents and ignores shadowed metadata", async () => {
		const session = await beginCapture(evidence, "native-view");
		const backing = Buffer.from("prefix-valid-suffix");
		const view = backing.subarray(7, 12);
		Object.defineProperties(view, {
			byteLength: {
				get: () => {
					throw new Error("synthetic shadow");
				},
			},
			byteOffset: { value: 0 },
			buffer: { value: new ArrayBuffer(0) },
		});
		await session.stdout.append(view);
		const result = await sealCapture(session, completed);
		expect(result.stdout.bytes).toBe(5);
		expect(Buffer.from(await readCapturedBytes(evidence, result, "stdout")).toString()).toBe(
			"valid",
		);
	});
	it("does not let a shadow length bypass the cap", async () => {
		const session = await beginCapture(evidence, "shadow-cap");
		const bytes = Buffer.alloc(STDERR_LIMIT + 1);
		Object.defineProperty(bytes, "byteLength", { value: 0 });
		await refuses(session.stderr.append(bytes), "STDERR_LIMIT");
		const result = await sealCapture(session, completed);
		expect(result.stderr.bytes).toBe(0);
	});
	it("refuses a non-Buffer chunk and concurrent writes", async () => {
		const session = await beginCapture(evidence, "bad-chunk");
		await refuses(session.stdout.append(new Uint8Array([1])), "CAPTURE_IO");
		const first = session.stdout.append(Buffer.from("synthetic"));
		await refuses(session.stdout.append(Buffer.from("second")), "CAPTURE_IO");
		await first;
		await sealCapture(session, completed);
	});
	it("does not seal a fabricated or reused session", async () => {
		const session = await beginCapture(evidence, "once");
		await refuses(sealCapture({ ...session }, completed));
		await sealCapture(session, completed);
		await refuses(sealCapture(session, completed));
	});
});

describe("capture provenance and rereads", () => {
	it("refuses deserialized records and cross-run records", async () => {
		const result = await capture();
		await refuses(readCapturedBytes(evidence, JSON.parse(JSON.stringify(result)), "stdout"));
		const other = await createEvidenceDirectory({
			checkoutRoot: checkout,
			directory: path.join(root, "other-evidence"),
		});
		await refuses(readCapturedBytes(other, result, "stdout"));
	});
	it("refuses changed bytes even when identity and length are unchanged", async () => {
		const result = await capture();
		await writeFile(path.join(directory, result.stdout.file), "synthetic-change");
		await refuses(readCapturedBytes(evidence, result, "stdout"));
	});
	it("refuses replacement, truncation, growth and hard links", async () => {
		for (const mode of ["replace", "truncate", "grow", "link"] as const) {
			const result = await capture(mode);
			const file = path.join(directory, result.stdout.file);
			if (mode === "replace") {
				await rename(file, `${file}-old`);
				await writeFile(file, "synthetic-output");
			} else if (mode === "link") {
				await link(file, `${file}-link`);
			} else {
				await writeFile(file, mode === "truncate" ? "" : "synthetic-output-extra");
			}
			await refuses(readCapturedBytes(evidence, result, "stdout"));
		}
	});
	it("refuses a changed evidence directory during reread", async () => {
		const result = await capture();
		await rename(directory, `${directory}-old`);
		await symlink(`${directory}-old`, directory, process.platform === "win32" ? "junction" : "dir");
		await refuses(readCapturedBytes(evidence, result, "stdout"));
	});
	it("retains nonzero completion and refuses incomplete capture data", async () => {
		const nonzero = await sealCapture(await beginCapture(evidence, "nonzero"), {
			exitCode: 7,
			signal: null,
			failure: null,
		});
		expect(nonzero.exitCode).toBe(7);
		expect(await readCapturedBytes(evidence, nonzero, "stdout")).toHaveLength(0);
		const failed = await sealCapture(await beginCapture(evidence, "failed"), {
			exitCode: 7,
			signal: null,
			failure: "CAPTURE_IO",
		});
		expect(failed.exitCode).toBe(7);
		await refuses(readCapturedBytes(evidence, failed, "stdout"));
	});
	it("exposes only fixed errors when a filesystem operation fails", async () => {
		await rm(directory, { recursive: true });
		try {
			await beginCapture(evidence, "metadata");
			expect.fail("missing evidence must refuse");
		} catch (error) {
			expect(error).toBeInstanceOf(CaptureError);
			expect(String(error)).toBe("CaptureError: native process capture refused");
			expect(JSON.stringify(error)).not.toContain(root);
		}
	});
});
