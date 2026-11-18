import { createHash } from "node:crypto";
import type { BackupManifest } from "@draftyak/extensions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	captureNativeBackupTarget,
	NativeBackupTargetError,
	putNativeBackupTarget,
} from "../../src/extensions/registry.ts";
import {
	createNativeBackupTargetFixture,
	type NativeBackupTargetFixture,
} from "./native-backup-target-fixture.ts";

const name = "backup-1.dyb";
const ciphertext = [Buffer.from([11, 22, 33]), Buffer.from([44, 55])] as const;
const manifest: BackupManifest = {
	name,
	createdAt: 1,
	accounts: [],
	dataClasses: [],
	sha256: createHash("sha256").update(Buffer.concat(ciphertext)).digest("hex"),
	bytes: 5,
};
let fixtures: NativeBackupTargetFixture[];
let releases: (() => void)[];

beforeEach(() => {
	fixtures = [];
	releases = [];
});
afterEach(async () => {
	for (const release of releases) release();
	const closed = await Promise.allSettled(fixtures.map((fixture) => fixture.close()));
	expect(closed.every((result) => result.status === "fulfilled")).toBe(true);
});

async function fixture() {
	const f = await createNativeBackupTargetFixture();
	fixtures.push(f);
	return { f, target: captureNativeBackupTarget(f.host, f.targetId) };
}

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	releases.push(release);
	return { promise, release };
}

async function* sealed(): AsyncIterable<Uint8Array> {
	yield* ciphertext;
}

function completion(operation: Promise<void>): () => boolean {
	let completed = false;
	void operation.then(
		() => {
			completed = true;
		},
		() => {
			completed = true;
		},
	);
	return () => completed;
}

async function refused(operation: Promise<void>): Promise<void> {
	const error = await operation.then(
		() => null,
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(NativeBackupTargetError);
	expect(error).toMatchObject({
		name: "NativeBackupTargetError",
		code: "BACKUP_TARGET_UNAVAILABLE",
		message: "Backup target unavailable",
	});
	expect(Object.hasOwn(error as object, "cause")).toBe(false);
}

it("uses the captured real provider method and receiver with the exact sealed delivery DATA", async () => {
	const { f, target } = await fixture();
	const replacement = vi.fn(async () => {
		throw new Error("DYTEST replacement put");
	});
	f.provider.put = replacement;
	await f.track(putNativeBackupTarget(target, f.host, name, sealed(), manifest));
	expect(replacement).not.toHaveBeenCalled();
	expect(f.calls).toHaveLength(1);
	expect(f.calls[0]?.receiver).toBe(f.provider);
	expect(f.calls[0]).toMatchObject({ name, manifest, chunks: ciphertext });
	expect(f.received).toEqual(ciphertext);
});

it("joins a real provider paused before its first read after the host closes", async () => {
	const { f, target } = await fixture();
	const pause = f.pause("before");
	let pulls = 0;
	async function* source() {
		pulls++;
		yield ciphertext[0];
	}
	const delivering = f.track(putNativeBackupTarget(target, f.host, name, source(), manifest));
	const completed = completion(delivering);
	await pause.entered;
	f.host.close();
	await Promise.resolve();
	expect(completed()).toBe(false);
	expect(f.calls).toHaveLength(1);
	expect(f.received).toEqual([]);
	pause.release();
	await refused(delivering);
	expect(pulls).toBe(0);
	expect(f.received).toEqual([]);
});

it("stops before requesting another source chunk after the provider has taken one", async () => {
	const { f, target } = await fixture();
	const pause = f.pause("chunk");
	let pulls = 0;
	async function* source() {
		for (const chunk of ciphertext) {
			pulls++;
			yield chunk;
		}
	}
	const delivering = f.track(putNativeBackupTarget(target, f.host, name, source(), manifest));
	await pause.entered;
	expect(f.received).toEqual(ciphertext.slice(0, 1));
	f.host.close();
	pause.release();
	await refused(delivering);
	expect(pulls).toBe(1);
	expect(f.received).toEqual(ciphertext.slice(0, 1));
});

it("refuses a late result without claiming already received ciphertext was rolled back", async () => {
	const { f, target } = await fixture();
	const pause = f.pause("after");
	const delivering = f.track(putNativeBackupTarget(target, f.host, name, sealed(), manifest));
	const completed = completion(delivering);
	await pause.entered;
	expect(f.received).toEqual(ciphertext);
	f.host.close();
	await Promise.resolve();
	expect(completed()).toBe(false);
	pause.release();
	await refused(delivering);
	expect(f.calls).toHaveLength(1);
	expect(f.calls[0]).toMatchObject({ name, manifest, chunks: ciphertext });
	expect(f.received).toEqual(ciphertext);
});

it("checks closure after awaiting the original iterator next before exposing its yielded bytes", async () => {
	const { f, target } = await fixture();
	const entered = gate(),
		resume = gate();
	let finished = false;
	async function* source() {
		try {
			entered.release();
			await resume.promise;
			yield ciphertext[0];
		} finally {
			finished = true;
		}
	}
	const delivering = f.track(putNativeBackupTarget(target, f.host, name, source(), manifest));
	await entered.promise;
	f.host.close();
	resume.release();
	await refused(delivering);
	expect(f.received).toEqual([]);
	expect(finished).toBe(true);
});

it("blocks a chunk whose original generator closes the actual host just before yielding it", async () => {
	const { f, target } = await fixture();
	let produced = 0;
	async function* source() {
		produced++;
		yield ciphertext[0];
		f.host.close();
		produced++;
		yield ciphertext[1];
	}
	await refused(f.track(putNativeBackupTarget(target, f.host, name, source(), manifest)));
	expect(produced).toBe(2);
	expect(f.received).toEqual(ciphertext.slice(0, 1));
});

it("keeps the whole put pending until the started original generator's finally completes", async () => {
	const { f, target } = await fixture();
	const pause = f.pause("chunk"),
		cleaning = gate(),
		finish = gate();
	let cleaned = false;
	async function* source() {
		try {
			yield* ciphertext;
		} finally {
			cleaning.release();
			await finish.promise;
			cleaned = true;
		}
	}
	const delivering = f.track(putNativeBackupTarget(target, f.host, name, source(), manifest));
	const completed = completion(delivering);
	await pause.entered;
	f.host.close();
	pause.release();
	await cleaning.promise;
	await Promise.resolve();
	expect(completed()).toBe(false);
	expect(cleaned).toBe(false);
	expect(f.received).toEqual(ciphertext.slice(0, 1));
	finish.release();
	await refused(delivering);
	expect(cleaned).toBe(true);
	expect(f.received).toEqual(ciphertext.slice(0, 1));
});
