import type { Challenge, OperationReview, SignedEnvelope } from "@draftyak/protocol/device-api";
import { afterEach, describe, expect, it } from "vitest";
import type { ChallengeService as Service } from "../../src/identity/challenges.ts";
import type {
	AdminAcceptContext,
	AdminAcceptedFacts,
} from "../../src/identity/challenges-admin.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const { fixture: nativeFixture } = await import("./admin-operations-fixture.ts");
const { ChallengeService, consumeAdminChallengeContext } = await import(
	"../../src/identity/challenges.ts"
);
const { applyNativeAdminOperation, prepareNativeAdminOperation, writeNativeAdminOperations } =
	await import("../../src/identity/admin-operations.ts");
const { NativeAdminError } = await import("../../src/identity/admin-errors.ts");
const { signStatement } = await import("@draftyak/protocol/sign");
const { parseStatement } = await import("@draftyak/protocol/statements");
const { canonicalize } = await import("@draftyak/protocol/jcs");
const { fromBase64Url } = await import("@draftyak/protocol/scalars");
const { revokePinScope } = await import("../../src/authz/scopes.ts");
const { AdminStatement } = await import("@draftyak/protocol/statements/admin");
const { newId } = await import("../../src/kernel/ids.ts");
const native = await import("../authz/native-fixture.ts");

type Base = Awaited<ReturnType<typeof nativeFixture>>;
interface Fixture extends Base {
	readonly service: Service;
}
const fixtures: Fixture[] = [];

function service(f: Base, admin: boolean = true): Service {
	return new ChallengeService(
		f.native.store,
		f.native.audit,
		f.native.pins,
		f.native.registry,
		f.native.authorizer,
		{
			identity: f.native.identity,
			clock: f.clock,
			send: f.send,
			...(admin ? { admin: f.operations } : {}),
		},
	);
}
async function fixture(admin: boolean = true): Promise<Fixture> {
	const f = await nativeFixture();
	const result = { ...f, service: service(f, admin) };
	fixtures.push(result);
	return result;
}
afterEach(async () => {
	for (const f of fixtures.splice(0)) {
		f.service.lock();
		await f.close();
	}
});

function open(f: Fixture): Extract<OperationReview, { kind: "account.mode-full" }> {
	const result = f.operations.open(f.device.peer, {
		kind: "account.mode-full",
		ids: [f.account.account.id],
	});
	if (result.kind !== "account.mode-full") throw new Error("DYTEST wrong operation");
	return result;
}
function issue(f: Fixture, id: string): Challenge {
	return f.service.issue(f.device.peer, { kind: "admin.v1", id });
}
function signed(
	f: Fixture,
	challenge: Challenge,
	changes?: Record<string, unknown>,
): SignedEnvelope {
	const bytes = fromBase64Url(challenge.statement);
	const statement = bytes && parseStatement("admin.v1", bytes);
	if (!statement) throw new Error("DYTEST invalid admin statement");
	const value = { ...statement, ...changes };
	return {
		statement: changes
			? Buffer.from(canonicalize(value)).toString("base64url")
			: challenge.statement,
		signature: signStatement("admin.v1", value, f.device.privateKey),
		pin: native.PIN,
	};
}
function pinEffects(f: Fixture): { verified: number; failures: number } {
	return f.native.store.read((tx) => ({
		verified:
			tx.get<{ n: number }>(
				"SELECT count(*) AS n FROM main.audit_events WHERE action='pin.verified'",
			)?.n ?? 0,
		failures:
			tx.get<{ failures: number }>("SELECT failures FROM main.approval_pins WHERE user_id=?", [
				native.owner(f.native),
			])?.failures ?? 0,
	}));
}
function settled(
	f: Fixture,
	operation: string,
): { consumed: number | null; signature: string | null; state: string } {
	return f.native.store.read((tx) => {
		const challenge = tx.get<{ consumed_at: number | null; signature: string | null }>(
			"SELECT consumed_at,signature FROM main.native_admin_challenges WHERE target_id=? ORDER BY issued_at DESC LIMIT 1",
			[operation],
		);
		const row = tx.get<{ state: string }>(
			"SELECT state FROM main.native_admin_operations WHERE id=?",
			[operation],
		);
		if (!challenge || !row) throw new Error("DYTEST missing native records");
		return { consumed: challenge.consumed_at, signature: challenge.signature, state: row.state };
	});
}
function effectCounts(f: Fixture): { audit: number; events: number } {
	return f.native.store.read((tx) => ({
		audit:
			tx.get<{ n: number }>(
				"SELECT count(*) AS n FROM main.audit_events WHERE action='account.changed'",
			)?.n ?? 0,
		events:
			tx.get<{ n: number }>("SELECT count(*) AS n FROM main.events WHERE kind='accounts.changed'")
				?.n ?? 0,
	}));
}

describe("native account mode challenges", () => {
	it("accepts one genuine concurrent signature and PIN, changes only mode, and refuses replay", async () => {
		const f = await fixture();
		const operation = open(f),
			challenge = issue(f, operation.id),
			envelope = signed(f, challenge);
		const before = f.current(),
			counts = effectCounts(f);
		expect(challenge.id).toBe(operation.id);
		const results = await Promise.allSettled([
			f.service.accept(f.device.peer, "admin.v1", envelope),
			f.service.accept(f.device.peer, "admin.v1", envelope),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(f.current()).toEqual({
			account: { ...before.account, mode: "full" },
			generation: before.generation + 1,
		});
		expect(effectCounts(f)).toEqual({ audit: counts.audit + 1, events: counts.events + 1 });
		expect(settled(f, operation.id)).toMatchObject({
			state: "applied",
			signature: envelope.signature,
			consumed: expect.any(Number),
		});
		await expect(f.service.accept(f.device.peer, "admin.v1", envelope)).rejects.toMatchObject({
			code: "CHALLENGE_INVALID",
		});
		expect(f.current().generation).toBe(before.generation + 1);
	});

	it("keeps missing issuers and unsupported operations unavailable without structural admission", async () => {
		const f = await fixture(false),
			foreign = await fixture();
		const operation = open(f),
			before = pinEffects(f);
		expect(() => issue(f, operation.id)).toThrow("KIND_UNAVAILABLE");
		for (const admin of [Object.freeze({}), foreign.operations]) {
			expect(
				() =>
					new ChallengeService(
						f.native.store,
						f.native.audit,
						f.native.pins,
						f.native.registry,
						f.native.authorizer,
						{
							identity: f.native.identity,
							clock: f.clock,
							send: f.send,
							admin: admin as never,
						},
					),
			).toThrow("UNAVAILABLE");
		}
		expect(() =>
			f.operations.open(f.device.peer, { kind: "account.disconnect", ids: [f.account.account.id] }),
		).toThrow();
		expect(pinEffects(f)).toEqual(before);
		expect(f.current().account.mode).toBe("read_only");
	});

	it.each(["signature", "issued bytes", "operation"] as const)(
		"refuses changed %s before attempting a PIN",
		async (change) => {
			const f = await fixture(),
				operation = open(f),
				challenge = issue(f, operation.id);
			const original =
				change === "issued bytes"
					? signed(f, challenge, { digest: "0".repeat(64) })
					: change === "operation"
						? signed(f, challenge, { op: open(f).id })
						: signed(f, challenge);
			const envelope =
				change === "signature"
					? {
							...original,
							signature: `${original.signature[0] === "A" ? "B" : "A"}${original.signature.slice(1)}`,
						}
					: original;
			const before = pinEffects(f);
			const [result] = await Promise.allSettled([
				f.service.accept(f.device.peer, "admin.v1", envelope),
			]);
			expect(pinEffects(f)).toEqual(before);
			expect(result).toMatchObject({
				status: "rejected",
				reason: { code: change === "signature" ? "SIGNATURE_INVALID" : "CHALLENGE_INVALID" },
			});
			expect(f.current().account.mode).toBe("read_only");
			expect(settled(f, operation.id).consumed).toBeNull();
		},
	);

	it("rejects a generation-only account change with an unchanged review digest during actual PIN work", async () => {
		const f = await fixture(),
			operation = open(f),
			challenge = issue(f, operation.id);
		const before = f.current(),
			pins = pinEffects(f);
		const accepting = f.service.accept(f.device.peer, "admin.v1", signed(f, challenge));
		f.database.write((scope) => f.accounts.replace(scope, before.account, before.generation));
		const fresh = open(f);
		expect(fresh.digest).toBe(operation.digest);
		await expect(accepting).rejects.toMatchObject({ code: "STALE" });
		expect(pinEffects(f).verified).toBeGreaterThan(pins.verified);
		expect(f.current()).toEqual({ account: before.account, generation: before.generation + 1 });
		expect(settled(f, operation.id).consumed).toBeNull();
	});

	it("consumes the real operation-and-nonce PIN proof after the native guard changes its material", async () => {
		const f = await fixture(),
			operation = open(f),
			challenge = issue(f, operation.id);
		const before = pinEffects(f);
		f.native.store.write((tx) =>
			tx.run(
				"UPDATE main.dytest_admin_faults SET pin_material=1,owner_user_id=? WHERE singleton=1",
				[native.owner(f.native)],
			),
		);
		const [result] = await Promise.allSettled([
			f.service.accept(f.device.peer, "admin.v1", signed(f, challenge)),
		]);
		f.native.store.write((tx) =>
			tx.run("UPDATE main.dytest_admin_faults SET pin_material=0 WHERE singleton=1"),
		);
		expect(pinEffects(f).verified).toBeGreaterThan(before.verified);
		expect(f.current().account.mode).toBe("read_only");
		expect(settled(f, operation.id).consumed).toBeNull();
		expect(result).toMatchObject({
			status: "rejected",
			reason: { code: "PIN_REFUSED", detail: "PIN_CHANGED" },
		});
	});

	it.each(["wall", "mono"] as const)(
		"rechecks the original %s deadline after real asynchronous PIN work",
		async (clock) => {
			const f = await fixture(),
				operation = open(f),
				challenge = issue(f, operation.id),
				before = pinEffects(f);
			const accepting = f.service.accept(f.device.peer, "admin.v1", signed(f, challenge));
			f.time[clock] += 120_001;
			await expect(accepting).rejects.toThrow();
			expect(pinEffects(f).verified).toBeGreaterThan(before.verified);
			expect(f.current().account.mode).toBe("read_only");
			expect(settled(f, operation.id).consumed).toBeNull();
		},
	);

	it.each([false, true])(
		"keeps an older operation's original deadline with a newer challenge (jump=%s)",
		async (jump) => {
			const f = await fixture(),
				operation = open(f),
				account = f.current();
			const start = { ...f.time };
			f.time.mono += 119_000;
			const challenge = issue(f, operation.id),
				before = pinEffects(f);
			const accepting = f.service.accept(f.device.peer, "admin.v1", signed(f, challenge));
			if (jump) f.time.mono += 2_000;
			const [result] = await Promise.allSettled([accepting]);
			expect(pinEffects(f).verified).toBeGreaterThan(before.verified);
			expect(f.time.wall).toBe(start.wall);
			expect(f.time.mono - start.mono).toBe(jump ? 121_000 : 119_000);
			if (jump) {
				expect(f.current()).toEqual(account);
				expect(settled(f, operation.id).consumed).toBeNull();
				expect(result).toMatchObject({ status: "rejected" });
			} else {
				expect(f.current()).toEqual({
					account: { ...account.account, mode: "full" },
					generation: account.generation + 1,
				});
				expect(settled(f, operation.id).state).toBe("applied");
				expect(result).toMatchObject({
					status: "fulfilled",
					value: { kind: "admin.v1", id: operation.id },
				});
			}
		},
	);

	it("refreshes the genuine peer grant after PIN work instead of accepting a revoked device", async () => {
		const f = await fixture(),
			operation = open(f),
			challenge = issue(f, operation.id);
		const id = native.idOf(f.device),
			owner = native.owner(f.native);
		const proof = await f.native.pins.verify(owner, native.PIN, revokePinScope(id));
		const accepting = f.service.accept(f.device.peer, "admin.v1", signed(f, challenge));
		try {
			f.native.store.write((tx) => f.native.registry.revoke(tx, id, { kind: "device", id, proof }));
		} finally {
			f.native.pins.discard(proof);
		}
		await expect(accepting).rejects.toMatchObject({
			code: "DEVICE_REFUSED",
			detail: "DEVICE_REVOKED",
		});
		expect(f.current().account.mode).toBe("read_only");
		expect(settled(f, operation.id).consumed).toBeNull();
	});

	it.each(["lock", "replacement"] as const)(
		"does not revive an accepting context after coordinator %s",
		async (action) => {
			const f = await fixture(),
				operation = open(f),
				challenge = issue(f, operation.id);
			const accepting = f.service.accept(f.device.peer, "admin.v1", signed(f, challenge));
			let replacement: Service | undefined;
			if (action === "lock") f.service.lock();
			else replacement = service(f);
			try {
				await expect(accepting).rejects.toMatchObject({ code: "UNAVAILABLE" });
				expect(f.current().account.mode).toBe("read_only");
				expect(settled(f, operation.id).consumed).toBeNull();
			} finally {
				replacement?.lock();
			}
		},
	);

	it("rolls back the account, operation and challenge when real final settlement SQL fails", async () => {
		const f = await fixture(),
			operation = open(f),
			challenge = issue(f, operation.id);
		const before = f.current(),
			effects = effectCounts(f),
			pins = pinEffects(f);
		f.native.store.write((tx) =>
			tx.run("UPDATE main.dytest_admin_faults SET final_op=1 WHERE singleton=1"),
		);
		await expect(
			f.service.accept(f.device.peer, "admin.v1", signed(f, challenge)),
		).rejects.toThrow();
		expect(f.current()).toEqual(before);
		expect(effectCounts(f)).toEqual(effects);
		expect(settled(f, operation.id)).toEqual({ state: "pending", consumed: null, signature: null });
		expect(pinEffects(f).verified).toBeGreaterThan(pins.verified);
		f.native.store.write((tx) =>
			tx.run("UPDATE main.dytest_admin_faults SET final_op=0 WHERE singleton=1"),
		);
		const retryOperation = open(f),
			retryChallenge = issue(f, retryOperation.id);
		await expect(
			f.service.accept(f.device.peer, "admin.v1", signed(f, retryChallenge)),
		).resolves.toEqual({ kind: "admin.v1", id: retryOperation.id });
	});

	it("rejects an unissued context and poisons a genuine caught-apply scope", async () => {
		const f = await fixture(),
			before = f.current(),
			operation = open(f),
			pins = pinEffects(f);
		let caught = false;
		let caughtError: unknown;
		let writeError: unknown;
		try {
			writeNativeAdminOperations(f.operations, (tx, scope) => {
				const prepared = prepareNativeAdminOperation(
					f.operations,
					tx,
					scope,
					f.device.peer,
					operation.id,
				);
				const grant = f.native.authorizer.requirePeerKind(tx, f.device.peer, "admin.v1");
				// Complete negative DATA: no challenge issuance, signature, PIN or context mint occurs.
				const unverified: AdminAcceptedFacts = Object.freeze({
					statement: AdminStatement.parse({
						v: 1,
						hub: f.native.identity.hid,
						epoch: grant.epoch,
						device: grant.deviceId,
						nonce: Buffer.alloc(16, 1).toString("base64url"),
						iat: f.time.wall,
						exp: f.time.wall + 120_000,
						...prepared.fields,
					}),
					peer: f.device.peer,
					operationVersion: prepared.operationVersion,
					owner: grant.ownerUserId,
					epoch: grant.epoch,
					deviceId: grant.deviceId,
					approvalKey: grant.approvalKey,
					now: Object.freeze({ wall: f.time.wall, mono: f.time.mono }),
					challengeId: newId(f.time.wall),
				});
				try {
					applyNativeAdminOperation(
						f.operations,
						tx,
						scope,
						unverified as unknown as AdminAcceptContext,
					);
				} catch (error) {
					caught = true;
					caughtError = error;
				}
				tx.run("UPDATE main.dytest_admin_faults SET final_op=1 WHERE singleton=1");
			});
		} catch (error) {
			writeError = error;
		}
		const after = f.current();
		expect(after.account.mode).toBe("read_only");
		expect(after.generation).toBe(before.generation);
		expect(after.account).toEqual(before.account);
		expect(pinEffects(f)).toEqual(pins);
		expect(caught).toBe(true);
		expect(caughtError).toBeInstanceOf(NativeAdminError);
		expect(caughtError).toMatchObject({ code: "UNAVAILABLE" });
		expect(writeError).toBeInstanceOf(NativeAdminError);
		expect(writeError).toMatchObject({ code: "UNAVAILABLE" });
		expect(
			f.native.store.read((tx) =>
				tx.get<{ n: number }>("SELECT count(*) AS n FROM main.native_admin_challenges"),
			)?.n,
		).toBe(0);
		expect(
			f.native.store.read((tx) =>
				tx.get<{ final_op: number }>(
					"SELECT final_op FROM main.dytest_admin_faults WHERE singleton=1",
				),
			)?.final_op,
		).toBe(0);
		expect(() =>
			consumeAdminChallengeContext(
				Object.freeze({}) as AdminAcceptContext,
				f.operations,
				{} as never,
				{} as never,
			),
		).toThrow("UNAVAILABLE");
	});
});
