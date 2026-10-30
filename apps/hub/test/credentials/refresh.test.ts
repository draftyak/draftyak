import { afterEach, describe, expect, it } from "vitest";
import {
	CREDENTIAL_REFRESH_TIMEOUT_MS,
	type CredentialBinding,
	CredentialError,
	CredentialRefreshError,
	type CredentialUse,
	type CredentialValue,
	MAX_REFRESH_AHEAD_MS,
} from "../../src/credentials/vault.ts";
import type { TimerClock } from "../../src/kernel/clock.ts";
import {
	canary,
	cleanupFixtures,
	deferred,
	fakeClock,
	gmail,
	keptValue,
	keyValue,
	slack,
	token,
	vaultFixture,
} from "./helpers.ts";

afterEach(cleanupFixtures);
const MINUTE = 60_000;
async function clocked() {
	const time = fakeClock();
	const f = await vaultFixture({ clock: time.clock });
	const until = (ms: number) => token(time.state.wall + ms);
	return { ...time, f, until };
}
const counting = (next: () => CredentialValue) => {
	const adapter = {
		calls: 0,
		refresh: async (): Promise<CredentialValue> => {
			adapter.calls++;
			return next();
		},
	};
	return adapter;
};

describe("early refresh on an injected clock", () => {
	it("refreshes a read inside its window and leaves values outside it alone", async () => {
		const { f, until, advance } = await clocked(),
			owner = gmail(),
			current = until(20 * MINUTE),
			reference = f.create(owner, current),
			rotated = until(60 * MINUTE),
			adapter = counting(() => rotated);
		const read = (refreshAheadMs?: number) =>
			f.vault.withCredential(
				reference,
				owner,
				{
					requestClass: "read",
					refresh: adapter.refresh,
					...(refreshAheadMs === undefined ? {} : { refreshAheadMs }),
				},
				(value, use) => ({ value, generation: use.generation }),
			);
		await expect(read()).resolves.toEqual({ value: current, generation: 1 });
		await expect(read(15 * MINUTE)).resolves.toEqual({ value: current, generation: 1 });
		advance(5 * MINUTE);
		await expect(read(15 * MINUTE)).resolves.toEqual({ value: rotated, generation: 2 });
		expect(adapter.calls).toBe(1);
		await expect(read(15 * MINUTE)).resolves.toEqual({ value: rotated, generation: 2 });
		expect(adapter.calls).toBe(1);
	});
	it("never refreshes a send or a read without an adapter, and expires them on the clock", async () => {
		const { f, state, advance } = await clocked(),
			owner = slack(),
			stored: CredentialValue = {
				kind: "slack-token",
				accessToken: canary(),
				expiresAt: state.wall + 10 * MINUTE,
			},
			reference = f.create(owner, stored),
			adapter = counting(() => ({
				kind: "slack-token",
				accessToken: canary(),
				expiresAt: state.wall + 60 * MINUTE,
			}));
		const use = (request: Record<string, unknown>) =>
			f.vault.withCredential(reference, owner, request as never, (current) => current);
		await expect(
			use({ requestClass: "send", refresh: adapter.refresh, refreshAheadMs: 30 * MINUTE }),
		).rejects.toThrow(CredentialError);
		await expect(use({ requestClass: "send", refresh: adapter.refresh })).resolves.toEqual(stored);
		await expect(use({ requestClass: "read", refreshAheadMs: 30 * MINUTE })).resolves.toEqual(
			stored,
		);
		advance(10 * MINUTE - 1);
		await expect(use({ requestClass: "send" })).resolves.toEqual(stored);
		advance(1);
		await expect(use({ requestClass: "send", refresh: adapter.refresh })).rejects.toThrow(
			CredentialError,
		);
		await expect(use({ requestClass: "read" })).rejects.toThrow(CredentialError);
		expect(adapter.calls).toBe(0);
		expect(f.vault.describe(reference, owner).generation).toBe(1);
		await expect(use({ requestClass: "read", refresh: adapter.refresh })).resolves.toMatchObject({
			kind: "slack-token",
		});
		expect(adapter.calls).toBe(1);
	});
	it("refuses malformed windows and refreshed values that are already expired", async () => {
		const { f, until } = await clocked(),
			owner = gmail(),
			current = until(MINUTE),
			reference = f.create(owner, current),
			adapter = counting(() => until(0));
		for (const refreshAheadMs of [-1, 0.5, MAX_REFRESH_AHEAD_MS + 1, "60000", Number.NaN, null])
			await expect(
				f.vault.withCredential(
					reference,
					owner,
					{ requestClass: "read", refresh: adapter.refresh, refreshAheadMs } as never,
					() => "unsafe",
				),
			).rejects.toThrow(CredentialError);
		expect(adapter.calls).toBe(0);
		await expect(
			f.vault.withCredential(
				reference,
				owner,
				{ requestClass: "read", refresh: adapter.refresh, refreshAheadMs: MAX_REFRESH_AHEAD_MS },
				() => "unsafe",
			),
		).rejects.toThrow(CredentialError);
		expect(adapter.calls).toBe(1);
		expect(f.row(reference)).toMatchObject({ status: "refreshing", generation: 2 });
		expect(keptValue(f, reference, owner)).toEqual(current);
	});
	it.each(["installed", "restored"] as const)(
		"lets a use of a value that has not expired run on while an early refresh is %s",
		async (outcome) => {
			const { f, until } = await clocked(),
				owner = gmail(),
				reference = f.create(owner, until(20 * MINUTE)),
				started = deferred<void>(),
				gate = deferred<void>(),
				rotated = until(60 * MINUTE);
			let use: CredentialUse | undefined;
			let finished = false;
			const sending = f.vault
				.withCredential(reference, owner, { requestClass: "send" }, async (_, context) => {
					use = context;
					started.resolve();
					await gate.promise;
					finished = true;
				})
				.catch((error: unknown) => error);
			await started.promise;
			const read = await f.vault
				.withCredential(
					reference,
					owner,
					{
						requestClass: "read",
						refreshAheadMs: 30 * MINUTE,
						refresh: async () => {
							if (outcome === "restored") throw new CredentialRefreshError("temporary");
							return rotated;
						},
					},
					(value, context) => [value, context.generation],
				)
				.catch((error: unknown) => error);
			if (outcome === "installed") expect(read).toEqual([rotated, 2]);
			else {
				expect(read).toBeInstanceOf(CredentialError);
				expect(f.row(reference)).toMatchObject({ status: "active", generation: 3 });
			}
			expect(use?.signal.aborted).toBe(false);
			gate.resolve();
			// The use runs to its end; its result then fails the generation check.
			expect(await sending).toBeInstanceOf(CredentialError);
			expect(finished).toBe(true);
		},
	);
	it("ends uses of a value that has not expired when an early refresh gets invalid_grant", async () => {
		const { f, until } = await clocked(),
			owner = gmail(),
			reference = f.create(owner, until(20 * MINUTE)),
			started = deferred<void>(),
			gate = deferred<void>();
		let use: CredentialUse | undefined;
		let finished = false;
		const sending = f.vault
			.withCredential(reference, owner, { requestClass: "send" }, async (_, context) => {
				use = context;
				started.resolve();
				await gate.promise;
				finished = true;
			})
			.catch((error: unknown) => error);
		await started.promise;
		await expect(
			f.vault.withCredential(
				reference,
				owner,
				{
					requestClass: "read",
					refreshAheadMs: 30 * MINUTE,
					refresh: async () => {
						throw new CredentialRefreshError("invalid_grant");
					},
				},
				() => "unsafe",
			),
		).rejects.toThrow(CredentialError);
		expect(f.row(reference)).toMatchObject({ status: "revoked", value: null, generation: 3 });
		expect(use?.signal.aborted).toBe(true);
		// The revoke ends the use at once, before it reaches its end.
		expect(await sending).toBeInstanceOf(CredentialError);
		expect(finished).toBe(false);
		gate.resolve();
	});
	it("still ends uses of a value that has expired when its refresh starts", async () => {
		const { f, until, advance } = await clocked(),
			owner = gmail(),
			reference = f.create(owner, until(MINUTE)),
			started = deferred<void>(),
			gate = deferred<void>(),
			rotated = until(60 * MINUTE);
		let use: CredentialUse | undefined;
		const reading = f.vault
			.withCredential(reference, owner, { requestClass: "read" }, async (_, context) => {
				use = context;
				started.resolve();
				await gate.promise;
				return "late";
			})
			.catch((error: unknown) => error);
		await started.promise;
		advance(MINUTE);
		await expect(
			f.vault.withCredential(
				reference,
				owner,
				{ requestClass: "read", refresh: async () => rotated },
				(value) => value,
			),
		).resolves.toEqual(rotated);
		expect(use?.signal.aborted).toBe(true);
		expect(await reading).toBeInstanceOf(CredentialError);
		gate.resolve();
	});
});

describe("refresh failures and limits", () => {
	it("ends a refresh that never settles at its time limit and releases the credential", async () => {
		const { f, until, advance, waits } = await clocked(),
			owner = gmail(),
			current = until(0),
			reference = f.create(owner, current),
			started = deferred<void>();
		let signal: AbortSignal | undefined;
		const late = deferred<CredentialValue>();
		const hung = f.vault.withCredential(
			reference,
			owner,
			{
				requestClass: "read",
				refresh: (_, context) => {
					signal = context.signal;
					started.resolve();
					return late.promise;
				},
			},
			() => "unsafe",
		);
		let settled = false;
		const outcome = hung.then(
			() => "resolved",
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		await started.promise;
		const queued = counting(() => until(60 * MINUTE));
		const waiter = f.vault
			.withCredential(
				reference,
				owner,
				{ requestClass: "read", refresh: queued.refresh },
				() => "unsafe",
			)
			.catch((error: unknown) => error);
		expect(waits.size).toBe(1);
		advance(CREDENTIAL_REFRESH_TIMEOUT_MS - 1);
		await new Promise((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		expect(signal?.aborted).toBe(false);
		advance(1);
		await expect(outcome).resolves.toBeInstanceOf(CredentialError);
		expect(signal?.aborted).toBe(true);
		await expect(waiter).resolves.toBeInstanceOf(CredentialError);
		expect(queued.calls).toBe(0);
		late.resolve(until(60 * MINUTE));
		await new Promise((resolve) => setImmediate(resolve));
		expect(f.row(reference)).toMatchObject({ status: "refreshing", generation: 2 });
		expect(keptValue(f, reference, owner)).toEqual(current);
		expect(waits.size).toBe(0);
	});
	it("keeps the time limit when the wall clock moves back", async () => {
		const { f, until, advance, state } = await clocked(),
			owner = gmail(),
			current = until(0),
			reference = f.create(owner, current),
			started = deferred<void>();
		const hung = f.vault
			.withCredential(
				reference,
				owner,
				{
					requestClass: "read",
					refresh: () => {
						started.resolve();
						return new Promise<CredentialValue>(() => undefined);
					},
				},
				() => "unsafe",
			)
			.catch((error: unknown) => error);
		await started.promise;
		state.wall -= 3_600_000;
		advance(CREDENTIAL_REFRESH_TIMEOUT_MS);
		await expect(hung).resolves.toBeInstanceOf(CredentialError);
		expect(f.row(reference)).toMatchObject({ status: "refreshing", generation: 2 });
		expect(keptValue(f, reference, owner)).toEqual(current);
	});
	it("keeps the time limit on the wall clock when the monotonic clock stalls", async () => {
		const { f, until, state, fire } = await clocked(),
			owner = gmail(),
			current = until(0),
			reference = f.create(owner, current),
			started = deferred<void>();
		let signal: AbortSignal | undefined;
		const hung = f.vault
			.withCredential(
				reference,
				owner,
				{
					requestClass: "read",
					refresh: (_, context) => {
						signal = context.signal;
						started.resolve();
						return new Promise<CredentialValue>(() => undefined);
					},
				},
				() => "unsafe",
			)
			.catch((error: unknown) => error);
		await started.promise;
		state.wall += CREDENTIAL_REFRESH_TIMEOUT_MS - 1;
		fire();
		await new Promise((resolve) => setImmediate(resolve));
		expect(signal?.aborted).toBe(false);
		state.wall += 1;
		fire();
		await new Promise((resolve) => setImmediate(resolve));
		expect(signal?.aborted).toBe(true);
		await expect(hung).resolves.toBeInstanceOf(CredentialError);
		expect(keptValue(f, reference, owner)).toEqual(current);
		await expect(
			f.vault.withCredential(reference, owner, { requestClass: "read" }, () => "unsafe"),
		).rejects.toThrow(CredentialError);
	});
	it.each(["after", "wallMs", "monotonicMs"] as const)(
		"ends the exchange when the clock's %s fails during it",
		async (part) => {
			const time = fakeClock();
			let broken = false;
			const clock: TimerClock = {
				wallMs: () => {
					if (broken && part === "wallMs") throw new Error(canary());
					return time.state.wall;
				},
				monotonicMs: () => {
					if (broken && part === "monotonicMs") throw new Error(canary());
					return time.state.mono;
				},
				after: (ms, signal) =>
					broken && part === "after"
						? Promise.reject(new Error(canary()))
						: time.clock.after(ms, signal),
			};
			const f = await vaultFixture({ clock }),
				owner = gmail(),
				current = token(time.state.wall),
				reference = f.create(owner, current),
				started = deferred<void>();
			let signal: AbortSignal | undefined;
			const hung = f.vault
				.withCredential(
					reference,
					owner,
					{
						requestClass: "read",
						refresh: (_, context) => {
							signal = context.signal;
							started.resolve();
							return new Promise<CredentialValue>(() => undefined);
						},
					},
					() => "unsafe",
				)
				.catch((error: unknown) => error);
			await started.promise;
			broken = true;
			time.fire();
			await new Promise((resolve) => setImmediate(resolve));
			expect(signal?.aborted).toBe(true);
			await expect(hung).resolves.toBeInstanceOf(CredentialError);
			broken = false;
			expect(keptValue(f, reference, owner)).toEqual(current);
			await expect(
				f.vault.withCredential(reference, owner, { requestClass: "read" }, () => "unsafe"),
			).rejects.toThrow(CredentialError);
			expect(time.waits.size).toBe(0);
		},
	);
	it("fails every caller queued behind a failing refresh and runs the adapter once", async () => {
		const f = await vaultFixture(),
			owner = gmail(),
			current = token(),
			reference = f.create(owner, current),
			started = deferred<void>(),
			gate = deferred<CredentialValue>();
		let calls = 0;
		const request = {
			requestClass: "read" as const,
			refresh: async () => {
				calls++;
				started.resolve();
				return gate.promise;
			},
		};
		let uses = 0;
		const callers = [0, 1, 2].map(() =>
			f.vault
				.withCredential(reference, owner, request, () => {
					uses++;
				})
				.catch((error: unknown) => error),
		);
		await started.promise;
		gate.reject(new Error(canary()));
		for (const result of await Promise.all(callers)) {
			expect(result).toBeInstanceOf(CredentialError);
			expect(result).not.toHaveProperty("cause");
		}
		expect(calls).toBe(1);
		expect(uses).toBe(0);
		expect(keptValue(f, reference, owner)).toEqual(current);
	});
	it("lets two credentials refresh at the same time", async () => {
		const f = await vaultFixture(),
			first = gmail(),
			second = gmail(),
			firstRef = f.create(first, token()),
			secondRef = f.create(second, token()),
			firstStarted = deferred<void>(),
			firstGate = deferred<CredentialValue>(),
			rotated = token(Date.now() + 60 * MINUTE);
		const pending = f.vault.withCredential(
			firstRef,
			first,
			{
				requestClass: "read",
				refresh: async () => {
					firstStarted.resolve();
					return firstGate.promise;
				},
			},
			(value) => value,
		);
		await firstStarted.promise;
		await expect(
			f.vault.withCredential(
				secondRef,
				second,
				{ requestClass: "read", refresh: async () => rotated },
				(value) => value,
			),
		).resolves.toEqual(rotated);
		const last = token(Date.now() + 60 * MINUTE);
		firstGate.resolve(last);
		await expect(pending).resolves.toEqual(last);
	});
	it.each([
		["a value of another kind", () => keyValue()],
		["an extra key", () => ({ ...token(Date.now() + MINUTE), scope: "DYTEST" })],
		[
			"a missing key",
			() => ({ kind: "gmail-oauth", accessToken: canary(), expiresAt: Date.now() + MINUTE }),
		],
		["a control character", () => ({ ...token(Date.now() + MINUTE), accessToken: "DYTEST\n" })],
		["an expiry in the past", () => token(Date.now() - 1)],
		["a non-object", () => "DYTEST"],
	])("installs no refreshed value with %s", async (_, next) => {
		const f = await vaultFixture(),
			owner: CredentialBinding = gmail(),
			current = token(),
			reference = f.create(owner, current);
		const failure = await f.vault
			.withCredential(
				reference,
				owner,
				{ requestClass: "read", refresh: async () => next() as CredentialValue },
				() => "unsafe",
			)
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(CredentialError);
		expect(failure).toMatchObject({ message: "Credential unavailable" });
		expect(failure).not.toHaveProperty("cause");
		expect(f.row(reference)).toMatchObject({ status: "refreshing", generation: 2 });
		expect(keptValue(f, reference, owner)).toEqual(current);
	});
	it("never reads an accessor on a refreshed value", async () => {
		const f = await vaultFixture(),
			owner = gmail(),
			reference = f.create(owner, token());
		let reads = 0;
		const value = Object.defineProperty(
			{ kind: "gmail-oauth", accessToken: canary(), refreshToken: canary() },
			"expiresAt",
			{
				get() {
					reads++;
					return Date.now() + MINUTE;
				},
				enumerable: true,
			},
		);
		await expect(
			f.vault.withCredential(
				reference,
				owner,
				{ requestClass: "read", refresh: async () => value as CredentialValue },
				() => "unsafe",
			),
		).rejects.toThrow(CredentialError);
		expect(reads).toBe(0);
		expect(f.row(reference)?.status).toBe("refreshing");
	});
});
