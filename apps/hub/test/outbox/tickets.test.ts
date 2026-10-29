import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type HeaderList, headersSha256, sha256Hex } from "@draftyak/protocol/hash";
import { canonicalize } from "@draftyak/protocol/jcs";
import type { SendTicket, TicketedRequest } from "@draftyak/protocol/send-ticket";
import { afterEach, describe, expect, it } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { type CredentialBinding, CredentialVault } from "../../src/credentials/vault.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { createNativeHttpSendTransport } from "../../src/outbox/http-send.ts";
import {
	MAX_SEND_BODY_BYTES,
	type SendTicketInsert,
	SendTicketStorage,
} from "../../src/outbox/ticket-storage.ts";
import {
	type SendDispatch,
	type SendRedemption,
	SendTicketLedger,
} from "../../src/outbox/tickets.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";
import { migrations, nativeBinding } from "../store/helpers.ts";

const fixtures: {
	dir: string;
	stores: HubStore[];
	key: MasterKey;
	audit: AuditChain;
	storage: SendTicketStorage;
	ledger: SendTicketLedger;
}[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) {
		f.storage.destroy();
		f.ledger.destroy();
		for (const store of f.stores) store.close();
		f.audit.destroy();
		f.key.destroy();
		rmSync(f.dir, { recursive: true, force: true });
	}
});
async function fixture() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-send-tickets-")),
		filename = path.join(dir, "hub.db"),
		fault = path.join(dir, "fault");
	mkdirSync(fault);
	writeFileSync(
		path.join(fault, "0001_fault.sql"),
		"CREATE TABLE ticket_parent(id INTEGER PRIMARY KEY); CREATE TABLE ticket_child(id INTEGER REFERENCES ticket_parent(id) DEFERRABLE INITIALLY DEFERRED);",
	);
	const key = new MasterKey(randomBytes(32)),
		auditKey = key.derive("audit"),
		audit = new AuditChain(auditKey);
	auditKey.fill(0);
	const options = {
		filename,
		nativeBinding,
		masterKey: key,
		migrations: {
			audit: path.join(migrations, "audit"),
			credentials: path.resolve(import.meta.dirname, "../../src/credentials/migrations"),
			tickets: path.resolve(import.meta.dirname, "../../src/outbox/migrations"),
			fault,
		},
	};
	const store = new HubStore({ ...options, create: true });
	await store.migrate("audit");
	await store.migrate("credentials");
	await store.migrate("tickets");
	await store.migrate("fault");
	const time = { wall: 1_800_000_000_000, mono: 10_000 },
		clock = { wallMs: () => time.wall, monotonicMs: () => time.mono };
	const vault = new CredentialVault(store, audit),
		accountId = newId(time.wall),
		owner: CredentialBinding = { ownerKind: "account", ownerId: accountId, kind: "slack-token" };
	const secret = `DYTEST-${randomBytes(20).toString("hex")}`,
		reference = store.write((tx) =>
			vault.createInTransaction(tx, owner, {
				kind: "slack-token",
				accessToken: secret,
				expiresAt: null,
			}),
		);
	const ledger = new SendTicketLedger(store, audit, vault, key, clock),
		storage = new SendTicketStorage(store, audit, vault, key, clock),
		tracked = { dir, stores: [store], key, audit, storage, ledger };
	fixtures.push(tracked);
	const make = (change: Partial<SendTicketInsert> = {}): SendTicketInsert => {
		const headers: HeaderList = [["content-type", "application/json"]],
			body = Buffer.from(JSON.stringify({ text: `DYTEST-${randomBytes(30).toString("hex")}` }));
		return {
			accountId,
			credentialReference: reference,
			credentialGeneration: 1,
			credentialKind: "slack-token",
			epoch: 4,
			contentHash: sha256Hex("approved content"),
			flagsHash: sha256Hex("approved flags"),
			notBefore: null,
			deliverBy: time.wall + 120_000,
			outboxId: newId(time.wall),
			instanceId: newId(time.wall),
			method: "POST",
			url: "https://slack.com/api/chat.postMessage",
			contentType: "application/json",
			headers,
			body,
			approvedHeadersSha256: headersSha256(headers),
			approvedBodySha256: sha256Hex(body),
			...change,
		};
	};
	// Internal DML setup exercises real persistence, not production approval or caller authority.
	const insert = (input = make()): SendTicket =>
		store.write((tx) => storage.insertInTransaction(tx, input));
	const request = (ticket: SendTicket, input: SendTicketInsert): TicketedRequest => ({
		ticket,
		instanceId: input.instanceId,
		method: input.method,
		url: input.url,
		contentType: input.contentType,
		headers: input.headers,
		body: input.body,
	});
	const reopen = () => {
		store.close();
		const next = new HubStore(options);
		tracked.stores.push(next);
		const nextVault = new CredentialVault(next, audit);
		return {
			store: next,
			vault: nextVault,
			ledger: new SendTicketLedger(next, audit, nextVault, key, clock),
			storage: new SendTicketStorage(next, audit, nextVault, key, clock),
		};
	};
	return {
		dir,
		filename,
		store,
		key,
		audit,
		vault,
		owner,
		reference,
		secret,
		clock,
		time,
		ledger,
		storage,
		make,
		insert,
		request,
		reopen,
	};
}
describe("native encrypted send-ticket transaction kernel", () => {
	it("persists exact rendered bytes and native credential generation, with no plaintext database or WAL", async () => {
		const f = await fixture(),
			input = f.make(),
			ticket = f.insert(input);
		for (const suffix of ["", "-wal", "-shm"]) {
			if (!existsSync(f.filename + suffix)) continue;
			const bytes = readFileSync(f.filename + suffix);
			expect(bytes.includes(Buffer.from(input.body))).toBe(false);
			expect(bytes.includes(Buffer.from(f.secret))).toBe(false);
		}
		expect(f.ledger.getAttempt(input.outboxId)?.state).toBe("ISSUED");
		const redemption = f.ledger.redeem(f.request(ticket, input));
		expect(f.ledger.getAttempt(input.outboxId)?.state).toBe("REDEEMED");
		const dispatched = f.ledger.beginDispatch(redemption);
		expect(f.ledger.getAttempt(input.outboxId)?.state).toBe("SENDING");
		expect(dispatched.body).toEqual(input.body);
		expect(dispatched.headers).toEqual(input.headers);
		expect(dispatched.credential).toEqual({
			reference: f.reference,
			generation: 1,
			binding: f.owner,
		});
		expect(f.ledger.recordOutcome(dispatched.dispatch, "SENT").state).toBe("SENT");
		const next = f.reopen();
		expect(next.ledger.getAttempt(input.outboxId)?.state).toBe("SENT");
		next.storage.destroy();
		next.ledger.destroy();
	});
	it("keeps ticket, attempt and authenticated audit atomic on rollback and failed commit", async () => {
		const f = await fixture(),
			input = f.make();
		expect(() =>
			f.store.write((tx) => {
				f.storage.insertInTransaction(tx, input);
				throw new Error("rollback");
			}),
		).toThrow("rollback");
		expect(f.ledger.getAttempt(input.outboxId)).toBeUndefined();
		expect(() =>
			f.store.write((tx) => {
				f.storage.insertInTransaction(tx, input);
				tx.run("INSERT INTO ticket_child(id) VALUES(99)");
			}),
		).toThrow();
		expect(f.ledger.getAttempt(input.outboxId)).toBeUndefined();
		expect(f.insert(input).outboxId).toBe(input.outboxId);
		f.store.read((db) => f.audit.verify(db));
	});
	it("requires a live same-store transaction and current native credential for internal insertion", async () => {
		const f = await fixture(),
			other = await fixture(),
			input = f.make();
		let ended: SqlTransaction | undefined;
		f.store.write((tx) => {
			ended = tx;
			expect(f.vault.describeInTransaction(tx, f.reference, f.owner).generation).toBe(1);
		});
		expect(() => f.storage.insertInTransaction(ended as SqlTransaction, input)).toThrow(
			"Send ticket unavailable",
		);
		expect(() =>
			f.vault.describeInTransaction(ended as SqlTransaction, f.reference, f.owner),
		).toThrow("Credential unavailable");
		expect(() => other.store.write((tx) => f.storage.insertInTransaction(tx, input))).toThrow(
			"Send ticket unavailable",
		);
		expect(() =>
			other.store.write((tx) => f.vault.describeInTransaction(tx, f.reference, f.owner)),
		).toThrow("Credential unavailable");
		expect(() => f.insert({ ...input, credentialReference: other.reference })).toThrow(
			"Send ticket unavailable",
		);
		expect(() => f.insert({ ...input, accountId: newId() })).toThrow("Send ticket unavailable");
		const saved = f.store.read((db) =>
			db.get<{
				owner_kind: string;
				owner_id: string;
				kind: string;
				generation: number;
				status: string;
				value: string;
			}>("SELECT owner_kind,owner_id,kind,generation,status,value FROM credentials WHERE id=?", [
				f.reference,
			]),
		);
		if (!saved) throw new Error("missing fixture credential");
		other.store.write((tx) =>
			tx.run(
				"INSERT INTO credentials(id,owner_kind,owner_id,kind,generation,status,value) VALUES(?,?,?,?,?,?,?)",
				[
					f.reference,
					saved.owner_kind,
					saved.owner_id,
					saved.kind,
					saved.generation,
					saved.status,
					saved.value,
				],
			),
		);
		expect(() =>
			other.store.write((tx) => f.vault.describeInTransaction(tx, f.reference, f.owner)),
		).toThrow("Credential unavailable");
	});
	it.each(["body", "url", "instanceId", "ticket"] as const)(
		"durably burns a found ticket after %s mismatch before refusing",
		async (field) => {
			const f = await fixture(),
				input = f.make(),
				ticket = f.insert(input),
				request = f.request(ticket, input);
			const bad = {
				...request,
				...(field === "body"
					? { body: Buffer.from("changed") }
					: field === "url"
						? { url: "https://slack.com/api/other" }
						: field === "instanceId"
							? { instanceId: newId() }
							: { ticket: { ...ticket, exp: ticket.exp + 1 } }),
			};
			expect(() => f.ledger.redeem(bad)).toThrow("Send ticket unavailable");
			expect(f.ledger.getAttempt(input.outboxId)?.state).toBe("NEEDS_REAPPROVAL");
			expect(() => f.ledger.redeem(request)).toThrowError(
				expect.objectContaining({ reason: "TICKET_UNKNOWN" }),
			);
			const next = f.reopen();
			expect(() => next.ledger.redeem(request)).toThrowError(
				expect.objectContaining({ reason: "TICKET_UNKNOWN" }),
			);
			next.storage.destroy();
			next.ledger.destroy();
		},
	);
	it("never invokes hostile getters or proxy traps and still burns a safely identified ticket", async () => {
		const f = await fixture(),
			input = f.make(),
			ticket = f.insert(input),
			request = f.request(ticket, input);
		let calls = 0;
		const bad = { ...request };
		Object.defineProperty(bad, "body", {
			get: () => {
				calls++;
				throw new Error(f.secret);
			},
		});
		expect(() => f.ledger.redeem(bad)).toThrowError(
			expect.objectContaining({ reason: "TICKET_INVALID" }),
		);
		expect(calls).toBe(0);
		expect(f.ledger.getAttempt(input.outboxId)?.state).toBe("NEEDS_REAPPROVAL");
		const proxy = new Proxy(request, {
			get() {
				calls++;
				throw new Error(f.secret);
			},
			getPrototypeOf() {
				calls++;
				throw new Error(f.secret);
			},
		});
		expect(() => f.ledger.redeem(proxy)).toThrowError(
			expect.objectContaining({ reason: "TICKET_UNKNOWN" }),
		);
		expect(calls).toBe(0);
	});
	it("allows exactly one redemption and one dispatch across concurrent facades of the same real store", async () => {
		const f = await fixture(),
			input = f.make(),
			ticket = f.insert(input),
			other = new SendTicketLedger(f.store, f.audit, f.vault, f.key, f.clock);
		const results = await Promise.allSettled([
			Promise.resolve().then(() => f.ledger.redeem(f.request(ticket, input))),
			Promise.resolve().then(() => other.redeem(f.request(ticket, input))),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const winner = results.find((result) => result.status === "fulfilled");
		if (winner?.status !== "fulfilled") throw new Error("missing redemption");
		const dispatch = other.beginDispatch(winner.value);
		expect(() => f.ledger.beginDispatch(winner.value)).toThrow("Send ticket unavailable");
		expect(() => f.ledger.beginDispatch({} as SendRedemption)).toThrow("Send ticket unavailable");
		expect(() => f.ledger.recordOutcome({} as SendDispatch, "SENT")).toThrow(
			"Send ticket unavailable",
		);
		expect(f.ledger.recordOutcome(dispatch.dispatch, "UNKNOWN").state).toBe("UNKNOWN");
		expect(() => other.recordOutcome(dispatch.dispatch, "SENT")).toThrow("Send ticket unavailable");
		other.destroy();
	});
	it("refuses opaque handles from another encrypted store", async () => {
		const f = await fixture(),
			other = await fixture(),
			input = f.make(),
			ticket = f.insert(input),
			redemption = f.ledger.redeem(f.request(ticket, input));
		expect(() => other.ledger.beginDispatch(redemption)).toThrow("Send ticket unavailable");
		const dispatch = f.ledger.beginDispatch(redemption);
		expect(() => other.ledger.recordOutcome(dispatch.dispatch, "SENT")).toThrow(
			"Send ticket unavailable",
		);
		expect(f.ledger.recordOutcome(dispatch.dispatch, "SENT").state).toBe("SENT");
	});
	it.each(["before-redemption", "before-dispatch"])(
		"fails closed on actual credential rotation %s",
		async (where) => {
			const f = await fixture(),
				input = f.make(),
				ticket = f.insert(input),
				redemption =
					where === "before-dispatch" ? f.ledger.redeem(f.request(ticket, input)) : undefined;
			f.store.write((tx) =>
				f.vault.replaceInTransaction(tx, f.reference, f.owner, {
					kind: "slack-token",
					accessToken: `DYTEST-${randomBytes(20).toString("hex")}`,
					expiresAt: null,
				}),
			);
			expect(() =>
				redemption ? f.ledger.beginDispatch(redemption) : f.ledger.redeem(f.request(ticket, input)),
			).toThrow("Send ticket unavailable");
			expect(f.ledger.getAttempt(input.outboxId)?.state).toBe("NEEDS_REAPPROVAL");
		},
	);
	it("enforces both the wall-clock window and monotonic ticket lifetime", async () => {
		const f = await fixture(),
			input = f.make(),
			ticket = f.insert(input),
			redemption = f.ledger.redeem(f.request(ticket, input));
		f.time.mono += 60_001;
		expect(() => f.ledger.beginDispatch(redemption)).toThrow("Send ticket unavailable");
		expect(f.ledger.getAttempt(input.outboxId)?.state).toBe("NEEDS_REAPPROVAL");
		const second = f.make(),
			secondTicket = f.insert(second);
		f.time.wall = secondTicket.exp + 1;
		expect(() => f.ledger.redeem(f.request(secondTicket, second))).toThrowError(
			expect.objectContaining({ reason: "TICKET_EXPIRED" }),
		);
		expect(f.ledger.getAttempt(second.outboxId)?.state).toBe("EXPIRED");
	});
	it("does not renew the ticket lifetime when wall time stalls before first redemption", async () => {
		const f = await fixture(),
			input = f.make(),
			ticket = f.insert(input);
		f.time.mono += 60_001;
		expect(() => f.ledger.redeem(f.request(ticket, input))).toThrowError(
			expect.objectContaining({ reason: "SEND_STATE_CHANGED" }),
		);
		expect(f.ledger.getAttempt(input.outboxId)?.state).toBe("NEEDS_REAPPROVAL");
	});
	it("refuses early schedule, closed delivery window, wrong approved digest and noncanonical URLs", async () => {
		const f = await fixture();
		for (const change of [
			{ notBefore: f.time.wall + 1 },
			{ deliverBy: f.time.wall },
			{ approvedBodySha256: sha256Hex("wrong") },
			{ approvedHeadersSha256: sha256Hex("wrong") },
			{ url: "https://slack.com:443/api/chat.postMessage" },
			{ headers: [["authorization", "refuse"]] as HeaderList },
		])
			expect(() => f.insert(f.make(change))).toThrow("Send ticket unavailable");
		expect(
			f.store.read(
				(db) => db.get<{ n: number }>("SELECT count(*) AS n FROM native_send_attempts")?.n,
			),
		).toBe(0);
	});
	it("returns saved hub bytes after caller buffers change, and ignores overridden typed-array properties", async () => {
		const f = await fixture(),
			input = f.make(),
			original = Buffer.from(input.body),
			ticket = f.insert(input);
		input.body.fill(33);
		const body = Buffer.from(original);
		Object.defineProperties(body, {
			buffer: {
				get() {
					throw new Error("getter");
				},
			},
			byteLength: {
				get() {
					throw new Error("getter");
				},
			},
			[Symbol.iterator]: {
				value() {
					throw new Error("iterator");
				},
			},
		});
		const redemption = f.ledger.redeem({ ...f.request(ticket, input), body }),
			dispatch = f.ledger.beginDispatch(redemption);
		body.fill(42);
		expect(dispatch.body).toEqual(original);
		expect(f.ledger.getAttempt(input.outboxId)?.state).toBe("SENDING");
	});
	it("bounds the actual stored body before copying and refuses shared-memory request bodies", async () => {
		const f = await fixture();
		expect(() => f.insert(f.make({ body: new Uint8Array(MAX_SEND_BODY_BYTES + 1) }))).toThrow(
			"Send ticket unavailable",
		);
		const shared = new Uint8Array(new SharedArrayBuffer(4));
		expect(() => f.insert(f.make({ body: shared }))).toThrow("Send ticket unavailable");
		const body = Buffer.alloc(65_537, 120),
			input = f.make({ body, approvedBodySha256: sha256Hex(body) }),
			ticket = f.insert(input);
		expect(f.ledger.beginDispatch(f.ledger.redeem(f.request(ticket, input))).body.byteLength).toBe(
			65_537,
		);
	});
	it.each(["body", "state", "payload"])(
		"refuses stored %s corruption before releasing any request",
		async (column) => {
			const f = await fixture(),
				input = f.make(),
				ticket = f.insert(input);
			f.store.write((tx) => {
				if (column === "body")
					tx.run("UPDATE native_send_attempts SET body=? WHERE outbox_id=?", [
						Buffer.from("tampered"),
						input.outboxId,
					]);
				else if (column === "state")
					tx.run("UPDATE native_send_attempts SET state='REDEEMED' WHERE outbox_id=?", [
						input.outboxId,
					]);
				else
					tx.run("UPDATE native_send_attempts SET payload=? WHERE outbox_id=?", [
						"{}",
						input.outboxId,
					]);
			});
			expect(() => f.ledger.redeem(f.request(ticket, input))).toThrow("Send ticket unavailable");
		},
	);
	it("detects authenticated old-row resurrection and missing-row resend through current audit history", async () => {
		const f = await fixture(),
			input = f.make(),
			ticket = f.insert(input),
			old = f.store.read((db) =>
				db.get<{ state: string; updated_at: number; audit_seq: number; mac: string }>(
					"SELECT state,updated_at,audit_seq,mac FROM native_send_attempts WHERE outbox_id=?",
					[input.outboxId],
				),
			);
		f.ledger.redeem(f.request(ticket, input));
		if (!old) throw new Error("missing row");
		f.store.write((tx) =>
			tx.run(
				"UPDATE native_send_attempts SET state=?,updated_at=?,audit_seq=?,mac=? WHERE outbox_id=?",
				[old.state, old.updated_at, old.audit_seq, old.mac, input.outboxId],
			),
		);
		expect(() => f.ledger.redeem(f.request(ticket, input))).toThrow("Send ticket unavailable");
		f.store.write((tx) =>
			tx.run("DELETE FROM native_send_attempts WHERE outbox_id=?", [input.outboxId]),
		);
		expect(() => f.insert(input)).toThrow("Send ticket unavailable");
	});
	it("authenticates approved content and flags bindings even when altered SQL remains structurally valid", async () => {
		const f = await fixture(),
			input = f.make(),
			ticket = f.insert(input);
		f.store.write((tx) => {
			const row = tx.get<{ payload: string }>(
				"SELECT payload FROM native_send_attempts WHERE outbox_id=?",
				[input.outboxId],
			);
			if (!row) throw new Error("missing row");
			const payload = JSON.parse(row.payload);
			payload.flagsHash = sha256Hex("different flags");
			tx.run("UPDATE native_send_attempts SET payload=? WHERE outbox_id=?", [
				canonicalize(payload),
				input.outboxId,
			]);
		});
		expect(() => f.ledger.redeem(f.request(ticket, input))).toThrow("Send ticket unavailable");
	});
	it("never moves an observed terminal attempt back into a dispatchable state", async () => {
		const f = await fixture(),
			input = f.make(),
			ticket = f.insert(input),
			dispatch = f.ledger.beginDispatch(f.ledger.redeem(f.request(ticket, input)));
		f.ledger.recordOutcome(dispatch.dispatch, "UNKNOWN");
		expect(() =>
			f.storage.write((tx) => {
				const row = f.storage.find(tx, "outbox_id", input.outboxId);
				if (!row) throw new Error("missing row");
				f.storage.transition(tx, row, "ISSUED");
			}),
		).toThrow("Send ticket unavailable");
		expect(f.ledger.getAttempt(input.outboxId)?.state).toBe("UNKNOWN");
	});
	it("recovers issued and redeemed attempts to reapproval and possibly effective IO to UNKNOWN without retry", async () => {
		const f = await fixture(),
			issued = f.make(),
			redeemed = f.make(),
			sending = f.make();
		f.insert(issued);
		const rt = f.insert(redeemed),
			st = f.insert(sending);
		f.ledger.redeem(f.request(rt, redeemed));
		f.ledger.beginDispatch(f.ledger.redeem(f.request(st, sending)));
		const next = f.reopen();
		expect(next.ledger.getAttempt(issued.outboxId)?.state).toBe("NEEDS_REAPPROVAL");
		expect(next.ledger.getAttempt(redeemed.outboxId)?.state).toBe("NEEDS_REAPPROVAL");
		expect(next.ledger.getAttempt(sending.outboxId)?.state).toBe("UNKNOWN");
		for (const input of [issued, redeemed, sending])
			expect(() => next.store.write((tx) => next.storage.insertInTransaction(tx, input))).toThrow(
				"Send ticket unavailable",
			);
		next.storage.destroy();
		next.ledger.destroy();
	});
	it("retains real IO outcomes after credential revocation and ticket expiry without creating fresh authority", async () => {
		const f = await fixture(),
			input = f.make(),
			ticket = f.insert(input),
			dispatch = f.ledger.beginDispatch(f.ledger.redeem(f.request(ticket, input)));
		f.store.write((tx) => f.vault.invalidateInTransaction(tx, f.reference, f.owner, "revoke"));
		f.time.wall += 120_001;
		f.time.mono += 120_001;
		expect(f.ledger.recordOutcome(dispatch.dispatch, "SENT").state).toBe("SENT");
		expect(() => f.insert(input)).toThrow("Send ticket unavailable");
	});
	it("does not expose a dispatch when audit persistence is unavailable", async () => {
		const f = await fixture(),
			input = f.make(),
			ticket = f.insert(input),
			redemption = f.ledger.redeem(f.request(ticket, input));
		f.audit.destroy();
		expect(() => f.ledger.beginDispatch(redemption)).toThrow("Send ticket unavailable");
		expect(() => f.ledger.beginDispatch(redemption)).toThrow("Send ticket unavailable");
		expect(
			f.store.read((db) =>
				db.get<{ state: string }>("SELECT state FROM native_send_attempts WHERE outbox_id=?", [
					input.outboxId,
				]),
			)?.state,
		).toBe("REDEEMED");
	});
	it("acquires exactly one native write right across real ledger facades", async () => {
		const f = await fixture(),
			input = f.make(),
			ticket = f.insert(input),
			dispatch = f.ledger.beginDispatch(f.ledger.redeem(f.request(ticket, input))),
			other = new SendTicketLedger(f.store, f.audit, f.vault, f.key, f.clock);
		const actual = other.prepareDispatchWrite(dispatch.dispatch);
		expect(actual.body).toEqual(input.body);
		expect(actual.ticket).toEqual(ticket);
		expect(actual.credential.generation).toBe(1);
		expect(() => f.ledger.prepareDispatchWrite(dispatch.dispatch)).toThrow(
			"Send ticket unavailable",
		);
		expect(f.ledger.getAttempt(input.outboxId)?.state).toBe("SENDING");
		f.ledger.recordOutcome(dispatch.dispatch, "UNKNOWN");
		other.destroy();
	});
	it.each(["expiry", "rotation"] as const)(
		"rechecks %s immediately before native write acquisition",
		async (change) => {
			const f = await fixture(),
				input = f.make(),
				ticket = f.insert(input),
				dispatch = f.ledger.beginDispatch(f.ledger.redeem(f.request(ticket, input)));
			if (change === "expiry") f.time.mono += 60_001;
			else
				f.store.write((tx) =>
					f.vault.replaceInTransaction(tx, f.reference, f.owner, {
						kind: "slack-token",
						accessToken: `DYTEST-${randomBytes(20).toString("hex")}`,
						expiresAt: null,
					}),
				);
			expect(() => f.ledger.prepareDispatchWrite(dispatch.dispatch)).toThrow(
				"Send ticket unavailable",
			);
			expect(() => f.ledger.prepareDispatchWrite(dispatch.dispatch)).toThrow(
				"Send ticket unavailable",
			);
			expect(f.ledger.recordOutcome(dispatch.dispatch, "FAILED").state).toBe("FAILED");
		},
	);
	it("write expiry cannot erase a later native outcome or create another write right", async () => {
		const f = await fixture(),
			input = f.make(),
			ticket = f.insert(input),
			dispatch = f.ledger.beginDispatch(f.ledger.redeem(f.request(ticket, input)));
		f.ledger.prepareDispatchWrite(dispatch.dispatch);
		f.time.wall += 60_001;
		f.time.mono += 60_001;
		// This is ledger persistence only; the HTTP path requires genuine native classification.
		expect(f.ledger.recordOutcome(dispatch.dispatch, "SENT").state).toBe("SENT");
		expect(() => f.ledger.prepareDispatchWrite(dispatch.dispatch)).toThrow(
			"Send ticket unavailable",
		);
	});
	it("pins native transport composition to the ledger's actual vault instance", async () => {
		const f = await fixture(),
			foreign = await fixture();
		expect(() => f.ledger.assertVault(f.vault)).not.toThrow();
		expect(() => f.ledger.assertVault(foreign.vault)).toThrow("Send ticket unavailable");
		expect(() =>
			createNativeHttpSendTransport({
				ledger: f.ledger,
				vault: foreign.vault,
				networkPolicy: { deniedAddresses: [], deniedPorts: [] },
			}),
		).toThrow("Send request unavailable");
	});
	it("rechecks native write currentness after preparation before bytes can be written", async () => {
		const f = await fixture(),
			input = f.make(),
			ticket = f.insert(input),
			dispatch = f.ledger.beginDispatch(f.ledger.redeem(f.request(ticket, input)));
		expect(() => f.ledger.assertDispatchWriteCurrent(dispatch.dispatch)).toThrow(
			"Send ticket unavailable",
		);
		f.ledger.prepareDispatchWrite(dispatch.dispatch);
		expect(() => f.ledger.assertDispatchWriteCurrent(dispatch.dispatch)).not.toThrow();
		f.time.mono += 60_001;
		expect(() => f.ledger.assertDispatchWriteCurrent(dispatch.dispatch)).toThrow(
			"Send ticket unavailable",
		);
		expect(f.ledger.recordOutcome(dispatch.dispatch, "FAILED").state).toBe("FAILED");
	});
});
