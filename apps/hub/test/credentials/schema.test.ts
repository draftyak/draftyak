import { copyFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CredentialBinding,
	CredentialError,
	CredentialVault,
} from "../../src/credentials/vault.ts";
import { newId } from "../../src/kernel/ids.ts";
import {
	appValue,
	canary,
	cleanupFixtures,
	credentialMigrations,
	gmail,
	holdsAny,
	keyValue,
	provider,
	slack,
	slackApp,
	slackValue,
	token,
	vaultFixture,
} from "./helpers.ts";

afterEach(cleanupFixtures);
const later = (): number => Date.now() + 3_600_000;
const MAX = 9007199254740991;

describe("credential schema", () => {
	it("upgrades 0001 plaintext rows by revoking live ones without copying their values", async () => {
		expect(readdirSync(credentialMigrations).toSorted()).toEqual([
			"0001_credentials.sql",
			"0002_sealed_credentials.sql",
		]);
		const f = await vaultFixture({ legacy: true });
		expect(() => new CredentialVault(f.store, f.audit, f.key)).toThrow(CredentialError);
		const plain = [canary(), canary(), canary()];
		const rows: [string, string, string, string, number, string, string | null][] = [
			[newId(), "account", newId(), "gmail-oauth", 1, "active", JSON.stringify(plain)],
			[newId(), "account", newId(), "gmail-oauth", 4, "refreshing", null],
			[newId(), "account", newId(), "slack-token", 2, "revoked", null],
			[newId(), "account", newId(), "slack-token", 3, "disconnected", null],
			[newId(), "account", newId(), "gmail-oauth", 5, "deleted", null],
			[newId(), "provider", newId(), "provider-key", 1, "active", JSON.stringify(plain)],
			[newId(), "account", newId(), "slack-token", MAX, "active", JSON.stringify(plain)],
		];
		f.raw((tx) => {
			for (const row of rows)
				tx.run(
					"INSERT INTO main.credentials(id,owner_kind,owner_id,kind,generation,status,value) VALUES(?,?,?,?,?,?,?)",
					row,
				);
		});
		expect(holdsAny(f.store, f.filename, plain)).toBe(true);
		copyFileSync(
			path.join(credentialMigrations, "0002_sealed_credentials.sql"),
			path.join(f.legacy, "0002_sealed_credentials.sql"),
		);
		await expect(f.store.migrate("credentials")).resolves.toEqual(["0002_sealed_credentials"]);
		const expected = [
			["revoked", 2],
			["revoked", 5],
			["revoked", 2],
			["disconnected", 3],
			["deleted", 5],
			["revoked", 2],
			["revoked", MAX],
		];
		for (const [i, [id, ownerKind, ownerId, kind]] of rows.entries())
			expect(f.row(id)).toEqual({
				owner_kind: ownerKind,
				owner_id: ownerId,
				kind,
				data_class: kind === "slack-token" ? "slack.metadata" : "credentials",
				generation: expected[i]?.[1],
				status: expected[i]?.[0],
				value: null,
			});
		f.store.checkpoint();
		expect(holdsAny(f.store, f.filename, plain)).toBe(false);
		const vault = f.open();
		const [first] = rows,
			owner = gmail(first?.[2]);
		for (const [id, ownerKind, ownerId, kind] of rows)
			expect(() => vault.describe(id, { ownerKind, ownerId, kind } as CredentialBinding)).toThrow(
				CredentialError,
			);
		const replacement = token(later());
		f.store.write((tx) => vault.replaceInTransaction(tx, first?.[0] as string, owner, replacement));
		await expect(
			vault.withCredential(first?.[0] as string, owner, { requestClass: "read" }, (value) => value),
		).resolves.toEqual(replacement);
	});
	it("derives each row's data class from its kind and refuses writing it", async () => {
		const f = await vaultFixture();
		const created = [
			[f.create(gmail(), token(later())), "credentials"],
			[f.create(slack(), slackValue()), "slack.metadata"],
			[f.create(slackApp(), appValue()), "slack.metadata"],
			[f.create(provider(), keyValue()), "credentials"],
		] as const;
		for (const [reference, dataClass] of created)
			expect(f.row(reference)?.data_class).toBe(dataClass);
		const [slackRow] = created.slice(1);
		expect(() =>
			f.raw((tx) =>
				tx.run("UPDATE main.credentials SET data_class='credentials' WHERE id=?", [
					slackRow?.[0] as string,
				]),
			),
		).toThrow();
		expect(() =>
			f.raw((tx) =>
				tx.run(
					"INSERT INTO main.credentials(id,owner_kind,owner_id,kind,data_class,generation,status,value) VALUES(?,?,?,?,?,?,?,?)",
					[newId(), "account", newId(), "slack-token", "credentials", 1, "revoked", null],
				),
			),
		).toThrow();
		expect(f.row(slackRow?.[0] as string)?.data_class).toBe("slack.metadata");
	});
	it("refuses a stored row whose data class does not match its kind", async () => {
		const f = await vaultFixture(),
			mail = gmail(),
			user = slack(),
			mailRef = f.create(mail, token(later())),
			userRef = f.create(user, slackValue());
		writeFileSync(
			path.join(f.fault, "0001_wrong_data_class.sql"),
			`ALTER TABLE credentials DROP COLUMN data_class;
			ALTER TABLE credentials ADD COLUMN data_class TEXT;
			UPDATE credentials SET data_class='credentials';`,
		);
		await f.store.migrate("fault");
		expect(f.row(userRef)?.data_class).toBe("credentials");
		expect(f.vault.describe(mailRef, mail).generation).toBe(1);
		expect(() => f.vault.describe(userRef, user)).toThrow(CredentialError);
		await expect(
			f.vault.withCredential(userRef, user, { requestClass: "send" }, () => "unsafe"),
		).rejects.toThrow(CredentialError);
		expect(() => f.store.write((tx) => f.vault.purgeInTransaction(tx, userRef, user))).toThrow(
			CredentialError,
		);
		expect(
			f.store.write((tx) =>
				f.vault.purgeOwnerInTransaction(tx, { ownerKind: "account", ownerId: user.ownerId }),
			),
		).toBe(1);
		expect(f.row(userRef)).toBeUndefined();
	});
	it("stores a sealed value only on active rows and on refreshing rows that keep one", async () => {
		const f = await vaultFixture(),
			sealed = f.row(f.create(gmail(), token(later())))?.value as Uint8Array;
		const insert = (status: string, value: unknown) => () =>
			f.raw((tx) => {
				tx.run(
					"INSERT INTO main.credentials(id,owner_kind,owner_id,kind,generation,status,value) VALUES(?,?,?,?,?,?,?)",
					[newId(), "account", newId(), "gmail-oauth", 1, status, value as Uint8Array | null],
				);
			});
		for (const status of ["revoked", "disconnected", "deleted"]) {
			expect(insert(status, sealed)).toThrow();
			expect(insert(status, null)).not.toThrow();
		}
		expect(insert("active", null)).toThrow();
		expect(insert("active", sealed)).not.toThrow();
		expect(insert("refreshing", sealed)).not.toThrow();
		expect(insert("refreshing", null)).not.toThrow();
		for (const value of [Buffer.alloc(29, 1), Buffer.alloc(24_606, 1), "DYTEST".repeat(8)])
			expect(insert("refreshing", value)).toThrow();
	});
});
