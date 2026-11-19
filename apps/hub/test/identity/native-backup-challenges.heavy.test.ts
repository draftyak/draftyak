import { afterEach, expect, it, vi } from "vitest";
import { NativeAdminError } from "../../src/identity/admin-errors.ts";
import type { ChallengeError as SourceChallengeError } from "../../src/identity/challenges.ts";
import type { NativeBackupFixture } from "./native-backup-fixture.ts";

interface PinHold {
	reached(): void;
	readonly released: Promise<void>;
}
const faults = vi.hoisted(() => ({
	nextPin: undefined as PinHold | undefined,
	abortAfterApply: false,
	applied: 0,
}));
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	const argon2: typeof actual.argon2 = (algorithm, params, callback) => {
		const hold = faults.nextPin;
		faults.nextPin = undefined;
		actual.argon2(algorithm, params, (error, output) => {
			if (!hold) callback(error, output);
			else {
				hold.reached();
				void hold.released.then(() => callback(error, output));
			}
		});
	};
	return { ...actual, argon2 };
});
vi.mock("../../src/identity/backup-operations.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/identity/backup-operations.ts")>();
	const applyNativeBackupOperation: typeof actual.applyNativeBackupOperation = (...args) => {
		// All four objects, including the private context, are the genuine original inputs.
		actual.applyNativeBackupOperation(...args);
		if (faults.abortAfterApply) {
			faults.applied++;
			actual.abortNativeBackupScope(args[0], args[2]);
		}
	};
	return { ...actual, applyNativeBackupOperation };
});

// Load the coordinator before the mock's original module can reach it through the issuer cycle.
const { ChallengeError } = await import("../../src/identity/challenges.ts");
const { takeNativeBackupLease } = await import("../../src/identity/backup-operations.ts");
const { nativeBackupFixture, resignBackup } = await import("./native-backup-fixture.ts");

const fixtures: NativeBackupFixture[] = [];
const releases = new Set<() => void>();
async function fixture(): Promise<NativeBackupFixture> {
	const f = await nativeBackupFixture();
	fixtures.push(f);
	return f;
}
afterEach(async () => {
	faults.nextPin = undefined;
	faults.abortAfterApply = false;
	for (const release of releases) release();
	releases.clear();
	const closed = await Promise.allSettled(fixtures.splice(0).map((f) => f.close()));
	if (closed.some((result) => result.status === "rejected"))
		throw new Error("DYTEST backup challenges cleanup incomplete");
});
function barrier() {
	let release = (): void => {};
	const open = new Promise<void>((resolve) => {
		release = resolve;
	});
	releases.add(release);
	return { open, release };
}
async function refused(promise: Promise<unknown>): Promise<SourceChallengeError> {
	let error: unknown,
		accepted = false;
	await promise.then(
		() => {
			accepted = true;
		},
		(reason: unknown) => {
			error = reason;
		},
	);
	expect(accepted).toBe(false);
	expect(error instanceof ChallengeError).toBe(true);
	return error as SourceChallengeError;
}
function noLease(f: NativeBackupFixture, id: string): void {
	let error: unknown;
	try {
		takeNativeBackupLease(f.operations, f.owner.device.peer, id);
	} catch (reason) {
		error = reason;
	}
	expect(error instanceof NativeAdminError).toBe(true);
}
function accountUnchanged(
	before: ReturnType<NativeBackupFixture["evidence"]>,
	after: ReturnType<NativeBackupFixture["evidence"]>,
): void {
	expect(after.accountMode).toBe(before.accountMode);
	expect(after.accountGeneration).toBe(before.accountGeneration);
	expect(after.accountEvents).toBe(before.accountEvents);
	expect(after.accountAudit).toBe(before.accountAudit);
}

it("accepts a genuine owner ES256 and scoped PIN once with only backup authorization CAS and audit effects", async () => {
	const f = await fixture(),
		issued = f.issue(),
		before = f.evidence(),
		row = f.operation(issued.review.id);
	const accepted = await f.accept(issued.envelope);
	expect(accepted.kind).toBe("admin.v1");
	expect(accepted.id === issued.review.id).toBe(true);
	const after = f.evidence();
	expect(after).toEqual({
		...before,
		applied: before.applied + 1,
		pendingOperations: before.pendingOperations - 1,
		appliedOperations: before.appliedOperations + 1,
		consumed: before.consumed + 1,
		pinVerified: before.pinVerified + 1,
	});
	expect(f.operation(issued.review.id).state).toBe("applied");
	expect(f.operation(issued.review.id).version > row.version).toBe(true);
	expect(f.auditFor(issued.review.id)).toEqual({ applied: 1, exactRefs: true });
	expect(
		f.session.store.read((sql) =>
			sql.get<{ n: number }>(
				"SELECT count(*) AS n FROM main.native_backup_challenges WHERE data_class<>'hub.state'",
			),
		)?.n,
	).toBe(0);
	await refused(f.accept(issued.envelope));
	expect(f.evidence()).toEqual(after);
});

it("refuses the wrong genuine PIN without applying backup state or publishing a lease", async () => {
	const f = await fixture(),
		issued = f.issue(),
		before = f.evidence(),
		row = f.operation(issued.review.id);
	const wrongPin = f.pin === "000000" ? "111111" : "000000";
	const error = await refused(f.accept({ ...issued.envelope, pin: wrongPin }));
	expect(error.code).toBe("PIN_REFUSED");
	const after = f.evidence();
	accountUnchanged(before, after);
	expect(after.pinFailed).toBe(before.pinFailed + 1);
	expect(after.applied).toBe(before.applied);
	expect(after.appliedOperations).toBe(before.appliedOperations);
	expect(after.consumed).toBe(before.consumed);
	expect(f.operation(issued.review.id).version).toBe(row.version);
	noLease(f, issued.review.id);
});

it("binds genuine signed backup bytes to the held digest, operation kind, signature and admin statement namespace", async () => {
	const f = await fixture();
	for (const fault of ["digest", "operation-kind", "signature", "statement-kind"] as const) {
		const issued = f.issue(),
			before = f.evidence(),
			row = f.operation(issued.review.id);
		const envelope =
			fault === "digest"
				? resignBackup(f, issued, { digest: "0".repeat(64) })
				: fault === "operation-kind"
					? resignBackup(f, issued, { kind: "account.mode-full" })
					: fault === "signature"
						? {
								...issued.envelope,
								signature: `${issued.envelope.signature[0] === "A" ? "B" : "A"}${issued.envelope.signature.slice(1)}`,
							}
						: issued.envelope;
		const error = await refused(
			fault === "statement-kind"
				? f.service.accept(f.owner.device.peer, "pair-confirm.v1", envelope)
				: f.accept(envelope),
		);
		expect(error.code === "PIN_REFUSED").toBe(false);
		const after = f.evidence();
		accountUnchanged(before, after);
		expect(after.applied).toBe(before.applied);
		expect(after.appliedOperations).toBe(before.appliedOperations);
		expect(after.consumed).toBe(before.consumed);
		expect(after.pinVerified).toBe(before.pinVerified);
		expect(after.pinFailed).toBe(before.pinFailed);
		expect(f.operation(issued.review.id).version).toBe(row.version);
		noLease(f, issued.review.id);
	}
});

it("rechecks the original native epoch after a genuinely pending Argon2 PIN verification", async () => {
	const f = await fixture(),
		issued = f.issue(),
		before = f.evidence(),
		row = f.operation(issued.review.id);
	const entered = barrier(),
		hold = barrier();
	faults.nextPin = { reached: entered.release, released: hold.open };
	const pending = f.accept(issued.envelope).then(
		() => ({ accepted: true, error: undefined }),
		(error: unknown) => ({ accepted: false, error }),
	);
	try {
		await Promise.race([
			entered.open,
			pending.then(() => {
				throw new Error("DYTEST backup acceptance ended before the real PIN barrier");
			}),
		]);
		f.session.store.write((tx) =>
			tx.run("UPDATE main.device_authority SET epoch=epoch+1,bootstrap_done=0 WHERE singleton=1"),
		);
		hold.release();
		const result = await pending;
		expect(result.accepted).toBe(false);
		expect(result.error instanceof ChallengeError).toBe(true);
		const after = f.evidence();
		accountUnchanged(before, after);
		expect(after.pinVerified).toBe(before.pinVerified + 1);
		expect(after.applied).toBe(before.applied);
		expect(after.appliedOperations).toBe(before.appliedOperations);
		expect(after.consumed).toBe(before.consumed);
		expect(f.operation(issued.review.id).state).toBe("pending");
		expect(f.operation(issued.review.id).version).toBe(row.version);
		noLease(f, issued.review.id);
	} finally {
		faults.nextPin = undefined;
		hold.release();
		await pending;
	}
});

it("rolls back a genuinely applied backup scope and publishes no lease when its native scope is aborted", async () => {
	const f = await fixture(),
		issued = f.issue(),
		before = f.evidence(),
		row = f.operation(issued.review.id);
	faults.applied = 0;
	faults.abortAfterApply = true;
	let accepted = false;
	let refusal: unknown;
	try {
		await f.accept(issued.envelope).then(
			() => {
				accepted = true;
			},
			(error: unknown) => {
				refusal = error;
			},
		);
	} finally {
		faults.abortAfterApply = false;
	}
	expect(faults.applied).toBe(1);
	expect(accepted).toBe(false);
	expect(refusal instanceof ChallengeError).toBe(true);
	const after = f.evidence();
	accountUnchanged(before, after);
	expect(after.pinVerified).toBe(before.pinVerified + 1);
	expect(after.applied).toBe(before.applied);
	expect(after.appliedOperations).toBe(before.appliedOperations);
	expect(after.consumed).toBe(before.consumed);
	expect(f.operation(issued.review.id).state).toBe("pending");
	expect(f.operation(issued.review.id).version).toBe(row.version);
	noLease(f, issued.review.id);
});
