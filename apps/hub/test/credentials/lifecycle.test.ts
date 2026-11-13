import { addAbortListener } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CredentialActor,
	type CredentialBinding,
	CredentialError,
	type CredentialOwner,
	CredentialRefreshError,
	type CredentialUse,
	type CredentialValue,
} from "../../src/credentials/vault.ts";
import type { TimerClock } from "../../src/kernel/clock.ts";
import { newId } from "../../src/kernel/ids.ts";
import type { SqlTransaction } from "../../src/store/store.ts";
import {
	appValue,
	cleanupFixtures,
	deferred,
	fakeClock,
	gmail,
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
const ownerOf = (binding: CredentialBinding): CredentialOwner => ({
	ownerKind: binding.ownerKind,
	ownerId: binding.ownerId,
});

describe("credential vault drain", () => {
	const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
	const refused = (work: Promise<unknown>): Promise<boolean> =>
		work.then(
			() => false,
			(error: unknown) =>
				error instanceof CredentialError && error.code === "CREDENTIAL_UNAVAILABLE",
		);
	it.each(["fulfilled", "rejected"] as const)(
		"joins an original %s use callback after its caller stops waiting",
		async (outcome) => {
			const f = await vaultFixture(),
				owner = provider(),
				reference = f.create(owner, keyValue()),
				caller = new AbortController(),
				entered = deferred<void>(),
				release = deferred<void>(),
				finished = deferred<void>();
			let calls = 0,
				context: CredentialUse | undefined,
				state = "pending";
			const pending = f.vault.withCredential(
				reference,
				owner,
				{ requestClass: "read", signal: caller.signal },
				async (_, current) => {
					calls++;
					context = current;
					entered.resolve();
					try {
						await release.promise;
						if (outcome === "rejected") throw new Error("DYTEST late callback failure");
						return "DYTEST late result";
					} finally {
						finished.resolve();
					}
				},
			);
			const rejection = refused(pending);
			let draining: Promise<void> | undefined;
			try {
				await entered.promise;
				caller.abort();
				expect(await rejection).toBe(true);
				expect(context?.signal.aborted).toBe(true);
				const auditCount = f.actions().length;
				draining = f.vault.drain();
				expect(f.vault.drain()).toBe(draining);
				const completion = draining.then(
					() => {
						state = "closed";
					},
					() => {
						state = "failed";
					},
				);
				await turn();
				expect(state).toBe("pending");
				release.resolve();
				await finished.promise;
				await completion;
				expect(state).toBe("closed");
				expect(calls).toBe(1);
				expect(f.row(reference)?.status).toBe("active");
				expect(f.row(reference)?.generation).toBe(1);
				expect(f.actions().length).toBe(auditCount);
				expect(() => f.vault.describe(reference, owner)).toThrow(CredentialError);
				expect(
					await refused(
						f.vault.withCredential(reference, owner, { requestClass: "read" }, () => {
							calls++;
						}),
					),
				).toBe(true);
				expect(calls).toBe(1);
			} finally {
				caller.abort();
				f.vault.destroy();
				release.resolve();
				if (calls) await finished.promise;
				await Promise.allSettled([pending, draining ?? f.vault.drain()]);
			}
		},
	);
	it.each(["refresh-first", "timer-first"] as const)(
		"joins the original refresh and timer finally independently: %s",
		async (order) => {
			const time = fakeClock(),
				refreshEntered = deferred<void>(),
				refreshRelease = deferred<void>(),
				refreshDone = deferred<void>(),
				timerEntered = deferred<void>(),
				timerAborted = deferred<void>(),
				timerRelease = deferred<void>(),
				timerDone = deferred<void>();
			let refreshCalls = 0,
				timerCalls = 0,
				uses = 0,
				exchange: CredentialUse | undefined,
				state = "pending";
			const clock: TimerClock = {
				wallMs: time.clock.wallMs,
				monotonicMs: time.clock.monotonicMs,
				after: async (_, signal) => {
					timerCalls++;
					const aborted = deferred<void>();
					let listener: Disposable | undefined;
					try {
						timerEntered.resolve();
						if (!signal) throw new Error("DYTEST missing timer signal");
						listener = addAbortListener(signal, () => aborted.resolve());
						if (signal.aborted) aborted.resolve();
						await aborted.promise;
						timerAborted.resolve();
						await timerRelease.promise;
						throw new Error("DYTEST stopped timer");
					} finally {
						listener?.[Symbol.dispose]();
						timerDone.resolve();
					}
				},
			};
			const f = await vaultFixture({ clock }),
				owner = gmail(),
				reference = f.create(owner, token(time.state.wall - 1)),
				rotated = token(time.state.wall + 3_600_000),
				caller = new AbortController();
			const pending = f.vault.withCredential(
				reference,
				owner,
				{
					requestClass: "read",
					signal: caller.signal,
					refresh: async (_, current) => {
						refreshCalls++;
						exchange = current;
						refreshEntered.resolve();
						try {
							await refreshRelease.promise;
							if (order === "timer-first") throw new CredentialRefreshError("temporary");
							return rotated;
						} finally {
							refreshDone.resolve();
						}
					},
				},
				() => {
					uses++;
				},
			);
			const rejection = refused(pending);
			let queued: Promise<unknown> | undefined, draining: Promise<void> | undefined;
			try {
				await refreshEntered.promise;
				await timerEntered.promise;
				queued = f.vault.withCredential(reference, owner, { requestClass: "read" }, () => {
					uses++;
				});
				const queuedRejection = refused(queued);
				caller.abort();
				expect(await rejection).toBe(true);
				expect(exchange?.signal.aborted).toBe(false);
				const kept = f.row(reference)?.value,
					auditCount = f.actions().length;
				draining = f.vault.drain();
				expect(f.vault.drain()).toBe(draining);
				const completion = draining.then(
					() => {
						state = "closed";
					},
					() => {
						state = "failed";
					},
				);
				expect(await queuedRejection).toBe(true);
				await timerAborted.promise;
				expect(exchange?.signal.aborted).toBe(true);
				await turn();
				expect(state).toBe("pending");
				if (order === "refresh-first") {
					refreshRelease.resolve();
					await refreshDone.promise;
					await turn();
					expect(state).toBe("pending");
					timerRelease.resolve();
				} else {
					timerRelease.resolve();
					await timerDone.promise;
					await turn();
					expect(state).toBe("pending");
					refreshRelease.resolve();
				}
				await completion;
				expect(state).toBe("closed");
				expect(refreshCalls).toBe(1);
				expect(timerCalls).toBe(1);
				expect(uses).toBe(0);
				expect(f.row(reference)?.status).toBe("refreshing");
				expect(f.row(reference)?.generation).toBe(2);
				expect(Buffer.from(f.row(reference)?.value ?? []).equals(Buffer.from(kept ?? []))).toBe(
					true,
				);
				expect(f.actions().length).toBe(auditCount);
				await f.vault.drain();
				expect(refreshCalls).toBe(1);
				expect(f.actions().length).toBe(auditCount);
			} finally {
				caller.abort();
				f.vault.destroy();
				refreshRelease.resolve();
				timerRelease.resolve();
				if (refreshCalls) await refreshDone.promise;
				if (timerCalls) await timerDone.promise;
				await Promise.allSettled([pending, queued, draining ?? f.vault.drain()]);
			}
		},
	);
	it("drains its cancelled queue without joining or cancelling a sibling facade", async () => {
		const time = fakeClock(),
			f = await vaultFixture({ clock: time.clock }),
			sibling = f.open(),
			owner = gmail(),
			reference = f.create(owner, token(time.state.wall - 1)),
			otherOwner = provider(),
			otherReference = f.create(otherOwner, keyValue()),
			entered = deferred<void>(),
			release = deferred<void>(),
			finished = deferred<void>();
		let exchange: CredentialUse | undefined,
			refreshCalls = 0,
			queuedUses = 0,
			state = "pending";
		const pending = f.vault.withCredential(
			reference,
			owner,
			{
				requestClass: "read",
				refresh: async (_, current) => {
					refreshCalls++;
					exchange = current;
					entered.resolve();
					try {
						await release.promise;
						return token(time.state.wall + 3_600_000);
					} finally {
						finished.resolve();
					}
				},
			},
			() => "DYTEST ready",
		);
		const success = pending.then(
			(result) => result === "DYTEST ready",
			() => false,
		);
		let queued: Promise<unknown> | undefined, draining: Promise<void> | undefined;
		try {
			await entered.promise;
			queued = sibling.withCredential(reference, owner, { requestClass: "read" }, () => {
				queuedUses++;
			});
			const rejection = refused(queued);
			draining = sibling.drain();
			const completion = draining.then(
				() => {
					state = "closed";
				},
				() => {
					state = "failed";
				},
			);
			expect(await rejection).toBe(true);
			await turn();
			expect(state).toBe("closed");
			expect(exchange?.signal.aborted).toBe(false);
			expect(queuedUses).toBe(0);
			expect(f.vault.describe(otherReference, otherOwner).generation).toBe(1);
			f.key.derive("secrets").fill(0);
			release.resolve();
			await finished.promise;
			expect(await success).toBe(true);
			await completion;
			expect(refreshCalls).toBe(1);
			expect(f.row(reference)?.status).toBe("active");
			expect(f.row(reference)?.generation).toBe(2);
			await expect(f.vault.drain()).resolves.toBeUndefined();
			expect(time.waits.size).toBe(0);
		} finally {
			sibling.destroy();
			f.vault.destroy();
			release.resolve();
			if (refreshCalls) await finished.promise;
			await Promise.allSettled([pending, queued, draining ?? sibling.drain(), f.vault.drain()]);
		}
	});
	it("refuses a new refresh when its audit clock re-enters destroy", async () => {
		const time = fakeClock();
		let armed = false,
			wallReads = 0,
			fenced = false,
			refreshCalls = 0,
			uses = 0,
			timers = 0,
			draining: Promise<void> | undefined;
		const clock: TimerClock = {
			wallMs: () => {
				if (armed && ++wallReads === 2) {
					fenced = true;
					f.vault.destroy();
					draining = f.vault.drain();
				}
				return time.clock.wallMs();
			},
			monotonicMs: time.clock.monotonicMs,
			after: (ms, signal) => {
				timers++;
				return time.clock.after(ms, signal);
			},
		};
		const f = await vaultFixture({ clock }),
			owner = gmail(),
			reference = f.create(owner, token(time.state.wall - 1));
		armed = true;
		const pending = f.vault.withCredential(
			reference,
			owner,
			{
				requestClass: "read",
				refresh: async () => {
					refreshCalls++;
					return token(time.state.wall + 3_600_000);
				},
			},
			() => {
				uses++;
			},
		);
		const rejection = refused(pending);
		try {
			expect(await rejection).toBe(true);
			expect(fenced).toBe(true);
			expect(refreshCalls).toBe(0);
			expect(uses).toBe(0);
			expect(timers).toBe(0);
			expect(draining).toBeDefined();
			await expect(draining ?? f.vault.drain()).resolves.toBeUndefined();
			expect(f.row(reference)?.status).toBe("refreshing");
			expect(f.row(reference)?.generation).toBe(2);
			expect(f.actions().at(-1)?.action).toBe("credential.refresh_started");
			expect(time.waits.size).toBe(0);
		} finally {
			armed = false;
			f.vault.destroy();
			await Promise.allSettled([pending, draining ?? f.vault.drain()]);
		}
	});
	it("keeps destroy synchronous and fences admission before an empty drain", async () => {
		const f = await vaultFixture(),
			owner = provider(),
			reference = f.create(owner, keyValue());
		let uses = 0;
		let sibling: ReturnType<typeof f.open> | undefined;
		try {
			expect(f.vault.destroy()).toBeUndefined();
			expect(() => f.vault.describe(reference, owner)).toThrow(CredentialError);
			expect(
				await refused(
					f.vault.withCredential(reference, owner, { requestClass: "read" }, () => {
						uses++;
					}),
				),
			).toBe(true);
			const draining = f.vault.drain();
			expect(f.vault.drain()).toBe(draining);
			await expect(draining).resolves.toBeUndefined();
			expect(f.vault.drain()).toBe(draining);
			expect(uses).toBe(0);
			sibling = f.open();
			expect(sibling.describe(reference, owner).generation).toBe(1);
			await expect(
				sibling.withCredential(reference, owner, { requestClass: "read" }, () => "DYTEST ready"),
			).resolves.toBe("DYTEST ready");
			await sibling.drain();
		} finally {
			f.vault.destroy();
			sibling?.destroy();
			await Promise.allSettled([f.vault.drain(), sibling?.drain()]);
		}
	});
});

describe("credential removal", () => {
	it("purges by reference, aborting in-flight use and auditing only identifiers", async () => {
		const f = await vaultFixture(),
			owner = gmail(),
			reference = f.create(owner, token(later())),
			started = deferred<void>(),
			gate = deferred<string>();
		let use: CredentialUse | undefined;
		const pending = f.vault.withCredential(
			reference,
			owner,
			{ requestClass: "read" },
			async (_, context) => {
				use = context;
				started.resolve();
				return gate.promise;
			},
		);
		const rejection = expect(pending).rejects.toThrow(CredentialError);
		await started.promise;
		const cli: CredentialActor = { kind: "cli", id: null };
		expect(() =>
			f.store.write((tx) => f.vault.purgeInTransaction(tx, reference, slack(owner.ownerId), cli)),
		).toThrow(CredentialError);
		expect(use?.signal.aborted).toBe(false);
		f.store.write((tx) => f.vault.purgeInTransaction(tx, reference, owner, cli));
		expect(use?.signal.aborted).toBe(true);
		gate.resolve("late");
		await rejection;
		expect(f.row(reference)).toBeUndefined();
		expect(f.actions().at(-1)).toEqual({
			action: "credential.purged",
			actor_kind: "cli",
			actor_id: null,
			refs: JSON.stringify({ account: owner.ownerId, credential: reference }),
		});
		const vault = f.open(f.reopen()),
			calls: ((tx: SqlTransaction) => unknown)[] = [
				(tx) => vault.describeInTransaction(tx, reference, owner),
				(tx) => vault.replaceInTransaction(tx, reference, owner, token(later())),
				(tx) => vault.invalidateInTransaction(tx, reference, owner, "delete"),
				(tx) => vault.purgeInTransaction(tx, reference, owner),
			];
		expect(() => vault.describe(reference, owner)).toThrow(CredentialError);
		for (const call of calls) expect(() => f.store.write(call)).toThrow(CredentialError);
		await expect(
			vault.withCredential(reference, owner, { requestClass: "read" }, () => "unsafe"),
		).rejects.toThrow(CredentialError);
		f.store.read((db) => f.audit.verify(db));
	});
	it("purges rows in every state and keeps a rolled-back purge's row", async () => {
		const f = await vaultFixture(),
			owner = provider(),
			reference = f.create(owner, keyValue());
		expect(() =>
			f.store.write((tx) => {
				f.vault.purgeInTransaction(tx, reference, owner);
				throw new Error("rollback");
			}),
		).toThrow("rollback");
		expect(f.row(reference)?.status).toBe("active");
		for (const reason of ["revoke", "disconnect", "delete"] as const) {
			const binding = gmail(),
				ref = f.create(binding, token(later()));
			f.store.write((tx) => f.vault.invalidateInTransaction(tx, ref, binding, reason));
			f.store.write((tx) => f.vault.purgeInTransaction(tx, ref, binding));
			expect(f.row(ref)).toBeUndefined();
		}
	});
	it("stops a refresh that a purge overtakes from restoring the row", async () => {
		const f = await vaultFixture(),
			owner = gmail(),
			reference = f.create(owner, token()),
			started = deferred<void>(),
			gate = deferred<CredentialValue>();
		let signal: AbortSignal | undefined;
		const pending = f.vault.withCredential(
			reference,
			owner,
			{
				requestClass: "read",
				refresh: async (_, context) => {
					signal = context.signal;
					started.resolve();
					return gate.promise;
				},
			},
			() => "unsafe",
		);
		const rejection = expect(pending).rejects.toThrow(CredentialError);
		await started.promise;
		f.store.write((tx) => f.vault.purgeInTransaction(tx, reference, owner));
		expect(signal?.aborted).toBe(true);
		gate.resolve(token(later()));
		await rejection;
		expect(f.row(reference)).toBeUndefined();
	});
	it("purges every credential of one owner and nothing else, and ends their uses and refreshes", async () => {
		const f = await vaultFixture(),
			account = newId(),
			mail = gmail(account),
			user = slack(account),
			app = slackApp(account),
			kept = gmail();
		const ended = f.create(mail, token(later()));
		f.store.write((tx) => f.vault.invalidateInTransaction(tx, ended, mail, "delete"));
		const stale = f.create(mail, token()),
			inUse = f.create(user, slackValue()),
			owned = [ended, stale, inUse, f.create(app, appValue())];
		const other = f.create(kept, token(later())),
			sameId = f.create(provider(account), keyValue());
		// A use of one owned credential and a refresh of another are running when the owner is purged.
		const using = deferred<CredentialUse>(),
			refreshing = deferred<CredentialUse>(),
			gate = deferred<void>();
		const callers = [
			f.vault.withCredential(inUse, user, { requestClass: "read" }, async (_, context) => {
				using.resolve(context);
				await gate.promise;
				return "late";
			}),
			f.vault.withCredential(
				stale,
				mail,
				{
					requestClass: "read",
					refresh: async (_, context) => {
						refreshing.resolve(context);
						await gate.promise;
						return token(later());
					},
				},
				() => "late",
			),
		].map((caller) => caller.catch((error: unknown) => error));
		const signals = [(await using.promise).signal, (await refreshing.promise).signal];
		const device: CredentialActor = { kind: "device", id: newId() };
		const purgedBefore = f.actions().length;
		expect(
			f.store.write((tx) =>
				f.vault.purgeOwnerInTransaction(tx, { ownerKind: "account", ownerId: account }, device),
			),
		).toBe(4);
		expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
		for (const result of await Promise.all(callers)) expect(result).toBeInstanceOf(CredentialError);
		gate.resolve();
		await new Promise((resolve) => setImmediate(resolve));
		for (const reference of owned) expect(f.row(reference)).toBeUndefined();
		expect(f.row(other)?.status).toBe("active");
		expect(f.row(sameId)?.status).toBe("active");
		const purged = f.actions().slice(purgedBefore);
		expect(purged.map(({ action }) => action)).toEqual(Array(4).fill("credential.purged"));
		expect(purged.map(({ refs }) => JSON.parse(refs).credential).toSorted()).toEqual(
			owned.toSorted(),
		);
		expect(purged.every((row) => row.actor_kind === "device" && row.actor_id === device.id)).toBe(
			true,
		);
		expect(f.store.write((tx) => f.vault.purgeOwnerInTransaction(tx, ownerOf(kept)))).toBe(1);
		expect(f.store.write((tx) => f.vault.purgeOwnerInTransaction(tx, ownerOf(kept)))).toBe(0);
		expect(
			f.store.write((tx) =>
				f.vault.purgeOwnerInTransaction(tx, { ownerKind: "provider", ownerId: account }),
			),
		).toBe(1);
		expect(f.row(sameId)).toBeUndefined();
		for (const owner of [
			{ ownerKind: "account", ownerId: "not-an-id" },
			{ ownerKind: "tool", ownerId: newId() },
			{ ...ownerOf(kept), kind: "gmail-oauth" },
		])
			expect(() =>
				f.store.write((tx) => f.vault.purgeOwnerInTransaction(tx, owner as CredentialOwner)),
			).toThrow(CredentialError);
	});
});

describe("credential change attribution", () => {
	it("records the given actor for changes and the hub for refreshes", async () => {
		const clock = fakeClock(),
			f = await vaultFixture({ clock: clock.clock }),
			owner = gmail(),
			cli: CredentialActor = { kind: "cli", id: null },
			device: CredentialActor = { kind: "device", id: newId() };
		const reference = f.create(owner, token(clock.state.wall + 1_000), cli);
		f.store.write((tx) =>
			f.vault.replaceInTransaction(tx, reference, owner, token(clock.state.wall + 1_000), device),
		);
		clock.advance(1_000);
		await f.vault.withCredential(
			reference,
			owner,
			{ requestClass: "read", refresh: async () => token(clock.state.wall + 3_600_000) },
			() => undefined,
		);
		f.store.write((tx) => f.vault.invalidateInTransaction(tx, reference, owner, "revoke", cli));
		f.create(provider(), keyValue());
		expect(
			f.actions().map(({ action, actor_kind, actor_id }) => [action, actor_kind, actor_id]),
		).toEqual([
			["credential.created", "cli", null],
			["credential.replaced", "device", device.id],
			["credential.refresh_started", "hub", null],
			["credential.refreshed", "hub", null],
			["credential.revoked", "cli", null],
			["credential.created", "hub", null],
		]);
		expect(
			f.store.read((db) => db.all<{ at: number }>("SELECT at FROM main.audit_events ORDER BY seq")),
		).toEqual([
			{ at: 1_800_000_000_000 },
			{ at: 1_800_000_000_000 },
			{ at: 1_800_000_001_000 },
			{ at: 1_800_000_001_000 },
			{ at: 1_800_000_001_000 },
			{ at: 1_800_000_001_000 },
		]);
	});
	it("refuses actors that cannot make an authorized credential change", async () => {
		const f = await vaultFixture(),
			owner = provider(),
			reference = f.create(owner, keyValue()),
			before = f.actions().length;
		const actors: unknown[] = [
			{ kind: "agent", id: newId() },
			{ kind: "plugin", id: newId() },
			{ kind: "browser", id: newId() },
			{ kind: "device", id: null },
			{ kind: "device", id: "not-an-id" },
			{ kind: "cli", id: newId() },
			{ kind: "hub" },
			{ kind: "hub", id: null, extra: true },
			Object.defineProperty({ kind: "cli" }, "id", { get: () => null, enumerable: true }),
			null,
		];
		for (const actor of actors) {
			const by = actor as CredentialActor;
			const calls: ((tx: SqlTransaction) => unknown)[] = [
				(tx) => f.vault.createInTransaction(tx, provider(), keyValue(), by),
				(tx) => f.vault.replaceInTransaction(tx, reference, owner, keyValue(), by),
				(tx) => f.vault.invalidateInTransaction(tx, reference, owner, "revoke", by),
				(tx) => f.vault.purgeInTransaction(tx, reference, owner, by),
				(tx) => f.vault.purgeOwnerInTransaction(tx, ownerOf(owner), by),
			];
			for (const call of calls) expect(() => f.store.write(call)).toThrow(CredentialError);
		}
		expect(f.actions()).toHaveLength(before);
		expect(f.row(reference)).toMatchObject({ status: "active", generation: 1 });
	});
});

describe("credential kinds and states", () => {
	it("keeps a Slack app-level token apart from the user token of the same account", async () => {
		const f = await vaultFixture(),
			account = newId(),
			user = slack(account),
			app = slackApp(account),
			userValue = slackValue(),
			appToken = appValue();
		const userRef = f.create(user, userValue),
			appRef = f.create(app, appToken);
		for (const [reference, binding] of [
			[userRef, app],
			[appRef, user],
		] as const) {
			expect(() => f.vault.describe(reference, binding)).toThrow(CredentialError);
			await expect(
				f.vault.withCredential(reference, binding, { requestClass: "read" }, () => "unsafe"),
			).rejects.toThrow(CredentialError);
			await expect(
				f.vault.withCredential(reference, binding, { requestClass: "send" }, () => "unsafe"),
			).rejects.toThrow(CredentialError);
		}
		expect(() => f.create(slack(), appValue())).toThrow(CredentialError);
		expect(() => f.create(slackApp(), slackValue())).toThrow(CredentialError);
		expect(() =>
			f.create(slackApp(), { ...appValue(), expiresAt: null } as unknown as CredentialValue),
		).toThrow(CredentialError);
		expect(() =>
			f.create(
				{ ownerKind: "provider", ownerId: newId(), kind: "slack-app-token" } as never,
				appValue(),
			),
		).toThrow(CredentialError);
		expect(() =>
			f.store.write((tx) => f.vault.replaceInTransaction(tx, appRef, app, userValue)),
		).toThrow(CredentialError);
		let refreshes = 0;
		await expect(
			f.vault.withCredential(
				appRef,
				app,
				{
					requestClass: "read",
					refreshAheadMs: 1_800_000,
					refresh: async () => {
						refreshes++;
						return appValue();
					},
				},
				(value) => value,
			),
		).resolves.toEqual(appToken);
		await expect(
			f.vault.withCredential(userRef, user, { requestClass: "send" }, (value) => value),
		).resolves.toEqual(userValue);
		expect(refreshes).toBe(0);
	});
	it("refuses generation exhaustion without wrapping", async () => {
		const clock = fakeClock(),
			f = await vaultFixture({ clock: clock.clock }),
			owner = gmail(),
			reference = f.create(owner, token(clock.state.wall + 60_000));
		f.raw((tx) =>
			tx.run("UPDATE main.credentials SET generation=? WHERE id=?", [MAX - 1, reference]),
		);
		f.store.write((tx) =>
			f.vault.replaceInTransaction(tx, reference, owner, token(clock.state.wall + 60_000)),
		);
		const at = f.row(reference);
		expect(at).toMatchObject({ status: "active", generation: MAX });
		await expect(
			f.vault.withCredential(reference, owner, { requestClass: "read" }, () => "current"),
		).resolves.toBe("current");
		expect(() =>
			f.store.write((tx) => f.vault.replaceInTransaction(tx, reference, owner, token(later()))),
		).toThrow(CredentialError);
		for (const reason of ["revoke", "disconnect", "delete"] as const)
			expect(() =>
				f.store.write((tx) => f.vault.invalidateInTransaction(tx, reference, owner, reason)),
			).toThrow(CredentialError);
		clock.advance(60_000);
		let refreshes = 0;
		await expect(
			f.vault.withCredential(
				reference,
				owner,
				{
					requestClass: "read",
					refresh: async () => {
						refreshes++;
						return token(clock.state.wall + 60_000);
					},
				},
				() => "unsafe",
			),
		).rejects.toThrow(CredentialError);
		expect(refreshes).toBe(0);
		expect(f.row(reference)).toEqual(at);
		f.store.write((tx) => f.vault.purgeInTransaction(tx, reference, owner));
		expect(f.row(reference)).toBeUndefined();
	});
	it("refuses replacing or invalidating a deleted credential but replaces a revoked one", async () => {
		const f = await vaultFixture(),
			owner = gmail(),
			revoked = f.create(owner, token(later()));
		f.store.write((tx) => f.vault.invalidateInTransaction(tx, revoked, owner, "revoke"));
		const replacement = token(later());
		f.store.write((tx) => f.vault.replaceInTransaction(tx, revoked, owner, replacement));
		await expect(
			f.vault.withCredential(revoked, owner, { requestClass: "read" }, (value) => value),
		).resolves.toEqual(replacement);
		const binding = gmail(),
			deleted = f.create(binding, token(later()));
		f.store.write((tx) => f.vault.invalidateInTransaction(tx, deleted, binding, "delete"));
		const tombstone = f.row(deleted);
		expect(() =>
			f.store.write((tx) => f.vault.replaceInTransaction(tx, deleted, binding, token(later()))),
		).toThrow(CredentialError);
		for (const reason of ["revoke", "disconnect", "delete"] as const)
			expect(() =>
				f.store.write((tx) => f.vault.invalidateInTransaction(tx, deleted, binding, reason)),
			).toThrow(CredentialError);
		expect(f.row(deleted)).toEqual(tombstone);
		expect(() =>
			f.store.write((tx) =>
				f.vault.invalidateInTransaction(tx, revoked, owner, "expire" as "revoke"),
			),
		).toThrow(CredentialError);
	});
	it("describes active credentials in a transaction exactly as outside one", async () => {
		const f = await vaultFixture(),
			owner = gmail(),
			reference = f.create(owner, token(later())),
			other = await vaultFixture();
		expect(f.store.write((tx) => f.vault.describeInTransaction(tx, reference, owner))).toEqual(
			f.vault.describe(reference, owner),
		);
		expect(() =>
			f.store.write((tx) => f.vault.describeInTransaction(tx, reference, slack(owner.ownerId))),
		).toThrow(CredentialError);
		expect(() =>
			other.store.write((tx) => f.vault.describeInTransaction(tx, reference, owner)),
		).toThrow(CredentialError);
		let retired: SqlTransaction | undefined;
		f.store.write((tx) => {
			retired = tx;
		});
		expect(() =>
			f.vault.describeInTransaction(retired as SqlTransaction, reference, owner),
		).toThrow(CredentialError);
		const failing = gmail(),
			failed = f.create(failing, token());
		await expect(
			f.vault.withCredential(
				failed,
				failing,
				{
					requestClass: "read",
					refresh: async () => {
						throw new Error("DYTEST refresh failure");
					},
				},
				() => undefined,
			),
		).rejects.toThrow(CredentialError);
		expect(f.row(failed)?.status).toBe("refreshing");
		expect(() => f.store.write((tx) => f.vault.describeInTransaction(tx, failed, failing))).toThrow(
			CredentialError,
		);
		for (const reason of ["revoke", "delete"] as const) {
			const binding = gmail(),
				ref = f.create(binding, token(later()));
			f.store.write((tx) => f.vault.invalidateInTransaction(tx, ref, binding, reason));
			expect(() => f.store.write((tx) => f.vault.describeInTransaction(tx, ref, binding))).toThrow(
				CredentialError,
			);
		}
	});
});
