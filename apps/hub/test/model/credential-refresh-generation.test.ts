import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
	CredentialError,
	type CredentialRefresh,
	CredentialRefreshError,
	type CredentialUse,
	type CredentialValue,
	type CredentialVault,
} from "../../src/credentials/vault.ts";
import {
	cleanupFixtures,
	deferred,
	fakeClock,
	gmail,
	token,
	vaultFixture,
} from "../credentials/helpers.ts";

const outcomes = ["answer", "temporary", "invalid_grant"] as const;
const orders = ["old-before-new", "old-after-new"] as const;
const facades = ["same", "sibling"] as const;
const cases = outcomes.flatMap((outcome) =>
	orders.flatMap((order) =>
		facades.map((facade) => ({ outcome, order, facade, label: `${outcome}/${order}/${facade}` })),
	),
);
type Outcome = (typeof outcomes)[number];

function exchange() {
	const entered = deferred<void>();
	const answer = deferred<CredentialValue>();
	const finished = deferred<void>();
	const state = {
		calls: 0,
		active: false,
		finallyDone: false,
		use: undefined as CredentialUse | undefined,
	};
	// This callback supplies exchange DATA to the original vault. It grants no account rights.
	const refresh: CredentialRefresh = async (_value, use) => {
		state.calls++;
		state.active = true;
		state.use = use;
		entered.resolve();
		try {
			return await answer.promise;
		} finally {
			state.active = false;
			state.finallyDone = true;
			finished.resolve();
		}
	};
	return { entered, answer, finished, state, refresh };
}

function observe<T>(promise: Promise<T>) {
	const state = { settled: false };
	const result = promise.then(
		(value) => {
			state.settled = true;
			return { status: "fulfilled" as const, value };
		},
		(error: unknown) => {
			state.settled = true;
			return { status: "rejected" as const, error };
		},
	);
	return { state, result };
}

function settleOld(
	pending: ReturnType<typeof exchange>,
	outcome: Outcome,
	value: CredentialValue,
): void {
	if (outcome === "answer") pending.answer.resolve(value);
	else pending.answer.reject(new CredentialRefreshError(outcome));
}

describe("credential refresh generation command model", () => {
	it("enumerates all late-answer orders across both original facades", () => {
		expect(cases).toHaveLength(12);
		expect(new Set(cases.map((row) => row.label)).size).toBe(12);
		for (const outcome of outcomes)
			for (const order of orders)
				expect(cases.filter((row) => row.outcome === outcome && row.order === order)).toHaveLength(
					2,
				);
	});

	// Persistence/currentness only. The real fixture supplies encrypted storage, not account,
	// admin, Session, OAuth network, or native operation authorization. No physical send occurs.
	for (const row of cases) {
		it(`keeps the new credential generation for ${row.label}`, async () => {
			const clock = fakeClock();
			const old = exchange();
			const current = exchange();
			const owner = gmail();
			const initial = token(clock.state.wall);
			const replacement = token(clock.state.wall);
			const oldAnswer = token(clock.state.wall + 60_000);
			const newAnswer = token(clock.state.wall + 60_000);
			let owned: Awaited<ReturnType<typeof vaultFixture>> | undefined;
			let ownedSibling: CredentialVault | undefined;
			let firstCall: ReturnType<typeof observe<number>> | undefined;
			let secondCall: ReturnType<typeof observe<number>> | undefined;
			let firstDrain: ReturnType<typeof observe<void>> | undefined;
			let firstUses = 0;
			let secondUses = 0;
			let secondMatches = false;
			let finalUses = 0;
			let finalMatches = false;
			try {
				const f = await vaultFixture({ clock: clock.clock });
				owned = f;
				const first = f.vault;
				const sibling = f.open(f.store, clock.clock);
				ownedSibling = sibling;
				const second = row.facade === "same" ? first : sibling;
				const reference = f.create(owner, initial);
				const expectRow = (generation: number, status: string) => {
					const stored = f.row(reference);
					expect({
						generation: stored?.generation,
						status: stored?.status,
						hasValue: stored?.value !== null && stored?.value !== undefined,
					}).toEqual({ generation, status, hasValue: true });
				};
				const actions = () => f.actions().map((entry) => entry.action);
				const startedActions = [
					"credential.created",
					"credential.refresh_started",
					"credential.replaced",
					"credential.refresh_started",
				];
				expectRow(1, "active");
				firstCall = observe(
					first.withCredential(
						reference,
						owner,
						{ requestClass: "read", refresh: old.refresh },
						() => {
							firstUses++;
							return 0;
						},
					),
				);
				if (
					!(await Promise.race([
						old.entered.promise.then(() => true),
						firstCall.result.then(() => false),
					]))
				)
					throw new Error("DYTEST old caller settled before exchange entry");
				expectRow(2, "refreshing");
				expect(old.state.calls).toBe(1);
				expect(old.state.use?.generation).toBe(2);
				expect(old.state.use?.signal.aborted).toBe(false);

				// Original-store replacement is fixture storage setup, not an authorization producer.
				f.store.write((tx) => sibling.replaceInTransaction(tx, reference, owner, replacement));
				expectRow(3, "active");
				expect(old.state.use?.signal.aborted).toBe(true);
				const endedFirst = await firstCall.result;
				expect(endedFirst.status).toBe("rejected");
				if (endedFirst.status !== "rejected") throw new Error("DYTEST old read succeeded");
				expect(endedFirst.error instanceof CredentialError).toBe(true);
				expect(old.state.active).toBe(true);
				expect(old.state.finallyDone).toBe(false);

				secondCall = observe(
					second.withCredential(
						reference,
						owner,
						{ requestClass: "read", refresh: current.refresh },
						(value, use) => {
							secondUses++;
							secondMatches =
								value.kind === "gmail-oauth" &&
								newAnswer.kind === "gmail-oauth" &&
								value.accessToken === newAnswer.accessToken &&
								value.refreshToken === newAnswer.refreshToken &&
								value.expiresAt === newAnswer.expiresAt;
							return use.generation;
						},
					),
				);
				if (
					!(await Promise.race([
						current.entered.promise.then(() => true),
						secondCall.result.then(() => false),
					]))
				)
					throw new Error("DYTEST current caller settled before exchange entry");
				expectRow(4, "refreshing");
				expect(actions()).toEqual(startedActions);
				expect(current.state.calls).toBe(1);
				expect(current.state.use?.generation).toBe(4);
				expect(current.state.use?.signal.aborted).toBe(false);

				// A facade drains only its own exchange; a sibling's current refresh stays admitted.
				if (row.facade === "sibling") {
					firstDrain = observe(first.drain());
					await nextTurn();
					expect(firstDrain.state.settled).toBe(false);
					expect(current.state.use?.signal.aborted).toBe(false);
				}
				if (row.order === "old-before-new") {
					settleOld(old, row.outcome, oldAnswer);
					await old.finished.promise;
					expectRow(4, "refreshing");
					expect(actions()).toEqual(startedActions);
					if (firstDrain) expect((await firstDrain.result).status).toBe("fulfilled");
					expect(current.state.active).toBe(true);
					expect(current.state.use?.signal.aborted).toBe(false);
				}
				current.answer.resolve(newAnswer);
				const endedSecond = await secondCall.result;
				expect(endedSecond).toEqual({ status: "fulfilled", value: 4 });
				expect(current.state.finallyDone).toBe(true);
				expect(secondUses).toBe(1);
				expect(secondMatches).toBe(true);
				expectRow(4, "active");
				expect(actions()).toEqual([...startedActions, "credential.refreshed"]);

				if (row.order === "old-after-new") {
					firstDrain ??= observe(first.drain());
					await nextTurn();
					expect(firstDrain.state.settled).toBe(false);
					expect(old.state.active).toBe(true);
					expect(old.state.finallyDone).toBe(false);
					settleOld(old, row.outcome, oldAnswer);
					await old.finished.promise;
					expect((await firstDrain.result).status).toBe("fulfilled");
				}
				expect(old.state.finallyDone).toBe(true);
				expect(firstUses).toBe(0);
				expect(old.state.calls).toBe(1);
				expect(current.state.calls).toBe(1);
				expectRow(4, "active");
				expect(actions()).toEqual([...startedActions, "credential.refreshed"]);
				const generation = await sibling.withCredential(
					reference,
					owner,
					{ requestClass: "read" },
					(value, use) => {
						finalUses++;
						finalMatches =
							value.kind === "gmail-oauth" &&
							newAnswer.kind === "gmail-oauth" &&
							value.accessToken === newAnswer.accessToken &&
							value.refreshToken === newAnswer.refreshToken &&
							value.expiresAt === newAnswer.expiresAt;
						return use.generation;
					},
				);
				expect({ generation, finalUses, finalMatches }).toEqual({
					generation: 4,
					finalUses: 1,
					finalMatches: true,
				});
			} finally {
				// Release every DATA gate, then join real facade drains and physical callback bodies.
				// Neither a caller rejection nor a possibly premature drain replaces those joins.
				old.answer.resolve(oldAnswer);
				current.answer.resolve(newAnswer);
				const joins = await Promise.allSettled([
					...(owned ? [owned.vault.drain()] : []),
					...(ownedSibling ? [ownedSibling.drain()] : []),
					...(firstCall ? [firstCall.result] : []),
					...(secondCall ? [secondCall.result] : []),
				]);
				const physical = [old, current].filter((pending) => pending.state.calls > 0);
				await Promise.all(physical.map((pending) => pending.finished.promise));
				try {
					expect(joins.every((joined) => joined.status === "fulfilled")).toBe(true);
					expect(
						physical.every((pending) => !pending.state.active && pending.state.finallyDone),
					).toBe(true);
					expect(clock.waits.size).toBe(0);
				} finally {
					cleanupFixtures();
				}
			}
		});
	}
});
