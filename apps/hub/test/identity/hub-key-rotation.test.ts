import "reflect-metadata";
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign,
	verify,
	X509Certificate,
} from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalize } from "@draftyak/protocol/jcs";
import { exportSpki } from "@draftyak/protocol/sign";
import { openTypedStatement } from "@draftyak/protocol/statements";
import { X509CertificateGenerator } from "@peculiar/x509";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import {
	HubIdentity,
	identityCertificate,
	signIdentitySuccessor,
	wrapIdentityKey,
} from "../../src/identity/hub-key.ts";
import {
	HubKeyRotation,
	openRotatedIdentity,
	type PreparedSuccessor,
	type RotationClock,
	type RotationInput,
	type RotationRecord,
} from "../../src/identity/hub-key-rotation/rotation.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";
import {
	type ChainRow,
	keyHash,
	type RotationFixture,
	rotationFixture,
	signedRow,
	type TestKey,
	testKey,
	unwrapped,
} from "./hub-key-rotation/fixture.ts";

const UNAVAILABLE = "Hub identity rotation unavailable";
const CHAIN_UNAVAILABLE = "Hub identity chain unavailable";
const TYP = "hub-key-rotate.v1";
const CLI = { kind: "cli", id: null } as const;
const INPUT: RotationInput = { epoch: 3, actor: CLI };
const UNGUARD = [
	"DROP TRIGGER hub_identity_rotations_no_update;",
	"DROP TRIGGER hub_identity_rotations_no_delete;",
	"DROP TRIGGER hub_identity_rotations_successor;",
].join("\n");
const FAULTS = [
	"CREATE TABLE rotation_fault(singleton INTEGER PRIMARY KEY CHECK(singleton=1), target TEXT) STRICT;",
	"INSERT INTO rotation_fault VALUES(1, NULL);",
	"CREATE TRIGGER rotation_fault_audit BEFORE INSERT ON audit_events WHEN (SELECT target FROM rotation_fault)='audit' BEGIN SELECT RAISE(ABORT, 'DYTEST fault'); END;",
	"CREATE TRIGGER rotation_fault_chain BEFORE INSERT ON hub_identity_rotations WHEN (SELECT target FROM rotation_fault)='chain' BEGIN SELECT RAISE(ABORT, 'DYTEST fault'); END;",
	"CREATE TRIGGER rotation_fault_identity BEFORE UPDATE ON hub_meta WHEN (SELECT target FROM rotation_fault)='identity' BEGIN SELECT RAISE(ABORT, 'DYTEST fault'); END;",
].join("\n");

let f: RotationFixture;
const locks: { lock(): void }[] = [];
const track = <T extends { lock(): void }>(value: T): T => {
	locks.push(value);
	return value;
};
const genesis = async (store = f.store): Promise<HubIdentity> =>
	track(await HubIdentity.loadOrCreate(store, f.key));
const reload = async (store = f.store): Promise<HubIdentity> =>
	track(await openRotatedIdentity(store, f.key, f.audit));
const service = (store = f.store, clock?: RotationClock): HubKeyRotation =>
	track(new HubKeyRotation(store, f.key, f.audit, clock ? { clock } : {}));
function chainOf(store = f.store): readonly RotationRecord[] {
	const rotation = service(store);
	return store.read((db) => rotation.chain(db));
}
async function rotate(
	identity: HubIdentity,
	rotation = service(),
	input = INPUT,
	store = f.store,
): Promise<RotationRecord> {
	const prepared = await rotation.prepareSuccessor(identity);
	return store.write((tx) => rotation.commit(tx, prepared, input));
}
const identityKey = (identity: HubIdentity): string =>
	exportSpki(new X509Certificate(identity.certificate).publicKey);
const digest = (bytes: Uint8Array | null | undefined): string | null =>
	bytes ? createHash("sha256").update(bytes).digest("hex") : null;
function snapshot(store = f.store) {
	return store.read((db) => {
		const meta = db.get<{
			identity_wrapped: Buffer | null;
			statement_wrapped: Buffer | null;
			identity_cert: string | null;
		}>(
			"SELECT identity_wrapped,statement_wrapped,identity_cert FROM main.hub_meta WHERE singleton=1",
		);
		const state = {
			identity: digest(meta?.identity_wrapped),
			statement: digest(meta?.statement_wrapped),
			certificate: meta?.identity_cert ?? null,
			chain: db.all(
				"SELECT seq,id,old_key,new_key,epoch,iat,hex(statement) AS statement,signature FROM main.hub_identity_rotations ORDER BY seq",
			),
			audit: db.get("SELECT audit_seq,audit_head,audit_tag FROM main.audit_meta WHERE singleton=1"),
		};
		meta?.identity_wrapped?.fill(0);
		meta?.statement_wrapped?.fill(0);
		return state;
	});
}
async function refusedWithoutGenerating(store = f.store): Promise<void> {
	const create = vi.spyOn(X509CertificateGenerator, "createSelfSigned");
	try {
		await expect(openRotatedIdentity(store, f.key, f.audit)).rejects.toThrow(CHAIN_UNAVAILABLE);
		expect(create).not.toHaveBeenCalled();
	} finally {
		create.mockRestore();
	}
}
function insertRow(tx: SqlTransaction, row: ChainRow, audited = true): void {
	tx.run(
		"INSERT INTO main.hub_identity_rotations(seq,id,old_key,new_key,epoch,iat,statement,signature) VALUES(?,?,?,?,?,?,?,?)",
		[row.seq, row.id, row.old_key, row.new_key, row.epoch, row.iat, row.statement, row.signature],
	);
	if (audited)
		f.audit.append(tx, {
			id: newId(),
			at: row.iat,
			action: "hub.identity_rotated",
			actor: CLI,
			refs: { rotation: row.id },
		});
}
// Test keys stand in for the hub's own: the rows are audited and the tail becomes the identity.
async function craft(rows: readonly ChainRow[], identity: TestKey, audited = true): Promise<void> {
	const secrets = f.key.derive("secrets");
	let wrapped: Buffer | undefined;
	try {
		wrapped = wrapIdentityKey(identity.privateKey, secrets);
		const certificate = await identityCertificate(identity.privateKey);
		const bytes = wrapped;
		f.store.write((tx) => {
			for (const row of rows) insertRow(tx, row, audited);
			tx.run("UPDATE main.hub_meta SET identity_wrapped=?,identity_cert=? WHERE singleton=1", [
				bytes,
				certificate,
			]);
		});
	} finally {
		secrets.fill(0);
		wrapped?.fill(0);
	}
}

beforeEach(async () => {
	f = await rotationFixture();
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const value of locks.splice(0)) value.lock();
	f.cleanup();
});

it("rotates to a successor signed by the outgoing identity key and keeps the statement key", async () => {
	const old = await genesis();
	const before = { hid: old.hid, certificate: old.certificate, statementKey: old.statementKey };
	const oldKey = identityKey(old);
	const record = await rotate(old, service(f.store, { wallMs: () => 1_800_000_000_123 }), {
		epoch: 7,
		actor: CLI,
	});
	const rotated = await reload();
	expect(record).toMatchObject({ seq: 1, oldKey, epoch: 7, iat: 1_800_000_000_123 });
	expect(rotated.hid).toBe(keyHash(record.newKey));
	expect(rotated.hid).not.toBe(before.hid);
	expect(rotated.certificate).not.toBe(before.certificate);
	expect(identityKey(rotated)).toBe(record.newKey);
	expect(rotated.statementKey).toBe(before.statementKey);
	const statement = openTypedStatement(TYP, record.statement, record.signature, oldKey);
	expect(statement).toEqual({
		v: 1,
		hub: before.hid,
		epoch: 7,
		keyUse: "identity",
		newKey: record.newKey,
		iat: 1_800_000_000_123,
	});
	expect(Object.keys(JSON.parse(Buffer.from(record.statement).toString("utf8")))).toEqual([
		"epoch",
		"hub",
		"iat",
		"keyUse",
		"newKey",
		"v",
	]);
	for (const key of [record.newKey, rotated.statementKey])
		expect(openTypedStatement(TYP, record.statement, record.signature, key)).toBeUndefined();
	expect(chainOf()).toEqual([record]);
});

it("signs the canonical hub-key-rotate.v1 form of the merged vectors", async () => {
	const file = JSON.parse(
		readFileSync(
			path.resolve(
				import.meta.dirname,
				"../../../../spec/vectors/statements/hub-key-rotate.v1.json",
			),
			"utf8",
		),
	) as {
		cases: {
			id: string;
			statement: Record<string, unknown>;
			receivedHex: string;
			signingInputHex: string;
			signature: string;
			publicKeySpki: string;
			valid: boolean;
		}[];
	};
	const domain = Buffer.from(`draftyak/v1/${TYP}\n`);
	const valid = file.cases.filter((vector) => vector.valid);
	expect(valid.map((vector) => vector.id)).toEqual(["valid", "epoch-zero"]);
	for (const vector of valid) {
		const received = Buffer.from(vector.receivedHex, "hex");
		expect(received.toString("utf8")).toBe(canonicalize(vector.statement));
		expect(Buffer.from(vector.signingInputHex, "hex")).toEqual(Buffer.concat([domain, received]));
		expect(vector.statement.hub).toBe(keyHash(vector.publicKeySpki));
		expect(openTypedStatement(TYP, received, vector.signature, vector.publicKeySpki)).toEqual(
			vector.statement,
		);
	}
	const [vector] = valid;
	if (!vector) throw new Error("Missing merged vector");
	const old = await genesis();
	const oldKey = identityKey(old);
	const clock = { wallMs: () => Number(vector.statement.iat) };
	const record = await rotate(old, service(f.store, clock), {
		epoch: Number(vector.statement.epoch),
		actor: CLI,
	});
	const expected = canonicalize({ ...vector.statement, hub: old.hid, newKey: record.newKey });
	expect(Buffer.from(record.statement).toString("utf8")).toBe(expected);
	expect(record.statement.length).toBe(vector.receivedHex.length / 2);
	expect(old.hid).toBe(keyHash(oldKey));
	expect(
		verify(
			"sha256",
			Buffer.concat([domain, record.statement]),
			{
				key: createPublicKey({
					key: Buffer.from(oldKey, "base64url"),
					format: "der",
					type: "spki",
				}),
				dsaEncoding: "ieee-p1363",
			},
			Buffer.from(record.signature, "base64url"),
		),
	).toBe(true);
	const next = await reload();
	const rotation = service(f.store, clock);
	for (const id of ["epoch-negative", "fraction", "unsafe-integer"]) {
		const invalid = file.cases.find((item) => item.id === id);
		expect(invalid, `Missing merged vector ${id}`).toBeDefined();
		if (!invalid) throw new Error(`Missing merged vector ${id}`);
		const epoch = invalid.statement.epoch;
		const prepared = await rotation.prepareSuccessor(next);
		expect(() =>
			f.store.write((tx) => rotation.commit(tx, prepared, { epoch: epoch as number, actor: CLI })),
		).toThrow(UNAVAILABLE);
	}
});

it("locks the outgoing identity and serves the successor's TLS key after reload", async () => {
	const old = await genesis();
	const record = await rotate(old);
	expect(() => old.tlsPrivateKey()).toThrow("locked");
	const rotated = await reload();
	const pem = rotated.tlsPrivateKey();
	try {
		const privateKey = createPrivateKey(pem);
		expect(new X509Certificate(rotated.certificate).checkPrivateKey(privateKey)).toBe(true);
		expect(exportSpki(createPublicKey(privateKey))).toBe(record.newKey);
		expect(
			createHash("sha256")
				.update(createPublicKey(privateKey).export({ format: "der", type: "spki" }))
				.digest("hex"),
		).toBe(rotated.hid);
	} finally {
		pem.fill(0);
	}
});

describe("compare-and-swap", () => {
	it("lets one of two handles for the same identity commit and leaves the loser's state unchanged", async () => {
		const old = await genesis();
		const rotation = service();
		const first = await rotation.prepareSuccessor(old);
		const second = await rotation.prepareSuccessor(old);
		f.store.write((tx) => rotation.commit(tx, first, INPUT));
		const after = snapshot();
		expect(() => f.store.write((tx) => rotation.commit(tx, second, INPUT))).toThrow(UNAVAILABLE);
		expect(snapshot()).toEqual(after);
		expect(after.chain).toHaveLength(1);
	});

	it("lets exactly one of two connections rotate the same persisted identity", async () => {
		const other = f.open();
		const mine = await genesis();
		const theirs = await genesis(other);
		expect(theirs.hid).toBe(mine.hid);
		const commit = async (store: HubStore, identity: HubIdentity): Promise<RotationRecord> => {
			const rotation = service(store);
			const prepared = await rotation.prepareSuccessor(identity);
			return store.write((tx) => rotation.commit(tx, prepared, INPUT));
		};
		const outcomes = await Promise.allSettled([commit(f.store, mine), commit(other, theirs)]);
		const winners = outcomes.flatMap((outcome) =>
			outcome.status === "fulfilled" ? [outcome.value] : [],
		);
		expect(winners).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
		expect(identityKey(await reload(other))).toBe(winners[0]?.newKey);
		expect(snapshot().chain).toHaveLength(1);
	});

	it("refuses the swap when the identity record changes after it was checked", async () => {
		const old = await genesis();
		let transaction: SqlTransaction | undefined;
		const rotation = service(f.store, {
			wallMs: () => {
				transaction?.run(
					"UPDATE main.hub_meta SET identity_cert=identity_cert||char(10) WHERE singleton=1",
				);
				return 1_800_000_000_000;
			},
		});
		const prepared = await rotation.prepareSuccessor(old);
		const before = snapshot();
		expect(() =>
			f.store.write((tx) => {
				transaction = tx;
				return rotation.commit(tx, prepared, INPUT);
			}),
		).toThrow("Hub identity rotation conflicted");
		expect(snapshot()).toEqual(before);
		expect((await reload()).hid).toBe(old.hid);
	});
});

describe("refusals before any write", () => {
	it("refuses stale, foreign and fake identities, handles and transactions", async () => {
		const old = await genesis();
		const rotation = service();
		const before = snapshot();
		const commit =
			(prepared: PreparedSuccessor, store = f.store) =>
			() =>
				store.write((tx) => rotation.commit(tx, prepared, INPUT));
		const stale = await genesis();
		const lockedHandle = await rotation.prepareSuccessor(stale);
		stale.lock();
		expect(commit(lockedHandle)).toThrow(UNAVAILABLE);
		const other = await rotationFixture();
		let foreign: HubIdentity | undefined;
		try {
			foreign = await HubIdentity.loadOrCreate(other.store, other.key);
			expect(commit(await rotation.prepareSuccessor(foreign))).toThrow(UNAVAILABLE);
		} finally {
			foreign?.lock();
			other.cleanup();
		}
		const fake = Object.assign(Object.create(HubIdentity.prototype) as HubIdentity, {
			certificate: old.certificate,
			hid: old.hid,
			hubId: old.hubId,
			statementKey: old.statementKey,
		});
		expect(commit(await rotation.prepareSuccessor(fake))).toThrow(UNAVAILABLE);
		await expect(rotation.prepareSuccessor(new Proxy(old, {}))).rejects.toThrow(UNAVAILABLE);
		await expect(
			rotation.prepareSuccessor(Object.create(HubIdentity.prototype) as HubIdentity),
		).rejects.toThrow(UNAVAILABLE);
		expect(commit(Object.freeze(Object.create(null)) as PreparedSuccessor)).toThrow(UNAVAILABLE);
		expect(commit(await service().prepareSuccessor(old))).toThrow(UNAVAILABLE);
		const used = await rotation.prepareSuccessor(old);
		rotation.discard(used);
		expect(commit(used)).toThrow(UNAVAILABLE);
		const prepared = await rotation.prepareSuccessor(old);
		const second = f.open();
		expect(commit(prepared, second)).toThrow();
		let ended: SqlTransaction | undefined;
		f.store.write((tx) => {
			ended = tx;
		});
		expect(() => rotation.commit(ended as SqlTransaction, prepared, INPUT)).toThrow();
		expect(() =>
			f.store.read((db) => rotation.commit(db as SqlTransaction, prepared, INPUT)),
		).toThrow();
		expect(snapshot()).toEqual(before);
		expect(f.store.write((tx) => rotation.commit(tx, prepared, INPUT)).seq).toBe(1);
	});

	it("refuses a foreign identity that carries the persisted certificate", async () => {
		const old = await genesis();
		const rotation = service();
		const before = snapshot();
		const other = await rotationFixture();
		let foreign: HubIdentity | undefined;
		try {
			foreign = await HubIdentity.loadOrCreate(other.store, other.key);
			Object.defineProperty(foreign, "certificate", { value: old.certificate });
			const prepared = await rotation.prepareSuccessor(foreign);
			expect(() => f.store.write((tx) => rotation.commit(tx, prepared, INPUT))).toThrow(
				UNAVAILABLE,
			);
		} finally {
			foreign?.lock();
			other.cleanup();
		}
		expect(snapshot()).toEqual(before);
		expect((await reload()).hid).toBe(old.hid);
	});

	it("refuses an accessor-switched foreign identity on the first rotation", async () => {
		const old = await genesis();
		const oldKey = identityKey(old);
		const rotation = service();
		const before = snapshot();
		const other = await rotationFixture();
		let foreign: HubIdentity | undefined;
		let reads = 0;
		try {
			foreign = await HubIdentity.loadOrCreate(other.store, other.key);
			const foreignCertificate = foreign.certificate;
			Object.defineProperty(foreign, "certificate", {
				get: () => (++reads <= 3 ? old.certificate : foreignCertificate),
			});
			const prepared = await rotation.prepareSuccessor(foreign);
			expect(() => f.store.write((tx) => rotation.commit(tx, prepared, INPUT))).toThrow(
				UNAVAILABLE,
			);
			expect(reads).toBeGreaterThanOrEqual(3);
		} finally {
			foreign?.lock();
			other.cleanup();
		}
		expect(snapshot()).toEqual(before);
		expect(chainOf()).toEqual([]);
		expect(identityKey(await reload())).toBe(oldKey);
		const pem = old.tlsPrivateKey();
		try {
			expect(exportSpki(createPublicKey(createPrivateKey(pem)))).toBe(oldKey);
		} finally {
			pem.fill(0);
		}
	});

	it("refuses a changed prepared certificate even when the persisted record matches it", async () => {
		const old = await genesis();
		const rotation = service();
		const prepared = await rotation.prepareSuccessor(old);
		const changed = `${old.certificate}\n`;
		Object.defineProperty(old, "certificate", { value: changed });
		f.store.write((tx) =>
			tx.run("UPDATE main.hub_meta SET identity_cert=? WHERE singleton=1", [changed]),
		);
		const before = snapshot();
		expect(() => f.store.write((tx) => rotation.commit(tx, prepared, INPUT))).toThrow(UNAVAILABLE);
		expect(snapshot()).toEqual(before);
		expect((await reload()).hid).toBe(old.hid);
	});

	it("refuses a fifth held handle and frees its capacity when a handle is discarded", async () => {
		const old = await genesis();
		const rotation = service();
		const before = snapshot();
		const held: PreparedSuccessor[] = [];
		for (let index = 0; index < 4; index++) held.push(await rotation.prepareSuccessor(old));
		await expect(rotation.prepareSuccessor(old)).rejects.toThrow("Hub identity rotation busy");
		const discarded = held.shift();
		if (!discarded) throw new Error("Missing prepared successor");
		rotation.discard(discarded);
		held.push(await rotation.prepareSuccessor(old));
		await expect(rotation.prepareSuccessor(old)).rejects.toThrow("Hub identity rotation busy");
		expect(() => f.store.write((tx) => rotation.commit(tx, discarded, INPUT))).toThrow(UNAVAILABLE);
		expect(snapshot()).toEqual(before);
		for (const prepared of held) rotation.discard(prepared);
	});

	it("refuses a prepare while four others are in flight or held", async () => {
		const old = await genesis();
		const rotation = service();
		const before = snapshot();
		const busy = "Hub identity rotation busy";
		const concurrently = async (count: number) => {
			const outcomes = await Promise.allSettled(
				Array.from({ length: count }, () => rotation.prepareSuccessor(old)),
			);
			return {
				held: outcomes.flatMap((outcome) =>
					outcome.status === "fulfilled" ? [outcome.value] : [],
				),
				results: outcomes.map((outcome) =>
					outcome.status === "fulfilled" ? "prepared" : (outcome.reason as Error).message,
				),
			};
		};
		const first = await concurrently(6);
		expect(first.results).toEqual(["prepared", "prepared", "prepared", "prepared", busy, busy]);
		for (const prepared of first.held) rotation.discard(prepared);
		const kept = [await rotation.prepareSuccessor(old), await rotation.prepareSuccessor(old)];
		const second = await concurrently(3);
		expect(second.results).toEqual(["prepared", "prepared", busy]);
		for (const prepared of [...kept, ...second.held]) rotation.discard(prepared);
		expect(snapshot()).toEqual(before);
	});

	it("refuses a prepare locked while its real successor certificate is awaited", async () => {
		const old = await genesis();
		const rotation = service();
		const before = snapshot();
		const create = X509CertificateGenerator.createSelfSigned;
		const generated = vi
			.spyOn(X509CertificateGenerator, "createSelfSigned")
			.mockImplementationOnce(async (...args) => {
				const certificate = await create.apply(X509CertificateGenerator, args);
				rotation.lock();
				return certificate;
			});
		await expect(rotation.prepareSuccessor(old)).rejects.toThrow(UNAVAILABLE);
		expect(generated).toHaveBeenCalledOnce();
		expect(snapshot()).toEqual(before);
		await expect(rotation.prepareSuccessor(old)).rejects.toThrow(UNAVAILABLE);
	});

	it("refuses a successor certificate issued for another key", async () => {
		const old = await genesis();
		const rotation = service();
		const before = snapshot();
		const other = testKey();
		const algorithm = { name: "ECDSA", namedCurve: "P-256" };
		const keys = {
			privateKey: other.privateKey.toCryptoKey(algorithm, false, ["sign"]),
			publicKey: createPublicKey(other.privateKey).toCryptoKey(algorithm, true, ["verify"]),
		} as unknown as CryptoKeyPair;
		const create = X509CertificateGenerator.createSelfSigned;
		let issued: X509Certificate | undefined;
		const generated = vi
			.spyOn(X509CertificateGenerator, "createSelfSigned")
			.mockImplementationOnce(async (params, provider) => {
				const certificate = await create.call(
					X509CertificateGenerator,
					{ ...params, keys },
					provider,
				);
				issued = new X509Certificate(certificate.toString("pem"));
				return certificate;
			});
		await expect(rotation.prepareSuccessor(old)).rejects.toThrow(UNAVAILABLE);
		expect(generated).toHaveBeenCalledOnce();
		if (!issued) throw new Error("Missing issued certificate");
		expect(issued.verify(issued.publicKey)).toBe(true);
		expect(exportSpki(issued.publicKey)).toBe(other.spki);
		expect(snapshot()).toEqual(before);
		const held: PreparedSuccessor[] = [];
		for (let index = 0; index < 4; index++) held.push(await rotation.prepareSuccessor(old));
		for (const prepared of held) rotation.discard(prepared);
	});

	it("refuses a held handle and a verified chain read after locking", async () => {
		const old = await genesis();
		const rotation = service();
		const prepared = await rotation.prepareSuccessor(old);
		const before = snapshot();
		expect(f.store.read((db) => rotation.chain(db))).toEqual([]);
		rotation.lock();
		expect(() => f.store.write((tx) => rotation.commit(tx, prepared, INPUT))).toThrow(UNAVAILABLE);
		expect(() => f.store.read((db) => rotation.chain(db))).toThrow(CHAIN_UNAVAILABLE);
		expect(snapshot()).toEqual(before);
		expect((await reload()).hid).toBe(old.hid);
	});

	it("refuses invalid epochs, actors, inputs and clock readings", async () => {
		const old = await genesis();
		let now: unknown = 1_800_000_000_000;
		const rotation = service(f.store, { wallMs: () => now as number });
		const before = snapshot();
		const attempt = async (input: unknown): Promise<void> => {
			const prepared = await rotation.prepareSuccessor(old);
			expect(() =>
				f.store.write((tx) => rotation.commit(tx, prepared, input as RotationInput)),
			).toThrow(UNAVAILABLE);
		};
		for (const epoch of [-1, 2 ** 53, 1.5, "1", Number.NaN, null])
			await attempt({ epoch, actor: CLI });
		for (const actor of [
			{ kind: "hub", id: null },
			{ kind: "plugin", id: newId() },
			{ kind: "browser", id: newId() },
			{ kind: "agent", id: newId() },
			{ kind: "device", id: null },
			{ kind: "device", id: "DYTEST-NOT-A-ULID" },
			{ kind: "cli", id: newId() },
			{ kind: "cli", id: null, extra: true },
			new Proxy({ kind: "cli", id: null }, {}),
		])
			await attempt({ epoch: 1, actor });
		for (const input of [
			{ epoch: 1 },
			{ epoch: 1, actor: CLI, extra: true },
			Object.defineProperty({ actor: CLI }, "epoch", { get: () => 1, enumerable: true }),
			new Proxy({ epoch: 1, actor: CLI }, {}),
			null,
		])
			await attempt(input);
		for (const value of [Number.NaN, -1, 1.5, 2 ** 53, "1800000000000"]) {
			now = value;
			await attempt(INPUT);
		}
		expect(snapshot()).toEqual(before);
		now = 1_800_000_000_000;
		expect((await rotate(old, rotation)).seq).toBe(1);
	});

	it("refuses fake or proxied stores, keys, audit chains and options", async () => {
		let calls = 0;
		const hook = () => {
			calls++;
			throw new Error("DYTEST-HOOK-MUST-NOT-RUN");
		};
		const fakeStore = Object.assign(Object.create(HubStore.prototype) as HubStore, {
			assertMasterKey: hook,
			read: hook,
			write: hook,
		});
		const fakeKey = Object.assign(Object.create(MasterKey.prototype) as MasterKey, {
			derive: hook,
		});
		const fakeAudit = Object.assign(Object.create(AuditChain.prototype) as AuditChain, {
			append: hook,
			verify: hook,
		});
		const wrongKey = new MasterKey(Buffer.alloc(32, 7));
		const wrongAudit = new AuditChain(Buffer.alloc(32, 7));
		try {
			for (const [store, key, audit, options] of [
				[fakeStore, f.key, f.audit, {}],
				[new Proxy(f.store, { get: hook }), f.key, f.audit, {}],
				[f.store, fakeKey, f.audit, {}],
				[f.store, new Proxy(f.key, { get: hook }), f.audit, {}],
				[f.store, wrongKey, f.audit, {}],
				[f.store, f.key, fakeAudit, {}],
				[f.store, f.key, new Proxy(f.audit, { get: hook }), {}],
				[f.store, f.key, wrongAudit, {}],
				[f.store, f.key, f.audit, { clock: null }],
				[f.store, f.key, f.audit, { clock: { wallMs: 1 } }],
				[f.store, f.key, f.audit, { clock: new Proxy({ wallMs: () => 1 }, { get: hook }) }],
				[f.store, f.key, f.audit, { extra: true }],
				[f.store, f.key, f.audit, new Proxy({}, { ownKeys: hook })],
			] as const)
				expect(
					() => new HubKeyRotation(store, key, audit, options as Record<string, unknown>),
				).toThrow(UNAVAILABLE);
			expect(calls).toBe(0);
		} finally {
			wrongKey.destroy();
			wrongAudit.destroy();
		}
	});
});

describe("atomicity", () => {
	it.each(["audit", "chain", "identity"])(
		"rolls every write back when the %s step fails",
		async (target) => {
			await f.tamper(FAULTS);
			const old = await genesis();
			const rotation = service();
			f.store.write((tx) => tx.run("UPDATE main.rotation_fault SET target=?", [target]));
			const before = snapshot();
			const prepared = await rotation.prepareSuccessor(old);
			expect(() => f.store.write((tx) => rotation.commit(tx, prepared, INPUT))).toThrow(
				UNAVAILABLE,
			);
			expect(snapshot()).toEqual(before);
			expect((await reload()).hid).toBe(old.hid);
			const pem = old.tlsPrivateKey();
			pem.fill(0);
			f.store.write((tx) => tx.run("UPDATE main.rotation_fault SET target=NULL"));
			expect((await rotate(old, rotation)).seq).toBe(1);
		},
	);

	it.each([
		["audit", true],
		["chain", false],
		["identity", false],
	] as const)(
		"never loads a partial rotation a caller kept after the %s step failed",
		async (target, loads) => {
			await f.tamper(FAULTS);
			const old = await genesis();
			const rotation = service();
			f.store.write((tx) => tx.run("UPDATE main.rotation_fault SET target=?", [target]));
			const prepared = await rotation.prepareSuccessor(old);
			let refused = false;
			f.store.write((tx) => {
				try {
					rotation.commit(tx, prepared, INPUT);
				} catch {
					refused = true;
				}
			});
			expect(refused).toBe(true);
			if (loads) expect((await reload()).hid).toBe(old.hid);
			else await refusedWithoutGenerating();
		},
	);

	it("appends one audit entry with the caller's actor inside the same transaction", async () => {
		const old = await genesis();
		const device = newId();
		const record = await rotate(old, service(), {
			epoch: 9,
			actor: { kind: "device", id: device },
		});
		const entries = f.store.read((db) =>
			db.all(
				"SELECT action,actor_kind,actor_id,refs,at FROM main.audit_events WHERE action LIKE 'hub.%'",
			),
		);
		expect(entries).toEqual([
			{
				action: "hub.identity_rotated",
				actor_kind: "device",
				actor_id: device,
				refs: canonicalize({ rotation: record.id }),
				at: record.iat,
			},
		]);
		f.store.read((db) => f.audit.verify(db));
	});

	it("rolls the audit entry, chain row and swap back with the caller's transaction", async () => {
		const old = await genesis();
		const rotation = service();
		const prepared = await rotation.prepareSuccessor(old);
		const before = snapshot();
		expect(() =>
			f.store.write((tx) => {
				rotation.commit(tx, prepared, INPUT);
				throw new Error("DYTEST rollback");
			}),
		).toThrow("DYTEST rollback");
		expect(snapshot()).toEqual(before);
		expect(() => old.tlsPrivateKey()).toThrow("locked");
		expect((await reload()).hid).toBe(old.hid);
	});
});

describe("restart", () => {
	it("reloads the rotated identity after a restart and chains a second rotation", async () => {
		const first = await genesis();
		const one = await rotate(first);
		f.store.checkpoint();
		const store = f.reopen();
		const second = await reload(store);
		expect(second.hid).toBe(keyHash(one.newKey));
		const device = { kind: "device", id: newId() } as const;
		const two = await rotate(second, service(store), { epoch: 4, actor: device }, store);
		const reopened = f.reopen();
		const third = await reload(reopened);
		expect(two).toMatchObject({ seq: 2, oldKey: one.newKey, epoch: 4 });
		expect(third.hid).toBe(keyHash(two.newKey));
		expect(third.statementKey).toBe(first.statementKey);
		const chain = chainOf(reopened);
		expect(chain.map((record) => [record.seq, record.oldKey, record.newKey])).toEqual([
			[1, identityKey(first), one.newKey],
			[2, one.newKey, two.newKey],
		]);
	});

	it("accepts a well-formed chain of test keys, the control for the crafted refusals", async () => {
		await genesis();
		const [a, b, c] = [testKey(), testKey(), testKey()];
		await craft([signedRow(a, b.spki, 1), signedRow(b, c.spki, 2)], c);
		expect((await reload()).hid).toBe(keyHash(c.spki));
	});

	it("loads and audits all 129 rotations across the second page", async () => {
		await genesis();
		const keys = Array.from({ length: 130 }, () => testKey());
		const rows = keys.slice(1).map((next, index) => {
			const previous = keys[index];
			if (!previous) throw new Error("Missing outgoing test key");
			return signedRow(previous, next.spki, index + 1);
		});
		const tail = keys.at(-1);
		if (!tail) throw new Error("Missing chain tail");
		await craft(rows, tail);
		expect((await reload()).hid).toBe(keyHash(tail.spki));
		const chain = chainOf();
		expect(chain).toHaveLength(129);
		expect(chain.at(-1)).toMatchObject({ seq: 129, newKey: tail.spki });
		expect(chain.map((row) => row.id)).toEqual(rows.map((row) => row.id));
	});
});

describe("restart loader refusals", () => {
	async function rotated(times = 1): Promise<RotationRecord[]> {
		const records: RotationRecord[] = [];
		let identity = await genesis();
		for (let index = 0; index < times; index++) {
			records.push(await rotate(identity));
			identity = await reload();
		}
		return records;
	}
	const refusedChain = (): void => expect(() => chainOf()).toThrow(CHAIN_UNAVAILABLE);

	it("refuses hub_meta reset to the older identity", async () => {
		const old = await genesis();
		const saved = f.store.read((db) =>
			db.get<{ wrapped: Buffer; cert: string }>(
				"SELECT identity_wrapped AS wrapped,identity_cert AS cert FROM main.hub_meta",
			),
		);
		try {
			await rotate(old);
			f.store.write((tx) =>
				tx.run("UPDATE main.hub_meta SET identity_wrapped=?,identity_cert=?", [
					saved?.wrapped ?? null,
					saved?.cert ?? null,
				]),
			);
		} finally {
			saved?.wrapped.fill(0);
		}
		await refusedWithoutGenerating();
		refusedChain();
	});

	it.each([
		["a flipped statement byte", "UPDATE main.hub_identity_rotations SET statement=?"],
		["an edited epoch", "UPDATE main.hub_identity_rotations SET epoch=epoch+1"],
		["an edited iat", "UPDATE main.hub_identity_rotations SET iat=iat+1"],
		["a renumbered row", "UPDATE main.hub_identity_rotations SET seq=2"],
		["a deleted row", "DELETE FROM main.hub_identity_rotations"],
	])("refuses %s", async (_name, sql) => {
		const [record] = await rotated();
		const flipped = Buffer.from(record?.statement ?? []);
		const at = flipped.indexOf('"hub":"') + 12;
		flipped[at] = flipped[at] === 0x30 ? 0x31 : 0x30;
		await f.tamper(UNGUARD);
		f.store.write((tx) => tx.run(sql, sql.includes("?") ? [flipped] : []));
		await refusedWithoutGenerating();
		refusedChain();
	});

	it("refuses a signature by another key over the same statement", async () => {
		const [record] = await rotated();
		const intruder = testKey();
		const signature = sign(
			"sha256",
			Buffer.concat([Buffer.from(`draftyak/v1/${TYP}\n`), record?.statement ?? Buffer.alloc(0)]),
			{ key: intruder.privateKey, dsaEncoding: "ieee-p1363" },
		).toString("base64url");
		await f.tamper(UNGUARD);
		f.store.write((tx) =>
			tx.run("UPDATE main.hub_identity_rotations SET signature=?", [signature]),
		);
		await refusedWithoutGenerating();
	});

	it("refuses reordered rows and a truncated tail", async () => {
		await rotated(2);
		await f.tamper(UNGUARD);
		f.store.write((tx) => {
			tx.run("UPDATE main.hub_identity_rotations SET seq=seq+10");
			tx.run("UPDATE main.hub_identity_rotations SET seq=CASE seq WHEN 11 THEN 2 ELSE 1 END");
		});
		await refusedWithoutGenerating();
		f.store.write((tx) => {
			tx.run("UPDATE main.hub_identity_rotations SET seq=seq+10");
			tx.run("UPDATE main.hub_identity_rotations SET seq=CASE seq WHEN 11 THEN 2 ELSE 1 END");
		});
		expect(chainOf()).toHaveLength(2);
		f.store.write((tx) => tx.run("DELETE FROM main.hub_identity_rotations WHERE seq=2"));
		await refusedWithoutGenerating();
	});

	it("refuses rows whose ids the audit entries do not name in order", async () => {
		const [first, second] = await rotated(2);
		if (!first || !second) throw new Error("Missing rotations");
		await f.tamper(UNGUARD);
		const setIds = (one: string, two: string): void =>
			f.store.write((tx) => {
				tx.run("UPDATE main.hub_identity_rotations SET id=? WHERE seq=1", [newId()]);
				tx.run("UPDATE main.hub_identity_rotations SET id=? WHERE seq=2", [two]);
				tx.run("UPDATE main.hub_identity_rotations SET id=? WHERE seq=1", [one]);
			});
		setIds(second.id, first.id);
		await refusedWithoutGenerating();
		refusedChain();
		setIds(first.id, second.id);
		expect(chainOf()).toEqual([first, second]);
		f.store.write((tx) =>
			tx.run("UPDATE main.hub_identity_rotations SET id=? WHERE seq=2", [newId()]),
		);
		await refusedWithoutGenerating();
		refusedChain();
	});

	it("refuses a foreign key's row spliced into the chain", async () => {
		const [, second] = await rotated(2);
		if (!second) throw new Error("Missing second rotation");
		const forged = signedRow(testKey(), second.newKey, 2, {
			epoch: second.epoch,
			iat: second.iat,
		});
		await f.tamper(UNGUARD);
		f.store.write((tx) =>
			tx.run(
				"UPDATE main.hub_identity_rotations SET old_key=?,statement=?,signature=? WHERE seq=2",
				[forged.old_key, forged.statement, forged.signature],
			),
		);
		await refusedWithoutGenerating();
	});

	it("refuses another hub's genuine rotation appended to the chain", async () => {
		await rotated();
		const other = await rotationFixture();
		let foreign: ChainRow | undefined;
		let identity: HubIdentity | undefined;
		let rotation: HubKeyRotation | undefined;
		try {
			identity = await HubIdentity.loadOrCreate(other.store, other.key);
			const theirs = new HubKeyRotation(other.store, other.key, other.audit);
			rotation = theirs;
			const prepared = await theirs.prepareSuccessor(identity);
			const record = other.store.write((tx) => theirs.commit(tx, prepared, INPUT));
			foreign = {
				seq: 2,
				id: record.id,
				old_key: record.oldKey,
				new_key: record.newKey,
				epoch: record.epoch,
				iat: record.iat,
				statement: Buffer.from(record.statement),
				signature: record.signature,
			};
		} finally {
			identity?.lock();
			rotation?.lock();
			other.cleanup();
		}
		await f.tamper(UNGUARD);
		const row = foreign;
		f.store.write((tx) => insertRow(tx, row));
		await refusedWithoutGenerating();
	});

	it("refuses a chain that returns to a retired key", async () => {
		await genesis();
		const [a, b] = [testKey(), testKey()];
		await f.tamper(UNGUARD);
		await craft([signedRow(a, b.spki, 1), signedRow(b, a.spki, 2)], a);
		await refusedWithoutGenerating();
	});

	it("refuses a statement that names another hub", async () => {
		await genesis();
		const [a, b, c] = [testKey(), testKey(), testKey()];
		await craft([signedRow(a, b.spki, 1, { hub: keyHash(c.spki) })], b);
		await refusedWithoutGenerating();
	});

	it("refuses a validly signed successor that differs from the unsigned new_key column", async () => {
		await genesis();
		const [a, b, c] = [testKey(), testKey(), testKey()];
		const row = signedRow(a, b.spki, 1, { newKey: c.spki });
		expect(openTypedStatement(TYP, row.statement, row.signature, a.spki)).toMatchObject({
			newKey: c.spki,
		});
		await craft([row], b);
		await refusedWithoutGenerating();
		refusedChain();
	});

	it.each(["broken link", "missing audit"] as const)(
		"refuses a second-page %s in a 129-row chain",
		async (fault) => {
			await genesis();
			const keys = Array.from({ length: 130 }, () => testKey());
			const rows = keys.slice(1).map((next, index) => {
				const previous = keys[index];
				if (!previous) throw new Error("Missing outgoing test key");
				return signedRow(previous, next.spki, index + 1);
			});
			const tail = keys.at(-1);
			const previous = keys.at(-2);
			if (!tail || !previous) throw new Error("Missing chain tail");
			if (fault === "broken link") {
				await f.tamper(UNGUARD);
				rows[128] = signedRow(testKey(), tail.spki, 129);
				await craft(rows, tail);
			} else {
				await craft(rows.slice(0, 128), previous);
				expect(chainOf()).toHaveLength(128);
				await craft(rows.slice(128), tail, false);
				f.store.read((db) => f.audit.verify(db));
			}
			await refusedWithoutGenerating();
			refusedChain();
		},
	);

	it("refuses a row the audit never recorded", async () => {
		await genesis();
		const [a, b] = [testKey(), testKey()];
		await craft([signedRow(a, b.spki, 1)], b, false);
		await refusedWithoutGenerating();
	});

	it("refuses a chain whose audit entries no longer verify", async () => {
		await rotated();
		const rotation = service();
		expect(f.store.read((db) => rotation.chain(db))).toHaveLength(1);
		await f.tamper("DROP TRIGGER audit_no_update;");
		f.store.write((tx) =>
			tx.run("UPDATE main.audit_events SET at=at+1 WHERE action='hub.identity_rotated'"),
		);
		await refusedWithoutGenerating();
		expect(() => f.store.read((db) => rotation.chain(db))).toThrow(CHAIN_UNAVAILABLE);
	});

	it("refuses chain rows that do not extend the chain, and every edit or removal", async () => {
		const [record] = await rotated();
		if (!record) throw new Error("Missing rotation");
		const stranger = testKey();
		const row = signedRow(stranger, testKey().spki, 2);
		const insert = (change: Partial<ChainRow>) => () =>
			f.store.write((tx) => insertRow(tx, { ...row, ...change }, false));
		for (const change of [
			{ seq: 3, old_key: record.newKey },
			{ old_key: stranger.spki },
			{ old_key: record.newKey, new_key: record.oldKey },
			{ old_key: record.newKey, new_key: record.newKey },
		])
			expect(insert(change)).toThrow("must extend the chain");
		for (const sql of [
			"UPDATE main.hub_identity_rotations SET epoch=epoch+1",
			"DELETE FROM main.hub_identity_rotations",
		])
			expect(() => f.store.write((tx) => tx.run(sql))).toThrow("append only");
		expect(chainOf()).toEqual([record]);
		expect(insert({ old_key: record.newKey })).not.toThrow();
	});

	it("accepts a chain row only at the tail, even where a row was removed", async () => {
		const [first] = await rotated(2);
		if (!first) throw new Error("Missing rotation");
		await f.tamper("DROP TRIGGER hub_identity_rotations_no_delete;");
		f.store.write((tx) => tx.run("DELETE FROM main.hub_identity_rotations WHERE seq=1"));
		const row = { ...signedRow(testKey(), testKey().spki, 1), old_key: first.oldKey };
		expect(() => f.store.write((tx) => insertRow(tx, row, false))).toThrow("must extend the chain");
	});

	it("never makes an identity for an empty record, with or without a chain", async () => {
		await rotated();
		const empty =
			"UPDATE main.hub_meta SET identity_wrapped=NULL,statement_wrapped=NULL,identity_cert=NULL";
		f.store.write((tx) => tx.run(empty));
		await refusedWithoutGenerating();
		expect(snapshot()).toMatchObject({ identity: null, statement: null, certificate: null });
		const fresh = await rotationFixture();
		try {
			const create = vi.spyOn(X509CertificateGenerator, "createSelfSigned");
			await expect(openRotatedIdentity(fresh.store, fresh.key, fresh.audit)).rejects.toThrow(
				CHAIN_UNAVAILABLE,
			);
			expect(create).not.toHaveBeenCalled();
		} finally {
			fresh.cleanup();
		}
	});

	it("refuses a store without the rotation chain", async () => {
		const bare = await rotationFixture(["audit", "core"]);
		try {
			const identity = await HubIdentity.loadOrCreate(bare.store, bare.key);
			identity.lock();
			expect(() => new HubKeyRotation(bare.store, bare.key, bare.audit)).toThrow(UNAVAILABLE);
			const create = vi.spyOn(X509CertificateGenerator, "createSelfSigned");
			await expect(openRotatedIdentity(bare.store, bare.key, bare.audit)).rejects.toThrow(
				CHAIN_UNAVAILABLE,
			);
			expect(create).not.toHaveBeenCalled();
		} finally {
			bare.cleanup();
		}
	});
});

describe("insert-time chain constraints", () => {
	it("rejects malformed rows and duplicate ids or successor keys before loading", async () => {
		await f.tamper("DROP TRIGGER hub_identity_rotations_successor;");
		const row = signedRow(testKey(), testKey().spki, 1);
		const changes: readonly Partial<ChainRow>[] = [
			{ seq: 0 },
			{ seq: 4097 },
			{ id: row.id.slice(1) },
			{ id: `8${row.id.slice(1)}` },
			{ id: `${row.id.slice(0, -1)}I` },
			{ old_key: row.old_key.slice(1) },
			{ old_key: `${row.old_key}A` },
			{ old_key: `X${row.old_key.slice(1)}` },
			{ old_key: `${row.old_key.slice(0, 40)}=${row.old_key.slice(41)}` },
			{ old_key: `${row.old_key.slice(0, -1)}B` },
			{ new_key: row.new_key.slice(1) },
			{ new_key: `${row.new_key}A` },
			{ new_key: `X${row.new_key.slice(1)}` },
			{ new_key: `${row.new_key.slice(0, 40)}=${row.new_key.slice(41)}` },
			{ new_key: `${row.new_key.slice(0, -1)}B` },
			{ new_key: row.old_key },
			{ epoch: -1 },
			{ epoch: 2 ** 53 },
			{ iat: -1 },
			{ iat: 2 ** 53 },
			{ statement: Buffer.alloc(0) },
			{ statement: Buffer.alloc(1025) },
			{ signature: row.signature.slice(1) },
			{ signature: `${row.signature}A` },
			{ signature: `${row.signature.slice(0, -1)}=` },
		];
		for (const change of changes)
			expect(() => f.store.write((tx) => insertRow(tx, { ...row, ...change }, false))).toThrow(
				"CHECK constraint failed",
			);
		f.store.write((tx) => insertRow(tx, row, false));
		const next = signedRow(testKey(), testKey().spki, 2);
		for (const duplicate of [
			{ ...next, id: row.id },
			{ ...next, new_key: row.new_key },
		])
			expect(() => f.store.write((tx) => insertRow(tx, duplicate, false))).toThrow(
				"UNIQUE constraint failed",
			);
		expect(
			f.store.read((db) =>
				db.get<{ count: number }>("SELECT count(*) AS count FROM main.hub_identity_rotations"),
			)?.count,
		).toBe(1);
	});
});

describe("outgoing key", () => {
	it("signs only this identity's identity-key successor statement", async () => {
		const identity = await genesis();
		const own = identityKey(identity);
		const next = testKey().spki;
		const base = {
			v: 1,
			hub: identity.hid,
			epoch: 2,
			keyUse: "identity",
			newKey: next,
			iat: 1_800_000_000_000,
		} as const;
		const signature = signIdentitySuccessor(identity, base);
		expect(openTypedStatement(TYP, Buffer.from(canonicalize(base)), signature, own)).toEqual(base);
		const { iat: _iat, ...missing } = base;
		for (const statement of [
			{ ...base, keyUse: "statement" },
			{ ...base, hub: keyHash(next) },
			{ ...base, newKey: own },
			{ ...base, newKey: identity.statementKey },
			{ ...base, newKey: "DYTEST-NOT-A-KEY" },
			{ ...base, newKey: `${next.slice(0, -1)}B` },
			{ ...base, epoch: -1 },
			{ ...base, epoch: 1.5 },
			{ ...base, iat: -1 },
			{ ...base, v: 2 },
			{ ...base, extra: true },
			missing,
			Object.defineProperty({ ...base }, "hub", { get: () => identity.hid, enumerable: true }),
			new Proxy({ ...base }, {}),
			Object.assign(Object.create(null), base),
		])
			expect(() => signIdentitySuccessor(identity, statement as never)).toThrow(
				"Hub identity successor refused",
			);
		const fake = Object.assign(Object.create(HubIdentity.prototype) as HubIdentity, {
			certificate: identity.certificate,
			hid: identity.hid,
			hubId: identity.hubId,
			statementKey: identity.statementKey,
		});
		for (const signer of [fake, new Proxy(identity, {})])
			expect(() => signIdentitySuccessor(signer, base)).toThrow("Hub identity successor refused");
		identity.lock();
		expect(() => signIdentitySuccessor(identity, base)).toThrow("Hub identity successor refused");
		expect(Object.getOwnPropertyNames(HubIdentity.prototype).sort()).toEqual([
			"constructor",
			"lock",
			"tlsPrivateKey",
		]);
		expect(Object.hasOwn(HubIdentity.prototype, "signStatement")).toBe(false);
	});

	it("refuses the statement key as a successor after its public field is edited", async () => {
		const identity = await genesis();
		const statementKey = identity.statementKey;
		const next = testKey().spki;
		const base = {
			v: 1,
			hub: identity.hid,
			epoch: 2,
			keyUse: "identity",
			newKey: next,
			iat: 1_800_000_000_000,
		} as const;
		Object.defineProperty(identity, "statementKey", { value: next });
		expect(() => signIdentitySuccessor(identity, { ...base, newKey: statementKey })).toThrow(
			"Hub identity successor refused",
		);
		const signature = signIdentitySuccessor(identity, base);
		expect(
			openTypedStatement(TYP, Buffer.from(canonicalize(base)), signature, identityKey(identity)),
		).toEqual(base);
	});

	it("signs only while its public hid field names its own key", async () => {
		const identity = await genesis();
		const hid = identity.hid;
		const base = {
			v: 1,
			hub: hid,
			epoch: 2,
			keyUse: "identity",
			newKey: testKey().spki,
			iat: 1_800_000_000_000,
		} as const;
		Object.defineProperty(identity, "hid", { value: keyHash(testKey().spki) });
		expect(() => signIdentitySuccessor(identity, base)).toThrow("Hub identity successor refused");
		Object.defineProperty(identity, "hid", { value: hid });
		const signature = signIdentitySuccessor(identity, base);
		expect(
			openTypedStatement(TYP, Buffer.from(canonicalize(base)), signature, identityKey(identity)),
		).toEqual(base);
	});

	it("wraps the successor for the identity key use and erases every uncommitted handle", async () => {
		const old = await genesis();
		const oldIv = f.store.read((db) =>
			db.get<{ iv: Buffer }>("SELECT substr(identity_wrapped,2,12) AS iv FROM main.hub_meta"),
		)?.iv;
		const rotation = service();
		const secrets = f.key.derive("secrets");
		// The wrapped successor is the one Buffer.concat result that opens as an identity key.
		const prepare = async (identity: HubIdentity): Promise<[PreparedSuccessor, Buffer]> => {
			const concat = vi.spyOn(Buffer, "concat");
			let results: (typeof concat.mock.results)[number][];
			let prepared: PreparedSuccessor;
			try {
				prepared = await rotation.prepareSuccessor(identity);
			} finally {
				results = [...concat.mock.results];
				concat.mockRestore();
			}
			const wrapped = results.flatMap((result) =>
				result.type === "return" && unwrapped(result.value, secrets, "identity")
					? [result.value]
					: [],
			);
			expect(wrapped).toHaveLength(1);
			return [prepared, wrapped[0] as Buffer];
		};
		try {
			const [discarded, discardedBytes] = await prepare(old);
			rotation.discard(discarded);
			expect(discardedBytes.every((byte) => byte === 0)).toBe(true);
			expect(() => f.store.write((tx) => rotation.commit(tx, discarded, INPUT))).toThrow(
				UNAVAILABLE,
			);
			const [committed, committedBytes] = await prepare(old);
			const record = f.store.write((tx) => rotation.commit(tx, committed, INPUT));
			expect(committedBytes.every((byte) => byte === 0)).toBe(true);
			const row = f.store.read((db) =>
				db.get<{ bytes: Buffer; cert: string }>(
					"SELECT identity_wrapped AS bytes,identity_cert AS cert FROM main.hub_meta",
				),
			);
			if (!row || !oldIv) throw new Error("Missing rotated identity record");
			expect(row.bytes[0]).toBe(1);
			expect(row.bytes.subarray(1, 13).equals(oldIv)).toBe(false);
			expect(unwrapped(row.bytes, secrets, "statement")).toBeUndefined();
			const successor = unwrapped(row.bytes, secrets, "identity");
			if (!successor) throw new Error("Successor does not open as an identity key");
			expect(exportSpki(createPublicKey(successor))).toBe(record.newKey);
			const certificate = new X509Certificate(row.cert);
			expect(certificate.ca).toBe(false);
			expect(certificate.verify(certificate.publicKey)).toBe(true);
			expect(certificate.checkPrivateKey(successor)).toBe(true);
			expect(record.newKey).not.toBe(old.statementKey);
			row.bytes.fill(0);
			const next = await reload();
			const [pending, pendingBytes] = await prepare(next);
			rotation.lock();
			expect(pendingBytes.every((byte) => byte === 0)).toBe(true);
			expect(() => f.store.write((tx) => rotation.commit(tx, pending, INPUT))).toThrow(UNAVAILABLE);
			await expect(rotation.prepareSuccessor(next)).rejects.toThrow(UNAVAILABLE);
			expect(snapshot().chain).toHaveLength(1);
		} finally {
			secrets.fill(0);
		}
	});

	it("wraps and certifies only P-256 private keys", async () => {
		const secrets = Buffer.alloc(32, 1);
		for (const key of [
			generateKeyPairSync("ed25519").privateKey,
			generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey,
			createPublicKey(testKey().privateKey),
		]) {
			expect(() => wrapIdentityKey(key, secrets)).toThrow("Invalid hub key algorithm");
			await expect(identityCertificate(key)).rejects.toThrow("Invalid hub key algorithm");
		}
	});
});
