import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { Account } from "@draftyak/protocol/entities/account";
import type { BlobRef } from "@draftyak/protocol/normalized-change";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceEpochForRestore } from "../../src/identity/devices.ts";
import { WorkDatabase, type WorkScope } from "../../src/jobs/database.ts";
import { newId } from "../../src/kernel/ids.ts";
import type { JsonMemberWriter } from "../../src/plugins/broker/blob/index.ts";
import {
	RAW_CONTENT_CHUNK_BYTES,
	RAW_CONTENT_MAX_BYTES,
	RawContentError,
	type RawWriteLimits,
} from "../../src/sync/raw-store.ts";
import { fixture, project, readAll } from "./raw-fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
let f: Fixture;
beforeEach(async () => {
	f = await fixture();
});
afterEach(async () => {
	await f.cleanup();
});

const live = (): AbortSignal => new AbortController().signal;
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function counts(): readonly number[] {
	return f.store.read((sql) =>
		["rawcontent_objects", "rawcontent_chunks"].map(
			(table) => sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM main.${table}`)?.n ?? 0,
		),
	);
}
function committed(): number {
	return f.store.read(
		(sql) =>
			sql.get<{ n: number }>(
				"SELECT COUNT(*) AS n FROM main.rawcontent_objects WHERE state='committed'",
			)?.n ?? 0,
	);
}
function begin(limits?: RawWriteLimits, ref = f.ref()): JsonMemberWriter {
	return f.database.write((scope) => f.model.begin(scope, ref, limits));
}
async function refused(pending: Promise<unknown>): Promise<void> {
	const failure: unknown = await pending.then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(failure).toBeInstanceOf(RawContentError);
	expect(failure).toMatchObject({ code: "RAW_CONTENT_UNAVAILABLE" });
}
function denied(work: (scope: WorkScope) => unknown): void {
	const before = counts();
	let failure: unknown;
	expect(() =>
		f.database.write((scope) => {
			try {
				work(scope);
			} catch (error) {
				failure = error;
			}
		}),
	).toThrow();
	expect(failure).toBeInstanceOf(RawContentError);
	expect(failure).toMatchObject({ code: "RAW_CONTENT_UNAVAILABLE" });
	expect(counts()).toEqual(before);
}
function replace(changes: Partial<Account>): number {
	return f.database.write((scope) => {
		const current = f.accounts.get(scope, f.account.userId, f.account.id);
		if (!current) throw new Error("Native raw account fixture unavailable");
		return f.accounts.replace(
			scope,
			{ ...current.account, ...changes } as Account,
			current.generation,
		).generation;
	});
}
function stagedId(): string {
	const id = f.store.read(
		(sql) =>
			sql.get<{ id: string }>("SELECT id FROM main.rawcontent_objects WHERE state='staged'")?.id,
	);
	if (!id) throw new Error("Native raw staging fixture unavailable");
	return id;
}

describe("native raw caller bounds and scope controls", () => {
	it.each([
		["maxBytes", null],
		["maxBytes", -1],
		["maxBytes", 0.5],
		["maxBytes", Number.NaN],
		["maxBytes", Number.POSITIVE_INFINITY],
		["maxBytes", RAW_CONTENT_MAX_BYTES + 1],
		["ttlMs", null],
		["ttlMs", 0],
		["ttlMs", 0.5],
		["ttlMs", Number.NaN],
		["ttlMs", Number.POSITIVE_INFINITY],
		["ttlMs", 60_001],
	] as const)("refuses invalid %s=%s and poisons a caught native scope", (field, value) => {
		denied((scope) => f.model.begin(scope, f.ref(), { [field]: value }));
		expect(counts()).toEqual([0, 0]);
	});

	it("refuses effectful limits and reference records without invoking getters or traps", () => {
		let hooks = 0;
		const effect = () => {
			hooks++;
			throw new Error("Private input hook invoked");
		};
		const limits = Object.defineProperty({}, "maxBytes", { enumerable: true, get: effect });
		denied((scope) => f.model.begin(scope, f.ref(), limits));
		denied((scope) => f.model.begin(scope, new Proxy(f.ref(), { get: effect, ownKeys: effect })));
		const ref = Object.defineProperty({ ...f.ref() }, "generation", {
			enumerable: true,
			get: effect,
		});
		denied((scope) => f.model.begin(scope, ref));
		expect(hooks).toBe(0);
	});

	it("refuses copied, proxied, foreign and retired native scopes", () => {
		let retired: WorkScope | undefined;
		let hooks = 0;
		f.database.write((scope) => {
			retired = scope;
			for (const fake of [
				{ sql: scope.sql },
				Object.create(scope),
				new Proxy(scope, {
					get() {
						hooks++;
						throw new Error("Scope hook invoked");
					},
				}),
			])
				expect(() => f.model.begin(fake, f.ref())).toThrow(RawContentError);
		});
		new WorkDatabase(f.store).write((scope) => {
			expect(() => f.model.begin(scope, f.ref())).toThrow(RawContentError);
		});
		expect(() => f.model.begin(retired as WorkScope, f.ref())).toThrow(RawContentError);
		expect(hooks).toBe(0);
		expect(counts()).toEqual([0, 0]);
	});

	it.each([
		["accountId", newId()],
		["pluginInstanceId", newId()],
		["generation", 2],
		["mode", "read_only"],
		["ownerEpoch", 2],
	] as const)("refuses a mismatched current %s", (field, value) => {
		const actual = field === "ownerEpoch" ? f.ref().ownerEpoch + 1 : value;
		denied((scope) => f.model.begin(scope, f.ref({ [field]: actual })));
	});

	it("does not accept a real account owned by another user", () => {
		const other = f.email({ userId: newId() });
		f.database.write((scope) => f.accounts.create(scope, other));
		denied((scope) =>
			f.model.begin(
				scope,
				f.ref({ accountId: other.id, pluginInstanceId: other.pluginInstanceId }),
			),
		);
	});

	it("refuses a byte beyond a zero-byte or smaller object limit without a committed copy", async () => {
		for (const maxBytes of [0, 1]) {
			const writer = begin({ maxBytes });
			await refused(writer.write(new Uint8Array(maxBytes + 1), live()));
			await writer.abort();
			expect(counts()).toEqual([0, 0]);
		}
	});
});

describe("native raw currentness between independent short transactions", () => {
	it.each(["generation", "mode", "paused", "credential_lost", "expired", "disconnecting"])(
		"fences later write, commit and current read after native %s changes",
		async (change) => {
			const blob = await project(f, new Uint8Array([1, 2, 3]));
			const writing = begin();
			const committing = begin();
			await writing.write(new Uint8Array([4]), live());
			await committing.write(new Uint8Array([5]), live());
			const changes: Partial<Account> =
				change === "generation"
					? { alias: "dytest-new-account-generation" }
					: change === "mode"
						? { mode: "read_only" }
						: change === "credential_lost" || change === "expired"
							? {
									status: "credential_lost",
									deletionDeadline: f.clock.wall + (change === "expired" ? 0 : 60_000),
								}
							: { status: change as "paused" | "disconnecting", deletionDeadline: null };
			const generation = replace(changes);
			await refused(writing.write(new Uint8Array([6]), live()));
			await refused(committing.commit(live()));
			denied((scope) => f.model.read(scope, f.ref(), blob));
			denied((scope) =>
				f.model.read(
					scope,
					f.ref({ generation, mode: change === "mode" ? "read_only" : "full" }),
					blob,
				),
			);
			await writing.abort();
			await committing.abort();
			expect(committed()).toBe(1);
		},
	);

	it("fences a captured writer and read after a genuine native epoch transition", async () => {
		const blob = await project(f, new Uint8Array([1]));
		const writer = begin();
		await writer.write(new Uint8Array([2]), live());
		// A fixture-only durable transition; it grants no source or recovery admission.
		f.database.write((scope) => advanceEpochForRestore(f.devices, scope.sql));
		await refused(writer.commit(live()));
		denied((scope) => f.model.read(scope, f.ref(), blob));
		await writer.abort();
		expect(committed()).toBe(1);
	});
});

describe("native raw inert byte and signal inputs", () => {
	it("copies mutable bytes before its first promise boundary", async () => {
		const bytes = new Uint8Array(RAW_CONTENT_CHUNK_BYTES).fill(17);
		const expected = hash(bytes);
		const writer = begin();
		const pending = writer.write(bytes, live());
		bytes.fill(29);
		await pending;
		const blob = await writer.commit(live());
		expect(hash(readAll(f, blob))).toBe(expected);
	});

	it("refuses proxy, shared, detached and non-byte inputs without caller hooks", async () => {
		let hooks = 0;
		const detached = new Uint8Array(new ArrayBuffer(1));
		detached.buffer.transfer();
		const getter = Object.defineProperty({}, "byteLength", {
			get() {
				hooks++;
				throw new Error("Byte getter invoked");
			},
		});
		for (const bytes of [
			new Proxy(new Uint8Array([1]), {
				get() {
					hooks++;
					throw new Error("Byte proxy invoked");
				},
			}),
			new Uint8Array(new SharedArrayBuffer(1)),
			detached,
			new DataView(new ArrayBuffer(1)),
			getter,
		]) {
			const writer = begin();
			await refused(writer.write(bytes as Uint8Array, live()));
			await writer.abort();
			expect(counts()).toEqual([0, 0]);
		}
		expect(hooks).toBe(0);
	});

	it("refuses malformed signals without reading caller properties", async () => {
		let hooks = 0;
		const getter = Object.defineProperty({}, "aborted", {
			get() {
				hooks++;
				throw new Error("Signal getter invoked");
			},
		});
		const proxy = new Proxy(live(), {
			get() {
				hooks++;
				throw new Error("Signal proxy invoked");
			},
		});
		for (const signal of [getter, proxy, null, {}]) {
			const writer = begin();
			await refused(writer.write(new Uint8Array([1]), signal as AbortSignal));
			await writer.abort();
		}
		expect(hooks).toBe(0);
		expect(counts()).toEqual([0, 0]);
	});
});

describe("native raw staged visibility and terminal operations", () => {
	it("does not expose staged bytes through a guessed valid BlobRef", async () => {
		const writer = begin();
		await writer.write(new Uint8Array([1, 2, 3]), live());
		const blob: BlobRef = { ref: stagedId() };
		denied((scope) => f.model.read(scope, f.ref(), blob));
		await writer.abort();
		expect(counts()).toEqual([0, 0]);
	});

	it("makes abort terminal and permits cleanup after the account becomes inactive", async () => {
		const writer = begin();
		await writer.write(new Uint8Array([1]), live());
		replace({ status: "paused", deletionDeadline: null });
		await writer.abort();
		await refused(writer.write(new Uint8Array([2]), live()));
		await refused(writer.commit(live()));
		expect(counts()).toEqual([0, 0]);
	});

	it("does not resurrect an object when write overlaps abort", async () => {
		const writer = begin();
		const writing = writer.write(new Uint8Array(RAW_CONTENT_CHUNK_BYTES).fill(1), live());
		const aborting = writer.abort();
		const outcomes = await Promise.allSettled([writing, aborting]);
		expect(outcomes[1]?.status).toBe("fulfilled");
		expect(counts()).toEqual([0, 0]);
		await refused(writer.commit(live()));
		expect(counts()).toEqual([0, 0]);
	});

	it("never commits a prefix or resurrects failed overlapping write and commit calls", async () => {
		const writer = begin();
		const bytes = new Uint8Array(RAW_CONTENT_CHUNK_BYTES).fill(7);
		const writing = writer.write(bytes, live());
		const committing = writer.commit(live());
		const [written, result] = await Promise.allSettled([writing, committing]);
		if (written.status === "fulfilled" && result.status === "fulfilled") {
			expect(hash(readAll(f, result.value))).toBe(hash(bytes));
			await writer.abort();
		} else {
			expect(counts()).toEqual([0, 0]);
			await refused(writer.commit(live()));
		}
		expect(counts()).toEqual([0, 0]);
	});

	it("preserves order or terminally refuses overlapping ordinary writes", async () => {
		const writer = begin();
		const first = new Uint8Array(RAW_CONTENT_CHUNK_BYTES).fill(11);
		const second = new Uint8Array(RAW_CONTENT_CHUNK_BYTES).fill(13);
		const outcomes = await Promise.allSettled([
			writer.write(first, live()),
			writer.write(second, live()),
		]);
		if (outcomes.every((outcome) => outcome.status === "fulfilled")) {
			const blob = await writer.commit(live());
			const expected = new Uint8Array(first.length + second.length);
			expected.set(first);
			expected.set(second, first.length);
			expect(hash(readAll(f, blob))).toBe(hash(expected));
			await writer.abort();
		} else {
			expect(counts()).toEqual([0, 0]);
			await refused(writer.commit(live()));
		}
	});

	it("removes its object when private abort overlaps a commit promise", async () => {
		const writer = begin();
		await writer.write(new Uint8Array([1]), live());
		const committing = writer.commit(live());
		const aborting = writer.abort();
		const outcomes = await Promise.allSettled([committing, aborting]);
		expect(outcomes[1]?.status).toBe("fulfilled");
		expect(counts()).toEqual([0, 0]);
		await refused(writer.commit(live()));
	});

	it("refuses a signal already aborted before write and leaves no committed object", async () => {
		const writer = begin();
		const controller = new AbortController();
		controller.abort();
		await refused(writer.write(new Uint8Array([1]), controller.signal));
		await writer.abort();
		expect(counts()).toEqual([0, 0]);
	});

	it("aborts an in-flight commit before delivering its reference", async () => {
		const writer = begin();
		await writer.write(new Uint8Array([1]), live());
		const controller = new AbortController();
		const pending = writer.commit(controller.signal);
		controller.abort();
		await refused(pending);
		expect(counts()).toEqual([0, 0]);
	});

	it("keeps a returned reference after later signal abort until explicit private cleanup", async () => {
		const writer = begin();
		await writer.write(new Uint8Array([1, 2]), live());
		const controller = new AbortController();
		const blob = await writer.commit(controller.signal);
		controller.abort();
		await setImmediate();
		expect(readAll(f, blob).byteLength).toBe(2);
		await writer.abort();
		denied((scope) => f.model.read(scope, f.ref(), blob));
		expect(counts()).toEqual([0, 0]);
	});
});

describe("native raw quota and staging expiry", () => {
	it("enforces two active staging objects per account and releases capacity after abort", async () => {
		const first = begin();
		const second = begin();
		denied((scope) => f.model.begin(scope, f.ref()));
		expect(counts()[0]).toBe(2);
		await first.abort();
		const replacement = begin();
		await second.abort();
		await replacement.abort();
		expect(counts()).toEqual([0, 0]);
	});

	it("enforces four staging objects across genuine accounts in the same store", async () => {
		const secondAccount = f.email();
		const thirdAccount = f.email();
		f.database.write((scope) => {
			f.accounts.create(scope, secondAccount);
			f.accounts.create(scope, thirdAccount);
		});
		const otherRef = f.ref({
			accountId: secondAccount.id,
			pluginInstanceId: secondAccount.pluginInstanceId,
		});
		const thirdRef = f.ref({
			accountId: thirdAccount.id,
			pluginInstanceId: thirdAccount.pluginInstanceId,
		});
		const writers = [begin(), begin(), begin(undefined, otherRef), begin(undefined, otherRef)];
		denied((scope) => f.model.begin(scope, thirdRef));
		expect(counts()[0]).toBe(4);
		for (const writer of writers) await writer.abort();
		expect(counts()).toEqual([0, 0]);
	});

	it.each(["wall", "monotonic"] as const)(
		"refuses a live writer at its exact %s expiry",
		async (clock) => {
			const writer = begin({ ttlMs: 1 });
			await writer.write(new Uint8Array([1]), live());
			f.clock[clock] += 1;
			await refused(writer.commit(live()));
			expect(counts()).toEqual([0, 0]);
		},
	);

	it("expires an abandoned large stage in at most 64 chunks per native transaction", async () => {
		const writer = begin({ ttlMs: 1 });
		await writer.write(new Uint8Array(RAW_CONTENT_CHUNK_BYTES * 65).fill(1), live());
		expect(counts()).toEqual([1, 65]);
		f.clock.wall += 1;
		const first = f.database.write((scope) => f.model.expireStaging(scope));
		expect(first).toEqual({ deletedChunks: 64, deletedObjects: 0, more: true });
		expect(counts()).toEqual([1, 1]);
		const last = f.database.write((scope) => f.model.expireStaging(scope));
		expect(last).toEqual({ deletedChunks: 1, deletedObjects: 1, more: false });
		expect(counts()).toEqual([0, 0]);
		await refused(writer.commit(live()));
		expect(counts()).toEqual([0, 0]);
	});

	it("never expires committed content when its staging deadline passes", async () => {
		const blob = await project(f, new Uint8Array([1, 2, 3]), "raw", 4096, { ttlMs: 1 });
		f.clock.wall += 60_001;
		f.clock.monotonic += 60_001;
		expect(f.database.write((scope) => f.model.expireStaging(scope))).toEqual({
			deletedChunks: 0,
			deletedObjects: 0,
			more: false,
		});
		expect(readAll(f, blob).byteLength).toBe(3);
		expect(committed()).toBe(1);
	});
});

describe("native raw bounded current reads", () => {
	it("refuses malformed BlobRefs and read bounds without invoking reference hooks", async () => {
		const blob = await project(f, new Uint8Array([1, 2, 3]));
		let hooks = 0;
		const getter = Object.defineProperty({}, "ref", {
			enumerable: true,
			get() {
				hooks++;
				throw new Error("Blob reference getter invoked");
			},
		});
		denied((scope) => f.model.read(scope, f.ref(), getter as BlobRef));
		for (const [offset, maxBytes] of [
			[-1, 1],
			[0.5, 1],
			[4, 1],
			[0, 0],
			[0, 65_537],
			[0, Number.NaN],
		] as const)
			denied((scope) => f.model.read(scope, f.ref(), blob, offset, maxBytes));
		expect(hooks).toBe(0);
		expect(committed()).toBe(1);
	});

	it.each(["foreign-owner", "missing-chunk", "corrupt-digest", "wrong-length"] as const)(
		"refuses a committed object with %s corruption before returning a slice",
		async (corruption) => {
			const blob = await project(f, new Uint8Array([1, 2, 3, 4]));
			f.store.write((sql) => {
				if (corruption === "foreign-owner")
					sql.run("UPDATE main.rawcontent_objects SET user_id=? WHERE id=?", [newId(), blob.ref]);
				else if (corruption === "missing-chunk")
					sql.run("UPDATE main.rawcontent_chunks SET seq=1 WHERE object_id=?", [blob.ref]);
				else if (corruption === "corrupt-digest")
					sql.run("UPDATE main.rawcontent_chunks SET sha256=? WHERE object_id=?", [
						"0".repeat(64),
						blob.ref,
					]);
				else {
					const bytes = new Uint8Array([9]);
					sql.run("UPDATE main.rawcontent_chunks SET bytes=?,sha256=? WHERE object_id=?", [
						bytes,
						hash(bytes),
						blob.ref,
					]);
				}
			});
			denied((scope) => f.model.read(scope, f.ref(), blob));
		},
	);
});
