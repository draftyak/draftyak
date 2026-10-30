import "reflect-metadata";
import { X509CertificateGenerator } from "@peculiar/x509";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubIdentity, identityCertificate, wrapIdentityKey } from "../../src/identity/hub-key.ts";
import { openRotatedIdentity } from "../../src/identity/hub-key-rotation/rotation.ts";
import { type RotationFixture, rotationFixture, testKey } from "./hub-key-rotation/fixture.ts";

const loader = vi.hoisted(() => ({
	beforeLoad: undefined as (() => void) | undefined,
	afterLoad: undefined as (() => void) | undefined,
	loaded: [] as import("../../src/identity/hub-key.ts").HubIdentity[],
}));

// Schedule genuine second-connection writes around the real load-only operation.
vi.mock("../../src/identity/hub-key.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/identity/hub-key.ts")>();
	const load = actual.HubIdentity.loadExisting;
	vi.spyOn(actual.HubIdentity, "loadExisting").mockImplementation(async (...args) => {
		loader.beforeLoad?.();
		const identity = await load(...args);
		loader.loaded.push(identity);
		loader.afterLoad?.();
		return identity;
	});
	return actual;
});

const CHAIN_UNAVAILABLE = "Hub identity chain unavailable";
let f: RotationFixture;
let original: HubIdentity;

beforeEach(async () => {
	f = await rotationFixture();
	original = await HubIdentity.loadOrCreate(f.store, f.key);
});
afterEach(() => {
	loader.beforeLoad = undefined;
	loader.afterLoad = undefined;
	for (const identity of loader.loaded.splice(0)) identity.lock();
	original.lock();
	f.cleanup();
});
afterAll(() => vi.restoreAllMocks());

it("never regenerates or persists an identity emptied between the loader's two reads", async () => {
	const writer = f.open();
	loader.beforeLoad = () =>
		writer.write((tx) => {
			tx.run(
				"UPDATE main.hub_meta SET identity_wrapped=NULL,statement_wrapped=NULL,identity_cert=NULL WHERE singleton=1",
			);
		});
	const create = vi.spyOn(X509CertificateGenerator, "createSelfSigned");
	try {
		await expect(openRotatedIdentity(f.store, f.key, f.audit)).rejects.toThrow(CHAIN_UNAVAILABLE);
		expect(loader.loaded).toHaveLength(0);
		expect(create).not.toHaveBeenCalled();
		expect(
			f.store.read((db) =>
				db.get(
					"SELECT identity_wrapped,statement_wrapped,identity_cert FROM main.hub_meta WHERE singleton=1",
				),
			),
		).toEqual({ identity_wrapped: null, statement_wrapped: null, identity_cert: null });
		expect(
			f.store.read((db) =>
				db.get<{ count: number }>("SELECT count(*) AS count FROM main.hub_identity_rotations"),
			)?.count,
		).toBe(0);
		loader.beforeLoad = undefined;
		const restarted = f.reopen();
		await expect(openRotatedIdentity(restarted, f.key, f.audit)).rejects.toThrow(CHAIN_UNAVAILABLE);
		expect(create).not.toHaveBeenCalled();
	} finally {
		create.mockRestore();
	}
});

it.each(["loaded", "persisted"] as const)(
	"rechecks the %s certificate after loading and locks the refused native identity",
	async (changed) => {
		const saved = f.store.read((db) =>
			db.get<{ wrapped: Buffer; certificate: string }>(
				"SELECT identity_wrapped AS wrapped,identity_cert AS certificate FROM main.hub_meta WHERE singleton=1",
			),
		);
		if (!saved) throw new Error("Missing initialized identity");
		const key = testKey();
		const certificate = await identityCertificate(key.privateKey);
		const secrets = f.key.derive("secrets");
		const wrapped = wrapIdentityKey(key.privateKey, secrets);
		secrets.fill(0);
		const writer = f.open();
		const replace = (bytes: Buffer, cert: string): void =>
			writer.write((tx) => {
				tx.run("UPDATE main.hub_meta SET identity_wrapped=?,identity_cert=? WHERE singleton=1", [
					bytes,
					cert,
				]);
			});
		if (changed === "loaded") {
			loader.beforeLoad = () => replace(wrapped, certificate);
			loader.afterLoad = () => replace(saved.wrapped, saved.certificate);
		} else {
			loader.afterLoad = () => replace(wrapped, certificate);
		}
		const create = vi.spyOn(X509CertificateGenerator, "createSelfSigned");
		try {
			await expect(openRotatedIdentity(f.store, f.key, f.audit)).rejects.toThrow(CHAIN_UNAVAILABLE);
			expect(loader.loaded).toHaveLength(1);
			const refused = loader.loaded[0];
			if (!refused) throw new Error("Missing refused native identity");
			expect(refused.certificate).toBe(changed === "loaded" ? certificate : saved.certificate);
			expect(() => refused.tlsPrivateKey()).toThrow("Hub is locked");
			expect(create).not.toHaveBeenCalled();
			loader.beforeLoad = undefined;
			loader.afterLoad = undefined;
			const current = await openRotatedIdentity(f.store, f.key, f.audit);
			expect(current.certificate).toBe(changed === "loaded" ? saved.certificate : certificate);
		} finally {
			create.mockRestore();
			wrapped.fill(0);
			saved.wrapped.fill(0);
		}
	},
);
