import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const { fixture, closeFixture, proposal, envelope, issue, counts, native } = await import(
	"./challenges-fixture.ts"
);
const { ChallengeService, STATEMENT_KIND_DISPOSITIONS, ChallengeError } = await import(
	"../../src/identity/challenges.ts"
);
const { canonicalize } = await import("@draftyak/protocol/jcs");
const { revokePinScope } = await import("../../src/authz/scopes.ts");
const { advanceEpochForRestore } = await import("../../src/identity/devices.ts");
const { StatementSchemas, openTypedStatement } = await import("@draftyak/protocol/statements");
const { DEVICE_STATEMENT_KINDS, ChallengeRequest, SignedEnvelope, decodeDeviceStatement } =
	await import("@draftyak/protocol/device-api");
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const pairServices: InstanceType<typeof ChallengeService>[] = [];
async function setup() {
	const f = await fixture();
	fixtures.push(f);
	return f;
}
afterEach(async () => {
	for (const service of pairServices.splice(0)) service.lock();
	for (const f of fixtures.splice(0)) await closeFixture(f);
});
async function pairing(
	options: {
		readonly operationAgeMs?: number;
		readonly onAcceptSas?: (f: Awaited<ReturnType<typeof fixture>>) => void;
	} = {},
) {
	const f = await setup(),
		candidate = native.idOf(f.device);
	// Restore orchestration data stand-in; epoch and both bootstrap authorities are native.
	f.native.store.write((tx) => {
		tx.run("DELETE FROM main.approval_pins WHERE user_id=?", [native.owner(f.native)]);
		advanceEpochForRestore(f.native.registry, tx);
	});
	const approver = await native.bootstrap(f.native);
	let accepting = false;
	const TEST_ONLY_RESTORED_SAS = (id: string): string | undefined => {
		if (id !== candidate) return undefined;
		if (accepting) options.onAcceptSas?.(f);
		return "123456";
	};
	const service = new ChallengeService(
		f.native.store,
		f.native.audit,
		f.native.pins,
		f.native.registry,
		f.native.authorizer,
		{
			identity: f.native.identity,
			send: f.verifier,
			clock: f.clock,
			pairConfirmSas: TEST_ONLY_RESTORED_SAS,
		},
	);
	pairServices.push(service);
	const operation = service.openPairConfirmation(approver.peer, {
		kind: "pair-confirm",
		ids: [candidate],
		preset: "desktop",
	});
	f.time.mono += options.operationAgeMs ?? 0;
	const challenge = service.issue(approver.peer, { kind: "pair-confirm.v1", id: operation.id });
	accepting = true;
	const signed = envelope(f, challenge, native.PIN, undefined, challenge.kind, approver);
	return { f, candidate, approver, service, operation, challenge, signed };
}

describe("native statement challenge authority", () => {
	it("keeps every current statement kind explicitly accepted, postponed or unavailable", () => {
		for (const kind of new Set([...Object.keys(StatementSchemas), ...DEVICE_STATEMENT_KINDS])) {
			expect(Object.hasOwn(STATEMENT_KIND_DISPOSITIONS, kind)).toBe(true);
			expect(STATEMENT_KIND_DISPOSITIONS[kind]).toBe(
				kind === "approval.send.v1" || kind === "pair-confirm.v1"
					? "accepted"
					: kind === "admin.v1" || kind === "hub-key-rotate.v1" || kind === "consent.v1"
						? "unavailable"
						: "postponed",
			);
		}
	});
	it("replays the shared strict codec vectors used before native challenge admission", () => {
		const root = path.resolve(import.meta.dirname, "../../../../spec/vectors");
		for (const kind of ["approval.send.v1", "pair-confirm.v1"] as const) {
			const doc = JSON.parse(
				readFileSync(path.join(root, "statements", `${kind}.json`), "utf8"),
			) as {
				cases: {
					receivedHex: string;
					signature: string;
					rfc6979Signature?: string;
					publicKeySpki: string;
					valid: boolean;
				}[];
			};
			for (const v of doc.cases)
				for (const signature of [v.signature, v.rfc6979Signature].filter(
					(x): x is string => x !== undefined,
				))
					expect(
						openTypedStatement(
							kind,
							Buffer.from(v.receivedHex, "hex"),
							signature,
							v.publicKeySpki,
						) !== undefined,
					).toBe(v.valid);
		}
		const device = JSON.parse(readFileSync(path.join(root, "device-api/cases.json"), "utf8")) as {
			cases: { action: string; schema: string; value: unknown; valid: boolean }[];
		};
		for (const v of device.cases.filter(
			(v) =>
				v.action === "schema" && (v.schema === "SignedEnvelope" || v.schema === "ChallengeRequest"),
		))
			expect(
				(v.schema === "SignedEnvelope" ? SignedEnvelope : ChallengeRequest).safeParse(v.value)
					.success,
			).toBe(v.valid);
		const jcs = JSON.parse(readFileSync(path.join(root, "jcs/refusals.json"), "utf8")) as {
			cases: { input?: string; inputHex?: string; error?: string }[];
		};
		for (const v of jcs.cases.filter((v) => v.error !== undefined)) {
			const bytes =
				v.inputHex !== undefined ? Buffer.from(v.inputHex, "hex") : Buffer.from(v.input ?? "");
			expect(
				decodeDeviceStatement("approval.send.v1", bytes.toString("base64url")),
			).toBeUndefined();
		}
	});
	it("accepts a native TLS owner's exact signed send once with the real PIN", async () => {
		const f = await setup(),
			p = proposal(f),
			challenge = issue(f, p.id),
			signed = envelope(f, challenge);
		await expect(f.challenges.accept({} as never, challenge.kind, signed)).rejects.toMatchObject({
			code: "DEVICE_REFUSED",
		});
		expect(native.auditActions(f.native)).not.toContain("pin.verified");
		expect(await f.challenges.accept(f.device.peer, challenge.kind, signed)).toEqual({
			kind: challenge.kind,
			id: p.id,
		});
		expect(f.target.write((db) => f.target.item(db, p.id))?.state).toBe("APPROVED");
		expect(counts(f)).toEqual({ challenges: 1, approvals: 1, failures: 0 });
		expect(
			f.native.store.read((db) =>
				db.get<{ consumed_at: number; signature: string }>(
					"SELECT consumed_at,signature FROM main.approval_challenges WHERE statement=?",
					[Buffer.from(challenge.statement, "base64url")],
				),
			),
		).toEqual({ consumed_at: f.time.wall, signature: signed.signature });
		expect(
			f.native.store.read((db) =>
				db.get<{ n: number }>("SELECT COUNT(*) AS n FROM main.events WHERE kind='outbox.changed'"),
			)?.n,
		).toBe(2);
		expect(f.revisions.current(p.binding).lockId).not.toBeNull();
		await expect(f.challenges.accept(f.device.peer, challenge.kind, signed)).rejects.toMatchObject({
			code: "CHALLENGE_INVALID",
		});
	});
	it("checks ES256 before spending the PIN and burns a wrong-domain signature", async () => {
		const f = await setup(),
			p = proposal(f),
			challenge = issue(f, p.id),
			signed = envelope(f, challenge, "000000", undefined, "pair-confirm.v1");
		const [result] = await Promise.allSettled([
			f.challenges.accept(f.device.peer, challenge.kind, signed),
		]);
		expect(counts(f).failures).toBe(0);
		expect(
			native
				.auditActions(f.native)
				.filter((action) => ["pin.verified", "pin.failed", "pin.locked"].includes(action)),
		).toEqual([]);
		expect(result).toMatchObject({ status: "rejected", reason: { code: "SIGNATURE_INVALID" } });
		await expect(
			f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
		).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });
		expect(native.auditActions(f.native)).toContain("challenge.refused.signature_invalid");
	});
	it("requires a new challenge after a real wrong PIN and counts exactly one attempt", async () => {
		const f = await setup(),
			p = proposal(f),
			challenge = issue(f, p.id);
		await expect(
			f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge, "000000")),
		).rejects.toMatchObject({ code: "PIN_REFUSED", detail: "PIN_INVALID" });
		expect(counts(f)).toEqual({ challenges: 1, approvals: 0, failures: 1 });
		await expect(
			f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
		).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });
		const replacement = issue(f, p.id);
		await expect(
			f.challenges.accept(f.device.peer, replacement.kind, envelope(f, replacement)),
		).resolves.toMatchObject({ id: p.id });
		expect(counts(f).failures).toBe(0);
	});
	it("refuses missing PINs and hostile envelopes without invoking accessors", async () => {
		const f = await setup(),
			p = proposal(f),
			challenge = issue(f, p.id),
			signed = envelope(f, challenge);
		const { pin: _, ...missing } = signed;
		let touched = 0;
		for (const bad of [
			missing,
			new Proxy(
				{},
				{
					get() {
						touched++;
						throw new Error();
					},
				},
			),
			Object.defineProperty({}, "statement", {
				get() {
					touched++;
					return signed.statement;
				},
			}),
		])
			await expect(f.challenges.accept(f.device.peer, challenge.kind, bad)).rejects.toMatchObject({
				code: "INVALID_REQUEST",
			});
		expect(touched).toBe(0);
		expect(counts(f).failures).toBe(0);
	});
	it("binds issued bytes, audience, epoch, device, nonce and the entire send window", async () => {
		const f = await setup(),
			p = proposal(f),
			challenge = issue(f, p.id),
			bytes = Buffer.from(challenge.statement, "base64url"),
			statement = JSON.parse(bytes.toString());
		for (const changes of [
			{ hub: "b".repeat(64) },
			{ epoch: statement.epoch + 1 },
			{ device: p.id },
			{ nonce: Buffer.alloc(16, 1).toString("base64url") },
			{ iat: statement.iat + 1, exp: statement.exp + 1 },
			{ contentHash: "c".repeat(64) },
			{ flagsHash: "d".repeat(64) },
			{ deliverBy: statement.deliverBy + 1 },
			{ flagsAcked: ["EXTERNAL_LINK"] },
		]) {
			const [result] = await Promise.allSettled([
				f.challenges.accept(
					f.device.peer,
					challenge.kind,
					envelope(f, challenge, native.PIN, changes),
				),
			]);
			expect(counts(f).failures).toBe(0);
			expect(native.auditActions(f.native)).not.toContain("pin.verified");
			expect(result).toMatchObject({ status: "rejected", reason: { code: "CHALLENGE_INVALID" } });
		}
		const noncanonical = {
			...envelope(f, challenge),
			statement: Buffer.from(` ${canonicalize(statement)}`).toString("base64url"),
		};
		await expect(
			f.challenges.accept(f.device.peer, challenge.kind, noncanonical),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		expect(counts(f).failures).toBe(0);
		expect(native.auditActions(f.native)).not.toContain("pin.verified");
		await expect(
			f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
		).resolves.toMatchObject({ id: p.id });
	});
	it("allows only one simultaneous accept and one Argon2 attempt", async () => {
		const f = await setup(),
			p = proposal(f),
			challenge = issue(f, p.id),
			signed = envelope(f, challenge, "000000");
		const result = await Promise.allSettled([
			f.challenges.accept(f.device.peer, challenge.kind, signed),
			f.challenges.accept(f.device.peer, challenge.kind, signed),
		]);
		expect(
			result.map((r) => (r.status === "rejected" ? r.reason.code : "accepted")).sort(),
		).toEqual(["CHALLENGE_INVALID", "PIN_REFUSED"]);
		expect(counts(f).failures).toBe(1);
	});
	it("cannot revive a persisted challenge in a replacement service", async () => {
		const f = await setup(),
			p = proposal(f),
			challenge = issue(f, p.id);
		const next = new ChallengeService(
			f.native.store,
			f.native.audit,
			f.native.pins,
			f.native.registry,
			f.native.authorizer,
			{ identity: f.native.identity, clock: f.clock, send: f.verifier },
		);
		await expect(
			next.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
		).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });
		await expect(
			f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
		).rejects.toMatchObject({ code: "UNAVAILABLE" });
		expect(counts(f).approvals).toBe(0);
		next.lock();
	});
	it("keeps the same challenge retryable when a genuine PIN attempt cannot be recorded", async () => {
		const f = await setup(),
			p = proposal(f),
			challenge = issue(f, p.id),
			signed = envelope(f, challenge);
		f.native.store.write((tx) =>
			tx.run("UPDATE main.dytest_challenge_faults SET pin_record=1 WHERE singleton=1"),
		);
		await expect(f.challenges.accept(f.device.peer, challenge.kind, signed)).rejects.toMatchObject({
			code: "PIN_REFUSED",
			detail: "PIN_REQUIRED",
			wire: "UNAVAILABLE",
		});
		expect(
			f.native.store.read((db) =>
				db.get<{ burned_at: number | null }>(
					"SELECT burned_at FROM main.approval_challenges WHERE statement=?",
					[Buffer.from(challenge.statement, "base64url")],
				),
			)?.burned_at,
		).toBeNull();
		f.native.store.write((tx) =>
			tx.run("UPDATE main.dytest_challenge_faults SET pin_record=0 WHERE singleton=1"),
		);
		await expect(f.challenges.accept(f.device.peer, challenge.kind, signed)).resolves.toMatchObject(
			{ id: p.id },
		);
	});
	it.each(["wall", "mono"] as const)(
		"refuses expired %s time with the other clock fixed",
		async (field) => {
			const f = await setup(),
				p = proposal(f),
				challenge = issue(f, p.id);
			f.time[field] += 120_001;
			await expect(
				f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
			).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });
			expect(counts(f).approvals).toBe(0);
		},
	);
	it("refuses every nonaccepted kind before native peer, envelope, PIN or storage", async () => {
		const f = await setup(),
			before = counts(f),
			actions = native.auditActions(f.native);
		for (const kind of [
			"admin.v1",
			"agent-session.v1",
			"login.v1",
			"send-receipt.v1",
			"consent.v1",
			"send-ticket.v1",
			"hub-key-rotate.v1",
			"__proto__",
			"",
		])
			await expect(f.challenges.accept({} as never, kind, {})).rejects.toMatchObject({
				code: "KIND_UNAVAILABLE",
				wire: "INVALID_REQUEST",
			});
		expect(counts(f)).toEqual(before);
		expect(native.auditActions(f.native)).toEqual(actions);
		expect(Object.isFrozen(STATEMENT_KIND_DISPOSITIONS)).toBe(true);
		expect(new ChallengeError("KIND_UNAVAILABLE").wire).toBe("INVALID_REQUEST");
	});
	it("replaces one target at the per-device bound and sweeps monotonic expiry", async () => {
		const f = await setup(),
			items = Array.from({ length: 17 }, () => proposal(f));
		const firstItem = items[0],
			lastItem = items[16];
		if (!firstItem || !lastItem) throw new Error("Missing bounded challenge fixture");
		const first = issue(f, firstItem.id);
		for (const item of items.slice(1, 16)) issue(f, item.id);
		expect(() => issue(f, lastItem.id)).toThrow("UNAVAILABLE");
		const replacement = issue(f, firstItem.id);
		await expect(
			f.challenges.accept(f.device.peer, first.kind, envelope(f, first)),
		).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });
		expect(replacement.id).toBe(first.id);
		expect(replacement.statement).not.toBe(first.statement);
		f.time.mono += 120_001;
		expect(issue(f, lastItem.id).kind).toBe("approval.send.v1");
	});
	it("uses fixed challenge and pair-operation request refusals without creating rows", async () => {
		const f = await setup(),
			id = native.idOf(f.device);
		for (const kind of ["login.v1", "consent.v1", "admin.v1"])
			expect(() => f.challenges.issue(f.device.peer, { kind, id })).toThrow("KIND_UNAVAILABLE");
		expect(() => f.challenges.issue({} as never, { kind: "admin.v1", id: "x" })).toThrow(
			"KIND_UNAVAILABLE",
		);
		expect(() => f.challenges.issue({} as never, { kind: "admin.v1", id, flagsAcked: [] })).toThrow(
			"KIND_UNAVAILABLE",
		);
		expect(() => f.challenges.issue(f.device.peer, { kind: "agent-session.v1", id })).toThrow(
			"KIND_UNAVAILABLE",
		);
		expect(() =>
			f.challenges.openPairConfirmation(f.device.peer, { kind: "devices.revoke", ids: [id] }),
		).toThrow();
		expect(() =>
			f.challenges.openPairConfirmation(f.device.peer, {
				kind: "pair-confirm",
				ids: [id],
				preset: "desktop",
			}),
		).toThrow("NOT_FOUND");
		expect(
			f.native.store.read((db) =>
				db.get<{ n: number }>("SELECT COUNT(*) AS n FROM main.pair_confirm_operations"),
			)?.n,
		).toBe(0);
		expect(counts(f).challenges).toBe(0);
	});
	it("keeps Argon2 outside the store transaction and rechecks revocation after awaiting policy", async () => {
		let entered!: () => void, release!: (value: { kind: "require"; approvals: number }) => void;
		const waiting = new Promise<void>((resolve) => {
				entered = resolve;
			}),
			policy = {
				id: "DYTEST held",
				evaluate: async () => {
					entered();
					return new Promise<{ kind: "require"; approvals: number }>((resolve) => {
						release = resolve;
					});
				},
			};
		const f = await fixture(policy);
		fixtures.push(f);
		const p = proposal(f),
			challenge = issue(f, p.id);
		const accepting = f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge));
		// A write and a read can run while the native Argon2 operation is in flight.
		f.native.store.write((tx) =>
			tx.run("UPDATE main.jobs_meta SET singleton=singleton WHERE singleton=1"),
		);
		expect(
			f.native.store.read((db) => db.get("SELECT singleton FROM main.hub_meta")),
		).toBeDefined();
		await waiting;
		const id = native.idOf(f.device),
			proof = await f.native.pins.verify(native.owner(f.native), native.PIN, revokePinScope(id));
		try {
			f.native.store.write((tx) => f.native.registry.revoke(tx, id, { kind: "device", id, proof }));
		} finally {
			f.native.pins.discard(proof);
		}
		release({ kind: "require", approvals: 1 });
		await expect(accepting).rejects.toMatchObject({
			code: "DEVICE_REFUSED",
			detail: "DEVICE_REVOKED",
		});
		expect(counts(f).approvals).toBe(0);
		expect(f.target.write((db) => f.target.item(db, p.id))?.state).toBe("PENDING_APPROVAL");
	});
	it("reviews and confirms a restored device only with genuine peer, signature and PIN authority", async () => {
		const { f, candidate, approver, service, operation, challenge, signed } = await pairing();
		expect(service.reviewPairConfirmation(approver.peer, operation.id)).toMatchObject({
			kind: "pair-confirm",
			subject: { candidate, sas: "123456" },
		});
		expect(challenge.id).toBe(operation.id);
		await expect(service.accept(approver.peer, "approval.send.v1", signed)).rejects.toMatchObject({
			code: "INVALID_REQUEST",
		});
		for (const changes of [
			{ candidate: native.idOf(approver) },
			{ epoch: 999 },
			{ transportSpkiSha256: "b".repeat(64) },
			{ capabilities: ["read"] },
		])
			await expect(
				service.accept(
					approver.peer,
					challenge.kind,
					envelope(f, challenge, native.PIN, changes, challenge.kind, approver),
				),
			).rejects.toThrow();
		await expect(service.accept(approver.peer, challenge.kind, signed)).resolves.toEqual({
			kind: challenge.kind,
			id: operation.id,
		});
		expect(
			f.native.store.read(
				(db) => f.native.authorizer.requirePeerDevice(db, f.device.peer, "approve").deviceId,
			),
		).toBe(candidate);
		await expect(service.accept(approver.peer, challenge.kind, signed)).rejects.toMatchObject({
			code: "CHALLENGE_INVALID",
		});
	});
	it("accepts only one simultaneous pair confirmation", async () => {
		const { f, approver, service, challenge, signed } = await pairing();
		const results = await Promise.allSettled([
			service.accept(approver.peer, challenge.kind, signed),
			service.accept(approver.peer, challenge.kind, signed),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(
			native.auditActions(f.native).filter((action) => action === "pin.verified"),
		).toHaveLength(1);
	});
	it.each([false, true])(
		"keeps the older pair operation deadline after SAS data work (jump=%s)",
		async (jump) => {
			let reached = 0,
				jumped = false;
			const { f, candidate, approver, service, operation, challenge, signed } = await pairing({
				operationAgeMs: 119_000,
				onAcceptSas: (current) => {
					reached++;
					if (jump && !jumped) {
						jumped = true;
						current.time.mono += 2_000;
					}
				},
			});
			const before = { ...f.time };
			const [result] = await Promise.allSettled([
				service.accept(approver.peer, challenge.kind, signed),
			]);
			expect(reached).toBeGreaterThan(0);
			expect(jumped).toBe(jump);
			expect(f.time.wall).toBe(before.wall);
			expect(f.time.mono - before.mono).toBe(jump ? 2_000 : 0);
			if (jump) {
				expect(result?.status).toBe("rejected");
				expect(() =>
					f.native.store.read((db) =>
						f.native.authorizer.requirePeerDevice(db, f.device.peer, "approve"),
					),
				).toThrow("DEVICE_PENDING");
				expect(
					f.native.store.read((db) =>
						db.get<{ used_at: number | null }>(
							"SELECT used_at FROM main.pair_confirm_operations WHERE id=?",
							[operation.id],
						),
					)?.used_at,
				).toBeNull();
				expect(
					f.native.store.read((db) =>
						db.get<{ consumed_at: number | null; signature: string | null }>(
							"SELECT consumed_at,signature FROM main.approval_challenges WHERE statement=?",
							[Buffer.from(challenge.statement, "base64url")],
						),
					),
				).toEqual({ consumed_at: null, signature: null });
			} else {
				expect(result).toMatchObject({
					status: "fulfilled",
					value: { kind: challenge.kind, id: operation.id },
				});
				expect(
					f.native.store.read(
						(db) => f.native.authorizer.requirePeerDevice(db, f.device.peer, "approve").deviceId,
					),
				).toBe(candidate);
				expect(
					f.native.store.read((db) =>
						db.get<{ used_at: number | null }>(
							"SELECT used_at FROM main.pair_confirm_operations WHERE id=?",
							[operation.id],
						),
					)?.used_at,
				).toBe(before.wall);
			}
		},
	);
	it("refuses review and challenge when retained SAS data is unavailable", async () => {
		const { f, approver, operation, candidate } = await pairing();
		const next = new ChallengeService(
			f.native.store,
			f.native.audit,
			f.native.pins,
			f.native.registry,
			f.native.authorizer,
			{ identity: f.native.identity, send: f.verifier, clock: f.clock },
		);
		pairServices.push(next);
		expect(() =>
			next.openPairConfirmation(approver.peer, {
				kind: "pair-confirm",
				ids: [candidate],
				preset: "desktop",
			}),
		).toThrow("NOT_FOUND");
		expect(() => next.reviewPairConfirmation(approver.peer, operation.id)).toThrow("NOT_FOUND");
		expect(() => next.issue(approver.peer, { kind: "pair-confirm.v1", id: operation.id })).toThrow(
			"NOT_FOUND",
		);
	});
	it("binds pair confirmation to both original clock limits and accepts their exact upper bound", async () => {
		const { f, approver, service, challenge, signed } = await pairing(),
			start = { ...f.time };
		for (const time of [
			{ wall: start.wall - 1, mono: start.mono },
			{ wall: start.wall + 120001, mono: start.mono },
			{ wall: start.wall, mono: start.mono + 120001 },
		]) {
			Object.assign(f.time, time);
			await expect(service.accept(approver.peer, challenge.kind, signed)).rejects.toMatchObject({
				code: "CHALLENGE_INVALID",
			});
		}
		Object.assign(f.time, { wall: start.wall + 120000, mono: start.mono + 120000 });
		await expect(service.accept(approver.peer, challenge.kind, signed)).resolves.toMatchObject({
			kind: challenge.kind,
		});
	});
	it("rolls back native confirmation, operation and challenge together on a final SQL refusal", async () => {
		const { f, approver, service, challenge, signed } = await pairing();
		f.native.store.write((tx) =>
			tx.run("UPDATE main.dytest_challenge_faults SET pair_commit=1 WHERE singleton=1"),
		);
		await expect(service.accept(approver.peer, challenge.kind, signed)).rejects.toMatchObject({
			wire: "UNAVAILABLE",
		});
		expect(() =>
			f.native.store.read((db) =>
				f.native.authorizer.requirePeerDevice(db, f.device.peer, "approve"),
			),
		).toThrow("DEVICE_PENDING");
		expect(
			f.native.store.read((db) =>
				db.get<{ consumed_at: number | null }>(
					"SELECT consumed_at FROM main.approval_challenges WHERE statement=?",
					[Buffer.from(challenge.statement, "base64url")],
				),
			)?.consumed_at,
		).toBeNull();
		expect(native.auditActions(f.native)).not.toContain("pair_confirm.accepted");
	});
	it("rechecks the native epoch after the pairing PIN await", async () => {
		const { f, approver, service, challenge, signed } = await pairing();
		const accepting = service.accept(approver.peer, challenge.kind, signed);
		f.native.store.write((tx) => advanceEpochForRestore(f.native.registry, tx));
		await expect(accepting).rejects.toMatchObject({ code: "DEVICE_REFUSED" });
		expect(native.auditActions(f.native)).not.toContain("pair_confirm.accepted");
	});
});
