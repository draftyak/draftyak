import { createHash } from "node:crypto";
import {
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

let root: string;
let checkout: string;
let directory: string;
let evidence: EvidenceDirectory;
let sessions: CaptureSession[];
const completed = { exitCode: 0, signal: null, failure: null } as const;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

beforeEach(async () => {
	sessions = [];
	root = await mkdtemp(path.join(os.tmpdir(), "draftyak-evidence-test-"));
	checkout = path.join(root, "checkout");
	directory = path.join(root, "evidence");
	await mkdir(checkout);
	evidence = await createEvidenceDirectory({ checkoutRoot: checkout, directory });
});
afterEach(async () => {
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
async function capture(id = "metadata", value = "synthetic-output"): Promise<NativeCaptureResult> {
	const session = await beginCapture(evidence, id);
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
