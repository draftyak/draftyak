import { createHash } from "node:crypto";
import type { BlobRef } from "@draftyak/protocol/normalized-change";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobLease } from "../../src/jobs/queue.ts";
import { fixture } from "./ingest-fixture.ts";

const parser = vi.hoisted(() => ({
	calls: 0,
	rawInputs: [] as Uint8Array[],
	hold: undefined as
		| { expected: number; entered(): void; released: Promise<void>; release(): void }
		| undefined,
}));
vi.mock("@draftyak/content", async (original) => {
	const content = await original<typeof import("@draftyak/content")>();
	return {
		...content,
		async parseMailInWorker(...args: Parameters<typeof content.parseMailInWorker>) {
			parser.calls++;
			parser.rawInputs.push(args[0]);
			const hold = parser.hold;
			if (hold && parser.calls > hold.expected)
				throw new Error("Synthetic excess parser admission");
			if (hold) {
				if (parser.calls === hold.expected) hold.entered();
				await hold.released;
			}
			return content.parseMailInWorker(...args);
		},
	};
});

const { NativeMailIngestError } = await import("../../src/content/ingest.ts");

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function holdParser(expected = 1) {
	const entered = deferred();
	const released = deferred();
	parser.hold = {
		expected,
		entered: entered.resolve,
		released: released.promise,
		release: released.resolve,
	};
	return { entered: entered.promise, release: released.resolve };
}
async function enteredBeforeSettled(entered: Promise<void>, pending: readonly Promise<unknown>[]) {
	const unexpectedSettlement = () => {
		throw new Error("Synthetic ingestion settled before reaching the parser barrier");
	};
	await Promise.race([
		entered,
		...pending.map((operation) => operation.then(unexpectedSettlement, unexpectedSettlement)),
	]);
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Fixture = Awaited<ReturnType<typeof fixture>>;
let owned: Fixture | undefined;
const operations = new Set<Promise<unknown>>();
beforeEach(async () => {
	owned = undefined;
	parser.calls = 0;
	parser.rawInputs = [];
	parser.hold = undefined;
	owned = await fixture();
});
afterEach(async () => {
	parser.hold?.release();
	await Promise.allSettled(operations);
	operations.clear();
	parser.hold = undefined;
	const current = owned;
	owned = undefined;
	await current?.cleanup();
});
function current(): Fixture {
	if (!owned) throw new Error("Synthetic ingest fixture unavailable");
	return owned;
}
function start(
	f: Pick<Fixture, "ingestor" | "ref" | "message">,
	lease: JobLease,
	blob: BlobRef,
	signal?: AbortSignal,
) {
	const promise = f.ingestor.ingest(lease, f.ref, f.message.id, blob, signal);
	operations.add(promise);
	void promise.catch(() => undefined);
	return promise;
}
function mail(body = "DYTEST visible body"): Uint8Array {
	return new TextEncoder().encode(
		[
			"From: dytest-owner@example.invalid",
			"To: dytest-recipient@example.invalid",
			"Authentication-Results: mx.google.com; dmarc=pass header.from=example.invalid",
			"Message-ID: <dytest-message@example.invalid>",
			"In-Reply-To: <dytest-parent@example.invalid>",
			"References: <dytest-root@example.invalid> <dytest-parent@example.invalid>",
			"Subject: DYTEST parsed ingestion",
			"Content-Type: text/plain; charset=utf-8",
			"",
			body,
		].join("\r\n"),
	);
}

describe("native account-fenced mail ingestion", () => {
	it("parses real raw bytes and keeps unverified association, inbound direction and unknown auth", async () => {
		const f = current();
		const bytes = mail();
		const blob = await f.project(bytes);
		const lease = f.lease(f.message.id);
		const record = await start(f, lease, blob);
		expect(record.association).toBe("unverified");
		expect(record.mail).toMatchObject({
			rawSha256: digest(bytes),
			direction: "inbound",
			auth: { dmarc: "none", reason: "unsupported-provider" },
			subject: "DYTEST parsed ingestion",
			messageId: "<dytest-message@example.invalid>",
			inReplyTo: "<dytest-parent@example.invalid>",
			body: { text: "DYTEST visible body" },
		});
		expect(record.mail.auth.verifiedSender).toBeUndefined();
		expect(parser.calls).toBe(1);
		expect(parser.rawInputs[0]?.every((byte) => byte === 0)).toBe(true);
		const retainedRaw = f.database.write((scope) => f.raw.read(scope, f.ref, blob));
		try {
			expect(retainedRaw.sha256).toBe(digest(bytes));
			expect(retainedRaw.bytes).toEqual(bytes);
		} finally {
			retainedRaw.bytes.fill(0);
		}
		expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe("SUCCEEDED");
		expect(f.database.write((scope) => f.parsed.read(scope, f.ref, f.message.id))).toEqual(record);
		await expect(start(f, lease, blob)).rejects.toBeInstanceOf(NativeMailIngestError);
		expect(parser.calls).toBe(1);
	});

	it("assembles independent bounded slices without truncating the raw parse", async () => {
		const f = current();
		const bytes = mail("DYTEST ".repeat(12_000));
		expect(bytes.length > 65_536).toBe(true);
		const blob = await f.project(bytes);
		const record = await start(f, f.lease(f.message.id), blob);
		expect(record.mail.rawSha256).toBe(digest(bytes));
		expect(record.mail.body.text.startsWith("DYTEST DYTEST")).toBe(true);
		expect(record.mail.body.text.length).toBeLessThanOrEqual(40_000);
	});

	it("refuses a forged lease before worker admission", async () => {
		const f = current();
		const blob = await f.project(mail());
		const lease = f.lease(f.message.id);
		await expect(start(f, { job: lease.job }, blob)).rejects.toBeInstanceOf(NativeMailIngestError);
		expect(parser.calls).toBe(0);
		await expect(start(f, lease, blob)).resolves.toBeDefined();
	});

	it("does not consume a job or start a parser for an already aborted signal", async () => {
		const f = current();
		const blob = await f.project(mail());
		const lease = f.lease(f.message.id);
		const controller = new AbortController();
		controller.abort();
		await expect(start(f, lease, blob, controller.signal)).rejects.toBeInstanceOf(
			NativeMailIngestError,
		);
		expect(parser.calls).toBe(0);
		await expect(start(f, lease, blob)).resolves.toBeDefined();
	});

	it("bounds concurrent ingestion and releases capacity without consuming the refused job", async () => {
		const f = current();
		const secondAccount = f.createMailbox();
		const refusedAccount = f.createMailbox();
		expect(secondAccount.ingestor).toBe(f.ingestor);
		expect(refusedAccount.ingestor).toBe(f.ingestor);
		expect(new Set([f.account.id, secondAccount.account.id, refusedAccount.account.id]).size).toBe(
			3,
		);
		const blob = await f.project(mail());
		const secondBlob = await secondAccount.project(mail());
		const refusedBlob = await refusedAccount.project(mail());
		const firstController = new AbortController();
		const secondController = new AbortController();
		const gate = holdParser(2);
		const first = start(f, f.lease(f.message.id), blob, firstController.signal);
		const second = start(
			secondAccount,
			secondAccount.lease(secondAccount.message.id),
			secondBlob,
			secondController.signal,
		);
		const refusedLease = refusedAccount.lease(refusedAccount.message.id);
		try {
			await enteredBeforeSettled(gate.entered, [first, second]);
			await expect(start(refusedAccount, refusedLease, refusedBlob)).rejects.toBeInstanceOf(
				NativeMailIngestError,
			);
			expect(f.database.write((scope) => f.jobs.get(scope, refusedLease.job.id)?.state)).toBe(
				"RUNNING",
			);
			expect(parser.calls).toBe(2);
			firstController.abort();
			secondController.abort();
			gate.release();
			await expect(first).rejects.toBeInstanceOf(NativeMailIngestError);
			await expect(second).rejects.toBeInstanceOf(NativeMailIngestError);
			parser.hold = undefined;
			await expect(start(refusedAccount, refusedLease, refusedBlob)).resolves.toMatchObject({
				messageId: refusedAccount.message.id,
			});
			expect(parser.calls).toBe(3);
		} finally {
			firstController.abort();
			secondController.abort();
			gate.release();
			await Promise.allSettled([first, second]);
		}
	});

	it.each([
		"checkpoint-storage",
		"message",
		"raw",
		"generation",
		"credential-loss deadline",
		"abort",
	] as const)("rechecks %s after the worker await without holding a SQL write", async (change) => {
		const f = current();
		const blob = await f.project(mail());
		const lease = f.lease(f.message.id);
		const controller = new AbortController();
		const gate = holdParser();
		const pending = start(f, lease, blob, controller.signal);
		try {
			await enteredBeforeSettled(gate.entered, [pending]);
			// This real write would refuse if the parser await held the native transaction.
			expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe("RUNNING");
			if (change === "checkpoint-storage") {
				// Hostile storage change, not a concurrently admitted page job.
				f.database.write((scope) => {
					expect(
						f.database
							.sql(scope)
							.run(
								"UPDATE main.content_checkpoints SET cursor=?,revision=revision+1 WHERE account_id=? AND generation=?",
								["DYTEST-hostile-checkpoint", f.account.id, f.ref.generation],
							).changes,
					).toBe(1);
				});
			} else if (change === "message") {
				f.database.write((scope) =>
					f.database
						.sql(scope)
						.run("UPDATE main.content_messages SET internal_date=internal_date+1 WHERE id=?", [
							f.message.id,
						]),
				);
			} else if (change === "raw") {
				const replacement = new Uint8Array(mail()).fill(0x41);
				f.database.write((scope) =>
					f.database
						.sql(scope)
						.run("UPDATE main.rawcontent_chunks SET bytes=?,sha256=? WHERE object_id=? AND seq=0", [
							replacement,
							digest(replacement),
							blob.ref,
						]),
				);
			} else if (change === "generation") {
				f.database.write((scope) =>
					f.accounts.replace(scope, { ...f.account, mode: "read_only" }, 1),
				);
			} else if (change === "credential-loss deadline") {
				const deadline = f.time.wall + 5_000;
				const changed = f.database.write((scope) =>
					f.accounts.replace(
						scope,
						{ ...f.account, status: "credential_lost", deletionDeadline: deadline },
						f.ref.generation,
					),
				);
				expect(changed.generation).toBe(f.ref.generation + 1);
				expect(changed.account.status).toBe("credential_lost");
				expect(changed.account.deletionDeadline).toBe(deadline);
				expect(
					f.database.write((scope) => f.accounts.get(scope, f.account.userId, f.account.id)),
				).toEqual(changed);
				// Real credential loss fences the captured active source already;
				// expiry does not claim that a purge or account retirement ran.
				f.time.wall += 5_000;
				f.time.monotonic += 5_000;
			} else controller.abort();
			gate.release();
			await expect(pending).rejects.toBeInstanceOf(NativeMailIngestError);
			expect(
				f.native.store.read(
					(sql) =>
						sql.get<{ count: number }>("SELECT count(*) AS count FROM main.content_parsed_messages")
							?.count,
				),
			).toBe(0);
		} finally {
			gate.release();
			await pending.catch(() => undefined);
		}
	});
});
