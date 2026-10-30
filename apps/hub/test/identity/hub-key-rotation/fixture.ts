import "reflect-metadata";
import {
	createDecipheriv,
	createHash,
	createPrivateKey,
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "@draftyak/protocol/jcs";
import { exportSpki, signStatement } from "@draftyak/protocol/sign";
import { AuditChain } from "../../../src/audit/chain.ts";
import { HUB_KEY_ROTATION_MIGRATIONS } from "../../../src/identity/hub-key-rotation/rotation.ts";
import { newId } from "../../../src/kernel/ids.ts";
import { MasterKey } from "../../../src/kernel/master-key.ts";
import { HubStore } from "../../../src/store/store.ts";
import { nativeBinding } from "../../store/helpers.ts";

const PREFIX = "draftyak-hub-key-rotation-";
const temporaryRoot = realpathSync(os.tmpdir());
const storeMigrations = path.resolve(import.meta.dirname, "../../../src/store/migrations");

export function rotationMigrations(dir: string): Record<string, string> {
	return {
		audit: path.join(storeMigrations, "audit"),
		core: path.join(storeMigrations, "core"),
		hubkeys: HUB_KEY_ROTATION_MIGRATIONS,
		tamper: path.join(dir, "tamper"),
	};
}
export const keyHash = (spki: string): string =>
	createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex");

export interface TestKey {
	readonly privateKey: KeyObject;
	readonly spki: string;
}
export function testKey(): TestKey {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	return { privateKey, spki: exportSpki(publicKey) };
}
export interface ChainRow {
	readonly seq: number;
	readonly id: string;
	readonly old_key: string;
	readonly new_key: string;
	readonly epoch: number;
	readonly iat: number;
	readonly statement: Buffer;
	readonly signature: string;
}
/** A hub-key-rotate.v1 row signed by a test key. */
export function signedRow(
	signer: TestKey,
	newKey: string,
	seq: number,
	change: Record<string, unknown> = {},
): ChainRow {
	const statement = {
		v: 1,
		hub: keyHash(signer.spki),
		epoch: 1,
		keyUse: "identity",
		newKey,
		iat: 1_800_000_000_000,
		...change,
	};
	return {
		seq,
		id: newId(),
		old_key: signer.spki,
		new_key: newKey,
		epoch: statement.epoch,
		iat: statement.iat,
		statement: Buffer.from(canonicalize(statement)),
		signature: signStatement("hub-key-rotate.v1", statement, signer.privateKey),
	};
}
/** The private key in wrapped bytes when they open under this key use, else undefined. */
export function unwrapped(
	bytes: Uint8Array,
	secrets: Buffer,
	use: "identity" | "statement",
): KeyObject | undefined {
	if (bytes.length < 30 || bytes[0] !== 1) return undefined;
	let plain: Buffer | undefined;
	try {
		const decipher = createDecipheriv("aes-256-gcm", secrets, bytes.subarray(1, 13));
		decipher.setAAD(Buffer.from(`draftyak/v1/hub-key/${use}`));
		decipher.setAuthTag(bytes.subarray(13, 29));
		plain = Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]);
		return createPrivateKey({ key: plain, format: "der", type: "pkcs8" });
	} catch {
		return undefined;
	} finally {
		plain?.fill(0);
	}
}

export interface RotationFixture {
	readonly dir: string;
	readonly filename: string;
	readonly key: MasterKey;
	readonly audit: AuditChain;
	readonly store: HubStore;
	/** A copy of the master key bytes for another process; the caller erases it. */
	masterBytes(): Buffer;
	/** Another connection to the same file. */
	open(): HubStore;
	/** Closes the current main connection and opens a new one, as a restart does. */
	reopen(): HubStore;
	/** Runs SQL as the next migration of the test-only tamper namespace. */
	tamper(sql: string): Promise<void>;
	cleanup(): void;
}

export async function rotationFixture(
	namespaces: readonly string[] = ["audit", "core", "hubkeys"],
): Promise<RotationFixture> {
	const dir = realpathSync(mkdtempSync(path.join(temporaryRoot, PREFIX)));
	const owned = lstatSync(dir);
	const filename = path.join(dir, "draftyak.db");
	const bytes = randomBytes(32);
	const key = new MasterKey(bytes);
	const auditKey = key.derive("audit");
	const audit = new AuditChain(auditKey);
	auditKey.fill(0);
	const stores: HubStore[] = [];
	const connect = (create: boolean): HubStore => {
		const store = new HubStore({
			filename,
			nativeBinding,
			masterKey: key,
			migrations: rotationMigrations(dir),
			...(create ? { create } : {}),
		});
		stores.push(store);
		return store;
	};
	let main: HubStore | undefined;
	let tampers = 0;
	const cleanup = (): void => {
		const errors: unknown[] = [];
		for (const store of stores.splice(0)) {
			try {
				store.close();
			} catch (error) {
				errors.push(error);
			}
		}
		audit.destroy();
		key.destroy();
		bytes.fill(0);
		const current = lstatSync(dir);
		if (
			path.dirname(dir) !== temporaryRoot ||
			!path.basename(dir).startsWith(PREFIX) ||
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			current.dev !== owned.dev ||
			current.ino !== owned.ino
		)
			errors.push(new Error("Rotation fixture directory changed"));
		else rmSync(dir, { recursive: true, force: false });
		if (existsSync(dir)) errors.push(new Error("Rotation fixture cleanup incomplete"));
		if (errors.length) throw new AggregateError(errors, "Rotation fixture cleanup failed");
	};
	try {
		mkdirSync(path.join(dir, "tamper"));
		main = connect(true);
		for (const namespace of namespaces) await main.migrate(namespace);
	} catch (error) {
		cleanup();
		throw error;
	}
	return {
		dir,
		filename,
		key,
		audit,
		get store(): HubStore {
			if (!main) throw new Error("Rotation fixture has no store");
			return main;
		},
		masterBytes: () => Buffer.from(bytes),
		open: () => connect(false),
		reopen(): HubStore {
			main?.close();
			main = connect(false);
			return main;
		},
		async tamper(sql: string): Promise<void> {
			tampers++;
			writeFileSync(
				path.join(dir, "tamper", `${String(tampers).padStart(4, "0")}_tamper.sql`),
				sql,
			);
			await main?.migrate("tamper");
		},
		cleanup,
	};
}
