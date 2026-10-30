import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CredentialError, CredentialRefreshError } from "../../src/credentials/vault.ts";
import { cleanupFixtures, fakeClock, gmail, token, vaultFixture } from "./helpers.ts";

afterEach(cleanupFixtures);
it("does not restore an old value after the first clear COMMIT fails following a valid refresh answer", async () => {
	const time = fakeClock();
	const f = await vaultFixture({ clock: time.clock });
	const owner = gmail();
	const current = token(time.state.wall + 20 * 60_000);
	const reference = f.create(owner, current);
	writeFileSync(
		path.join(f.fault, "0001_fail_refresh_clear.sql"),
		`
    CREATE TABLE credential_clear_parent(id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE credential_clear_child(id INTEGER REFERENCES credential_clear_parent(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
    CREATE TRIGGER credential_clear_failure AFTER UPDATE ON credentials
      WHEN OLD.status='refreshing' AND NEW.status='refreshing' AND NEW.value IS NULL AND OLD.value IS NOT NULL
      BEGIN INSERT INTO credential_clear_child(id) VALUES(1); END;
  `,
	);
	await f.store.migrate("fault");
	let adapterAnswered = false;
	let kept: ReturnType<typeof f.row>;
	let uses = 0;
	await expect(
		f.vault.withCredential(
			reference,
			owner,
			{
				requestClass: "read",
				refreshAheadMs: 30 * 60_000,
				refresh: async () => {
					adapterAnswered = true;
					kept = f.row(reference);
					return token(time.state.wall + 60 * 60_000);
				},
			},
			() => {
				uses++;
			},
		),
	).rejects.toThrow(CredentialError);
	expect(adapterAnswered).toBe(true);
	expect(uses).toBe(0);
	expect(kept).toMatchObject({ status: "refreshing", generation: 2 });
	expect(kept?.value).toBeInstanceOf(Uint8Array);
	// COMMIT rolled back the clear: no durable row field distinguishes this from a crash
	// while the adapter still held the exchange.
	expect(f.row(reference)).toEqual(kept);
	const reopened = f.open(f.reopen());
	await expect(
		reopened.withCredential(reference, owner, { requestClass: "read" }, () => {
			uses++;
			return "resumed-old-value";
		}),
	).rejects.toThrow(CredentialError);
	expect(uses).toBe(0);
});

it.each(["invalid_grant", "temporary"] as const)(
	"does not restore an old value after %s recovery COMMIT fails",
	async (failure) => {
		const time = fakeClock();
		const f = await vaultFixture({ clock: time.clock });
		const owner = gmail();
		const reference = f.create(owner, token(time.state.wall + 20 * 60_000));
		writeFileSync(
			path.join(f.fault, "0001_fail_refresh_revoke.sql"),
			`
		CREATE TABLE credential_revoke_parent(id INTEGER PRIMARY KEY) STRICT;
		CREATE TABLE credential_revoke_child(id INTEGER REFERENCES credential_revoke_parent(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
		CREATE TRIGGER credential_revoke_failure AFTER UPDATE ON credentials
			WHEN OLD.status='refreshing' AND NEW.status='${failure === "temporary" ? "active" : "revoked"}'
			BEGIN INSERT INTO credential_revoke_child(id) VALUES(1); END;
		`,
		);
		await f.store.migrate("fault");
		let kept: ReturnType<typeof f.row>;
		let classified = false;
		let uses = 0;
		await expect(
			f.vault.withCredential(
				reference,
				owner,
				{
					requestClass: "read",
					refreshAheadMs: 30 * 60_000,
					refresh: async () => {
						kept = f.row(reference);
						classified = true;
						throw new CredentialRefreshError(failure);
					},
				},
				() => {
					uses++;
				},
			),
		).rejects.toThrow(CredentialError);
		expect(classified).toBe(true);
		expect(uses).toBe(0);
		expect(kept).toMatchObject({ status: "refreshing", generation: 2 });
		expect(f.row(reference)).toEqual(kept);
		const reopened = f.open(f.reopen());
		await expect(
			reopened.withCredential(reference, owner, { requestClass: "read" }, () => {
				uses++;
				return "resumed-revoked-value";
			}),
		).rejects.toThrow(CredentialError);
		expect(uses).toBe(0);
	},
);
