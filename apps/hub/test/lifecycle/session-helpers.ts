import { createHash, randomBytes } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import {
	type HubSession,
	HubSessionError,
	type HubSessionOptions,
	openHubSession,
} from "../../src/lifecycle/session.ts";
import type { SqlReader } from "../../src/store/store.ts";
import { moduleSource, pin } from "../extensions/helpers.ts";
import { nativeBinding } from "../store/helpers.ts";

export { nativeBinding };

export const PIN = "582910";
// No rows: a live audit key fails on the missing head, a destroyed one refuses before reading.
export const noRows: SqlReader = { get: () => undefined, all: () => [] };

const temporaryRoot = realpathSync.native(os.tmpdir());

export interface SessionFixture {
	/** A canonical data folder, empty until a test writes to it. */
	readonly folder: string;
	readonly database: string;
	/** A new MasterKey over this fixture's bytes; each open owns the key it is given. */
	key(): MasterKey;
	/** A MasterKey over different bytes. */
	otherKey(): MasterKey;
	open(options?: Partial<HubSessionOptions>): Promise<HubSession>;
	/** A new folder beside the data folder, never inside it. */
	scratch(): string;
	remove(): void;
}

export function sessionFixture(prefix = "draftyak-session-"): SessionFixture {
	const root = realpathSync.native(mkdtempSync(path.join(temporaryRoot, prefix)));
	const born = lstatSync(root);
	const folder = path.join(root, "data");
	mkdirSync(folder);
	expect(realpathSync.native(folder)).toBe(folder);
	const bytes = randomBytes(32);
	const keys: MasterKey[] = [];
	const sessions: HubSession[] = [];
	const key = (from: Uint8Array = bytes): MasterKey => {
		const created = new MasterKey(from);
		keys.push(created);
		return created;
	};
	return {
		folder,
		database: path.join(folder, "draftyak.db"),
		key: () => key(),
		otherKey: () => key(randomBytes(32)),
		async open(options = {}) {
			const session = await openHubSession({ folder, nativeBinding, masterKey: key(), ...options });
			sessions.push(session);
			return session;
		},
		scratch: () => realpathSync.native(mkdtempSync(path.join(root, "scratch-"))),
		remove() {
			for (const session of sessions.splice(0)) {
				try {
					session.close();
				} catch {
					/* Reported by the test that made the close fail. */
				}
			}
			for (const created of keys.splice(0)) created.destroy();
			bytes.fill(0);
			const current = lstatSync(root);
			if (
				path.dirname(root) !== temporaryRoot ||
				!path.basename(root).startsWith(prefix) ||
				current.ino !== born.ino ||
				current.dev !== born.dev
			)
				throw new Error("Unowned session fixture folder");
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** The refusal an open or close produced; anything else fails the test. */
export async function refusal(operation: Promise<unknown>): Promise<HubSessionError> {
	const error = await operation.then(
		() => expect.unreachable("operation was not refused"),
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(HubSessionError);
	return error as HubSessionError;
}

export function refusalNow(operation: () => unknown): HubSessionError {
	let error: unknown;
	try {
		operation();
	} catch (reason) {
		error = reason;
	}
	expect(error).toBeInstanceOf(HubSessionError);
	return error as HubSessionError;
}

export const listing = (folder: string): string[] => readdirSync(folder).toSorted();

export const digest = (file: string): string =>
	createHash("sha256").update(readFileSync(file)).digest("hex");

/** An erased key refuses every derivation. */
export function expectErased(key: MasterKey): void {
	expect(() => key.derive("db")).toThrow("Hub is locked");
}

export function expectUsable(key: MasterKey): void {
	const derived = key.derive("db");
	expect(derived).toHaveLength(32);
	derived.fill(0);
}

/** Every service of a closed session refuses. */
export async function expectLocked(session: HubSession): Promise<void> {
	await expect(session.pins.verify("not-a-user", PIN, "approval")).rejects.toThrow("PIN_REQUIRED");
	expect(() => session.identity.tlsPrivateKey()).toThrow("Hub is locked");
	expect(() => session.audit.verify(noRows)).toThrow("Audit is locked");
	expect(() => session.store.read((db) => db.get("SELECT 1"))).toThrow("unavailable");
}

/** One pinned module that registers an audit sink; its entry stays outside the data folder. */
export function configureModule(fixture: SessionFixture, id: string, register = ""): void {
	const source = moduleSource(
		id,
		`${register}
		registry.auditSink({ id: "sink", async append() {} });`,
	);
	const entry = path.join(fixture.scratch(), `${id}.mjs`);
	writeFileSync(entry, source);
	writeFileSync(
		path.join(fixture.folder, "config.json"),
		JSON.stringify({
			modules: [{ id, version: "1.0.0", entry, sha512: pin(source), provides: ["auditSink"] }],
		}),
	);
}
