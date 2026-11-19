import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import { expect } from "vitest";
import {
	consumeNativeBackupLease,
	takeNativeBackupLease,
} from "../../src/identity/backup-operations.ts";
import {
	BACKUP_ARTIFACT_HEADER_SIZE,
	decodeBackupArtifactHeader,
} from "../../src/recovery/backup-artifact.ts";
import {
	type NativeBackupArtifact,
	openNativeBackupArtifacts,
} from "../../src/recovery/backup-artifact-native.ts";
import { verifyRecoveryBinding } from "../../src/recovery/backup-bindings.ts";
import { openNativeBackupRecovery } from "../../src/recovery/backup-recovery.ts";
import { openRecoveryBytes } from "../../src/recovery/recovery-code.ts";
import type { TestDevice } from "../authz/native-fixture.ts";
import {
	type NativeBackupFixture,
	nativeBackupFixture,
	originalKeyErased,
} from "../identity/native-backup-fixture.ts";

const openFile = fs.open;
export interface RestoreArtifactFacts {
	readonly imageLength: number;
	readonly sourceDevice: TestDevice;
	readonly sourceIdentity: Readonly<{
		hid: string;
		statementKey: string;
		certificateHash: string;
		owner: string;
		epoch: number;
		users: number;
		deviceId: string;
		pin: string;
	}>;
	readonly sourceAccountData: Readonly<{
		id: string;
		generation: number;
		events: number;
		audit: number;
	}>;
}

/** The original signed artifact setup, shared by preparation and complete-restore tests. */
export function selectedRestoreArtifact(
	artifact: string,
	code: Buffer,
): {
	readonly ready: Promise<RestoreArtifactFacts>;
	close(): Promise<void>;
} {
	let opening: Promise<NativeBackupFixture> | undefined;
	let fixture: NativeBackupFixture | undefined;
	let produced: NativeBackupArtifact | undefined;
	let output: FileHandle | undefined;
	let header: ReturnType<typeof decodeBackupArtifactHeader> | undefined;
	let closing: Promise<void> | undefined;
	let uncertain = false;
	function closeKnown(): Promise<void> {
		if (closing) return closing;
		closing = Promise.resolve().then(async () => {
			const results = await Promise.allSettled([
				...(output ? [Promise.resolve().then(() => output!.close())] : []),
				...(produced ? [Promise.resolve().then(() => produced!.close())] : []),
				...(fixture ? [Promise.resolve().then(() => fixture!.close())] : []),
			]);
			if (results.some((result) => result.status === "rejected")) uncertain = true;
			if (opening && !fixture) uncertain = true;
			if (fixture) {
				const erased = originalKeyErased(fixture.key);
				if (!erased) uncertain = true;
				expect(erased).toBe(true);
			}
			if (uncertain) throw new Error("DYTEST original artifact cleanup retained");
		});
		void closing.catch(() => {
			closing = undefined;
		});
		return closing;
	}
	const ready = Promise.resolve().then(async () => {
		try {
			opening = nativeBackupFixture();
			const f = await opening;
			fixture = f;
			await openNativeBackupRecovery(f.session).enroll(code);
			const state = f.session.devices.currentState();
			const oldId = f.owner.device.id;
			if (state.ownerUserId === null || !oldId)
				throw new Error("DYTEST original owner identity unavailable");
			const sourceDevice = f.owner.device;
			const sourceIdentity = Object.freeze({
				hid: f.session.identity.hid,
				statementKey: f.session.identity.statementKey,
				certificateHash: createHash("sha256").update(f.session.identity.certificate).digest("hex"),
				owner: state.ownerUserId,
				epoch: state.epoch,
				users: f.session.store.read(
					(db) => db.get<{ n: number }>("SELECT count(*) AS n FROM main.users")?.n ?? -1,
				),
				deviceId: oldId,
				pin: f.pin,
			});
			const accountRows = f.session.store.read((db) =>
				db.all<{ id: unknown; user_id: unknown }>(
					"SELECT id,user_id FROM main.accounts ORDER BY id LIMIT 2",
				),
			);
			const originalAccount = accountRows[0];
			if (
				accountRows.length !== 1 ||
				!originalAccount ||
				typeof originalAccount.id !== "string" ||
				originalAccount.user_id !== state.ownerUserId
			)
				throw new Error("DYTEST original account DATA unavailable");
			// Finish the backup challenge before creating the account approval coordinator.
			const issued = f.issue();
			const accepted = await f.accept(issued.envelope);
			expect(accepted.kind === "admin.v1" && accepted.id === issued.review.id).toBe(true);
			const lease = takeNativeBackupLease(f.operations, f.owner.device.peer, issued.review.id);
			const execution = consumeNativeBackupLease(lease, f.session);
			const before = f.evidence();
			expect(before.accountMode === "read_only").toBe(true);
			const approvals = f.session.accountApprovals();
			const review = approvals.open(f.owner.device.peer, {
				kind: "account.mode-full",
				ids: [originalAccount.id],
			});
			const challenge = approvals.issue(f.owner.device.peer, review.id);
			const envelope = f.owner.client.envelope({
				challenge,
				review,
				request: { kind: "admin.v1", id: review.id },
				device: oldId,
				pin: f.pin,
			});
			const acceptedMode = await approvals.accept(f.owner.device.peer, envelope);
			expect(acceptedMode.kind === "admin.v1" && acceptedMode.id === review.id).toBe(true);
			const full = f.evidence();
			expect(
				full.accountMode === "full" &&
					full.accountGeneration === before.accountGeneration + 1 &&
					full.accountAudit === before.accountAudit + 1 &&
					full.accountEvents === before.accountEvents + 1,
			).toBe(true);
			const sourceAccountData = Object.freeze({
				id: originalAccount.id,
				generation: full.accountGeneration,
				events: full.accountEvents,
				audit: full.accountAudit,
			});
			produced = await openNativeBackupArtifacts(f.session).create(execution, f.owner.device.peer);
			expect(
				Number.isSafeInteger(produced.byteLength) &&
					produced.byteLength > BACKUP_ARTIFACT_HEADER_SIZE,
			).toBe(true);
			const imageLength = produced.byteLength - BACKUP_ARTIFACT_HEADER_SIZE;
			const whole = createHash("sha256");
			const body = createHash("sha256");
			let bytes = 0;
			output = await openFile(artifact, "wx", 0o600);
			for await (const chunk of produced.bytes(f.owner.device.peer)) {
				try {
					whole.update(chunk);
					if (bytes === 0) {
						expect(chunk.byteLength === BACKUP_ARTIFACT_HEADER_SIZE).toBe(true);
						header = decodeBackupArtifactHeader(chunk);
						expect(header.byteLength === imageLength).toBe(true);
					} else body.update(chunk);
					for (let offset = 0; offset < chunk.byteLength; ) {
						const written = await output.write(chunk, offset, chunk.byteLength - offset);
						if (written.bytesWritten <= 0) throw new Error("DYTEST artifact write incomplete");
						offset += written.bytesWritten;
					}
					bytes += chunk.byteLength;
				} finally {
					chunk.fill(0);
				}
			}
			await output.sync();
			expect(
				bytes === produced.byteLength && (await output.stat()).size === produced.byteLength,
			).toBe(true);
			expect(whole.digest("hex") === produced.sha256).toBe(true);
			if (!header) throw new Error("DYTEST original artifact header missing");
			expect(body.digest("hex") === header.sha256).toBe(true);
			const recovered = openRecoveryBytes(header.capsule, code);
			try {
				expect(() => f.session.store.assertMasterKey(recovered)).not.toThrow();
				expect(verifyRecoveryBinding(recovered, header.capsule, header.binding)).toBe(true);
			} finally {
				recovered.destroy();
			}
			return Object.freeze({ imageLength, sourceDevice, sourceIdentity, sourceAccountData });
		} finally {
			header?.capsule.fill(0);
			header?.binding.fill(0);
			await closeKnown();
		}
	});
	void ready.catch(() => undefined);
	return Object.freeze({
		ready,
		async close() {
			await ready.catch(() => undefined);
			await closeKnown();
		},
	});
}
