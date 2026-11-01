import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CredentialBinding,
	CredentialError,
	type CredentialValue,
	CredentialVault,
} from "../../src/credentials/vault.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import {
	appValue,
	cleanupFixtures,
	gmail,
	holdsAny,
	keyValue,
	provider,
	sealWith,
	secrets,
	slack,
	slackApp,
	slackValue,
	token,
	unsealWith,
	type VaultFixture,
	vaultFixture,
} from "./helpers.ts";

afterEach(cleanupFixtures);
const later = (): number => Date.now() + 3_600_000;
const setValue = (f: VaultFixture, reference: string, value: Uint8Array): void =>
	f.raw((tx) => {
		tx.run("UPDATE main.credentials SET value=? WHERE id=?", [value, reference]);
	});
const opens = async (f: VaultFixture, reference: string, owner: CredentialBinding) => {
	let uses = 0;
	const result = await f.vault
		.withCredential(reference, owner, { requestClass: "read" }, (value) => {
			uses++;
			return value;
		})
		.catch((error: unknown) => error);
	return { result, uses };
};

describe("sealed credential values", () => {
	it("stores every kind as a versioned AES-256-GCM value under the secrets subkey", async () => {
		const f = await vaultFixture();
		const values: [CredentialBinding, CredentialValue][] = [
			[gmail(), token(later())],
			[slack(), slackValue(later())],
			[slackApp(), appValue()],
			[provider(), keyValue()],
		];
		for (const [owner, value] of values) {
			const reference = f.create(owner, value),
				row = f.row(reference);
			expect(row?.value).toBeInstanceOf(Uint8Array);
			const sealed = Buffer.from(row?.value as Uint8Array);
			expect(sealed[0]).toBe(1);
			expect(sealed.length).toBe(29 + Buffer.byteLength(JSON.stringify(value)));
			expect(unsealWith(f.key, sealed, reference, owner, 1)).toEqual(value);
		}
		const twin = keyValue(),
			first = f.create(provider(), twin),
			second = f.create(provider(), twin);
		expect(Buffer.from(f.row(first)?.value as Uint8Array)).not.toEqual(
			Buffer.from(f.row(second)?.value as Uint8Array),
		);
		const all = values.flatMap(([, value]) => secrets(value));
		expect(holdsAny(f.store, f.filename, all)).toBe(false);
		f.store.checkpoint();
		expect(holdsAny(f.store, f.filename, all)).toBe(false);
	});
	it("opens a value sealed independently in the documented format", async () => {
		const f = await vaultFixture(),
			owner = gmail(),
			value = token(later()),
			reference = f.create(owner, token(later()));
		setValue(f, reference, sealWith(f.key, reference, owner, 1, value));
		await expect(opens(f, reference, owner)).resolves.toEqual({ result: value, uses: 1 });
	});
	it("binds each value to its reference, owner, kind and generation", async () => {
		const f = await vaultFixture(),
			owner = gmail(),
			value = token(later()),
			reference = f.create(owner, value),
			sibling = f.create(owner, token(later())),
			other = gmail(),
			otherReference = f.create(other, token(later()));
		const original = Buffer.from(f.row(reference)?.value as Uint8Array);
		const variants: [string, Uint8Array][] = [
			["reference", sealWith(f.key, otherReference, owner, 1, value)],
			["owner", sealWith(f.key, reference, other, 1, value)],
			["kind", sealWith(f.key, reference, slack(owner.ownerId), 1, value)],
			["generation", sealWith(f.key, reference, owner, 2, value)],
			[
				"row of the same owner, kind and generation",
				Buffer.from(f.row(sibling)?.value as Uint8Array),
			],
			["other row", Buffer.from(f.row(otherReference)?.value as Uint8Array)],
		];
		for (const [name, sealed] of variants) {
			setValue(f, reference, sealed);
			const { result, uses } = await opens(f, reference, owner);
			expect(result, name).toBeInstanceOf(CredentialError);
			expect(uses, name).toBe(0);
		}
		setValue(f, reference, original);
		await expect(opens(f, reference, owner)).resolves.toEqual({ result: value, uses: 1 });
	});
	it("refuses a changed version, nonce, tag or ciphertext byte and a truncated value", async () => {
		const f = await vaultFixture(),
			owner = provider(),
			value = keyValue(),
			reference = f.create(owner, value),
			original = Buffer.from(f.row(reference)?.value as Uint8Array);
		for (const at of [0, 1, 12, 13, 28, 29, original.length - 1]) {
			const changed = Buffer.from(original);
			changed[at] = (changed[at] ?? 0) ^ 1;
			setValue(f, reference, changed);
			expect((await opens(f, reference, owner)).uses).toBe(0);
		}
		setValue(f, reference, original.subarray(0, original.length - 1));
		expect((await opens(f, reference, owner)).uses).toBe(0);
		setValue(f, reference, original);
		await expect(opens(f, reference, owner)).resolves.toEqual({ result: value, uses: 1 });
	});
	it("refuses a value sealed by another hub's master key", async () => {
		const f = await vaultFixture(),
			owner = provider(),
			value = keyValue(),
			reference = f.create(owner, value);
		const foreign = new MasterKey(randomBytes(32));
		try {
			setValue(f, reference, sealWith(foreign, reference, owner, 1, value));
		} finally {
			foreign.destroy();
		}
		expect((await opens(f, reference, owner)).uses).toBe(0);
	});
	it("re-seals a rotated value for the next generation only", async () => {
		const f = await vaultFixture(),
			owner = gmail(),
			reference = f.create(owner, token()),
			before = Buffer.from(f.row(reference)?.value as Uint8Array),
			rotated = token(later());
		await f.vault.withCredential(
			reference,
			owner,
			{ requestClass: "read", refresh: async () => rotated },
			() => undefined,
		);
		const after = Buffer.from(f.row(reference)?.value as Uint8Array);
		expect(after).not.toEqual(before);
		expect(unsealWith(f.key, after, reference, owner, 2)).toEqual(rotated);
		expect(() => unsealWith(f.key, after, reference, owner, 1)).toThrow();
		setValue(f, reference, before);
		expect((await opens(f, reference, owner)).uses).toBe(0);
		setValue(f, reference, after);
		await expect(opens(f, reference, owner)).resolves.toEqual({ result: rotated, uses: 1 });
	});
	it("keeps no secret in any table or file through rotation, revoke and a checkpoint", async () => {
		const f = await vaultFixture(),
			owner = gmail(),
			first = token(),
			rotated = token(later()),
			reference = f.create(owner, first),
			all = [...secrets(first), ...secrets(rotated)];
		expect(holdsAny(f.store, f.filename, all)).toBe(false);
		await f.vault.withCredential(
			reference,
			owner,
			{ requestClass: "read", refresh: async () => rotated },
			() => undefined,
		);
		expect(holdsAny(f.store, f.filename, all)).toBe(false);
		f.store.write((tx) => f.vault.invalidateInTransaction(tx, reference, owner, "revoke"));
		expect(f.row(reference)).toMatchObject({ status: "revoked", value: null, generation: 3 });
		f.store.checkpoint();
		expect(holdsAny(f.store, f.filename, all)).toBe(false);
	});
});

describe("vault keys", () => {
	it("refuses a master key that does not open the store", async () => {
		const f = await vaultFixture(),
			wrong = new MasterKey(randomBytes(32));
		try {
			expect(() => new CredentialVault(f.store, f.audit, wrong)).toThrow(CredentialError);
		} finally {
			wrong.destroy();
		}
		const locked = new MasterKey(randomBytes(32));
		locked.destroy();
		expect(() => new CredentialVault(f.store, f.audit, locked)).toThrow(CredentialError);
	});
	it("refuses every call after destroy while other facades keep working", async () => {
		const f = await vaultFixture(),
			owner = provider(),
			reference = f.create(owner, keyValue()),
			other = f.open();
		f.vault.destroy();
		const calls: (() => unknown)[] = [
			() => f.vault.describe(reference, owner),
			() => f.store.write((tx) => f.vault.describeInTransaction(tx, reference, owner)),
			() => f.store.write((tx) => f.vault.createInTransaction(tx, provider(), keyValue())),
			() => f.store.write((tx) => f.vault.replaceInTransaction(tx, reference, owner, keyValue())),
			() => f.store.write((tx) => f.vault.invalidateInTransaction(tx, reference, owner, "revoke")),
			() => f.store.write((tx) => f.vault.purgeInTransaction(tx, reference, owner)),
			() =>
				f.store.write((tx) =>
					f.vault.purgeOwnerInTransaction(tx, {
						ownerKind: owner.ownerKind,
						ownerId: owner.ownerId,
					}),
				),
		];
		for (const call of calls) expect(call).toThrow(CredentialError);
		await expect(
			f.vault.withCredential(reference, owner, { requestClass: "read" }, () => "unsafe"),
		).rejects.toThrow(CredentialError);
		await expect(
			other.withCredential(reference, owner, { requestClass: "read" }, () => "current"),
		).resolves.toBe("current");
	});
	it("refuses every call of every facade once the master key is destroyed", async () => {
		const f = await vaultFixture(),
			owner = provider(),
			reference = f.create(owner, keyValue()),
			other = f.open();
		f.key.destroy();
		for (const vault of [f.vault, other]) {
			expect(() => vault.describe(reference, owner)).toThrow(CredentialError);
			expect(() =>
				f.store.write((tx) => vault.describeInTransaction(tx, reference, owner)),
			).toThrow(CredentialError);
			expect(() =>
				f.store.write((tx) => vault.createInTransaction(tx, provider(), keyValue())),
			).toThrow(CredentialError);
			expect(() => f.store.write((tx) => vault.purgeInTransaction(tx, reference, owner))).toThrow(
				CredentialError,
			);
			await expect(
				vault.withCredential(reference, owner, { requestClass: "read" }, () => "unsafe"),
			).rejects.toThrow(CredentialError);
		}
		expect(f.row(reference)?.status).toBe("active");
	});
});
