import { parseMail } from "@draftyak/content";
import type { BlobRef } from "@draftyak/protocol/normalized-change";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MAX_PARSED_ACCOUNT_BYTES,
	MAX_PARSED_ACCOUNT_RECORDS,
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
	if (!current) throw new Error("Synthetic parsed quota fixture unavailable");
	return current;
}

const TEMPLATE = "DYTEST-quota-template";
const CANDIDATE = "DYTEST-quota-candidate";
const GENERATED = "DYTEST-generated-quota-";
const ZERO_DIGEST = "0".repeat(64);
const storageId = (index: number): string => String(index).padStart(26, "0");
const MESSAGE_COLUMNS =
	"id,user_id,account_id,generation,provider_id,conversation_id,internal_date,label_json,size_bytes,state,direction";
const CACHE_COLUMNS =
	"message_id,account_id,generation,user_id,plugin_instance_id,mode,provider_id,thread_id,account_digest,metadata_digest,source_cursor,source_revision,raw_ref,raw_sha256,raw_bytes,parsed_json,parsed_digest,scope_token,cleaned_body,association";
// The negative occupancy has ZERO_DIGEST account data, never current parse authority.
const GENERATED_SCOPE =
	"'dyparsedv1z'||lower(hex(p.user_id))||'z'||lower(hex(p.account_id))||'z'||CAST(p.generation AS TEXT)||'z'||lower(hex(p.plugin_instance_id))||'z'||lower(hex(p.mode))||'z'||?";
function totals(f: NativeParsedFixture): { count: number; bytes: number } {
	const result = f.store.read((sql) =>
		sql.get<{ count: number; bytes: number }>(
			"SELECT count(*) AS count,coalesce(sum(length(CAST(parsed_json AS BLOB))),0) AS bytes FROM main.content_parsed_messages WHERE account_id=? AND generation=?",
			[f.account.id, f.ref().generation],
		),
	);
	if (!result) throw new Error("Synthetic quota totals unavailable");
	return result;
}
function capture(f: NativeParsedFixture, messageId: string, blob: BlobRef) {
	const lease = f.lease(messageId);
	const source = f.database.write((scope) =>
		f.model.capture(scope, lease, f.ref(), messageId, blob),
	);
	for (let pass = 0; pass < 2; pass++) f.scan(source).fill(0);
	return { source, jobId: lease.job.id };
}
function abandonRefused(f: NativeParsedFixture, source: NativeParsedSource, jobId: string): void {
	// commit's known refusal retires this source, not its hidden renewed job lease.
	f.database.write((scope) => f.model.abandon(scope, source));
	expect(f.database.write((scope) => f.jobs.get(scope, jobId))).toMatchObject({
		state: "PENDING",
		leaseUntil: null,
	});
}
async function prepared() {
	const f = owned();
	f.apply([emailMessage(TEMPLATE), emailMessage(CANDIDATE)]);
	const messages = f.database.write((scope) => f.metadata.messages(scope, f.ref()));
	const templateId = messages.find((message) => message.providerId === TEMPLATE)?.id;
	const candidateId = messages.find((message) => message.providerId === CANDIDATE)?.id;
	if (!templateId || !candidateId) throw new Error("Synthetic quota metadata unavailable");
	const bytes = new TextEncoder().encode(
		`From: sender@example.invalid\r\nTo: ${f.account.address}\r\nSubject: Synthetic quota boundary\r\n\r\nSynthetic quota body`,
	);
	try {
		// One genuine Raw writer/JSON-member admission serves these two metadata records.
		const blob = await f.project(bytes);
		const mail = await parseMail(bytes, {
			provider: "generic",
			ownerAddresses: [f.account.address],
		});
		const template = capture(f, templateId, blob);
		f.database.write((scope) => f.model.commit(scope, template.source, mail));
		expect(f.database.write((scope) => f.jobs.get(scope, template.jobId))).toMatchObject({
			state: "SUCCEEDED",
			leaseUntil: null,
		});
		const jsonBytes = totals(f).bytes;
		expect(totals(f).count).toBe(1);
		expect(jsonBytes).toBeGreaterThan(2);
		expect(jsonBytes).toBeLessThan(4096);
		return { f, blob, mail, templateId, candidateId, jsonBytes };
	} finally {
		bytes.fill(0);
	}
}

/**
 * Generated hostile storage occupancy only. These are NOT producer admissions,
 * parsed results, provider observations, NativeParsedSource handles or leases.
 * The real quota intentionally counts all stored occupancy. Invalid digests,
 * absent Raw references and non-ParsedMail JSON prevent positive extraction.
 */
function seedCountOccupancy(f: NativeParsedFixture, templateId: string, count: number): void {
	const numbers = `WITH digit(n) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
 generated(n) AS (SELECT 1+a.n+10*b.n+100*c.n+1000*d.n FROM digit a CROSS JOIN digit b CROSS JOIN digit c CROSS JOIN digit d)`;
	f.store.write((sql) => {
		expect(
			sql.run(
				`${numbers} INSERT INTO main.content_messages(${MESSAGE_COLUMNS})
 SELECT printf('%026d',n),m.user_id,m.account_id,m.generation,?||n,m.conversation_id,m.internal_date,m.label_json,m.size_bytes,m.state,m.direction
 FROM generated CROSS JOIN main.content_messages m WHERE n<=? AND m.id=?`,
				[GENERATED, count, templateId],
			).changes,
		).toBe(count);
		expect(
			sql.run(
				`INSERT INTO main.content_parsed_messages(${CACHE_COLUMNS})
 SELECT m.id,p.account_id,p.generation,p.user_id,p.plugin_instance_id,p.mode,m.provider_id,p.thread_id,?,?,p.source_cursor,p.source_revision,m.id,?,1,'[]',?,${GENERATED_SCOPE},'','unverified'
 FROM main.content_messages m CROSS JOIN main.content_parsed_messages p
 WHERE p.message_id=? AND m.account_id=p.account_id AND m.generation=p.generation AND substr(m.provider_id,1,?)=?`,
				[
					ZERO_DIGEST,
					ZERO_DIGEST,
					ZERO_DIGEST,
					ZERO_DIGEST,
					ZERO_DIGEST,
					templateId,
					GENERATED.length,
					GENERATED,
				],
			).changes,
		).toBe(count);
	});
}
function seedByteOccupancy(
	f: NativeParsedFixture,
	templateId: string,
	byteCount: number,
): readonly string[] {
	const ids: string[] = [];
	f.store.write((sql) => {
		let remaining = byteCount;
		while (remaining > 0) {
			const length = Math.min(remaining, MAX_PARSED_JSON_BYTES);
			expect(length).toBeGreaterThanOrEqual(3);
			const id = storageId(ids.length + 1),
				json = `"${"x".repeat(length - 2)}"`;
			expect(Buffer.byteLength(json)).toBe(length);
			expect(
				sql.run(
					`INSERT INTO main.content_messages(${MESSAGE_COLUMNS})
 SELECT ?,m.user_id,m.account_id,m.generation,?,m.conversation_id,m.internal_date,m.label_json,m.size_bytes,m.state,m.direction
 FROM main.content_messages m WHERE m.id=?`,
					[id, GENERATED + (ids.length + 1), templateId],
				).changes,
			).toBe(1);
			expect(
				sql.run(
					`INSERT INTO main.content_parsed_messages(${CACHE_COLUMNS})
 SELECT ?,p.account_id,p.generation,p.user_id,p.plugin_instance_id,p.mode,?,p.thread_id,?,?,p.source_cursor,p.source_revision,?, ?,1,?,?,${GENERATED_SCOPE},'','unverified'
 FROM main.content_parsed_messages p WHERE p.message_id=?`,
					[
						id,
						GENERATED + (ids.length + 1),
						ZERO_DIGEST,
						ZERO_DIGEST,
						id,
						ZERO_DIGEST,
						json,
						ZERO_DIGEST,
						ZERO_DIGEST,
						templateId,
					],
				).changes,
			).toBe(1);
			ids.push(id);
			remaining -= length;
		}
	});
	return ids;
}
function expectGeneratedRowUnavailable(f: NativeParsedFixture, messageId: string): void {
	let result: unknown;
	try {
		result = f.database.write((scope) => f.model.read(scope, f.ref(), messageId));
	} catch (error) {
		expect(error).toBeInstanceOf(NativeParsedError);
	}
	expect(result).toBeUndefined();
}

describe("native parsed account quota storage boundaries", () => {
	it("counts 10,000 stored rows, refuses row 10,001, then admits with exactly one slot free", async () => {
		const { f, blob, mail, templateId, candidateId, jsonBytes } = await prepared();
		expect(MAX_PARSED_ACCOUNT_RECORDS).toBe(10_000);
		seedCountOccupancy(f, templateId, MAX_PARSED_ACCOUNT_RECORDS - 1);
		const full = totals(f);
		expect(full).toEqual({ count: 10_000, bytes: jsonBytes + 9_999 * 2 });
		expect(full.bytes + jsonBytes).toBeLessThan(MAX_PARSED_ACCOUNT_BYTES);
		expectGeneratedRowUnavailable(f, storageId(1));
		const refused = capture(f, candidateId, blob);
		expect(() => f.database.write((scope) => f.model.commit(scope, refused.source, mail))).toThrow(
			NativeParsedError,
		);
		expect(totals(f)).toEqual(full);
		expect(f.database.write((scope) => f.model.read(scope, f.ref(), candidateId))).toBeUndefined();
		expect(f.database.write((scope) => f.jobs.get(scope, refused.jobId))).toMatchObject({
			state: "RUNNING",
		});
		abandonRefused(f, refused.source, refused.jobId);
		f.store.write((sql) => {
			expect(
				sql.run("DELETE FROM main.content_messages WHERE id=? AND account_id=?", [
					storageId(1),
					f.account.id,
				]).changes,
			).toBe(1);
		});
		expect(totals(f)).toEqual({ count: 9_999, bytes: full.bytes - 2 });
		const admitted = capture(f, candidateId, blob);
		expect(admitted.jobId).not.toBe(refused.jobId);
		const record = f.database.write((scope) => f.model.commit(scope, admitted.source, mail));
		expect(totals(f)).toEqual({ count: 10_000, bytes: full.bytes - 2 + jsonBytes });
		expect(f.database.write((scope) => f.model.read(scope, f.ref(), candidateId))).toEqual(record);
		expect(f.database.write((scope) => f.jobs.get(scope, admitted.jobId))).toMatchObject({
			state: "SUCCEEDED",
			leaseUntil: null,
		});
	});

	it("refuses one byte over 64 MiB, then admits at exactly 64 MiB after one storage byte is removed", async () => {
		const { f, blob, mail, templateId, candidateId, jsonBytes } = await prepared();
		expect(MAX_PARSED_ACCOUNT_BYTES).toBe(67_108_864);
		const generatedIds = seedByteOccupancy(
			f,
			templateId,
			MAX_PARSED_ACCOUNT_BYTES - 2 * jsonBytes + 1,
		);
		expect(generatedIds).toHaveLength(16);
		const first = generatedIds[0];
		if (!first) throw new Error("Synthetic quota storage row unavailable");
		const full = totals(f);
		expect(full).toEqual({ count: 17, bytes: MAX_PARSED_ACCOUNT_BYTES - jsonBytes + 1 });
		expect(full.bytes + jsonBytes).toBe(MAX_PARSED_ACCOUNT_BYTES + 1);
		expect(full.count + 1).toBeLessThan(MAX_PARSED_ACCOUNT_RECORDS);
		expectGeneratedRowUnavailable(f, first);
		const refused = capture(f, candidateId, blob);
		expect(() => f.database.write((scope) => f.model.commit(scope, refused.source, mail))).toThrow(
			NativeParsedError,
		);
		expect(totals(f)).toEqual(full);
		expect(f.database.write((scope) => f.model.read(scope, f.ref(), candidateId))).toBeUndefined();
		expect(f.database.write((scope) => f.jobs.get(scope, refused.jobId))).toMatchObject({
			state: "RUNNING",
		});
		abandonRefused(f, refused.source, refused.jobId);
		f.store.write((sql) => {
			expect(
				sql.run(
					"UPDATE main.content_parsed_messages SET parsed_json=substr(parsed_json,1,length(parsed_json)-2)||'\"' WHERE message_id=? AND account_id=?",
					[first, f.account.id],
				).changes,
			).toBe(1);
		});
		expect(totals(f)).toEqual({ count: full.count, bytes: full.bytes - 1 });
		expect(totals(f).bytes + jsonBytes).toBe(MAX_PARSED_ACCOUNT_BYTES);
		const admitted = capture(f, candidateId, blob);
		expect(admitted.jobId).not.toBe(refused.jobId);
		const record = f.database.write((scope) => f.model.commit(scope, admitted.source, mail));
		expect(totals(f)).toEqual({ count: 18, bytes: MAX_PARSED_ACCOUNT_BYTES });
		expect(f.database.write((scope) => f.model.read(scope, f.ref(), candidateId))).toEqual(record);
		expect(f.database.write((scope) => f.jobs.get(scope, admitted.jobId))).toMatchObject({
			state: "SUCCEEDED",
			leaseUntil: null,
		});
	});
});
