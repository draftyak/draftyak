import { createHash } from "node:crypto";
import { type ParsedMail, parseMail, parseMailInWorker } from "@draftyak/content";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobLease } from "../../src/jobs/queue.ts";
import { newId } from "../../src/kernel/ids.ts";
import type { SqlValue } from "../../src/store/store.ts";
import {
	MAX_PARSED_JSON_BYTES,
	NativeParsedError,
	type NativeParsedSource,
} from "../../src/sync/parsed.ts";
import { emailMessage, fixture, type NativeParsedFixture } from "./parsed-fixture.ts";

let current: NativeParsedFixture | undefined;
beforeEach(async () => {
	current = undefined;
	current = await fixture();
});
afterEach(async () => {
	const owned = current;
	current = undefined;
	await owned?.cleanup();
});
function owned(): NativeParsedFixture {
	if (!current) throw new Error("Synthetic parsed fixture unavailable");
	return current;
}
const sha = (bytes: Uint8Array | string): string =>
	createHash("sha256").update(bytes).digest("hex");
const rowCount = (f: NativeParsedFixture): number =>
	f.store.read(
		(sql) =>
			sql.get<{ n: number }>("SELECT count(*) AS n FROM main.content_parsed_messages")?.n ?? -1,
	);
const CACHE_COLUMNS = [
	"message_id",
	"account_id",
	"generation",
	"user_id",
	"plugin_instance_id",
	"mode",
	"provider_id",
	"thread_id",
	"account_digest",
	"metadata_digest",
	"source_cursor",
	"source_revision",
	"raw_ref",
	"raw_sha256",
	"raw_bytes",
	"parsed_json",
	"parsed_digest",
	"scope_token",
	"cleaned_body",
	"association",
] as const;
type SavedCacheRow = Record<(typeof CACHE_COLUMNS)[number], SqlValue>;
function savedCacheRow(f: NativeParsedFixture, messageId: string): SavedCacheRow {
	const row = f.store.read((sql) =>
		sql.get<SavedCacheRow>(
			`SELECT ${CACHE_COLUMNS.join(",")} FROM main.content_parsed_messages WHERE message_id=?`,
			[messageId],
		),
	);
	if (!row) throw new Error("Synthetic prior extraction missing");
	return row;
}
/** Negative corruption only: reinstall exact OLD genuine extraction, never a positive row. */
function restoreOldCacheRow(f: NativeParsedFixture, row: SavedCacheRow): void {
	f.store.write((sql) => {
		sql.run("DELETE FROM main.content_parsed_messages WHERE message_id=?", [row.message_id]);
		sql.run(
			`INSERT INTO main.content_parsed_messages(${CACHE_COLUMNS.join(",")}) VALUES(${CACHE_COLUMNS.map(() => "?").join(",")})`,
			CACHE_COLUMNS.map((column) => row[column]),
		);
	});
}
async function preparedInput(
	body = "Synthetic parsed body",
	contentType: "text/plain" | "text/html" = "text/plain",
) {
	const f = owned(),
		bytes = new TextEncoder().encode(
			`From: Sender <sender@example.invalid>\r\nTo: ${f.account.address}\r\nSubject: Synthetic parsed mail\r\nContent-Type: ${contentType}; charset=UTF-8\r\n\r\n${body}`,
		);
	f.apply([emailMessage()]);
	const messageId = f.database.write((scope) => f.metadata.messages(scope, f.ref())[0]?.id);
	if (!messageId) throw new Error("Synthetic metadata missing");
	const blob = await f.project(bytes);
	const mail = await parseMail(bytes, { provider: "generic", ownerAddresses: [f.account.address] });
	return { f, bytes, blob, mail, messageId };
}
async function prepared(body = "Synthetic parsed body") {
	const input = await preparedInput(body);
	return { ...input, source: input.f.capture(input.messageId, input.blob) };
}
function passes(f: NativeParsedFixture, source: NativeParsedSource, count = 2): void {
	for (let i = 0; i < count; i++) {
		const bytes = f.scan(source, 4096);
		bytes.fill(0);
	}
}

function inertNodeCount(value: unknown): number {
	const pending = [value];
	let count = 0;
	while (pending.length > 0) {
		const item = pending.pop();
		count++;
		if (item !== null && typeof item === "object") {
			for (const child of Object.values(item)) pending.push(child);
		}
	}
	return count;
}

/** Closed untrusted DATA based on the real parser result, not provider association. */
function nodeBoundaryData(mail: ParsedMail, count: number): ParsedMail {
	const from: { address: string; name?: string }[] = mail.from.map(({ address }) => ({ address }));
	const to: { address: string; name?: string }[] = mail.to.map(({ address }) => ({ address }));
	if (!from[0] || !to[0]) throw new Error("Synthetic budget mailbox missing");
	const links: { index: number; host: string }[] = [];
	const input: ParsedMail = { ...mail, from, to, body: { ...mail.body, links } };
	const remaining = count - inertNodeCount(input);
	const linkCount = Math.floor(remaining / 3);
	if (!Number.isInteger(remaining) || remaining < 0 || linkCount >= 6_700)
		throw new Error("Synthetic node fixture exceeds its bounded shape");
	for (let i = 0; i < linkCount; i++)
		links.push({ index: 0, host: "dytest-budget.example.invalid" });
	if (remaining % 3 >= 1) from[0].name = "DYTEST";
	if (remaining % 3 === 2) to[0].name = "DYTEST";
	return input;
}

function byteBoundaryData(mail: ParsedMail, bytes: number): ParsedMail {
	const address = mail.to[0]?.address;
	if (!address) throw new Error("Synthetic budget recipient missing");
	const to = Array.from({ length: 64 }, () => ({ address, name: "" }));
	const input: ParsedMail = { ...mail, to };
	let remaining = bytes - Buffer.byteLength(JSON.stringify(input), "utf8");
	if (!Number.isInteger(remaining) || remaining < 0 || remaining > 64 * 65_536)
		throw new Error("Synthetic byte fixture exceeds its bounded shape");
	for (const mailbox of to) {
		const length = Math.min(remaining, 65_536);
		mailbox.name = "x".repeat(length);
		remaining -= length;
	}
	if (remaining !== 0) throw new Error("Synthetic byte fixture was not filled");
	return input;
}

describe("native parsed extraction storage", () => {
	it("reads two bounded complete passes and persists detached conservative DATA", async () => {
		const { f, bytes, blob, mail, messageId, source } = await prepared("x".repeat(70_000));
		const first = f.scan(source, 4096);
		try {
			expect(first).toEqual(Buffer.from(bytes));
		} finally {
			first.fill(0);
		}
		passes(f, source, 1);
		expect(f.database.write((scope) => f.model.ownerAddress(scope, source))).toBe(
			f.account.address,
		);
		const result = f.database.write((scope) => f.model.commit(scope, source, mail));
		expect(result).toMatchObject({
			messageId,
			raw: blob,
			rawSha256: sha(bytes),
			rawBytes: bytes.length,
			association: "unverified",
			mail: { direction: "inbound", auth: { dmarc: "none", reason: "unsupported-provider" } },
		});
		expect(Object.isFrozen(result.mail.body)).toBe(true);
		mail.body.text = "changed caller DATA";
		const stored = f.database.write((scope) => f.model.read(scope, f.ref(), messageId));
		expect(stored).toEqual(result);
		expect(stored?.mail.body.text).not.toBe("changed caller DATA");
		expect(
			f.database.write((scope) => f.model.forThread(scope, f.ref(), "DYTEST-parsed-thread")),
		).toEqual({ records: [result], nextAfterId: null, scanned: 1 });
		expect(() => f.database.write((scope) => f.model.ownerAddress(scope, source))).toThrow(
			NativeParsedError,
		);
	});

	it("requires a second whole-byte pass and abandons only its renewed real job", async () => {
		const { f, mail, messageId, blob, source } = await prepared();
		passes(f, source, 1);
		expect(() => f.database.write((scope) => f.model.commit(scope, source, mail))).toThrow(
			NativeParsedError,
		);
		expect(rowCount(f)).toBe(0);
		f.database.write((scope) => f.model.abandon(scope, source));
		const replacement = f.capture(messageId, blob);
		passes(f, replacement);
		f.database.write((scope) => f.model.commit(scope, replacement, mail));
		expect(rowCount(f)).toBe(1);
	});

	it.each(["forged", "wrong-kind", "wrong-ref"] as const)(
		"refuses %s job provenance before returning a source",
		async (variant) => {
			const { f, messageId, blob } = await preparedInput();
			const real = f.lease(
				variant === "wrong-ref" ? newId() : messageId,
				variant === "wrong-kind" ? "retention" : "sync",
			);
			const input = variant === "forged" ? ({ job: real.job } as JobLease) : real;
			expect(() =>
				f.database.write((scope) => f.model.capture(scope, input, f.ref(), messageId, blob)),
			).toThrow(NativeParsedError);
			expect(rowCount(f)).toBe(0);
		},
	);

	it("refuses nonsequential progress and permanently retires an abandoned source", async () => {
		const { f, source } = await prepared();
		expect(() => f.database.write((scope) => f.model.readSource(scope, source, 1, 1))).toThrow(
			NativeParsedError,
		);
		f.database.write((scope) => f.model.abandon(scope, source));
		f.database.write((scope) => f.model.abandon(scope, source));
		expect(() => f.database.write((scope) => f.model.readSource(scope, source, 0, 1))).toThrow(
			NativeParsedError,
		);
		expect(rowCount(f)).toBe(0);
	});

	it("rejects a foreign genuine WorkScope and an oversized slice request", async () => {
		const { f, source, messageId, blob } = await prepared();
		const other = await fixture();
		try {
			expect(() =>
				other.database.write((scope) => f.model.read(scope, f.ref(), messageId)),
			).toThrow(NativeParsedError);
			expect(() =>
				f.database.write((scope) => f.model.readSource(scope, source, 0, 65_537)),
			).toThrow(NativeParsedError);
			f.database.write((scope) => f.model.abandon(scope, source));
			const fresh = f.capture(messageId, blob),
				bytes = f.scan(fresh, 1);
			try {
				expect(bytes.length).toBeGreaterThan(0);
			} finally {
				bytes.fill(0);
			}
			f.database.write((scope) => f.model.abandon(scope, fresh));
			expect(rowCount(f)).toBe(0);
		} finally {
			await other.cleanup();
		}
	});

	it("refuses a coherent changed chunk even when its chunk digest is updated", async () => {
		const { f, blob, source } = await prepared("x".repeat(70_000));
		const original = f.store.read((sql) =>
			sql.get<{ bytes: Uint8Array; sha: string }>(
				"SELECT bytes,sha256 AS sha FROM main.rawcontent_chunks WHERE object_id=? AND seq=1",
				[blob.ref],
			),
		);
		if (!original) throw new Error("Synthetic second raw chunk missing");
		const changed = new Uint8Array(original.bytes);
		changed[0] = (changed[0] ?? 0) ^ 1;
		try {
			f.store.write((sql) =>
				sql.run("UPDATE main.rawcontent_chunks SET bytes=?,sha256=? WHERE object_id=? AND seq=1", [
					changed,
					sha(changed),
					blob.ref,
				]),
			);
			expect(() => f.scan(source)).toThrow(NativeParsedError);
			expect(rowCount(f)).toBe(0);
		} finally {
			f.store.write((sql) =>
				sql.run("UPDATE main.rawcontent_chunks SET bytes=?,sha256=? WHERE object_id=? AND seq=1", [
					original.bytes,
					original.sha,
					blob.ref,
				]),
			);
			original.bytes.fill(0);
			changed.fill(0);
		}
	});

	it.each([
		"checkpoint-storage",
		"generation",
		"account-data",
		"device-lock",
		"lease-expiry",
	] as const)("rechecks the original %s fence", async (variant) => {
		const { f, source } = await prepared();
		if (variant === "checkpoint-storage") {
			// Hostile storage change, not a second page job beside the running parse.
			f.database.write((scope) => {
				expect(
					f.database
						.sql(scope)
						.run(
							"UPDATE main.content_checkpoints SET cursor=?,revision=revision+1 WHERE account_id=? AND generation=?",
							["DYTEST-hostile-checkpoint", f.account.id, f.ref().generation],
						).changes,
				).toBe(1);
			});
		} else if (variant === "generation")
			f.database.write((scope) => f.accounts.replace(scope, f.account, 1));
		else if (variant === "account-data")
			f.store.write((sql) =>
				sql.run("UPDATE main.accounts SET account_json=? WHERE id=?", [
					JSON.stringify({ ...f.account, alias: "dytest-changed-account" }),
					f.account.id,
				]),
			);
		else if (variant === "device-lock") f.native.registry.lock();
		else {
			f.clock.wall += 30_000;
			f.clock.monotonic += 30_000;
		}
		expect(() => f.database.write((scope) => f.model.ownerAddress(scope, source))).toThrow(
			NativeParsedError,
		);
		expect(rowCount(f)).toBe(0);
	});

	it("rejects an effectful parsed record without invoking its getter", async () => {
		const { f, source, mail } = await prepared();
		passes(f, source);
		let called = 0;
		const hostile = Object.defineProperty({ ...mail }, "subject", {
			enumerable: true,
			get() {
				called++;
				return "effectful";
			},
		});
		expect(() => f.database.write((scope) => f.model.commit(scope, source, hostile))).toThrow(
			NativeParsedError,
		);
		expect(called).toBe(0);
		expect(rowCount(f)).toBe(0);
	});

	it.each(["hash", "outbound", "verified-auth", "unknown-field"] as const)(
		"refuses invalid %s parsed DATA",
		async (variant) => {
			const { f, source, mail } = await prepared();
			passes(f, source);
			const input: unknown =
				variant === "hash"
					? { ...mail, rawSha256: "0".repeat(64) }
					: variant === "outbound"
						? { ...mail, direction: "outbound" }
						: variant === "verified-auth"
							? {
									...mail,
									auth: { dmarc: "pass", reason: "verified", verifiedSender: "example.invalid" },
								}
							: { ...mail, complete: true };
			expect(() =>
				f.database.write((scope) => f.model.commit(scope, source, input as ParsedMail)),
			).toThrow(NativeParsedError);
			expect(rowCount(f)).toBe(0);
		},
	);

	it("refuses stored JSON corruption and returns fixed content-free errors", async () => {
		const { f, source, mail, messageId } = await prepared();
		passes(f, source);
		f.database.write((scope) => f.model.commit(scope, source, mail));
		f.store.write((sql) =>
			sql.run("UPDATE main.content_parsed_messages SET parsed_json=? WHERE message_id=?", [
				"{}",
				messageId,
			]),
		);
		try {
			f.database.write((scope) => f.model.read(scope, f.ref(), messageId));
			throw new Error("Synthetic corruption was accepted");
		} catch (error) {
			expect(error).toBeInstanceOf(NativeParsedError);
			expect(error).toMatchObject({
				code: "PARSED_CONTENT_UNAVAILABLE",
				message: "Parsed content unavailable",
			});
			expect((error as Error).cause).toBeUndefined();
		}
	});

	it("hides changed metadata and removes only its stale cached extraction", async () => {
		const { f, source, bytes, messageId, blob } = await prepared();
		const mail = await parseMailInWorker(bytes, {
			provider: "generic",
			ownerAddresses: [f.account.address],
		});
		passes(f, source);
		f.database.write((scope) => f.model.commit(scope, source, mail));
		const old = savedCacheRow(f, messageId);
		f.apply([{ ...emailMessage(), labelIds: ["INBOX", "UNREAD"] }]);
		expect(rowCount(f)).toBe(0);
		restoreOldCacheRow(f, old);
		expect(f.database.write((scope) => f.model.read(scope, f.ref(), messageId))).toBeUndefined();
		expect(f.database.write((scope) => f.model.cleanup(scope, f.ref(), null, 1))).toMatchObject({
			deleted: 1,
			more: false,
		});
		expect(rowCount(f)).toBe(0);
		const slice = f.database.write((scope) => f.raw.read(scope, f.ref(), blob, 0, 1));
		try {
			expect(slice.bytes.length).toBe(1);
		} finally {
			slice.bytes.fill(0);
		}
		expect(
			f.database.write((scope) => f.metadata.messages(scope, f.ref())).map((m) => m.id),
		).toEqual([messageId]);
	});

	it("advances a stale first candidate to a later current record within bounded pages", async () => {
		const f = owned(),
			bytes = new TextEncoder().encode(
				`From: sender@example.invalid\r\nTo: ${f.account.address}\r\nSubject: Synthetic paged extraction\r\n\r\nSynthetic page body`,
			);
		f.apply([emailMessage("DYTEST-parsed-first"), emailMessage("DYTEST-parsed-second")]);
		const messages = f.database.write((scope) => f.metadata.messages(scope, f.ref()));
		const [first, second] = messages;
		if (!first || !second) throw new Error("Synthetic paged metadata missing");
		const blob = await f.project(bytes),
			mail = await parseMailInWorker(bytes, {
				provider: "generic",
				ownerAddresses: [f.account.address],
			});
		for (const message of [first, second]) {
			const source = f.capture(message.id, blob);
			passes(f, source);
			f.database.write((scope) => f.model.commit(scope, source, mail));
		}
		const old = savedCacheRow(f, first.id);
		f.apply([
			{
				...emailMessage(first.providerId),
				internalDate: first.internalDate + 1,
				labelIds: first.labelIds,
			},
		]);
		expect(rowCount(f)).toBe(1);
		expect(f.database.write((scope) => f.model.read(scope, f.ref(), first.id))).toBeUndefined();
		const currentMail = await parseMailInWorker(bytes, {
			provider: "generic",
			ownerAddresses: [f.account.address],
		});
		const currentSource = f.capture(second.id, blob);
		passes(f, currentSource);
		const currentRecord = f.database.write((scope) =>
			f.model.commit(scope, currentSource, currentMail),
		);
		restoreOldCacheRow(f, old);
		expect(rowCount(f)).toBe(2);
		expect(f.database.write((scope) => f.model.read(scope, f.ref(), first.id))).toBeUndefined();
		const stalePage = f.database.write((scope) =>
			f.model.forThread(scope, f.ref(), first.threadId, null, 1),
		);
		expect(stalePage).toEqual({ records: [], nextAfterId: first.id, scanned: 1 });
		expect(Object.isFrozen(stalePage)).toBe(true);
		expect(Object.isFrozen(stalePage.records)).toBe(true);
		const currentPage = f.database.write((scope) =>
			f.model.forThread(scope, f.ref(), first.threadId, stalePage.nextAfterId, 1),
		);
		expect(currentPage.scanned).toBe(1);
		expect(currentPage.nextAfterId).toBe(second.id);
		expect(currentPage.records).toEqual([currentRecord]);
		expect(currentPage.records[0]?.association).toBe("unverified");
		const end = f.database.write((scope) =>
			f.model.forThread(scope, f.ref(), first.threadId, currentPage.nextAfterId, 1),
		);
		expect(end).toEqual({ records: [], nextAfterId: null, scanned: 0 });
	});

	it.each([
		["exact", 20_000, true],
		["one-over", 20_001, false],
	] as const)(
		"enforces the inert JSON node %s boundary before consuming its job",
		async (_label, nodes, accepted) => {
			const { f, mail, messageId, blob } = await preparedInput();
			const input = nodeBoundaryData(mail, nodes);
			expect(inertNodeCount(input)).toBe(nodes);
			expect(input.body.links.length).toBeLessThan(6_700);
			expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeLessThan(4_194_304);
			const lease = f.lease(messageId);
			const source = f.database.write((scope) =>
				f.model.capture(scope, lease, f.ref(), messageId, blob),
			);
			passes(f, source);
			if (accepted) {
				const record = f.database.write((scope) => f.model.commit(scope, source, input));
				expect(record.association).toBe("unverified");
				expect(inertNodeCount(record.mail)).toBe(nodes);
				expect(rowCount(f)).toBe(1);
				expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe(
					"SUCCEEDED",
				);
			} else {
				expect(() => f.database.write((scope) => f.model.commit(scope, source, input))).toThrow(
					NativeParsedError,
				);
				expect(rowCount(f)).toBe(0);
				expect(() => f.database.write((scope) => f.model.abandon(scope, source))).not.toThrow();
				expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe("PENDING");
			}
		},
	);

	it.each([
		["exact", 4_194_304, true],
		["one-over", 4_194_305, false],
	] as const)(
		"enforces the inert JSON byte %s boundary before consuming its job",
		async (_label, bytes, accepted) => {
			const { f, mail, messageId, blob } = await preparedInput();
			const input = byteBoundaryData(mail, bytes);
			expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(bytes);
			expect(inertNodeCount(input)).toBeLessThan(20_000);
			expect(input.to).toHaveLength(64);
			for (const mailbox of input.to) expect(mailbox.name?.length ?? 0).toBeLessThanOrEqual(65_536);
			const lease = f.lease(messageId);
			const source = f.database.write((scope) =>
				f.model.capture(scope, lease, f.ref(), messageId, blob),
			);
			passes(f, source);
			if (accepted) {
				const record = f.database.write((scope) => f.model.commit(scope, source, input));
				expect(record.association).toBe("unverified");
				expect(Buffer.byteLength(JSON.stringify(record.mail), "utf8")).toBe(bytes);
				expect(rowCount(f)).toBe(1);
				expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe(
					"SUCCEEDED",
				);
			} else {
				expect(() => f.database.write((scope) => f.model.commit(scope, source, input))).toThrow(
					NativeParsedError,
				);
				expect(rowCount(f)).toBe(0);
				// Refusal must precede irreversible job consumption, not merely hit SQLite's size CHECK.
				expect(() => f.database.write((scope) => f.model.abandon(scope, source))).not.toThrow();
				expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe("PENDING");
			}
		},
	);
});

describe("parsed Reply-To header count DATA", () => {
	it.each([
		["zero", "", 0],
		["empty duplicate headers", "Reply-To:\r\nReply-To:\r\n", 2],
	] as const)(
		"round-trips the parser's %s count independently of filtered addresses",
		async (_label, headers, count) => {
			const f = owned();
			const bytes = new TextEncoder().encode(
				`From: sender@example.invalid\r\nTo: ${f.account.address}\r\n${headers}Subject: Synthetic Reply-To count\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nSynthetic header-count body`,
			);
			try {
				f.apply([emailMessage()]);
				const messageId = f.database.write((scope) => f.metadata.messages(scope, f.ref())[0]?.id);
				if (!messageId) throw new Error("Synthetic header-count metadata missing");
				const blob = await f.project(bytes);
				const mail = await parseMail(bytes, {
					provider: "generic",
					ownerAddresses: [f.account.address],
				});
				expect(Object.hasOwn(mail, "replyToHeaderCount")).toBe(true);
				expect(mail.replyToHeaderCount).toBe(count);
				expect(mail.replyTo).toHaveLength(0);
				const source = f.capture(messageId, blob);
				passes(f, source);
				const committed = f.database.write((scope) => f.model.commit(scope, source, mail));
				expect(Object.hasOwn(committed.mail, "replyToHeaderCount")).toBe(true);
				expect(committed.mail.replyToHeaderCount).toBe(count);
				const stored = f.database.write((scope) => f.model.read(scope, f.ref(), messageId));
				if (!stored) throw new Error("Synthetic header-count extraction missing");
				expect(stored).toEqual(committed);
				expect(Object.hasOwn(stored.mail, "replyToHeaderCount")).toBe(true);
				expect(stored.mail.replyToHeaderCount).toBe(count);
			} finally {
				bytes.fill(0);
			}
		},
	);

	it("keeps the optional count absent in legacy parsed DATA across commit and read", async () => {
		const { f, source, mail, messageId } = await prepared();
		expect(Object.hasOwn(mail, "replyToHeaderCount")).toBe(true);
		expect(mail.replyToHeaderCount).toBe(0);
		const legacy = { ...mail };
		delete legacy.replyToHeaderCount;
		expect(Object.hasOwn(legacy, "replyToHeaderCount")).toBe(false);
		passes(f, source);
		const committed = f.database.write((scope) => f.model.commit(scope, source, legacy));
		expect(Object.hasOwn(committed.mail, "replyToHeaderCount")).toBe(false);
		const stored = f.database.write((scope) => f.model.read(scope, f.ref(), messageId));
		if (!stored) throw new Error("Synthetic legacy extraction missing");
		expect(stored).toEqual(committed);
		expect(Object.hasOwn(stored.mail, "replyToHeaderCount")).toBe(false);
	});

	it.each([
		["negative", -1],
		["fractional", 0.5],
		["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
		["nonnumber", "0"],
	] as const)("refuses a %s count without replacing a genuine cache row", async (_label, value) => {
		const { f, source, mail, messageId, blob } = await prepared();
		expect(Object.hasOwn(mail, "replyToHeaderCount")).toBe(true);
		expect(mail.replyToHeaderCount).toBe(0);
		passes(f, source);
		const committed = f.database.write((scope) => f.model.commit(scope, source, mail));
		const before = savedCacheRow(f, messageId);
		const invalidSource = f.capture(messageId, blob);
		passes(f, invalidSource);
		const input: unknown = { ...mail, replyToHeaderCount: value };
		expect(() =>
			f.database.write((scope) => f.model.commit(scope, invalidSource, input as ParsedMail)),
		).toThrow(NativeParsedError);
		expect(rowCount(f)).toBe(1);
		expect(savedCacheRow(f, messageId)).toEqual(before);
		expect(f.database.write((scope) => f.model.read(scope, f.ref(), messageId))).toEqual(committed);
		f.database.write((scope) => f.model.abandon(scope, invalidSource));
	});
});

describe("parsed untrusted HTML storage DATA", () => {
	it.each([
		["nonempty", "<p>DYTEST visible body</p><!--DYTEST raw HTML only-->"],
		["empty", ""],
	] as const)("round-trips accepted %s HTML through real commit and read", async (_label, html) => {
		const { f, bytes, blob, mail, messageId } = await preparedInput(html, "text/html");
		try {
			expect(Object.hasOwn(mail, "untrustedHtml")).toBe(true);
			const decodedHtml = mail.untrustedHtml;
			expect(typeof decodedHtml).toBe("string");
			if (html === "") expect(decodedHtml).toBe("");
			else expect(decodedHtml).toContain("DYTEST raw HTML only");
			const source = f.capture(messageId, blob);
			passes(f, source);
			const committed = f.database.write((scope) => f.model.commit(scope, source, mail));
			expect(Object.hasOwn(committed.mail, "untrustedHtml")).toBe(true);
			expect(committed.mail.untrustedHtml).toBe(decodedHtml);
			const stored = f.database.write((scope) => f.model.read(scope, f.ref(), messageId));
			if (!stored) throw new Error("Synthetic HTML extraction missing");
			expect(stored).toEqual(committed);
			expect(Object.hasOwn(stored.mail, "untrustedHtml")).toBe(true);
			expect(stored.mail.untrustedHtml).toBe(decodedHtml);
			expect(
				f.database.write((scope) => f.model.forThread(scope, f.ref(), "DYTEST-parsed-thread"))
					.records[0]?.mail.untrustedHtml,
			).toBe(decodedHtml);
			const row = savedCacheRow(f, messageId);
			expect(JSON.parse(String(row.parsed_json)).untrustedHtml).toBe(decodedHtml);
			expect(row.cleaned_body).toBe(mail.body.text);
			expect(mail.body.text).not.toContain("DYTEST raw HTML only");
		} finally {
			bytes.fill(0);
		}
	});

	it("keeps the legacy optional HTML field absent for real plaintext mail", async () => {
		const { f, bytes, mail, messageId, source } = await prepared();
		try {
			expect(Object.hasOwn(mail, "untrustedHtml")).toBe(false);
			passes(f, source);
			const committed = f.database.write((scope) => f.model.commit(scope, source, mail));
			const stored = f.database.write((scope) => f.model.read(scope, f.ref(), messageId));
			expect(stored).toEqual(committed);
			expect(Object.hasOwn(committed.mail, "untrustedHtml")).toBe(false);
			if (!stored) throw new Error("Synthetic legacy extraction missing");
			expect(Object.hasOwn(stored.mail, "untrustedHtml")).toBe(false);
			expect(
				Object.hasOwn(JSON.parse(String(savedCacheRow(f, messageId).parsed_json)), "untrustedHtml"),
			).toBe(false);
		} finally {
			bytes.fill(0);
		}
	});

	it.each([
		"nonstring",
		"undefined",
		"ill-formed",
		"byte-limit",
		"refused-body",
		"accessor",
	] as const)("refuses %s HTML DATA without replacing a genuine extraction", async (variant) => {
		const { f, bytes, blob, mail, messageId } = await preparedInput(
			"<p>DYTEST HTML</p>",
			"text/html",
		);
		try {
			expect(typeof mail.untrustedHtml).toBe("string");
			const source = f.capture(messageId, blob);
			passes(f, source);
			const committed = f.database.write((scope) => f.model.commit(scope, source, mail));
			const before = savedCacheRow(f, messageId);
			const invalidSource = f.capture(messageId, blob);
			passes(f, invalidSource);
			let getterCalls = 0;
			let input: unknown;
			if (variant === "nonstring") input = { ...mail, untrustedHtml: 17 };
			else if (variant === "undefined") input = { ...mail, untrustedHtml: undefined };
			else if (variant === "ill-formed") input = { ...mail, untrustedHtml: "\ud800" };
			else if (variant === "byte-limit") {
				const value = "\u{1f4a5}".repeat(262_145);
				expect(value.length).toBeLessThan(1_048_576);
				expect(Buffer.byteLength(value, "utf8")).toBeGreaterThan(1_048_576);
				input = { ...mail, untrustedHtml: value };
			} else if (variant === "refused-body") input = { ...mail, bodyRefusal: "INVALID_INPUT" };
			else
				input = Object.defineProperty({ ...mail }, "untrustedHtml", {
					enumerable: true,
					get() {
						getterCalls++;
						return mail.untrustedHtml;
					},
				});
			expect(() =>
				f.database.write((scope) => f.model.commit(scope, invalidSource, input as ParsedMail)),
			).toThrow(NativeParsedError);
			expect(getterCalls).toBe(0);
			expect(rowCount(f)).toBe(1);
			expect(savedCacheRow(f, messageId)).toEqual(before);
			expect(f.database.write((scope) => f.model.read(scope, f.ref(), messageId))).toEqual(
				committed,
			);
			f.database.write((scope) => f.model.abandon(scope, invalidSource));
		} finally {
			bytes.fill(0);
		}
	});

	it("persists a real refused HTML body's metadata without restoring raw HTML", async () => {
		const { f, bytes, blob, mail, messageId } = await preparedInput(
			"x".repeat(1_048_577),
			"text/html",
		);
		try {
			expect(mail.bodyRefusal).toBe("INPUT_LIMIT");
			expect(Object.hasOwn(mail, "untrustedHtml")).toBe(false);
			const source = f.capture(messageId, blob);
			passes(f, source);
			const committed = f.database.write((scope) => f.model.commit(scope, source, mail));
			const stored = f.database.write((scope) => f.model.read(scope, f.ref(), messageId));
			expect(stored).toEqual(committed);
			if (!stored) throw new Error("Synthetic refused extraction missing");
			expect(stored.mail.bodyRefusal).toBe("INPUT_LIMIT");
			expect(Object.hasOwn(stored.mail, "untrustedHtml")).toBe(false);
			expect(savedCacheRow(f, messageId).cleaned_body).toBe(mail.body.text);
		} finally {
			bytes.fill(0);
		}
	});

	it.each([
		["exact", MAX_PARSED_JSON_BYTES, true],
		["one-over", MAX_PARSED_JSON_BYTES + 1, false],
	] as const)(
		"charges escaped HTML against the whole-mail JSON %s budget",
		async (_label, bytes, accepted) => {
			const html = `<p>DYTEST budget text</p><!--${"\n".repeat(4096)}-->`;
			const { f, bytes: rawBytes, blob, mail, messageId } = await preparedInput(html, "text/html");
			try {
				expect(mail.untrustedHtml).toContain("\n");
				const input = byteBoundaryData(mail, bytes);
				expect(input.untrustedHtml).toBe(mail.untrustedHtml);
				expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(bytes);
				const lease = f.lease(messageId);
				const source = f.database.write((scope) =>
					f.model.capture(scope, lease, f.ref(), messageId, blob),
				);
				passes(f, source);
				if (accepted) {
					const committed = f.database.write((scope) => f.model.commit(scope, source, input));
					expect(committed.mail.untrustedHtml).toBe(mail.untrustedHtml);
					expect(Buffer.byteLength(JSON.stringify(committed.mail), "utf8")).toBe(bytes);
					expect(f.database.write((scope) => f.model.read(scope, f.ref(), messageId))).toEqual(
						committed,
					);
					expect(savedCacheRow(f, messageId).cleaned_body).toBe(mail.body.text);
					expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe(
						"SUCCEEDED",
					);
				} else {
					expect(() => f.database.write((scope) => f.model.commit(scope, source, input))).toThrow(
						NativeParsedError,
					);
					expect(rowCount(f)).toBe(0);
					expect(() => f.database.write((scope) => f.model.abandon(scope, source))).not.toThrow();
					expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe(
						"PENDING",
					);
				}
			} finally {
				rawBytes.fill(0);
			}
		},
	);
});
