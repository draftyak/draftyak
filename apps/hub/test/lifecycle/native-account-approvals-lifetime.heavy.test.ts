import { spawnSync } from "node:child_process";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { NativeAccounts } from "../../src/accounts/records.ts";
import { EventLog } from "../../src/events/log.ts";
import { WorkDatabase } from "../../src/jobs/database.ts";
import type { MasterKey } from "../../src/kernel/master-key.ts";
import type { HubSession } from "../../src/lifecycle/session.ts";
import {
	accountApprovalEvidence,
	issueAccountApproval,
	nativeAccountApprovalsFixture,
} from "../identity/native-account-approvals-fixture.ts";
import {
	expectErased,
	expectLocked,
	nativeBinding,
	refusal,
	refusalNow,
	sessionFixture,
} from "./session-helpers.ts";

interface KdfRecord {
	readonly input: NodeJS.ArrayBufferView;
	readonly salt: NodeJS.ArrayBufferView;
	output?: Buffer;
}
interface KdfHold {
	reached(): void;
	readonly released: Promise<void>;
	record?: KdfRecord;
}
const observed = vi.hoisted(() => ({
	next: undefined as KdfHold | undefined,
	derived: [] as { readonly label: string; readonly view: Uint8Array }[],
	firstDrafts: undefined as (() => void) | undefined,
	failDestroy: false,
	destroyAttempts: 0,
	destroyed: 0,
}));
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	const hkdfSync: typeof actual.hkdfSync = (...args) => {
		const output = actual.hkdfSync(...args);
		const info = args[3];
		if (
			info === "draftyak/v1/drafts" ||
			info === "draftyak/v1/outbox" ||
			info === "draftyak/v1/approvals"
		)
			// MasterKey's Buffer.from(ArrayBuffer) shares this exact original output memory.
			observed.derived.push({ label: info, view: new Uint8Array(output) });
		if (info === "draftyak/v1/drafts") {
			const firstDrafts = observed.firstDrafts;
			observed.firstDrafts = undefined;
			firstDrafts?.();
		}
		return output;
	};
	const argon2: typeof actual.argon2 = (algorithm, params, callback) => {
		const held = observed.next;
		observed.next = undefined;
		const record: KdfRecord = {
			input: params.message as NodeJS.ArrayBufferView,
			salt: params.nonce as NodeJS.ArrayBufferView,
		};
		if (held) held.record = record;
		actual.argon2(algorithm, params, (error, output) => {
			record.output = output;
			if (!held) callback(error, output);
			else {
				held.reached();
				void held.released.then(() => callback(error, output));
			}
		});
	};
	return { ...actual, hkdfSync, argon2 };
});
vi.mock("../../src/drafts/revisions.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/drafts/revisions.ts")>();
	const destroy = actual.NativeDraftRevisions.prototype.destroy;
	class ObservedRevisions extends actual.NativeDraftRevisions {
		override destroy(): void {
			observed.destroyAttempts++;
			if (observed.failDestroy) throw new Error("DYTEST revision cleanup unavailable");
			destroy.call(this);
			observed.destroyed++;
		}
	}
	return { ...actual, NativeDraftRevisions: ObservedRevisions };
});

function barrier() {
	let release = (): void => {};
	const open = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { open, release };
}

function erased(view: NodeJS.ArrayBufferView | undefined): boolean {
	if (!view) throw new Error("Missing genuine KDF buffer");
	return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).every((byte) => byte === 0);
}

function expectKeyUsable(key: MasterKey): void {
	const derived = key.derive("db");
	try {
		expect(derived.byteLength).toBe(32);
	} finally {
		derived.fill(0);
	}
}

function contender(folder: string): string {
	const env: NodeJS.ProcessEnv = {};
	for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
		if (process.env[name] !== undefined) env[name] = process.env[name];
	const run = spawnSync(
		process.execPath,
		[
			"--disable-sigusr1",
			path.join(import.meta.dirname, "../kernel/fixtures/data-folder-child.ts"),
			"try",
			folder,
			nativeBinding,
		],
		{ env, encoding: "utf8", maxBuffer: 65_536, timeout: 60_000, windowsHide: true, shell: false },
	);
	expect(run.error).toBeUndefined();
	expect(run.status, run.stderr).toBe(0);
	const outcome = JSON.parse(run.stdout) as { result: string; ms: number };
	expect(Number.isFinite(outcome.ms)).toBe(true);
	return outcome.result;
}

it("fences account approvals immediately and drains real PIN acceptance before releasing the session", async () => {
	observed.derived.length = 0;
	const f = await nativeAccountApprovalsFixture();
	// Exclude already-erased per-call derivations; retain all live original graph buffers.
	const graphKeys = observed.derived.filter(({ view }) => !erased(view));
	const { review, envelope } = issueAccountApproval(f);
	const before = f.current(),
		evidence = accountApprovalEvidence(f);
	const reached = barrier(),
		held = barrier();
	const hold: KdfHold = { reached: reached.release, released: held.open };
	observed.next = hold;
	let accepted = false;
	const outcome = Promise.resolve()
		.then(() => f.approvals.accept(f.owner.device.peer, envelope))
		.then(
			() => {
				accepted = true;
				return undefined;
			},
			(error: unknown) => error,
		);
	let closing: Promise<void> | undefined;
	try {
		expect(new Set(graphKeys.map(({ label }) => label))).toEqual(
			new Set(["draftyak/v1/drafts", "draftyak/v1/outbox", "draftyak/v1/approvals"]),
		);
		for (const { view } of graphKeys) expect(erased(view)).toBe(false);
		await Promise.race([
			reached.open,
			outcome.then(() => {
				throw new Error("Acceptance ended before genuine PIN verification reached the barrier");
			}),
		]);
		expect(hold.record !== undefined).toBe(true);
		expect(erased(hold.record?.output)).toBe(false);
		for (const { view } of graphKeys) expect(erased(view)).toBe(false);
		let settled = false;
		closing = f.session.close();
		const completion = closing.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		expect(f.session.close()).toBe(closing);
		expect(() => f.session.accountApprovals()).toThrow("SESSION_UNAVAILABLE");
		expect(() => f.approvals.review(f.owner.device.peer, review.id)).toThrow("SESSION_UNAVAILABLE");
		expect(() => f.approvals.issue(f.owner.device.peer, review.id)).toThrow("SESSION_UNAVAILABLE");
		expect(() => f.approvals.accept(f.owner.device.peer, envelope)).toThrow("SESSION_UNAVAILABLE");
		expect(() => f.session.devices.currentState()).toThrow("UNAVAILABLE");
		expect(() => f.session.identity.tlsPrivateKey()).toThrow("Hub is locked");
		await checkpoint();
		expect(settled).toBe(false);
		expect(f.session.store.read((sql) => sql.get("SELECT 1 AS alive"))).toEqual({ alive: 1 });
		expectKeyUsable(f.key);
		expect(f.current()).toEqual(before);
		expect(contender(f.storage.folder)).toBe("DATA_DIR_LOCKED");
		expect(erased(hold.record?.output)).toBe(false);
		held.release();
		expect(await outcome).toBeInstanceOf(Error);
		expect(accepted).toBe(false);
		await completion;
		await closing;
		expect(settled).toBe(true);
		for (const { view } of graphKeys) expect(erased(view)).toBe(true);
		for (const material of [hold.record?.input, hold.record?.salt, hold.record?.output])
			expect(erased(material)).toBe(true);
		await expectLocked(f.session);
		expectErased(f.key);
		expect(() => f.session.accountApprovals()).toThrow("SESSION_UNAVAILABLE");
		expect(() => f.approvals.review(f.owner.device.peer, review.id)).toThrow("SESSION_UNAVAILABLE");
		expect(contender(f.storage.folder)).toBe("admitted");
		const reopened = await f.storage.open();
		expect(accountApprovalEvidence({ session: reopened })).toEqual(evidence);
		const database = new WorkDatabase(reopened.store);
		const accounts = new NativeAccounts(
			database,
			new EventLog(database, Date.now),
			reopened.audit,
			Date.now,
		);
		expect(
			database.write((scope) => accounts.get(scope, before.account.userId, before.account.id)),
		).toEqual(before);
		expect(reopened.accountApprovals()).not.toBe(f.approvals);
		reopened.store.read((sql) => reopened.audit.verify(sql));
	} finally {
		observed.next = undefined;
		held.release();
		await outcome;
		try {
			await closing;
		} finally {
			try {
				await f.close();
			} finally {
				observed.derived.length = 0;
				graphKeys.length = 0;
			}
		}
	}
});

it("retains the original session until a close reentered during the first drafts derivation drains", async () => {
	observed.derived.length = 0;
	const storage = sessionFixture("draftyak-account-init-close-");
	const key = storage.key();
	let session: HubSession | undefined;
	let closing: Promise<void> | undefined;
	let started = 0;
	let settled = false;
	try {
		session = await storage.open({ masterKey: key });
		const original = session;
		observed.firstDrafts = () => {
			started++;
			closing = original.close();
			void closing.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
		};
		const error = refusalNow(() => original.accountApprovals());
		expect(error.code).toBe("SESSION_UNAVAILABLE");
		expect(error.message).toBe("SESSION_UNAVAILABLE");
		expect(started).toBe(1);
		expect(observed.firstDrafts).toBeUndefined();
		const pendingClose = closing;
		if (!pendingClose) throw new Error("Genuine initialization close was not reached");
		expect(original.close()).toBe(pendingClose);
		expect(settled).toBe(false);
		let alive: unknown;
		expect(() => {
			alive = original.store.read((sql) => sql.get("SELECT 1 AS alive"));
		}).not.toThrow();
		expect(alive).toEqual({ alive: 1 });
		expectKeyUsable(key);
		const partialKeys = [...observed.derived];
		expect(partialKeys.map(({ label }) => label)).toEqual(["draftyak/v1/drafts"]);
		await pendingClose;
		expect(settled).toBe(true);
		for (const { view } of partialKeys) expect(erased(view)).toBe(true);
		expectErased(key);
		await expectLocked(original);
		expect(contender(storage.folder)).toBe("admitted");
		const reopened = await storage.open();
		expect(reopened.store.read((sql) => sql.get("SELECT 1 AS alive"))).toEqual({ alive: 1 });
		expect(Object.isFrozen(reopened.accountApprovals())).toBe(true);
		reopened.store.read((sql) => reopened.audit.verify(sql));
	} finally {
		observed.firstDrafts = undefined;
		observed.failDestroy = false;
		try {
			await closing;
		} finally {
			try {
				await session?.close();
			} finally {
				await storage.remove();
				observed.derived.length = 0;
			}
		}
	}
});

it("retries retained genuine revision cleanup after a failed close has erased the original master key", async () => {
	observed.derived.length = 0;
	observed.destroyAttempts = 0;
	observed.destroyed = 0;
	const storage = sessionFixture("draftyak-account-cleanup-retry-");
	const key = storage.key();
	let session: HubSession | undefined;
	try {
		session = await storage.open({ masterKey: key });
		const original = session;
		const approvals = original.accountApprovals();
		const graphKeys = observed.derived.filter(({ view }) => !erased(view));
		expect(new Set(graphKeys.map(({ label }) => label))).toEqual(
			new Set(["draftyak/v1/drafts", "draftyak/v1/outbox", "draftyak/v1/approvals"]),
		);
		for (const { view } of graphKeys) expect(erased(view)).toBe(false);
		observed.failDestroy = true;
		const firstClose = original.close();
		expect(original.close()).toBe(firstClose);
		const error = await refusal(firstClose);
		expect(error.code).toBe("CLOSE_INCOMPLETE");
		expect(observed.destroyAttempts).toBeGreaterThan(0);
		expect(observed.destroyed).toBe(0);
		expectErased(key);
		expect(original.store.read((sql) => sql.get("SELECT 1 AS alive"))).toEqual({ alive: 1 });
		expect(() => original.accountApprovals()).toThrow("SESSION_UNAVAILABLE");
		expect(Object.isFrozen(approvals)).toBe(true);
		expect(contender(storage.folder)).toBe("DATA_DIR_LOCKED");
		for (const { label, view } of graphKeys)
			expect(erased(view)).toBe(label !== "draftyak/v1/drafts");
		const derivations = observed.derived.length;
		observed.failDestroy = false;
		const retry = original.close();
		expect(retry).not.toBe(firstClose);
		expect(original.close()).toBe(retry);
		await retry;
		expect(observed.destroyed).toBe(1);
		expect(observed.derived.length).toBe(derivations);
		for (const { view } of graphKeys) expect(erased(view)).toBe(true);
		expectErased(key);
		await expectLocked(original);
		expect(contender(storage.folder)).toBe("admitted");
		const reopened = await storage.open();
		expect(reopened.accountApprovals()).not.toBe(approvals);
		reopened.store.read((sql) => reopened.audit.verify(sql));
	} finally {
		observed.failDestroy = false;
		observed.firstDrafts = undefined;
		try {
			await session?.close();
		} finally {
			await storage.remove();
			observed.derived.length = 0;
		}
	}
});
