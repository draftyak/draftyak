import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, describe, expect, it } from "vitest";
import { AuditChain } from "../../../../src/audit/chain.ts";
import { newId } from "../../../../src/kernel/ids.ts";
import { MasterKey } from "../../../../src/kernel/master-key.ts";
import {
	auditChannelDenial,
	CHANNEL_DENIAL_CODES,
	type ChannelBinding,
	type ChannelCaller,
	type ChannelDenialCode,
	type ChannelRequest,
	type ChannelTicket,
	decideChannelRequest,
} from "../../../../src/plugins/broker/channel/index.ts";
import { HubStore } from "../../../../src/store/store.ts";
import { migrations, nativeBinding } from "../../../store/helpers.ts";

interface AuditRow {
	seq: number;
	id: string;
	at: number;
	action: string;
	actor_kind: string;
	actor_id: string | null;
	refs: string;
	previous: string;
	mac: string;
}

const fixtures: { dir: string; store: HubStore; key: MasterKey; audit: AuditChain }[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) {
		f.store.close();
		f.audit.destroy();
		f.key.destroy();
		rmSync(f.dir, { recursive: true, force: true });
		expect(existsSync(f.dir)).toBe(false);
	}
});
async function fixture() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-channel-audit-")),
		key = new MasterKey(randomBytes(32)),
		auditKey = key.derive("audit"),
		audit = new AuditChain(auditKey);
	auditKey.fill(0);
	const store = new HubStore({
		filename: path.join(dir, "hub.db"),
		nativeBinding,
		masterKey: key,
		create: true,
		migrations: { audit: path.join(migrations, "audit") },
	});
	fixtures.push({ dir, store, key, audit });
	await store.migrate("audit");
	const rows = (): AuditRow[] =>
		store.read((db) => db.all<AuditRow>("SELECT * FROM main.audit_events ORDER BY seq"));
	return { store, audit, rows };
}
const caller = (): { instanceId: string; accountId: string } => ({
	instanceId: newId(),
	accountId: newId(),
});

describe("channel denial audit", () => {
	it("appends one record per denial: its code in the action, the instance as actor, ids as refs", async () => {
		const f = await fixture(),
			who = caller(),
			at = 1_900_000_000_000;
		f.store.write((tx) => {
			for (const code of CHANNEL_DENIAL_CODES) auditChannelDenial(f.audit, tx, who, code, at);
		});
		const rows = f.rows();
		expect(rows.map((row) => row.action)).toEqual(
			CHANNEL_DENIAL_CODES.map((code) => `broker.denied.${code}`),
		);
		for (const row of rows)
			expect(row).toMatchObject({
				at,
				actor_kind: "plugin",
				actor_id: who.instanceId,
				refs: canonicalize({ instance: who.instanceId, account: who.accountId }),
			});
		f.store.read((db) => f.audit.verify(db));
		expect(Object.isFrozen(CHANNEL_DENIAL_CODES)).toBe(true);
		expect(new Set(CHANNEL_DENIAL_CODES).size).toBe(CHANNEL_DENIAL_CODES.length);
	});

	it("leaves the account out when the caller has none and stamps the current time", async () => {
		const f = await fixture(),
			instanceId = newId(),
			before = Date.now();
		f.store.write((tx) => auditChannelDenial(f.audit, tx, { instanceId }, "off_profile"));
		const [row] = f.rows();
		expect(row?.refs).toBe(canonicalize({ instance: instanceId }));
		expect(row?.at).toBeGreaterThanOrEqual(before);
		expect(row?.at).toBeLessThanOrEqual(Date.now());
	});

	it("records no URL, path, query, header value or token from a denied request", async () => {
		const f = await fixture(),
			who = caller(),
			canary = `DYTEST-${randomBytes(8).toString("hex")}`;
		const gmail = "https://gmail.googleapis.com/gmail/v1/users/me",
			slack = "https://slack.com/api";
		const asked: [ChannelBinding, ChannelRequest, ChannelTicket, ChannelDenialCode][] = [];
		const add = (
			code: ChannelDenialCode,
			profile: ChannelBinding["profile"],
			method: string,
			url: string,
			headers: [string, string][] = [],
			ticket: ChannelTicket = { state: "absent" },
			accountMode: ChannelBinding["accountMode"] = "full",
		): void => {
			asked.push([{ profile, accountMode }, { method, url, headers }, ticket, code]);
		};
		add("method_invalid", "gmail-v1", canary, `${gmail}/messages`);
		add("url_invalid", "gmail-v1", "GET", `http://gmail.googleapis.com/${canary}`);
		add("off_profile", "gmail-v1", "POST", `${gmail}/messages/${canary}/trash`);
		add("gmail_batch", "gmail-v1", "POST", `https://www.googleapis.com/batch/gmail/v1?x=${canary}`);
		add("system_parameter", "gmail-v1", "GET", `${gmail}/messages?$alt=${canary}`);
		add("query_credential", "gmail-v1", "GET", `${gmail}/messages?q=${canary}&key=${canary}`);
		add("method_override", "gmail-v1", "GET", `${gmail}/messages`, [
			["X-HTTP-Method-Override", canary],
		]);
		add("headers_invalid", "gmail-v1", "GET", `${gmail}/messages`, [
			["accept", `${canary}\r\nx: y`],
		]);
		add(
			"account_read_only",
			"gmail-v1",
			"POST",
			`${gmail}/messages/batchModify?q=${canary}`,
			[["content-type", canary]],
			undefined,
			"read_only",
		);
		add("off_profile", "gmail-readonly-v1", "POST", `${gmail}/threads/${canary}/modify`);
		add("ticket_missing", "gmail-v1", "POST", `${gmail}/messages/send?q=${canary}`, [
			["authorization", `Bearer ${canary}`],
		]);
		add("slack_scheduling", "slack-v1", "POST", `${slack}/chat.scheduleMessage?text=${canary}`);
		add("hub_only", "slack-v1", "POST", `${slack}/auth.revoke?token=${canary}`);
		add("query_credential", "slack-v1", "GET", `${slack}/conversations.history?token=${canary}`);
		add("ticket_off_profile", "slack-v1", "POST", `${slack}/conversations.list?q=${canary}`, [], {
			state: "redeemed",
		});
		add(
			"ticket_body_mismatch",
			"slack-v1",
			"POST",
			`${slack}/chat.postMessage?text=${canary}`,
			[],
			{
				state: "refused",
				reason: "TICKET_BODY_MISMATCH",
			},
		);
		f.store.write((tx) => {
			for (const [binding, request, ticket, code] of asked) {
				const decision = decideChannelRequest(binding, request, ticket);
				expect(decision).toMatchObject({ allowed: false, code });
				if (!decision.allowed) auditChannelDenial(f.audit, tx, who, decision.code);
			}
		});
		const rows = f.rows();
		expect(rows.map((row) => row.action)).toEqual(
			asked.map(([, , , code]) => `broker.denied.${code}`),
		);
		const page = f.store.read((db) => f.audit.exportVerifiedJsonl(db, { limit: 1000 }));
		expect(page.count).toBe(asked.length);
		for (const text of [JSON.stringify(rows), page.jsonl])
			for (const fragment of [canary, "googleapis", "slack.com", "https", "/"])
				expect(text.includes(fragment)).toBe(false);
	});

	it("appends inside the caller's transaction, so a rollback leaves nothing", async () => {
		const f = await fixture();
		expect(() =>
			f.store.write((tx) => {
				auditChannelDenial(f.audit, tx, caller(), "ticket_missing");
				throw new Error("rollback");
			}),
		).toThrow("rollback");
		expect(f.rows()).toEqual([]);
		f.store.read((db) => f.audit.verify(db));
	});

	it("refuses an unknown code or a non-ULID ref and writes nothing", async () => {
		const f = await fixture(),
			who = caller();
		for (const code of ["toString", "url_invalid.extra", "URL_INVALID", "", "denied"])
			expect(() =>
				f.store.write((tx) =>
					auditChannelDenial(f.audit, tx, who, code as ChannelDenialCode, Date.now()),
				),
			).toThrow("Unknown channel denial code");
		for (const bad of [
			{ instanceId: "https://gmail.googleapis.com/gmail/v1/users/me/messages" },
			{ instanceId: who.instanceId, accountId: "DYTEST-account" },
			{ instanceId: who.instanceId.toLowerCase() },
		] as ChannelCaller[])
			expect(() =>
				f.store.write((tx) => auditChannelDenial(f.audit, tx, bad, "off_profile")),
			).toThrow("Audit metadata is invalid");
		expect(f.rows()).toEqual([]);
	});

	it("appends through the chain's own method, so neither a replaced append nor a fake chain drops it", async () => {
		const f = await fixture(),
			who = caller();
		Object.defineProperty(f.audit, "append", {
			value: () => undefined,
		});
		f.store.write((tx) => auditChannelDenial(f.audit, tx, who, "gmail_batch"));
		expect(f.rows().map((row) => row.action)).toEqual(["broker.denied.gmail_batch"]);
		const fake = { append: () => undefined } as unknown as AuditChain;
		expect(() => f.store.write((tx) => auditChannelDenial(fake, tx, who, "gmail_batch"))).toThrow(
			TypeError,
		);
		expect(f.rows()).toHaveLength(1);
	});
});
