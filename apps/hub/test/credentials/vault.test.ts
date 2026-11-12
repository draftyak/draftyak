import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CredentialBinding,
	CredentialError,
	type CredentialUse,
	type CredentialValue,
	CredentialVault,
} from "../../src/credentials/vault.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";
import { nativeBinding } from "../store/helpers.ts";
import {
	appValue,
	canary,
	cleanupFixtures,
	deferred,
	gmail,
	holdsAny,
	keptValue,
	keyValue,
	provider,
	secrets,
	slack,
	slackApp,
	slackValue,
	token,
	unsealWith,
	vaultFixture,
} from "./helpers.ts";

afterEach(cleanupFixtures);
const later = (): number => Date.now() + 60_000;
const fixture = () => vaultFixture();

describe("encrypted native credential persistence", () => {
	it("persists Gmail, Slack and provider credentials across reopen without plaintext database/WAL/SHM", async () => {
		const f = await fixture();
		const values: [CredentialBinding, CredentialValue][] = [
			[gmail(), token(later())],
			[slack(), slackValue()],
			[slackApp(), appValue()],
			[provider(), keyValue()],
		];
		const refs = values.map(([owner, value]) => f.create(owner, value));
		const all = values.flatMap(([, value]) => secrets(value));
		expect(holdsAny(f.store, f.filename, all)).toBe(false);
		const store = f.reopen(),
			vault = f.open(store);
		for (let i = 0; i < values.length; i++) {
			const [owner, value] = values[i] as [CredentialBinding, CredentialValue];
			const ref = refs[i] as string;
			expect(vault.describe(ref, owner)).toEqual({ reference: ref, generation: 1, binding: owner });
			await vault.withCredential(ref, owner, { requestClass: "read" }, (actual) => {
				expect(actual).toEqual(value);
				return "result";
			});
		}
		store.checkpoint();
		expect(holdsAny(store, f.filename, all)).toBe(false);
		store.read((db) => f.audit.verify(db));
	});
	it("refuses the wrong database key and structural or foreign transaction facades", async () => {
		const f = await fixture(),
			owner = provider(),
			other = await fixture();
		const wrong = new MasterKey(randomBytes(32));
		try {
			expect(
				() => new HubStore({ filename: f.filename, nativeBinding, masterKey: wrong }),
			).toThrow();
		} finally {
			wrong.destroy();
		}
		expect(
			() => new CredentialVault({ read: () => undefined } as unknown as HubStore, f.audit, f.key),
		).toThrow(CredentialError);
		expect(() =>
			f.vault.createInTransaction(
				{ run: () => ({ changes: 1 }) } as unknown as SqlTransaction,
				owner,
				keyValue(),
			),
		).toThrow(CredentialError);
		expect(() =>
			other.store.write((tx) => f.vault.createInTransaction(tx, owner, keyValue())),
		).toThrow(CredentialError);
		let retired: SqlTransaction | undefined;
		f.store.write((tx) => {
			retired = tx;
		});
		expect(() => f.vault.createInTransaction(retired as SqlTransaction, owner, keyValue())).toThrow(
			CredentialError,
		);
	});
	it("separates bindings, exposes only opaque metadata and redacts audit/errors", async () => {
		const f = await fixture(),
			owner = provider(),
			value = keyValue(),
			reference = f.create(owner, value);
		expect(() => f.vault.describe(reference, provider())).toThrow(CredentialError);
		expect(() => f.vault.describe(reference, slack(owner.ownerId))).toThrow(CredentialError);
		expect(JSON.stringify(f.vault.describe(reference, owner))).not.toContain(JSON.stringify(value));
		expect(JSON.stringify(f.vault)).toBe('"[REDACTED]"');
		const failure = await f.vault
			.withCredential(reference, owner, { requestClass: "read" }, () => {
				throw new Error(JSON.stringify(value));
			})
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({
			message: "Credential unavailable",
			code: "CREDENTIAL_UNAVAILABLE",
		});
		expect(failure).not.toHaveProperty("cause");
		const audit = f.actions();
		expect(audit).toHaveLength(1);
		expect(JSON.parse(audit[0]?.refs ?? "")).toEqual({
			credential: reference,
			provider: owner.ownerId,
		});
	});
	it("rolls back credential and audit together when the caller transaction fails", async () => {
		const f = await fixture(),
			owner = provider();
		expect(() =>
			f.store.write((tx) => {
				f.vault.createInTransaction(tx, owner, keyValue());
				throw new Error("rollback");
			}),
		).toThrow("rollback");
		expect(
			f.store.read((db) => db.get<{ n: number }>("SELECT count(*) n FROM main.credentials")?.n),
		).toBe(0);
		expect(f.actions()).toHaveLength(0);
	});
	it("refuses hostile value objects and malformed stored payloads", async () => {
		const f = await fixture(),
			owner = provider();
		let getterCalls = 0;
		const hostile = Object.defineProperty({ kind: "provider-key" }, "key", {
			get() {
				getterCalls++;
				return canary();
			},
			enumerable: true,
		});
		expect(() => f.create(owner, hostile as CredentialValue)).toThrow(CredentialError);
		expect(getterCalls).toBe(0);
		const ref = f.create(owner, keyValue());
		expect(() =>
			f.raw((tx) => tx.run("UPDATE main.credentials SET value=? WHERE id=?", ["{}", ref])),
		).toThrow();
		f.raw((tx) =>
			tx.run("UPDATE main.credentials SET value=? WHERE id=?", [
				Buffer.concat([Buffer.from([1]), randomBytes(60)]),
				ref,
			]),
		);
		await expect(
			f.vault.withCredential(ref, owner, { requestClass: "read" }, () => "unsafe"),
		).rejects.toThrow(CredentialError);
	});
});

describe("shared refresh and revision coordination", () => {
	it("removes canceled queue waiters while valid callers still share the real refresh", async () => {
		const f = await fixture(),
			owner = gmail(),
			ref = f.create(owner, token());
		const started = deferred<void>(),
			gate = deferred<CredentialValue>(),
			external = new AbortController();
		let refreshSignal: AbortSignal | undefined,
			canceledUses = 0;
		const refreshing = f.vault.withCredential(
			ref,
			owner,
			{
				requestClass: "read",
				refresh: async (_, context) => {
					refreshSignal = context.signal;
					started.resolve();
					return gate.promise;
				},
			},
			() => "refresh",
		);
		await started.promise;
		const canceled = f.vault.withCredential(
			ref,
			owner,
			{ requestClass: "read", signal: external.signal },
			() => {
				canceledUses++;
			},
		);
		const rejected = expect(canceled).rejects.toThrow(CredentialError);
		const valid = f.vault.withCredential(ref, owner, { requestClass: "read" }, () => "valid");
		external.abort();
		await rejected;
		expect(refreshSignal?.aborted).toBe(false);
		gate.resolve(token(later()));
		await expect(Promise.all([refreshing, valid])).resolves.toEqual(["refresh", "valid"]);
		expect(canceledUses).toBe(0);
	});
	it("cancels the refreshing caller promptly while its exchange still installs the rotated value", async () => {
		const f = await fixture(),
			owner = gmail(),
			original = token(),
			ref = f.create(owner, original),
			rotated = token(later());
		const started = deferred<void>(),
			gate = deferred<CredentialValue>(),
			external = new AbortController();
		let refreshSignal: AbortSignal | undefined;
		const refreshing = f.vault.withCredential(
			ref,
			owner,
			{
				requestClass: "read",
				signal: external.signal,
				refresh: async (_, context) => {
					refreshSignal = context.signal;
					started.resolve();
					return gate.promise;
				},
			},
			() => "unsafe",
		);
		const rejected = expect(refreshing).rejects.toThrow(CredentialError);
		await started.promise;
		external.abort();
		await rejected;
		expect(refreshSignal?.aborted).toBe(false);
		expect(keptValue(f, ref, owner)).toEqual(original);
		gate.resolve(rotated);
		await expect(
			f.vault.withCredential(ref, owner, { requestClass: "read" }, (value) => value),
		).resolves.toEqual(rotated);
		expect(f.row(ref)).toMatchObject({ status: "active", generation: 2 });
	});
	it("cancels asynchronous use and safely refuses fake or shadowed signal objects", async () => {
		const f = await fixture(),
			owner = provider(),
			ref = f.create(owner, keyValue());
		const started = deferred<void>(),
			gate = deferred<void>(),
			external = new AbortController();
		let signal: AbortSignal | undefined;
		const using = f.vault.withCredential(
			ref,
			owner,
			{ requestClass: "read", signal: external.signal },
			async (_, context) => {
				signal = context.signal;
				started.resolve();
				await gate.promise;
			},
		);
		const rejected = expect(using).rejects.toThrow(CredentialError);
		await started.promise;
		external.abort();
		await rejected;
		expect(signal?.aborted).toBe(true);
		gate.resolve();
		const shadowed = new AbortController().signal;
		let reads = 0;
		Object.defineProperty(shadowed, "aborted", {
			get() {
				reads++;
				return false;
			},
		});
		for (const candidate of [shadowed, { aborted: false }]) {
			await expect(
				f.vault.withCredential(
					ref,
					owner,
					{ requestClass: "read", signal: candidate as AbortSignal },
					() => "unsafe",
				),
			).rejects.toThrow(CredentialError);
		}
		expect(reads).toBe(0);
	});
	it("shares one refresh across vaults/adapters and lets other credentials progress", async () => {
		const f = await fixture(),
			owner = gmail(),
			ref = f.create(owner, token()),
			gate = deferred<CredentialValue>(),
			started = deferred<void>();
		const otherVault = f.open();
		let refreshes = 0,
			alternate = 0;
		const read = f.vault.withCredential(
			ref,
			owner,
			{
				requestClass: "read",
				refresh: async () => {
					refreshes++;
					started.resolve();
					return gate.promise;
				},
			},
			() => "one",
		);
		await started.promise;
		const second = otherVault.withCredential(
			ref,
			owner,
			{
				requestClass: "read",
				refresh: async () => {
					alternate++;
					return token(later());
				},
			},
			() => "two",
		);
		const otherOwner = provider(),
			otherRef = f.create(otherOwner, keyValue());
		await expect(
			otherVault.withCredential(
				otherRef,
				otherOwner,
				{ requestClass: "read" },
				() => "independent",
			),
		).resolves.toBe("independent");
		const rotated = token(later());
		gate.resolve(rotated);
		await expect(Promise.all([read, second])).resolves.toEqual(["one", "two"]);
		expect(refreshes).toBe(1);
		expect(alternate).toBe(0);
		expect(f.vault.describe(ref, owner).generation).toBe(2);
	});
	it("commits rotated values and their audit before invoking dependent use", async () => {
		const f = await fixture(),
			owner = gmail(),
			ref = f.create(owner, token()),
			rotated = token(later());
		await f.vault.withCredential(
			ref,
			owner,
			{ requestClass: "read", refresh: async () => rotated },
			(value, context) => {
				expect(value).toEqual(rotated);
				expect(context.generation).toBe(2);
				const row = f.row(ref);
				expect(row?.status).toBe("active");
				expect(unsealWith(f.key, row?.value as Uint8Array, ref, owner, 2)).toEqual(rotated);
				expect(f.actions().at(-1)?.action).toBe("credential.refreshed");
			},
		);
	});
	it("exposes no rotated or stale authority after a real deferred commit failure, including reopen", async () => {
		const f = await fixture(),
			owner = gmail(),
			ref = f.create(owner, token());
		writeFileSync(
			path.join(f.fault, "0001_commit_failure.sql"),
			`
			CREATE TABLE credential_fault_parent(id INTEGER PRIMARY KEY) STRICT;
			CREATE TABLE credential_fault_child(id INTEGER REFERENCES credential_fault_parent(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
			CREATE TRIGGER credential_commit_failure AFTER UPDATE ON credentials WHEN OLD.status='refreshing' AND NEW.status='active'
			BEGIN INSERT INTO credential_fault_child(id) VALUES(1); END;
		`,
		);
		await f.store.migrate("fault");
		let uses = 0;
		await expect(
			f.vault.withCredential(
				ref,
				owner,
				{ requestClass: "read", refresh: async () => token(later()) },
				() => {
					uses++;
				},
			),
		).rejects.toThrow(CredentialError);
		expect(uses).toBe(0);
		expect(f.row(ref)).toMatchObject({ status: "refreshing", value: null, generation: 2 });
		const vault = f.open(f.reopen());
		expect(f.row(ref)).toMatchObject({ status: "refreshing", value: null, generation: 2 });
		await expect(
			vault.withCredential(
				ref,
				owner,
				{ requestClass: "read", refresh: async () => token(later()) },
				() => {
					uses++;
				},
			),
		).rejects.toThrow(CredentialError);
		expect(uses).toBe(0);
		expect(f.actions().map(({ action }) => action)).not.toContain("credential.restored");
	});
	it("never refreshes an expired send, while a current send may use its existing value", async () => {
		const f = await fixture(),
			owner = gmail(),
			ref = f.create(owner, token());
		let refreshes = 0,
			uses = 0;
		const request = {
			requestClass: "send" as const,
			refresh: async () => {
				refreshes++;
				return token(later());
			},
		};
		await expect(
			f.vault.withCredential(ref, owner, request, () => {
				uses++;
			}),
		).rejects.toThrow(CredentialError);
		expect(refreshes).toBe(0);
		expect(uses).toBe(0);
		expect(f.vault.describe(ref, owner).generation).toBe(1);
		f.store.write((tx) => f.vault.replaceInTransaction(tx, ref, owner, token(later())));
		await f.vault.withCredential(ref, owner, request, () => {
			uses++;
		});
		expect(refreshes).toBe(0);
		expect(uses).toBe(1);
	});
	it.each(["revoke", "disconnect", "delete"] as const)(
		"does not resurrect a %s racing a delayed refresh",
		async (reason) => {
			const f = await fixture(),
				owner = gmail(),
				ref = f.create(owner, token()),
				gate = deferred<CredentialValue>(),
				started = deferred<void>();
			let signal: AbortSignal | undefined,
				uses = 0;
			const pending = f.vault.withCredential(
				ref,
				owner,
				{
					requestClass: "read",
					refresh: async (_, context) => {
						signal = context.signal;
						started.resolve();
						return gate.promise;
					},
				},
				() => {
					uses++;
				},
			);
			const rejection = expect(pending).rejects.toThrow(CredentialError);
			await started.promise;
			f.store.write((tx) => f.vault.invalidateInTransaction(tx, ref, owner, reason));
			expect(signal?.aborted).toBe(true);
			gate.resolve(token(later()));
			await rejection;
			expect(uses).toBe(0);
			expect(() => f.open(f.reopen()).describe(ref, owner)).toThrow(CredentialError);
		},
	);
	it("replacement aborts prior revision use and blocks delayed refresh overwriting the replacement", async () => {
		const f = await fixture(),
			owner = gmail(),
			ref = f.create(owner, token()),
			gate = deferred<CredentialValue>(),
			started = deferred<void>();
		const pending = f.vault.withCredential(
			ref,
			owner,
			{
				requestClass: "read",
				refresh: async () => {
					started.resolve();
					return gate.promise;
				},
			},
			() => "old",
		);
		const rejection = expect(pending).rejects.toThrow(CredentialError);
		await started.promise;
		const replacement = token(later());
		f.open();
		f.store.write((tx) => f.vault.replaceInTransaction(tx, ref, owner, replacement));
		gate.resolve(token(later()));
		await rejection;
		await f.vault.withCredential(ref, owner, { requestClass: "read" }, (actual) => {
			expect(actual).toEqual(replacement);
		});
	});
	it("aborts in-flight use across facades and refuses its delayed result", async () => {
		const f = await fixture(),
			owner = provider(),
			ref = f.create(owner, keyValue()),
			gate = deferred<string>(),
			started = deferred<void>();
		let context: CredentialUse | undefined;
		const pending = f.vault.withCredential(ref, owner, { requestClass: "read" }, async (_, use) => {
			context = use;
			started.resolve();
			return gate.promise;
		});
		const rejection = expect(pending).rejects.toThrow(CredentialError);
		await started.promise;
		const other = f.open();
		f.store.write((tx) => other.replaceInTransaction(tx, ref, owner, keyValue()));
		expect(context?.signal.aborted).toBe(true);
		gate.resolve("late");
		await rejection;
	});
	it("redacts refresh failure and keeps stale authority unusable rather than retrying it", async () => {
		const f = await fixture(),
			owner = gmail(),
			ref = f.create(owner, token());
		let refreshes = 0;
		const request = {
			requestClass: "read" as const,
			refresh: async () => {
				refreshes++;
				throw new Error(canary());
			},
		};
		const failure = await f.vault
			.withCredential(ref, owner, request, () => "unsafe")
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({
			message: "Credential unavailable",
			code: "CREDENTIAL_UNAVAILABLE",
		});
		expect(failure).not.toHaveProperty("cause");
		await expect(f.vault.withCredential(ref, owner, request, () => "unsafe")).rejects.toThrow(
			CredentialError,
		);
		expect(refreshes).toBe(1);
	});
});
