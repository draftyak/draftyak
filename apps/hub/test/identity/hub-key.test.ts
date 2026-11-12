import "reflect-metadata";
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomBytes,
	X509Certificate,
} from "node:crypto";
import { inspect } from "node:util";
import { exportSpki } from "@draftyak/protocol/sign";
import { BasicConstraintsExtension, X509CertificateGenerator } from "@peculiar/x509";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubIdentity } from "../../src/identity/hub-key.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore } from "../../src/store/store.ts";
import { addShadows, fixture, nativeBinding, removeFixture } from "./helpers.ts";

let f: Awaited<ReturnType<typeof fixture>>;
const identities = new Set<HubIdentity>();
async function loadIdentity(store: HubStore, key: MasterKey): Promise<HubIdentity> {
	const identity = await HubIdentity.loadOrCreate(store, key);
	identities.add(identity);
	return identity;
}
beforeEach(async () => {
	f = await fixture();
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const identity of identities) identity.lock();
	identities.clear();
	f.store.close();
	f.key.destroy();
	removeFixture(f.dir);
});

it("persists separate wrapped keys and preserves the full SPKI pin on restart", async () => {
	const first = await loadIdentity(f.store, f.key);
	const pem = first.tlsPrivateKey();
	const transportPublic = createPublicKey(createPrivateKey(pem));
	expect(exportSpki(transportPublic)).not.toBe(first.statementKey);
	expect(first.hid).toMatch(/^[0-9a-f]{64}$/);
	expect(first.hid).toBe(
		createHash("sha256")
			.update(transportPublic.export({ format: "der", type: "spki" }))
			.digest("hex"),
	);
	expect(first.hubId).toBe(`DYK-${first.hid.slice(0, 16).toUpperCase().match(/.{4}/g)?.join("-")}`);
	expect(first.hubId).toMatch(/^DYK-(?:[0-9A-F]{4}-){3}[0-9A-F]{4}$/);
	const stored = f.store.read((db) =>
		db.get<{ identity_wrapped: Buffer; statement_wrapped: Buffer }>(
			"SELECT identity_wrapped,statement_wrapped FROM hub_meta",
		),
	);
	expect(stored?.identity_wrapped.includes(pem)).toBe(false);
	expect(inspect(first)).not.toContain("PRIVATE KEY");
	expect(JSON.stringify(first)).not.toContain("PRIVATE KEY");
	const again = await loadIdentity(f.store, f.key);
	expect(again.hid).toBe(first.hid);
	expect(again.statementKey).toBe(first.statementKey);
	expect(Object.hasOwn(HubIdentity.prototype, "signStatement")).toBe(false);
	pem.fill(0);
	first.lock();
	again.lock();
	expect(() => first.tlsPrivateKey()).toThrow("locked");
	f.store.checkpoint();
	f.store.close();
	const reopened = new HubStore({ filename: f.filename, masterKey: f.key, nativeBinding });
	let persisted: HubIdentity | undefined;
	try {
		persisted = await loadIdentity(reopened, f.key);
		expect(persisted.hid).toBe(first.hid);
		expect(persisted.statementKey).toBe(first.statementKey);
		expect(persisted.certificate).toBe(first.certificate);
	} finally {
		persisted?.lock();
		reopened.close();
	}
});
it("does not regenerate keys after corruption, key-use swapping or a wrong wrapping key", async () => {
	await loadIdentity(f.store, f.key);
	const wrong = new MasterKey(Buffer.alloc(32, 9));
	await expect(loadIdentity(f.store, wrong)).rejects.toThrow();
	wrong.destroy();
	f.store.write((tx) => tx.run("UPDATE hub_meta SET identity_wrapped=statement_wrapped"));
	await expect(loadIdentity(f.store, f.key)).rejects.toThrow();
	f.store.write((tx) => tx.run("UPDATE hub_meta SET identity_wrapped=NULL"));
	await expect(loadIdentity(f.store, f.key)).rejects.toThrow("incomplete");
});

it("round trips both wrapped private keys independently with authenticated key-use binding", async () => {
	const identity = await loadIdentity(f.store, f.key);
	const row = f.store.read((db) =>
		db.get<{ identity_wrapped: Buffer; statement_wrapped: Buffer }>(
			"SELECT identity_wrapped,statement_wrapped FROM main.hub_meta",
		),
	);
	if (!row) throw new Error("Missing synthetic wrapped keys");
	const key = f.key.derive("secrets");
	try {
		const expected = [
			new X509Certificate(identity.certificate).publicKey,
			createPublicKey({
				key: Buffer.from(identity.statementKey, "base64url"),
				format: "der",
				type: "spki",
			}),
		];
		for (const [index, use] of ["identity", "statement"].entries()) {
			const bytes = index === 0 ? row.identity_wrapped : row.statement_wrapped;
			expect(bytes[0]).toBe(1);
			const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(1, 13));
			cipher.setAAD(Buffer.from(`draftyak/v1/hub-key/${use}`));
			cipher.setAuthTag(bytes.subarray(13, 29));
			const first = cipher.update(bytes.subarray(29));
			const last = cipher.final();
			const plain = Buffer.concat([first, last]);
			try {
				expect(
					exportSpki(
						createPublicKey(createPrivateKey({ key: plain, format: "der", type: "pkcs8" })),
					),
				).toBe(exportSpki(expected[index] as ReturnType<typeof createPublicKey>));
			} finally {
				first.fill(0);
				last.fill(0);
				plain.fill(0);
			}
		}
		expect(row.identity_wrapped.subarray(1, 13).equals(row.statement_wrapped.subarray(1, 13))).toBe(
			false,
		);
	} finally {
		key.fill(0);
		row.identity_wrapped.fill(0);
		row.statement_wrapped.fill(0);
	}
});

it.each([0, 13, 29])(
	"refuses wrapped version/tag/ciphertext corruption at byte %s without regeneration",
	async (offset) => {
		await loadIdentity(f.store, f.key);
		const row = f.store.read((db) =>
			db.get<{ bytes: Buffer }>("SELECT identity_wrapped AS bytes FROM main.hub_meta"),
		);
		if (!row) throw new Error("Missing synthetic wrapped key");
		try {
			row.bytes[offset] = (row.bytes[offset] ?? 0) ^ 1;
			f.store.write((tx) => tx.run("UPDATE main.hub_meta SET identity_wrapped=?", [row.bytes]));
			const create = vi.spyOn(X509CertificateGenerator, "createSelfSigned");
			await expect(loadIdentity(f.store, f.key)).rejects.toThrow("Hub identity unavailable");
			expect(create).not.toHaveBeenCalled();
			expect(
				f.store.read((db) =>
					db.get<{ bytes: Buffer }>("SELECT identity_wrapped AS bytes FROM main.hub_meta"),
				)?.bytes,
			).toEqual(row.bytes);
		} finally {
			row.bytes.fill(0);
		}
	},
);

it("refuses a correctly wrapped non-P256 statement key while accepting the original record", async () => {
	await loadIdentity(f.store, f.key);
	const key = f.key.derive("secrets");
	const plain = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({
		format: "der",
		type: "pkcs8",
	});
	try {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(Buffer.from("draftyak/v1/hub-key/statement"));
		const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
		const wrapped = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
		f.store.write((tx) => tx.run("UPDATE main.hub_meta SET statement_wrapped=?", [wrapped]));
		await expect(loadIdentity(f.store, f.key)).rejects.toThrow("Hub identity unavailable");
	} finally {
		plain.fill(0);
		key.fill(0);
	}
});

it("refuses a matching self-signed CA certificate", async () => {
	const identity = await loadIdentity(f.store, f.key);
	const pem = identity.tlsPrivateKey();
	try {
		const privateKey = createPrivateKey(pem);
		const algorithm = { name: "ECDSA", namedCurve: "P-256" };
		const cert = await X509CertificateGenerator.createSelfSigned({
			name: "CN=DYTEST fixture CA",
			keys: {
				privateKey: privateKey.toCryptoKey(algorithm, false, ["sign"]),
				publicKey: createPublicKey(privateKey).toCryptoKey(algorithm, true, ["verify"]),
			} as unknown as CryptoKeyPair,
			signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
			extensions: [new BasicConstraintsExtension(true, undefined, true)],
		});
		f.store.write((tx) =>
			tx.run("UPDATE main.hub_meta SET identity_cert=?", [cert.toString("pem")]),
		);
		await expect(loadIdentity(f.store, f.key)).rejects.toThrow("Hub identity unavailable");
	} finally {
		pem.fill(0);
	}
});

it.each(["same Store", "second Store"])(
	"allows one native initialization winner with %s and reloads that winner",
	async (mode) => {
		const other =
			mode === "same Store"
				? f.store
				: new HubStore({ filename: f.filename, masterKey: f.key, nativeBinding });
		try {
			const outcomes = await Promise.allSettled([
				loadIdentity(f.store, f.key),
				loadIdentity(other, f.key),
			]);
			const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
			expect(winners).toHaveLength(1);
			expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
			const winner = winners[0];
			if (winner?.status !== "fulfilled") throw new Error("Missing native identity winner");
			const reloaded = await loadIdentity(other, f.key);
			expect(reloaded.hid).toBe(winner.value.hid);
			expect(reloaded.certificate).toBe(winner.value.certificate);
			expect(reloaded.statementKey).toBe(winner.value.statementKey);
		} finally {
			if (other !== f.store) other.close();
		}
	},
);

it("refuses a valid foreign certificate without regenerating or changing either wrapped key", async () => {
	const identity = await loadIdentity(f.store, f.key);
	const other = await fixture();
	let foreign: HubIdentity | undefined;
	let saved: { identity_wrapped: Buffer; statement_wrapped: Buffer } | undefined;
	try {
		foreign = await loadIdentity(other.store, other.key);
		saved = f.store.read((db) =>
			db.get<{ identity_wrapped: Buffer; statement_wrapped: Buffer }>(
				"SELECT identity_wrapped,statement_wrapped FROM main.hub_meta WHERE singleton=1",
			),
		);
		if (!saved) throw new Error("Missing wrapped native keys");
		f.store.write((tx) => {
			tx.run("UPDATE main.hub_meta SET identity_cert=? WHERE singleton=1", [
				foreign?.certificate ?? null,
			]);
		});
		const create = vi.spyOn(X509CertificateGenerator, "createSelfSigned");
		await expect(loadIdentity(f.store, f.key)).rejects.toThrow("Hub identity unavailable");
		expect(create).not.toHaveBeenCalled();
		const after = f.store.read((db) =>
			db.get<{ identity_wrapped: Buffer; statement_wrapped: Buffer; identity_cert: string }>(
				"SELECT identity_wrapped,statement_wrapped,identity_cert FROM main.hub_meta WHERE singleton=1",
			),
		);
		if (!after) throw new Error("Missing refused native record");
		try {
			expect(after.identity_wrapped.equals(saved.identity_wrapped)).toBe(true);
			expect(after.statement_wrapped.equals(saved.statement_wrapped)).toBe(true);
			expect(after.identity_cert).toBe(foreign.certificate);
		} finally {
			after.identity_wrapped.fill(0);
			after.statement_wrapped.fill(0);
		}
	} finally {
		saved?.identity_wrapped.fill(0);
		saved?.statement_wrapped.fill(0);
		identity.lock();
		foreign?.lock();
		other.store.close();
		other.key.destroy();
		removeFixture(other.dir);
	}
});

const emptyRecord = (store: HubStore) =>
	store.read((db) =>
		db.get<{ empty: number }>(
			"SELECT identity_wrapped IS NULL AND statement_wrapped IS NULL AND identity_cert IS NULL AS empty FROM main.hub_meta WHERE singleton=1",
		),
	)?.empty;

it("refuses an unrelated genuine key before changing an empty identity record", async () => {
	const wrong = new MasterKey(Buffer.alloc(32, 9));
	try {
		await expect(loadIdentity(f.store, wrong)).rejects.toThrow("Hub identity unavailable");
		expect(emptyRecord(f.store)).toBe(1);
		const identity = await loadIdentity(f.store, f.key);
		expect(emptyRecord(f.store)).toBe(0);
		identity.lock();
	} finally {
		wrong.destroy();
	}
});

it("requires actual store/key private brands and never invokes substituted methods or proxy traps", async () => {
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
	const fakeKey = Object.assign(Object.create(MasterKey.prototype) as MasterKey, { derive: hook });
	for (const [store, key] of [
		[fakeStore, f.key],
		[f.store, fakeKey],
		[new Proxy(f.store, { get: hook }), f.key],
		[f.store, new Proxy(f.key, { get: hook })],
	] as const)
		await expect(loadIdentity(store, key)).rejects.toThrow("Hub identity unavailable");
	expect(calls).toBe(0);
	expect(emptyRecord(f.store)).toBe(1);
});

it("uses captured native store and key intrinsics on genuine instances", async () => {
	const hooks = [
		vi.spyOn(f.store, "assertMasterKey"),
		vi.spyOn(f.store, "read"),
		vi.spyOn(f.store, "write"),
		vi.spyOn(f.key, "derive"),
	];
	for (const hook of hooks)
		hook.mockImplementation(() => {
			throw new Error("DYTEST-OVERRIDE-MUST-NOT-RUN");
		});
	const identity = await loadIdentity(f.store, f.key);
	for (const hook of hooks) expect(hook).not.toHaveBeenCalled();
	identity.lock();
});

it.each(["key", "store"] as const)(
	"rechecks the genuine relationship after certificate generation when the %s closes",
	async (closed) => {
		const create = X509CertificateGenerator.createSelfSigned;
		let generated = false;
		vi.spyOn(X509CertificateGenerator, "createSelfSigned").mockImplementationOnce(
			async (...args) => {
				const certificate = await create.apply(X509CertificateGenerator, args);
				generated = true;
				if (closed === "key") f.key.destroy();
				else f.store.close();
				return certificate;
			},
		);
		await expect(loadIdentity(f.store, f.key)).rejects.toThrow("Hub identity unavailable");
		expect(generated).toBe(true);
		if (closed === "key") expect(emptyRecord(f.store)).toBe(1);
		else {
			const reopened = new HubStore({ filename: f.filename, masterKey: f.key, nativeBinding });
			try {
				expect(emptyRecord(reopened)).toBe(1);
			} finally {
				reopened.close();
			}
		}
	},
);

it("refuses closed or destroyed native inputs before generation", async () => {
	const create = vi.spyOn(X509CertificateGenerator, "createSelfSigned");
	const destroyed = new MasterKey(Buffer.alloc(32, 3));
	destroyed.destroy();
	await expect(loadIdentity(f.store, destroyed)).rejects.toThrow("Hub identity unavailable");
	f.store.close();
	await expect(loadIdentity(f.store, f.key)).rejects.toThrow("Hub identity unavailable");
	expect(create).not.toHaveBeenCalled();
});

it("bounds BLOB/TEXT records including text after NUL before parsing and refuses partial records", async () => {
	const create = vi.spyOn(X509CertificateGenerator, "createSelfSigned");
	for (const [column, value] of [
		["identity_wrapped", Buffer.alloc(4097)],
		["statement_wrapped", Buffer.alloc(29)],
		["identity_cert", ""],
		["identity_cert", `DYTEST-CERT\0${"x".repeat(16_384)}`],
		["identity_cert", "DYTEST-CERT\0suffix"],
	] as const) {
		f.store.write((tx) => tx.run(`UPDATE main.hub_meta SET ${column}=?`, [value]));
		await expect(loadIdentity(f.store, f.key)).rejects.toThrow("Hub identity record unavailable");
		f.store.write((tx) => tx.run(`UPDATE main.hub_meta SET ${column}=NULL`));
	}
	expect(emptyRecord(f.store)).toBe(1);
	expect(create).not.toHaveBeenCalled();
});

it("reads and persists the durable main identity despite a temporary shadow", async () => {
	await addShadows(f, "CREATE TEMP TABLE hub_meta AS SELECT * FROM main.hub_meta;");
	const identity = await loadIdentity(f.store, f.key);
	expect(emptyRecord(f.store)).toBe(0);
	expect(
		f.store.read((db) =>
			db.get<{ empty: number }>(
				"SELECT identity_wrapped IS NULL AND identity_cert IS NULL AS empty FROM temp.hub_meta",
			),
		)?.empty,
	).toBe(1);
	const restored = await loadIdentity(f.store, f.key);
	expect(restored.hid).toBe(identity.hid);
	identity.lock();
	restored.lock();
});

it("uses only the identity/PIN core tables and fields in this foundation", () => {
	const row = f.store.read((db) =>
		db.get<Record<string, unknown>>("SELECT * FROM main.hub_meta WHERE singleton=1"),
	);
	expect(Object.keys(row ?? {})).toEqual([
		"singleton",
		"identity_wrapped",
		"statement_wrapped",
		"identity_cert",
	]);
	const tables = f.store.read((db) =>
		db.all<{ name: string }>(
			"SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT GLOB '_migrations_*' AND name NOT GLOB 'sqlite_*' ORDER BY name",
		),
	);
	expect(tables.map((table) => table.name)).toEqual(
		expect.arrayContaining(["approval_pins", "audit_events", "audit_meta", "hub_meta", "users"]),
	);
});
