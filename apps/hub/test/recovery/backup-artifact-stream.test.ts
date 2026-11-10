import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
	BackupArtifactError,
	decodeBackupArtifactHeader,
	encodeBackupArtifactHeader,
} from "../../src/recovery/backup-artifact.ts";
import {
	type BackupArtifactStream,
	createBackupArtifactStream,
} from "../../src/recovery/backup-artifact-stream.ts";

const BODY = Buffer.from([11, 22, 33]);
const handles: BackupArtifactStream[] = [];
const releases: (() => void)[] = [];
const disarms: (() => void)[] = [];
const pending: Promise<unknown>[] = [];
const sha = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

// Invented encrypted DATA grammar; no capsule, binding or header is authenticated by this fixture.
function header(length = BODY.length, digest = sha(BODY)): Buffer {
	const capsule = Buffer.alloc(94, 17);
	Buffer.from("draftyak-recovery").copy(capsule);
	capsule[17] = 1;
	const binding = Buffer.alloc(69, 29);
	binding.set([0x44, 0x59, 0x52, 0x42, 1]);
	try {
		return encodeBackupArtifactHeader(capsule, binding, length, digest);
	} finally {
		capsule.fill(0);
		binding.fill(0);
	}
}

function stream(prefix: unknown, image: AsyncIterable<unknown>): BackupArtifactStream {
	const value = createBackupArtifactStream(prefix, image);
	handles.push(value);
	return value;
}

function probe(chunks: readonly unknown[], failAtEnd = false) {
	let offset = 0;
	const counts = { acquired: 0, next: 0, returned: 0 };
	const iterator: AsyncIterator<unknown> = {
		async next() {
			counts.next++;
			if (offset < chunks.length) return { done: false, value: chunks[offset++] };
			if (failAtEnd) throw new Error("DYTEST upstream DATA failure");
			return { done: true, value: undefined };
		},
		async return() {
			counts.returned++;
			return { done: true, value: undefined };
		},
	};
	return {
		counts,
		iterator,
		image: {
			[Symbol.asyncIterator]() {
				counts.acquired++;
				return iterator;
			},
		},
	};
}

function barrier() {
	let enter = () => {};
	let release = () => {};
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	releases.push(release);
	return { entered, wait, enter, release };
}

function track<T>(value: Promise<T>): Promise<T> {
	pending.push(value);
	void value.catch(() => undefined);
	return value;
}

async function refused(work: () => unknown): Promise<void> {
	let error: unknown;
	try {
		await work();
	} catch (reason) {
		error = reason;
	}
	expect(error).toBeInstanceOf(BackupArtifactError);
	expect(error).toMatchObject({
		code: "BACKUP_ARTIFACT_UNAVAILABLE",
		message: "Backup artifact unavailable",
	});
	expect(Object.hasOwn(error as object, "cause")).toBe(false);
}

async function bodyIterator(value: BackupArtifactStream): Promise<AsyncIterator<Uint8Array>> {
	const iterator = value.bytes()[Symbol.asyncIterator]();
	const prefix = await iterator.next();
	expect(prefix.done).toBe(false);
	expect(prefix.value).toHaveLength(208);
	return iterator;
}

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const disarm of disarms.splice(0)) disarm();
	await Promise.allSettled(pending.splice(0));
	const results = await Promise.allSettled(handles.splice(0).map((value) => value.close()));
	expect(results.every((result) => result.status === "fulfilled")).toBe(true);
});

it("assembles owned framing and copied ciphertext only after genuine upstream EOF", async () => {
	const input = Buffer.from(BODY);
	const prefix = header();
	const originalPrefix = Buffer.from(prefix);
	const source = probe([input]);
	const value = stream(prefix, source.image);
	prefix.fill(0);
	const iterator = value.bytes()[Symbol.asyncIterator]();
	const first = await iterator.next();
	expect(Buffer.from(first.value ?? []).equals(originalPrefix)).toBe(true);
	const part = await iterator.next();
	expect(part.done).toBe(false);
	expect(Buffer.from(part.value ?? []).equals(BODY)).toBe(true);
	input.fill(99);
	expect(Buffer.from(part.value ?? []).equals(BODY)).toBe(true);
	const body = Buffer.from(part.value ?? []);
	part.value?.fill(44);
	expect(input.equals(Buffer.alloc(3, 99))).toBe(true);
	const end = await iterator.next();
	expect(end.done).toBe(true);
	expect(source.counts).toEqual({ acquired: 1, next: 2, returned: 1 });
	const artifact = Buffer.concat([Buffer.from(first.value ?? []), body]);
	const decoded = decodeBackupArtifactHeader(artifact.subarray(0, 208));
	expect(decoded.byteLength).toBe(artifact.length - 208);
	expect(decoded.sha256).toBe(sha(artifact.subarray(208)));
	decoded.capsule.fill(0);
	decoded.binding.fill(0);
	await value.close();
	expect(source.counts.next).toBe(2);
});

const oversized = Buffer.alloc(65_537, 7);
const shared = new Uint8Array(new SharedArrayBuffer(3));
const detachedBacking = new ArrayBuffer(3);
const detached = new Uint8Array(detachedBacking);
detached.set(BODY);
structuredClone(detachedBacking, { transfer: [detachedBacking] });
const invalid = [
	{
		name: "truncation",
		chunks: [BODY.subarray(0, 2)],
		length: 3,
		digest: sha(BODY.subarray(0, 2)),
		yielded: 2,
	},
	{
		name: "overrun",
		chunks: [BODY, Buffer.from([44])],
		length: 3,
		digest: sha(Buffer.from([11, 22, 33, 44])),
		yielded: 3,
	},
	{
		name: "oversize chunk",
		chunks: [oversized],
		length: oversized.length,
		digest: sha(oversized),
		yielded: 0,
	},
	{
		name: "empty chunk",
		chunks: [Buffer.alloc(0), BODY],
		length: 3,
		digest: sha(BODY),
		yielded: 0,
	},
	{
		name: "other byte view",
		chunks: [new DataView(BODY.buffer)],
		length: 3,
		digest: sha(BODY),
		yielded: 0,
	},
	{ name: "shared chunk", chunks: [shared], length: 3, digest: sha(shared), yielded: 0 },
	{ name: "detached chunk", chunks: [detached], length: 3, digest: sha(BODY), yielded: 0 },
	{ name: "wrong digest", chunks: [BODY], length: 3, digest: "0".repeat(64), yielded: 3 },
	{
		name: "upstream rejection",
		chunks: [BODY],
		length: 3,
		digest: sha(BODY),
		yielded: 3,
		fail: true,
	},
];

it.each(invalid)("refuses $name without accepting a completed artifact", async (test) => {
	const source = probe(test.chunks, test.fail);
	const value = stream(header(test.length, test.digest), source.image);
	const iterator = await bodyIterator(value);
	let yielded = 0;
	await refused(async () => {
		for (;;) {
			const part = await iterator.next();
			if (part.done) break;
			yielded += part.value.byteLength;
		}
	});
	expect(yielded).toBe(test.yielded);
	expect(source.counts.returned).toBe(1);
	await value.close();
});

it("keeps the producer inert and never opens it for unused cancellation", async () => {
	let gets = 0;
	const image = {
		get [Symbol.asyncIterator](): () => AsyncIterator<unknown> {
			gets++;
			throw new Error("DYTEST lazy DATA getter");
		},
	};
	const value = stream(header(), image);
	expect(gets).toBe(0);
	const bytes = value.bytes();
	expect(gets).toBe(0);
	await refused(() => value.bytes());
	const iterator = bytes[Symbol.asyncIterator]();
	await refused(() => bytes[Symbol.asyncIterator]());
	await iterator.next();
	expect(gets).toBe(0);
	await iterator.return?.();
	expect(gets).toBe(0);
	await refused(() => iterator.next());
});

it("rejects a proxy header without caller hooks or source acquisition", async () => {
	let traps = 0;
	const source = probe([BODY]);
	const proxy = new Proxy(header(), {
		get() {
			traps++;
			throw new Error("DYTEST header property trap");
		},
	});
	await refused(() => createBackupArtifactStream(proxy, source.image));
	expect(traps).toBe(0);
	expect(source.counts.acquired).toBe(0);
});

it("requires genuine EOF after the declared bytes", async () => {
	const eof = barrier();
	const source = probe([BODY]);
	source.iterator.next = async () => {
		source.counts.next++;
		if (source.counts.next === 1) return { done: false, value: BODY };
		eof.enter();
		await eof.wait;
		return { done: true, value: undefined };
	};
	const value = stream(header(), source.image);
	const iterator = await bodyIterator(value);
	await iterator.next();
	let settled = false;
	const final = track(iterator.next());
	void final.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await eof.entered;
	expect(settled).toBe(false);
	expect(source.counts.next).toBe(2);
	eof.release();
	expect((await final).done).toBe(true);
	expect(source.counts.returned).toBe(1);
});

it("close fences immediately and joins pending next plus source return", async () => {
	const reading = barrier();
	const returning = barrier();
	const source = probe([]);
	source.iterator.next = async () => {
		source.counts.next++;
		reading.enter();
		await reading.wait;
		return { done: false, value: BODY };
	};
	source.iterator.return = async () => {
		source.counts.returned++;
		returning.enter();
		await returning.wait;
		return { done: true, value: undefined };
	};
	const value = stream(header(), source.image);
	const iterator = await bodyIterator(value);
	const pulling = track(iterator.next());
	await reading.entered;
	let closed = false;
	const closing = track(value.close());
	expect(value.close()).toBe(closing);
	void closing.then(
		() => {
			closed = true;
		},
		() => {
			closed = true;
		},
	);
	await refused(() => value.bytes());
	expect(closed).toBe(false);
	reading.release();
	await returning.entered;
	expect(closed).toBe(false);
	expect(source.counts).toEqual({ acquired: 1, next: 1, returned: 1 });
	returning.release();
	await refused(() => pulling);
	await closing;
	expect(closed).toBe(true);
	await refused(() => iterator.next());
});

it("consumer return waits for source finalization without another read", async () => {
	const returning = barrier();
	const source = probe([BODY]);
	source.iterator.return = async () => {
		source.counts.returned++;
		returning.enter();
		await returning.wait;
		return { done: true, value: undefined };
	};
	const value = stream(header(), source.image);
	const iterator = await bodyIterator(value);
	await iterator.next();
	let settled = false;
	const cancelled = track(iterator.return?.() ?? Promise.reject(new Error("DYTEST no return")));
	void cancelled.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await returning.entered;
	expect(settled).toBe(false);
	expect(source.counts.next).toBe(1);
	returning.release();
	expect((await cancelled).done).toBe(true);
	await refused(() => iterator.next());
});

it("retains the original failed return method and retries only cleanup through close", async () => {
	let blocked = true;
	disarms.push(() => {
		blocked = false;
	});
	const source = probe([BODY]);
	const originalIterator = source.iterator;
	originalIterator.return = async function (this: AsyncIterator<unknown>) {
		expect(this).toBe(originalIterator);
		source.counts.returned++;
		if (blocked) throw new Error("DYTEST retained return failure");
		return { done: true, value: undefined };
	};
	const value = stream(header(), source.image);
	const iterator = await bodyIterator(value);
	await iterator.next();
	await refused(() => iterator.return?.());
	expect(source.counts.returned).toBe(1);
	originalIterator.return = async () => {
		throw new Error("DYTEST replacement must not run");
	};
	await refused(() => value.close());
	expect(source.counts.returned).toBe(2);
	expect(source.counts.next).toBe(1);
	blocked = false;
	await value.close();
	expect(source.counts).toEqual({ acquired: 1, next: 1, returned: 3 });
});

it("registers the iterator cleanup before a next getter can fail", async () => {
	const returning = barrier();
	let gets = 0;
	let returns = 0;
	const iterator: AsyncIterator<unknown> = {
		get next(): AsyncIterator<unknown>["next"] {
			gets++;
			throw new Error("DYTEST next getter failure");
		},
		async return() {
			returns++;
			returning.enter();
			await returning.wait;
			return { done: true, value: undefined };
		},
	};
	const value = stream(header(), { [Symbol.asyncIterator]: () => iterator });
	const consuming = await bodyIterator(value);
	const pulling = track(consuming.next());
	await returning.entered;
	expect(gets).toBe(1);
	expect(returns).toBe(1);
	const closing = track(value.close());
	returning.release();
	await refused(() => pulling);
	await closing;
	expect(returns).toBe(1);
});

it("does not accept an incomplete return as completed cleanup", async () => {
	let calls = 0;
	const source = probe([BODY]);
	source.iterator.return = async () => {
		calls++;
		return { done: calls !== 1, value: undefined };
	};
	const value = stream(header(), source.image);
	const iterator = await bodyIterator(value);
	await iterator.next();
	await refused(() => iterator.return?.());
	expect(calls).toBe(1);
	await value.close();
	expect(calls).toBe(2);
	expect(source.counts.next).toBe(1);
});

it("accepts the exact chunk boundary with a separate final ciphertext byte", async () => {
	const body = Buffer.alloc(65_537, 55);
	const source = probe([body.subarray(0, 65_536), body.subarray(65_536)]);
	const value = stream(header(body.length, sha(body)), source.image);
	const iterator = await bodyIterator(value);
	expect((await iterator.next()).value).toHaveLength(65_536);
	expect((await iterator.next()).value).toHaveLength(1);
	expect((await iterator.next()).done).toBe(true);
	expect(source.counts).toEqual({ acquired: 1, next: 3, returned: 1 });
});

it("uses byte intrinsics without observing caller getters and rejects proxy chunks", async () => {
	let gets = 0;
	const chunk = Uint8Array.from(BODY);
	for (const name of ["byteLength", "buffer"])
		Object.defineProperty(chunk, name, {
			get() {
				gets++;
				throw new Error("DYTEST byte property trap");
			},
		});
	const source = probe([chunk]);
	const value = stream(header(), source.image);
	const iterator = await bodyIterator(value);
	expect(Buffer.from((await iterator.next()).value ?? []).equals(BODY)).toBe(true);
	expect((await iterator.next()).done).toBe(true);
	expect(gets).toBe(0);
	const proxy = new Proxy(Uint8Array.from(BODY), {
		get() {
			gets++;
			throw new Error("DYTEST proxy chunk trap");
		},
	});
	const invalidSource = probe([proxy]);
	const invalidStream = stream(header(), invalidSource.image);
	const invalidIterator = await bodyIterator(invalidStream);
	await refused(() => invalidIterator.next());
	expect(gets).toBe(0);
	expect(invalidSource.counts.returned).toBe(1);
});

it.each(["iterator getter", "iterator factory", "done", "value"] as const)(
	"fences reentrant close from the %s boundary before emitting body bytes",
	async (boundary) => {
		let value: BackupArtifactStream;
		let closing: Promise<void> | undefined;
		let factories = 0;
		const source = probe([BODY]);
		const stop = () => {
			closing = track(value.close());
		};
		if (boundary === "done" || boundary === "value")
			source.iterator.next = async () => {
				source.counts.next++;
				const result = { done: false, value: BODY };
				Object.defineProperty(result, boundary, {
					get() {
						stop();
						return boundary === "done" ? false : BODY;
					},
				});
				return result;
			};
		const image: AsyncIterable<unknown> = {
			get [Symbol.asyncIterator]() {
				if (boundary === "iterator getter") stop();
				return () => {
					factories++;
					if (boundary === "iterator factory") stop();
					return source.iterator;
				};
			},
		};
		value = stream(header(), image);
		const iterator = await bodyIterator(value);
		await refused(() => iterator.next());
		expect(closing).toBeDefined();
		await closing;
		expect(factories).toBe(boundary === "iterator getter" ? 0 : 1);
		expect(source.counts.next).toBe(boundary === "done" || boundary === "value" ? 1 : 0);
		expect(source.counts.returned).toBe(boundary === "iterator getter" ? 0 : 1);
		await refused(() => iterator.next());
	},
);

it.each(["failure", "close", "success"] as const)(
	"settles queued reads through %s without inventing completion",
	async (ending) => {
		const reading = barrier();
		const source = probe([]);
		source.iterator.next = async () => {
			const offset = ++source.counts.next;
			if (offset === 1) {
				reading.enter();
				await reading.wait;
			}
			if (ending === "failure") throw new Error("DYTEST queued source failure");
			return offset === 1 ? { done: false, value: BODY } : { done: true, value: undefined };
		};
		const value = stream(header(), source.image);
		const iterator = await bodyIterator(value);
		const first = track(iterator.next());
		await reading.entered;
		const second = track(iterator.next());
		const closing = ending === "close" ? track(value.close()) : undefined;
		reading.release();
		if (ending === "success") {
			const part = await first;
			expect(part.done).toBe(false);
			expect(Buffer.from(part.value ?? []).equals(BODY)).toBe(true);
			expect((await second).done).toBe(true);
		} else {
			await refused(() => first);
			await refused(() => second);
		}
		if (closing) await closing;
		else await value.close();
		expect(source.counts).toEqual({
			acquired: 1,
			next: ending === "success" ? 2 : 1,
			returned: 1,
		});
	},
);

it("does not report EOF when source finalization closes the actual stream", async () => {
	let value: BackupArtifactStream;
	let closing: Promise<void> | undefined;
	const source = probe([BODY]);
	source.iterator.return = async () => {
		source.counts.returned++;
		closing = track(value.close());
		return { done: true, value: undefined };
	};
	value = stream(header(), source.image);
	const iterator = await bodyIterator(value);
	expect((await iterator.next()).done).toBe(false);
	await refused(() => iterator.next());
	expect(closing).toBeDefined();
	await closing;
	expect(source.counts).toEqual({ acquired: 1, next: 2, returned: 1 });
});
