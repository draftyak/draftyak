import { createHash, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "@draftyak/protocol/jcs";
import { exportSpki } from "@draftyak/protocol/sign";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HUB_NAMESPACES, migrateHubSchemas } from "../../src/kernel/namespaces.ts";
import { HubStore, type SqlReader, type SqlTransaction } from "../../src/store/store.ts";

type Api = typeof import("../../src/outbox/restore-approvals.ts");
type Target = InstanceType<Api["NativeApprovalRestore"]>;
let api: Api;
const NOW = 1_800_000_000_000;
const id = (n: number) => String(n).padStart(26, "0");
const USER = id(1),
	DEVICE = id(2),
	ACCOUNT = id(3);
const apply = Reflect.apply;
const originalVerify = AuditChain.prototype.verify;
let afterVerify: ((db: SqlReader) => void) | undefined;
let restoreVerify: (() => void) | undefined;

function testBinding(): string {
	const require = createRequire(import.meta.url);
	const entry = fs.realpathSync.native(require.resolve("better-sqlite3-multiple-ciphers"));
	const root = path.dirname(path.dirname(entry));
	const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	if (
		metadata.name !== "better-sqlite3-multiple-ciphers" ||
		metadata.version !== "13.0.3" ||
		metadata.main !== "lib/index.js" ||
		entry !== path.join(root, "lib", "index.js")
	)
		throw new Error("Own ordinary SQLite test package unavailable");
	const file = path.join(root, "prebuilds", `${process.platform}-${process.arch}.node`);
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(file) !== file)
		throw new Error("Own ordinary SQLite test binding unavailable");
	return file;
}

class Fixture {
	root: string | undefined;
	identity: fs.BigIntStats | undefined;
	key: MasterKey | undefined;
	store: HubStore | undefined;
	audit: AuditChain | undefined;
	target: Target | undefined;
	uncertain = false;
	closed = false;
	wall = NOW;
	clockCalls = 0;
	onWall: (() => void) | undefined;
	serial = 0;
	readonly clock = {
		wallMs: () => {
			this.clockCalls++;
			this.onWall?.();
			return this.wall;
		},
		monotonicMs: () => 0,
	};
	async initialize(): Promise<void> {
		// The owner is registered before the first filesystem or native producer is called.
		const root = fs.mkdtempSync(
			path.join(fs.realpathSync.native(os.tmpdir()), "dy-restore-approvals-"),
		);
		this.root = root;
		this.identity = fs.lstatSync(root, { bigint: true });
		const seed = randomBytes(32);
		try {
			this.key = new MasterKey(seed);
		} finally {
			seed.fill(0);
		}
		const nativeBinding = testBinding();
		this.uncertain = true;
		this.store = new HubStore({
			filename: path.join(root, "archive.db"),
			create: true,
			masterKey: this.key,
			nativeBinding,
			migrations: HUB_NAMESPACES,
		});
		this.uncertain = false;
		await migrateHubSchemas(this.store);
		const auditKey = this.key.derive("audit");
		try {
			this.audit = new AuditChain(auditKey);
		} finally {
			auditKey.fill(0);
		}
		const spki = exportSpki(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey);
		this.store.write((tx) => {
			tx.run("INSERT INTO main.users(id,created_at) VALUES(?,?)", [USER, NOW]);
			// Historical synthetic row DATA only, never a connected or accepted device/peer.
			tx.run(
				`INSERT INTO main.devices(id,user_id,role,name,spki_sha256,approval_key,key_class,
 claim_window,paired_epoch,paired_at) VALUES(?,?,'device','synthetic archive',?,?,'dev','pairing',0,?)`,
				[
					DEVICE,
					USER,
					createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex"),
					spki,
					NOW,
				],
			);
		});
		this.target = new api.NativeApprovalRestore(this.store, this.audit, this.key, this.clock);
	}
	get db(): HubStore {
		return (
			this.store ??
			(() => {
				throw new Error("Original Store absent");
			})()
		);
	}
	get reducer(): Target {
		return (
			this.target ??
			(() => {
				throw new Error("Original reducer absent");
			})()
		);
	}
	seed(
		tx: SqlTransaction,
		state: "live" | "consumed" | "voided" = "live",
		notBefore: number | null = null,
	) {
		if (!this.key || !this.audit) throw new Error("Original fixture services unavailable");
		const serial = ++this.serial,
			approval = id(1000 + serial),
			outbox = id(2000 + serial),
			challenge = id(3000 + serial);
		tx.run(
			`INSERT INTO main.approval_challenges(id,nonce,kind,target_id,device_id,user_id,data_class,
 epoch,target_version,statement,issued_at,expires_at) VALUES(?,?,'approval.send.v1',?,?,?,'slack.content',1,1,?,?,?)`,
			[
				challenge,
				randomBytes(16).toString("base64url"),
				outbox,
				DEVICE,
				USER,
				Buffer.from("Synthetic archived challenge DATA"),
				NOW,
				NOW + 120_000,
			],
		);
		this.audit.append(tx, {
			id: id(4000 + serial),
			at: NOW,
			action: state === "voided" ? "approval.lapsed" : "approval.accepted",
			actor: { kind: "device", id: DEVICE },
			refs: { approval, outbox },
		});
		const head = tx.get<{ audit_seq: number; audit_mac: string }>(
			"SELECT audit_seq,audit_head AS audit_mac FROM main.audit_meta WHERE singleton=1",
		);
		if (!head) throw new Error("Original audit head missing");
		const facts = {
			id: approval,
			outbox_id: outbox,
			account_id: ACCOUNT,
			data_class: "slack.content",
			challenge_id: challenge,
			device_id: DEVICE,
			user_id: USER,
			content_hash: "1".repeat(64),
			flags_hash: "2".repeat(64),
			epoch: 1,
			target_version: 1,
			iat: NOW,
			not_before: notBefore,
			deliver_by: NOW + 60_000,
			accepted_at: NOW,
			consumed_at: state === "consumed" ? NOW + 1 : null,
			voided_at: state === "voided" ? NOW + 1 : null,
			void_reason: state === "voided" ? "policy" : null,
			...head,
		};
		const key = this.key.derive("approvals");
		let mac: string;
		try {
			mac = createHmac("sha256", key)
				.update("draftyak/native-approval/v1\n")
				.update(canonicalize(facts))
				.digest("hex");
		} finally {
			key.fill(0);
		}
		const names = Object.keys(facts);
		tx.run(
			`INSERT INTO main.approvals(${names.join(",")},mac) VALUES(${names.map(() => "?").join(",")},?)`,
			[...Object.values(facts), mac],
		);
		return { ...facts, mac };
	}
	snapshot() {
		return this.db.read((db) => ({
			rows: db.all<Record<string, unknown>>("SELECT * FROM main.approvals ORDER BY id"),
			audit: db.all<Record<string, unknown>>("SELECT * FROM main.audit_events ORDER BY seq"),
			head: db.get("SELECT * FROM main.audit_meta WHERE singleton=1"),
			events: db.all<Record<string, unknown>>("SELECT * FROM main.events ORDER BY seq"),
			eventHead: db.get("SELECT * FROM main.event_meta WHERE singleton=1"),
		}));
	}
	close(): void {
		if (this.closed) return;
		if (this.uncertain) throw new Error("Original fixture custody uncertain");
		this.onWall = undefined;
		this.target?.destroy();
		if (this.store) {
			this.uncertain = true;
			this.store.close();
			this.uncertain = false;
		}
		this.audit?.destroy();
		this.key?.destroy();
		if (this.root) {
			const named = fs.lstatSync(this.root, { bigint: true });
			if (
				!this.identity ||
				!named.isDirectory() ||
				named.isSymbolicLink() ||
				named.dev !== this.identity.dev ||
				named.ino !== this.identity.ino ||
				fs.realpathSync.native(this.root) !== this.root
			)
				throw new Error("Original fixture directory changed");
			fs.rmSync(this.root, { recursive: true });
		}
		this.closed = true;
	}
}
const owners: Fixture[] = [];
const bodies = new Set<Promise<void>>();
async function fixture(): Promise<Fixture> {
	if (owners.some((owner) => owner.uncertain))
		throw new Error("Earlier native owner remains uncertain");
	const current = new Fixture();
	owners.push(current);
	try {
		await current.initialize();
	} catch (initialError) {
		try {
			current.close();
		} catch (cleanupError) {
			throw new AggregateError(
				[initialError, cleanupError],
				"Fixture initialization and cleanup failed",
			);
		}
		throw initialError;
	}
	return current;
}
function testcase(name: string, body: () => Promise<void>): void {
	it(name, () => {
		if (bodies.size) throw new Error("Earlier whole test body is not joined");
		const original = Promise.resolve().then(body);
		bodies.add(original);
		return original;
	});
}
beforeAll(async () => {
	const observer = vi.spyOn(AuditChain.prototype, "verify").mockImplementation(function (
		this: AuditChain,
		db: SqlReader,
	) {
		const result = apply(originalVerify, this, [db]);
		afterVerify?.(db);
		return result;
	});
	restoreVerify = () => {
		observer.mockRestore();
	};
	api = await import("../../src/outbox/restore-approvals.ts");
});
afterEach(async () => {
	await Promise.allSettled([...bodies]);
	bodies.clear();
	afterVerify = undefined;
	const failures: unknown[] = [];
	for (const owner of owners) {
		try {
			owner.close();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, "Original fixture cleanup incomplete");
	owners.length = 0;
});
afterAll(() => {
	restoreVerify?.();
});

describe("approval storage restore in the original native write", () => {
	testcase(
		"voids only live authenticated rows with honest hub audit and exact fixed invalidation",
		async () => {
			const f = await fixture();
			const [live, consumed, voided] = f.db.write((tx) => [
				f.seed(tx),
				f.seed(tx, "consumed"),
				f.seed(tx, "voided"),
			]);
			if (!live || !consumed || !voided) throw new Error("Original archive rows unavailable");
			const before = f.snapshot();
			f.wall = NOW - 10;
			expect(
				f.db.write((tx) => api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, tx)),
			).toBe(1);
			const saved = f.snapshot();
			expect(saved.rows[1]).toEqual(consumed);
			expect(saved.rows[2]).toEqual(voided);
			expect(saved.rows[0]).toEqual({
				...live,
				voided_at: NOW,
				void_reason: "restored",
				audit_seq: saved.rows[0]?.audit_seq,
				audit_mac: saved.rows[0]?.audit_mac,
				mac: saved.rows[0]?.mac,
			});
			expect(saved.rows[0]?.audit_seq).not.toBe(live.audit_seq);
			expect(saved.audit.slice(before.audit.length)).toMatchObject([
				{
					action: "approval.lapsed",
					actor_kind: "hub",
					actor_id: null,
					refs: canonicalize({ approval: live.id, outbox: live.outbox_id }),
				},
			]);
			expect(saved.events).toMatchObject([
				{
					user_id: USER,
					account_id: ACCOUNT,
					data_class: "slack.content",
					kind: "outbox.changed",
					ids: JSON.stringify([live.outbox_id]),
				},
			]);
			f.db.read((db) => {
				f.audit!.verify(db);
			});
			expect(
				f.db.write((tx) => api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, tx)),
			).toBe(0);
			expect(f.snapshot()).toEqual(saved);
		},
	);
	testcase(
		"preserves a live row's nonnull schedule fields while invalidating its stored approval",
		async () => {
			const f = await fixture();
			const row = f.db.write((tx) => f.seed(tx, "live", NOW + 10));
			f.wall = NOW + 20;
			expect(
				f.db.write((tx) => api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, tx)),
			).toBe(1);
			expect(f.snapshot().rows[0]).toMatchObject({
				not_before: NOW + 10,
				deliver_by: row.deliver_by,
				voided_at: NOW + 20,
				void_reason: "restored",
				consumed_at: null,
			});
		},
	);
	testcase(
		"refuses foreign/read/copied/expired writes and copied or proxied owners before the clock",
		async () => {
			const f = await fixture(),
				foreign = await fixture();
			f.db.write((tx) => {
				f.seed(tx);
			});
			const before = f.snapshot(),
				other = foreign.snapshot();
			f.db.read((db) => {
				expect(() =>
					api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, db as SqlTransaction),
				).toThrow(api.ApprovalRestoreError);
			});
			expect(() =>
				foreign.db.write((tx) =>
					api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, tx),
				),
			).toThrow(api.ApprovalRestoreError);
			f.db.write((tx) => {
				expect(() =>
					api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, Object.create(tx)),
				).toThrow(api.ApprovalRestoreError);
			});
			let ended: SqlTransaction | undefined;
			f.db.write((tx) => {
				ended = tx;
			});
			if (!ended) throw new Error("Original ended write missing");
			expect(() =>
				api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, ended!),
			).toThrow(api.ApprovalRestoreError);
			for (const target of [
				Object.create(api.NativeApprovalRestore.prototype),
				new Proxy(f.reducer, {}),
			])
				expect(() =>
					f.db.write((tx) => api.resetNativeApprovalStorageForRestoreInTransaction(target, tx)),
				).toThrow(api.ApprovalRestoreError);
			expect(f.clockCalls).toBe(0);
			expect(foreign.clockCalls).toBe(0);
			expect(f.snapshot()).toEqual(before);
			expect(foreign.snapshot()).toEqual(other);
		},
	);
	testcase("refuses a corrupted row MAC without rewriting storage", async () => {
		const f = await fixture();
		const row = f.db.write((tx) => f.seed(tx));
		f.db.write((tx) => {
			tx.run("UPDATE main.approvals SET mac=? WHERE id=?", ["0".repeat(64), row.id]);
		});
		const before = f.snapshot();
		expect(() =>
			f.db.write((tx) => api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, tx)),
		).toThrow(api.ApprovalRestoreError);
		expect(f.snapshot()).toEqual(before);
	});
	testcase("requires the exact latest authenticated acceptance or lapse audit", async () => {
		const f = await fixture();
		const row = f.db.write((tx) => f.seed(tx));
		f.db.write((tx) => {
			f.audit!.append(tx, {
				id: id(9000),
				at: NOW + 1,
				action: "approval.lapsed",
				actor: { kind: "hub", id: null },
				refs: { approval: row.id, outbox: row.outbox_id },
			});
		});
		const before = f.snapshot();
		expect(() =>
			f.db.write((tx) => api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, tx)),
		).toThrow(api.ApprovalRestoreError);
		expect(f.snapshot()).toEqual(before);
	});
	testcase(
		"requires a full-prior MAC CAS after genuine audit verification before update",
		async () => {
			const f = await fixture();
			const row = f.db.write((tx) => f.seed(tx));
			const before = f.snapshot();
			let changed = false;
			expect(() =>
				f.db.write((tx) => {
					afterVerify = () => {
						const lapse = tx.get(
							"SELECT seq FROM main.audit_events WHERE action='approval.lapsed'",
						);
						if (!lapse) return;
						afterVerify = undefined;
						changed =
							tx.run("UPDATE main.approvals SET mac=? WHERE id=?", ["0".repeat(64), row.id])
								.changes === 1;
					};
					return api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, tx);
				}),
			).toThrow(api.ApprovalRestoreError);
			expect(changed).toBe(true);
			expect(f.snapshot()).toEqual(before);
		},
	);
	testcase("refuses deletion of the updated row from the original Event clock", async () => {
		const f = await fixture();
		const row = f.db.write((tx) => f.seed(tx));
		const before = f.snapshot();
		let changed = false;
		let callbackEntered = false;
		let updatedRowObserved = false;
		let callbackError: unknown;
		expect(() =>
			f.db.write((tx) => {
				f.onWall = () => {
					callbackEntered = true;
					try {
						const original = tx.get<{ void_reason: string | null }>(
							"SELECT void_reason FROM main.approvals WHERE id=?",
							[row.id],
						);
						if (original?.void_reason !== "restored") return;
						updatedRowObserved = true;
						f.onWall = undefined;
						const mutation = tx.run("DELETE FROM main.approvals WHERE id=?", [row.id]);
						const saved = tx.get<{ id: string }>("SELECT id FROM main.approvals WHERE id=?", [
							row.id,
						]);
						changed = mutation.changes === 1 && saved === undefined;
					} catch (error) {
						callbackError = error;
						throw error;
					}
				};
				return api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, tx);
			}),
		).toThrow(api.ApprovalRestoreError);
		expect(callbackEntered).toBe(true);
		expect(callbackError).toBeUndefined();
		expect(updatedRowObserved).toBe(true);
		expect(changed).toBe(true);
		expect(f.snapshot()).toEqual(before);
	});
	testcase(
		"joins actual row, audit and Event changes to a later original-write rollback",
		async () => {
			const f = await fixture();
			f.db.write((tx) => {
				f.seed(tx);
			});
			const before = f.snapshot();
			let changed = false;
			expect(() =>
				f.db.write((tx) => {
					changed = api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, tx) === 1;
					throw new Error("Explicit late original-write rollback witness");
				}),
			).toThrow("Explicit late original-write rollback witness");
			expect(changed).toBe(true);
			expect(f.snapshot()).toEqual(before);
		},
	);
	testcase(
		"rolls an observed earlier real invalidation back when a later row is corrupt",
		async () => {
			const f = await fixture();
			const [first, later] = f.db.write((tx) => [f.seed(tx), f.seed(tx)]);
			if (!first || !later) throw new Error("Original archive pair missing");
			f.db.write((tx) => {
				tx.run("UPDATE main.approvals SET mac=? WHERE id=?", ["0".repeat(64), later.id]);
			});
			const before = f.snapshot();
			let observed = false;
			expect(() =>
				f.db.write((tx) => {
					f.onWall = () => {
						if (
							tx.get<{ void_reason: string }>("SELECT void_reason FROM main.approvals WHERE id=?", [
								first.id,
							])?.void_reason === "restored"
						) {
							observed = true;
							f.onWall = undefined;
						}
					};
					return api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, tx);
				}),
			).toThrow(api.ApprovalRestoreError);
			expect(observed).toBe(true);
			expect(f.snapshot()).toEqual(before);
		},
	);
	testcase(
		"pages beyond 128 original rows and preserves the caller's MasterKey after wrapper destruction",
		async () => {
			const f = await fixture();
			f.db.write((tx) => {
				for (let i = 0; i < 129; i++) f.seed(tx);
			});
			expect(
				f.db.write((tx) => api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, tx)),
			).toBe(129);
			f.reducer.destroy();
			if (!f.key || !f.audit) throw new Error("Original fixture key missing");
			f.db.assertMasterKey(f.key);
			const replacement = new api.NativeApprovalRestore(f.db, f.audit, f.key, f.clock);
			try {
				expect(
					f.db.write((tx) =>
						api.resetNativeApprovalStorageForRestoreInTransaction(replacement, tx),
					),
				).toBe(0);
			} finally {
				replacement.destroy();
			}
			expect(f.snapshot().events).toHaveLength(129);
		},
	);
	testcase(
		"refuses a genuine live insertion from the Event clock and rolls the whole original write back",
		async () => {
			const f = await fixture();
			const first = f.db.write((tx) => f.seed(tx));
			const before = f.snapshot();
			let revoked = false,
				inserted = false;
			let newApproval: string | undefined, newChallenge: string | undefined;
			expect(() =>
				f.db.write((tx) => {
					f.onWall = () => {
						const original = tx.get<{ void_reason: string | null }>(
							"SELECT void_reason FROM main.approvals WHERE id=?",
							[first.id],
						);
						if (original?.void_reason !== "restored") return;
						revoked = true;
						f.onWall = undefined;
						// Original AuditChain + approval-domain MAC seed actual archived DATA, not a verifier proof.
						const added = f.seed(tx);
						newApproval = added.id;
						newChallenge = added.challenge_id;
						const actual = tx.get<{
							consumed_at: number | null;
							voided_at: number | null;
							mac: string;
						}>("SELECT consumed_at,voided_at,mac FROM main.approvals WHERE id=?", [added.id]);
						inserted =
							actual?.consumed_at === null && actual.voided_at === null && actual.mac === added.mac;
					};
					return api.resetNativeApprovalStorageForRestoreInTransaction(f.reducer, tx);
				}),
			).toThrow(api.ApprovalRestoreError);
			expect(revoked).toBe(true);
			expect(inserted).toBe(true);
			expect(f.snapshot()).toEqual(before);
			if (!newApproval || !newChallenge) throw new Error("Actual insertion was not witnessed");
			f.db.read((db) => {
				expect(db.get("SELECT id FROM main.approvals WHERE id=?", [newApproval!])).toBeUndefined();
				expect(
					db.get("SELECT id FROM main.approval_challenges WHERE id=?", [newChallenge!]),
				).toBeUndefined();
			});
		},
	);
});
