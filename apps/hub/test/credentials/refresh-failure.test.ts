import { afterEach, describe, expect, it } from "vitest";
import {
	CREDENTIAL_REFRESH_TIMEOUT_MS,
	CredentialError,
	type CredentialRefresh,
	CredentialRefreshError,
	type CredentialRefreshFailure,
	type CredentialValue,
} from "../../src/credentials/vault.ts";
import {
	canary,
	cleanupFixtures,
	deferred,
	fakeClock,
	gmail,
	keptValue,
	sealWith,
	token,
	unsealWith,
	type VaultFixture,
	vaultFixture,
} from "./helpers.ts";

afterEach(cleanupFixtures);
const MINUTE = 60_000;
const WINDOW = 15 * MINUTE;
async function clocked() {
	const time = fakeClock();
	const f = await vaultFixture({ clock: time.clock });
	const until = (ms: number) => token(time.state.wall + ms);
	return { ...time, f, until };
}
const audited = (f: VaultFixture): string[] =>
	f.actions().map(({ action, actor_kind }) => `${action}/${actor_kind}`);
/** An exchange that waits until the test settles it. */
function exchange() {
	const started = deferred<void>(),
		gate = deferred<CredentialValue>(),
		state = { calls: 0 };
	const refresh: CredentialRefresh = async () => {
		state.calls++;
		started.resolve();
		return gate.promise;
	};
	return { started, gate, refresh, state };
}

describe("refresh failure policy", () => {
	it("keeps the previous value sealed for the next generation and unusable during the exchange", async () => {
		const { f, until } = await clocked(),
			owner = gmail(),
			current = until(10 * MINUTE),
			reference = f.create(owner, current),
			rotated = until(60 * MINUTE),
			pending = exchange(),
			other = f.open();
		const refreshing = f.vault.withCredential(
			reference,
			owner,
			{ requestClass: "read", refresh: pending.refresh, refreshAheadMs: WINDOW },
			(value) => value,
		);
		await pending.started.promise;
		expect(f.row(reference)).toMatchObject({ status: "refreshing", generation: 2 });
		expect(keptValue(f, reference, owner)).toEqual(current);
		const kept = f.row(reference)?.value as Uint8Array;
		expect(() => unsealWith(f.key, kept, reference, owner, 1)).toThrow();
		expect(() => f.vault.describe(reference, owner)).toThrow(CredentialError);
		expect(() => f.store.write((tx) => other.describeInTransaction(tx, reference, owner))).toThrow(
			CredentialError,
		);
		const seen: CredentialValue[] = [];
		const queued = (["send", "read"] as const).map((requestClass) =>
			other.withCredential(reference, owner, { requestClass }, (value) => {
				seen.push(value);
			}),
		);
		pending.gate.resolve(rotated);
		await expect(refreshing).resolves.toEqual(rotated);
		await Promise.all(queued);
		expect(seen).toEqual([rotated, rotated]);
		expect(pending.state.calls).toBe(1);
	});
	it("restores the previous value after a temporary failure and fails the callers waiting on it", async () => {
		const { f, until } = await clocked(),
			owner = gmail(),
			current = until(10 * MINUTE),
			reference = f.create(owner, current),
			pending = exchange();
		const request = {
			requestClass: "read" as const,
			refresh: pending.refresh,
			refreshAheadMs: WINDOW,
		};
		let uses = 0;
		const callers = [0, 1, 2].map(() =>
			f.vault
				.withCredential(reference, owner, request, () => {
					uses++;
				})
				.catch((error: unknown) => error),
		);
		await pending.started.promise;
		pending.gate.reject(new CredentialRefreshError("temporary"));
		for (const result of await Promise.all(callers)) {
			expect(result).toBeInstanceOf(CredentialError);
			expect(result).toMatchObject({ message: "Credential unavailable" });
			expect(result).not.toHaveProperty("cause");
		}
		expect(pending.state.calls).toBe(1);
		expect(uses).toBe(0);
		const row = f.row(reference);
		expect(row).toMatchObject({ status: "active", generation: 3 });
		expect(unsealWith(f.key, row?.value as Uint8Array, reference, owner, 3)).toEqual(current);
		expect(audited(f).slice(-2)).toEqual([
			"credential.refresh_started/hub",
			"credential.restored/hub",
		]);
		await expect(
			f.vault.withCredential(reference, owner, { requestClass: "read" }, (value, use) => [
				value,
				use.generation,
			]),
		).resolves.toEqual([current, 3]);
		const rotated = until(60 * MINUTE);
		await expect(
			f.vault.withCredential(
				reference,
				owner,
				{ requestClass: "read", refresh: async () => rotated, refreshAheadMs: WINDOW },
				(value, use) => [value, use.generation],
			),
		).resolves.toEqual([rotated, 4]);
	});
	it("revokes the credential when the adapter reports invalid_grant", async () => {
		const { f, until } = await clocked(),
			owner = gmail(),
			reference = f.create(owner, until(0)),
			pending = exchange();
		const callers = [0, 1].map(() =>
			f.vault
				.withCredential(
					reference,
					owner,
					{ requestClass: "read", refresh: pending.refresh },
					() => "unsafe",
				)
				.catch((error: unknown) => error),
		);
		await pending.started.promise;
		pending.gate.reject(new CredentialRefreshError("invalid_grant"));
		for (const result of await Promise.all(callers)) expect(result).toBeInstanceOf(CredentialError);
		expect(pending.state.calls).toBe(1);
		expect(f.row(reference)).toMatchObject({ status: "revoked", value: null, generation: 3 });
		expect(audited(f).slice(-2)).toEqual([
			"credential.refresh_started/hub",
			"credential.revoked/hub",
		]);
		const vault = f.open(f.reopen());
		expect(f.row(reference)).toMatchObject({ status: "revoked", value: null, generation: 3 });
		expect(() => vault.describe(reference, owner)).toThrow(CredentialError);
		const replacement = until(60 * MINUTE);
		f.store.write((tx) => vault.replaceInTransaction(tx, reference, owner, replacement));
		await expect(
			vault.withCredential(reference, owner, { requestClass: "read" }, (value) => value),
		).resolves.toEqual(replacement);
	});
	it("keeps interrupted refreshes unavailable across reopens until authorized replacement", async () => {
		const { f, until, advance, waits } = await clocked();
		const entry = () => {
			const owner = gmail(),
				value = until(10 * MINUTE);
			return { owner, value, reference: f.create(owner, value) };
		};
		type Entry = ReturnType<typeof entry>;
		const attempt = (target: Entry, refresh: CredentialRefresh, signal?: AbortSignal) =>
			f.vault
				.withCredential(
					target.reference,
					target.owner,
					{
						requestClass: "read",
						refresh,
						refreshAheadMs: WINDOW,
						...(signal === undefined ? {} : { signal }),
					},
					() => "unsafe",
				)
				.catch((error: unknown) => error);
		const failed = entry(),
			canceled = entry(),
			timedOut = entry(),
			hung = entry(),
			tampered = entry();
		const failure: CredentialRefresh = async () => {
			throw new Error(canary());
		};
		expect(await attempt(failed, failure)).toBeInstanceOf(CredentialError);
		expect(await attempt(tampered, failure)).toBeInstanceOf(CredentialError);
		const external = new AbortController(),
			cancel = exchange();
		const cancelling = attempt(canceled, cancel.refresh, external.signal);
		await cancel.started.promise;
		external.abort();
		expect(await cancelling).toBeInstanceOf(CredentialError);
		// The exchange outlives its caller, and its unclassified failure keeps the value.
		cancel.gate.reject(new Error(canary()));
		const slow = exchange();
		const timing = attempt(timedOut, slow.refresh);
		await slow.started.promise;
		advance(CREDENTIAL_REFRESH_TIMEOUT_MS);
		expect(await timing).toBeInstanceOf(CredentialError);
		const stuck = exchange();
		const hanging = attempt(hung, stuck.refresh);
		await stuck.started.promise;
		for (const target of [failed, canceled, timedOut, hung, tampered]) {
			expect(keptValue(f, target.reference, target.owner)).toEqual(target.value);
			expect(() => f.vault.describe(target.reference, target.owner)).toThrow(CredentialError);
		}
		for (const target of [failed, canceled, timedOut, tampered])
			await expect(
				f.vault.withCredential(target.reference, target.owner, { requestClass: "read" }, (v) => v),
			).rejects.toThrow(CredentialError);
		f.raw((tx) => {
			tx.run("UPDATE main.credentials SET value=? WHERE id=?", [
				sealWith(f.key, tampered.reference, tampered.owner, 1, tampered.value),
				tampered.reference,
			]);
		});
		// Neither another facade nor a new store open can classify the interrupted result.
		f.open();
		for (const target of [failed, canceled, timedOut, hung, tampered])
			expect(f.row(target.reference)).toMatchObject({ status: "refreshing", generation: 2 });
		const before = f.actions().length,
			vault = f.open(f.reopen());
		for (const target of [failed, canceled, timedOut, hung]) {
			const row = f.row(target.reference);
			expect(row).toMatchObject({ status: "refreshing", generation: 2 });
			expect(
				unsealWith(f.key, row?.value as Uint8Array, target.reference, target.owner, 2),
			).toEqual(target.value);
			for (const requestClass of ["read", "send"] as const)
				await expect(
					vault.withCredential(target.reference, target.owner, { requestClass }, () => "unsafe"),
				).rejects.toThrow(CredentialError);
		}
		expect(f.row(tampered.reference)).toMatchObject({ status: "refreshing", generation: 2 });
		expect(() => vault.describe(tampered.reference, tampered.owner)).toThrow(CredentialError);
		expect(f.actions()).toHaveLength(before);
		stuck.gate.resolve(until(60 * MINUTE));
		expect(await hanging).toBeInstanceOf(CredentialError);
		expect(f.row(hung.reference)).toMatchObject({ status: "refreshing", generation: 2 });
		expect(waits.size).toBe(0);
		const count = f.actions().length;
		f.open(f.reopen());
		expect(f.actions()).toHaveLength(count);
		expect(f.row(tampered.reference)).toMatchObject({ status: "refreshing", generation: 2 });
		const replacementVault = f.open();
		for (const target of [failed, canceled, timedOut, hung]) {
			const replacement = until(60 * MINUTE);
			f.store.write((tx) =>
				replacementVault.replaceInTransaction(tx, target.reference, target.owner, replacement),
			);
			await expect(
				replacementVault.withCredential(
					target.reference,
					target.owner,
					{ requestClass: "read" },
					(value, use) => [value, use.generation],
				),
			).resolves.toEqual([replacement, 3]);
		}
		f.store.read((db) => f.audit.verify(db));
	});
	it.each([
		["a plain object", () => ({ failure: "temporary" })],
		[
			"an object on the class prototype",
			() =>
				Object.create(CredentialRefreshError.prototype, {
					failure: { value: "temporary", enumerable: true },
				}),
		],
		["a proxy of a classified error", () => new Proxy(new CredentialRefreshError("temporary"), {})],
		[
			"an error that names the class",
			() =>
				Object.assign(new Error("temporary"), {
					name: "CredentialRefreshError",
					failure: "temporary",
				}),
		],
	])("treats %s as an unclassified failure", async (_, thrown) => {
		const f = await vaultFixture(),
			owner = gmail(),
			current = token(),
			reference = f.create(owner, current);
		const failure = await f.vault
			.withCredential(
				reference,
				owner,
				{
					requestClass: "read",
					refresh: async () => {
						throw thrown();
					},
				},
				() => "unsafe",
			)
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(CredentialError);
		expect(failure).not.toHaveProperty("cause");
		expect(keptValue(f, reference, owner)).toEqual(current);
		expect(f.actions().map(({ action }) => action)).not.toContain("credential.restored");
	});
	it("names only the two classified failures", () => {
		for (const failure of ["temporary", "invalid_grant"] as const) {
			const error = new CredentialRefreshError(failure);
			expect(error.failure).toBe(failure);
			expect(error.message).toBe("Credential refresh failed");
		}
		for (const failure of ["Temporary", "expired", "", undefined])
			expect(() => new CredentialRefreshError(failure as CredentialRefreshFailure)).toThrow(
				TypeError,
			);
	});
	it.each(["revoke", "disconnect", "delete", "replace", "purge"] as const)(
		"never lets a classified failure undo a %s during the exchange",
		async (change) => {
			for (const failure of ["temporary", "invalid_grant"] as const) {
				const f = await vaultFixture(),
					owner = gmail(),
					reference = f.create(owner, token()),
					pending = exchange();
				const result = f.vault
					.withCredential(
						reference,
						owner,
						{ requestClass: "read", refresh: pending.refresh },
						() => "unsafe",
					)
					.catch((error: unknown) => error);
				await pending.started.promise;
				f.store.write((tx) => {
					if (change === "replace")
						f.vault.replaceInTransaction(tx, reference, owner, token(Date.now() + MINUTE));
					else if (change === "purge") f.vault.purgeInTransaction(tx, reference, owner);
					else f.vault.invalidateInTransaction(tx, reference, owner, change);
				});
				const changed = f.row(reference),
					count = f.actions().length;
				pending.gate.reject(new CredentialRefreshError(failure));
				expect(await result).toBeInstanceOf(CredentialError);
				expect(f.row(reference)).toEqual(changed);
				expect(f.actions()).toHaveLength(count);
			}
		},
	);
	it.each(["answer", "temporary", "invalid_grant", "time limit"] as const)(
		"finishes the exchange of a caller that stopped waiting (%s)",
		async (outcome) => {
			const { f, until, advance } = await clocked(),
				owner = gmail(),
				current = until(0),
				reference = f.create(owner, current),
				pending = exchange(),
				external = new AbortController(),
				rotated = until(60 * MINUTE);
			let signal: AbortSignal | undefined;
			const caller = f.vault
				.withCredential(
					reference,
					owner,
					{
						requestClass: "read",
						signal: external.signal,
						refresh: (value, context) => {
							signal = context.signal;
							return pending.refresh(value, context);
						},
					},
					() => "unsafe",
				)
				.catch((error: unknown) => error);
			await pending.started.promise;
			external.abort();
			expect(await caller).toBeInstanceOf(CredentialError);
			expect(signal?.aborted).toBe(false);
			const waiter = f.vault
				.withCredential(reference, owner, { requestClass: "read" }, (value, use) => [
					value,
					use.generation,
				])
				.catch((error: unknown) => error);
			if (outcome === "answer") pending.gate.resolve(rotated);
			else if (outcome === "time limit") advance(CREDENTIAL_REFRESH_TIMEOUT_MS);
			else pending.gate.reject(new CredentialRefreshError(outcome));
			const result = await waiter;
			expect(pending.state.calls).toBe(1);
			if (outcome === "answer") {
				expect(result).toEqual([rotated, 2]);
				expect(audited(f).slice(-2)).toEqual([
					"credential.refresh_started/hub",
					"credential.refreshed/hub",
				]);
				return;
			}
			expect(result).toBeInstanceOf(CredentialError);
			if (outcome === "temporary") {
				const row = f.row(reference);
				expect(row).toMatchObject({ status: "active", generation: 3 });
				expect(unsealWith(f.key, row?.value as Uint8Array, reference, owner, 3)).toEqual(current);
				expect(audited(f).at(-1)).toBe("credential.restored/hub");
			} else if (outcome === "invalid_grant") {
				expect(f.row(reference)).toMatchObject({ status: "revoked", value: null, generation: 3 });
				expect(audited(f).at(-1)).toBe("credential.revoked/hub");
			} else {
				expect(signal?.aborted).toBe(true);
				expect(keptValue(f, reference, owner)).toEqual(current);
				expect(audited(f).at(-1)).toBe("credential.refresh_started/hub");
			}
		},
	);
	it("ends a destroyed facade's exchange and refuses its kept value after reopen", async () => {
		const { f, until } = await clocked(),
			owner = gmail(),
			current = until(10 * MINUTE),
			reference = f.create(owner, current),
			pending = exchange(),
			external = new AbortController(),
			vault = f.open();
		let signal: AbortSignal | undefined;
		const caller = vault
			.withCredential(
				reference,
				owner,
				{
					requestClass: "read",
					signal: external.signal,
					refreshAheadMs: WINDOW,
					refresh: (value, context) => {
						signal = context.signal;
						return pending.refresh(value, context);
					},
				},
				() => "unsafe",
			)
			.catch((error: unknown) => error);
		await pending.started.promise;
		external.abort();
		expect(await caller).toBeInstanceOf(CredentialError);
		expect(signal?.aborted).toBe(false);
		vault.destroy();
		expect(signal?.aborted).toBe(true);
		pending.gate.resolve(until(60 * MINUTE));
		await expect(
			f.vault.withCredential(reference, owner, { requestClass: "read" }, (value) => value),
		).rejects.toThrow(CredentialError);
		expect(keptValue(f, reference, owner)).toEqual(current);
		const reopened = f.open(f.reopen());
		await expect(
			reopened.withCredential(reference, owner, { requestClass: "read" }, (value, use) => [
				value,
				use.generation,
			]),
		).rejects.toThrow(CredentialError);
		expect(f.row(reference)).toMatchObject({ status: "refreshing", generation: 2 });
		const replacement = until(60 * MINUTE);
		f.store.write((tx) => reopened.replaceInTransaction(tx, reference, owner, replacement));
		await expect(
			reopened.withCredential(reference, owner, { requestClass: "read" }, (value, use) => [
				value,
				use.generation,
			]),
		).resolves.toEqual([replacement, 3]);
	});
	it("leaves a row that changed outside this vault during the exchange as it is", async () => {
		for (const failure of ["temporary", "invalid_grant"] as const) {
			const f = await vaultFixture(),
				owner = gmail(),
				reference = f.create(owner, token()),
				pending = exchange();
			const result = f.vault
				.withCredential(
					reference,
					owner,
					{ requestClass: "read", refresh: pending.refresh },
					() => "unsafe",
				)
				.catch((error: unknown) => error);
			await pending.started.promise;
			f.raw((tx) => {
				tx.run(
					"UPDATE main.credentials SET generation=generation+1,status='disconnected',value=NULL WHERE id=?",
					[reference],
				);
			});
			const changed = f.row(reference),
				count = f.actions().length;
			pending.gate.reject(new CredentialRefreshError(failure));
			expect(await result).toBeInstanceOf(CredentialError);
			expect(f.row(reference)).toEqual(changed);
			expect(f.actions()).toHaveLength(count);
		}
	});
});
