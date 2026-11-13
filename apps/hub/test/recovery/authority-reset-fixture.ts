import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { exportSpki } from "@draftyak/protocol/sign";
import { AuditChain } from "../../src/audit/chain.ts";
import { HubIdentity } from "../../src/identity/hub-key.ts";
import { PinError, PinService } from "../../src/identity/pin.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HUB_NAMESPACES, migrateHubSchemas } from "../../src/kernel/namespaces.ts";
import { encodeBackupArtifactHeader } from "../../src/recovery/backup-artifact.ts";
import { createRecoveryBinding } from "../../src/recovery/backup-bindings.ts";
import { generateRecoveryCode } from "../../src/recovery/recovery-code.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";

export const OWNER = "00000000000000000000000001";
export const OLD_PIN = "31415926";
export const NEW_PIN = "27182818";
const AT = 1_800_000_000_000;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface AuthorityImageState {
	epoch: number;
	bootstrap: number;
	owner: string;
	pinVersion: number;
	failures: number;
	lockedUntil: number;
	pinDigest: string;
	identityDigest: string;
	devices: readonly Record<string, unknown>[];
	auditSequence: number;
}

interface CopyOwner {
	store: HubStore | undefined;
	key: MasterKey;
	audit: AuditChain | undefined;
	pins: PinService | undefined;
	closed: boolean;
	openUncertain: boolean;
}

/** Ordinary own locked test dependency only; no installed-App authentication claim. */
export function requiredAuthorityResetBinding(): string {
	try {
		const require = createRequire(import.meta.url);
		const entry = realpathSync(require.resolve("better-sqlite3-multiple-ciphers"));
		const packageRoot = path.dirname(path.dirname(entry));
		const metadata: unknown = JSON.parse(
			readFileSync(path.join(packageRoot, "package.json"), "utf8"),
		);
		if (metadata === null || typeof metadata !== "object") throw new Error();
		const technical = metadata as { name?: unknown; version?: unknown; main?: unknown };
		if (
			technical.name !== "better-sqlite3-multiple-ciphers" ||
			technical.version !== "13.0.3" ||
			technical.main !== "lib/index.js" ||
			entry !== realpathSync(path.join(packageRoot, "lib", "index.js"))
		)
			throw new Error();
		const binding = realpathSync(
			path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}.node`),
		);
		const file = lstatSync(binding);
		if (
			!path.isAbsolute(binding) ||
			path.extname(binding) !== ".node" ||
			!file.isFile() ||
			file.isSymbolicLink()
		)
			throw new Error();
		return binding;
	} catch {
		throw new Error("Authority reset test dependency unavailable");
	}
}

function seedRows(tx: SqlTransaction, binding: Buffer): void {
	tx.run("INSERT INTO main.users(id,created_at) VALUES(?,?)", [OWNER, AT]);
	tx.run(
		"UPDATE main.device_authority SET epoch=1,bootstrap_done=0,owner_user_id=? WHERE singleton=1",
		[OWNER],
	);
	tx.run("UPDATE main.device_authority SET bootstrap_done=1 WHERE singleton=1");
	for (const [index, revoked] of [false, true].entries()) {
		const publicKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
		const spki = exportSpki(publicKey);
		const id = `0000000000000000000000000${index + 2}`;
		// These are invented persisted ROW DATA, never an accepted peer, grant or Session.
		tx.run(
			"INSERT INTO main.devices(id,user_id,role,name,spki_sha256,approval_key,key_class,claim_window,paired_epoch,paired_at,capabilities,confirmed_epoch,confirmed_via,confirmed_preset,confirmed_by,confirmed_at,revoked_at) VALUES(?,?,'device',?,?,?,'dev','sidecar',1,?,31,1,'bootstrap','desktop',NULL,?,?)",
			[
				id,
				OWNER,
				`fixture-${index}`,
				digest(Buffer.from(spki, "base64url")),
				spki,
				AT,
				AT,
				revoked ? AT + 1 : null,
			],
		);
	}
	tx.run("INSERT INTO main.native_backup_recovery(singleton,binding) VALUES(1,?)", [binding]);
}

function snapshot(store: HubStore): AuthorityImageState {
	return store.read((db) => {
		const authority = db.get<{ epoch: number; bootstrap_done: number; owner_user_id: string }>(
			"SELECT epoch,bootstrap_done,owner_user_id FROM main.device_authority WHERE singleton=1",
		);
		const pin = db.get<{
			version: number;
			failures: number;
			locked_until: number;
			salt: Uint8Array;
			hash: Uint8Array;
		}>("SELECT version,failures,locked_until,salt,hash FROM main.approval_pins WHERE user_id=?", [
			OWNER,
		]);
		const identity = db.get<{
			identity_wrapped: Uint8Array;
			statement_wrapped: Uint8Array;
			identity_cert: string;
		}>(
			"SELECT identity_wrapped,statement_wrapped,identity_cert FROM main.hub_meta WHERE singleton=1",
		);
		const audit = db.get<{ audit_seq: number }>(
			"SELECT audit_seq FROM main.audit_meta WHERE singleton=1",
		);
		if (!authority || !pin || !identity || !audit) throw new Error("Fixture state unavailable");
		return {
			epoch: authority.epoch,
			bootstrap: authority.bootstrap_done,
			owner: authority.owner_user_id,
			pinVersion: pin.version,
			failures: pin.failures,
			lockedUntil: pin.locked_until,
			pinDigest: digest(Buffer.concat([pin.salt, pin.hash])),
			identityDigest: digest(
				Buffer.concat([
					identity.identity_wrapped,
					identity.statement_wrapped,
					Buffer.from(identity.identity_cert),
				]),
			),
			devices: db.all<Record<string, unknown>>("SELECT * FROM main.devices ORDER BY id"),
			auditSequence: audit.audit_seq,
		};
	});
}

export class AuthorityResetFixture {
	readonly root: string;
	readonly destination: string;
	readonly artifactFile: string;
	readonly recoveryCode: Buffer = generateRecoveryCode();
	readonly nativeBinding: string;
	readonly #rawKey = randomBytes(32);
	readonly #key = new MasterKey(this.#rawKey);
	readonly #copies: CopyOwner[] = [];
	readonly #pending = new Set<Promise<unknown>>();
	#source: HubStore | undefined;
	#sourceIdentity: HubIdentity | undefined;
	#sourcePins: PinService | undefined;
	#sourceAudit: AuditChain | undefined;
	#sourceClosed = false;
	#sourceUncertain = false;
	#fileCloseUncertain = false;
	readonly #files = new Set<FileHandle>();
	#closePreparation: (() => Promise<void>) | undefined;
	#closing: Promise<void> | undefined;
	#closed = false;
	#copyNumber = 0;
	#initializationStage = "source-store";
	#rootIdentity: Awaited<ReturnType<typeof fs.lstat>> | undefined;
	imageHandle: FileHandle | undefined;
	imagePath: string | undefined;
	before: AuthorityImageState | undefined;

	private constructor(root: string, nativeBinding: string) {
		this.root = root;
		this.nativeBinding = nativeBinding;
		this.destination = path.join(root, "destination");
		this.artifactFile = path.join(root, "backup.dyk");
	}
	static async create(
		nativeBinding: string,
		owned: AuthorityResetFixture[],
	): Promise<AuthorityResetFixture> {
		const parent = await fs.realpath(os.tmpdir());
		const root = await fs.mkdtemp(path.join(parent, "draftyak-authority-reset-"));
		const fixture = new AuthorityResetFixture(root, nativeBinding);
		// Retain the original owner before initialization or cleanup can reject.
		owned.push(fixture);
		fixture.#rootIdentity = await fs.lstat(root);
		try {
			await fixture.#initialize();
			return fixture;
		} catch (initialError) {
			const failure = new Error(
				`Fixture initialization failed at ${fixture.#initializationStage}`,
				{ cause: initialError },
			);
			try {
				await fixture.close();
			} catch (cleanupError) {
				throw new AggregateError(
					[failure, cleanupError],
					"Fixture initialization and cleanup failed",
					{ cause: initialError },
				);
			}
			throw failure;
		}
	}
	async #initialize(): Promise<void> {
		await fs.mkdir(this.destination, { mode: 0o700 });
		const filename = path.join(this.root, "source.db");
		this.#sourceUncertain = true;
		const store = new HubStore({
			filename,
			create: true,
			nativeBinding: this.nativeBinding,
			masterKey: this.#key,
			migrations: HUB_NAMESPACES,
		});
		this.#source = store;
		this.#sourceUncertain = false;
		this.#initializationStage = "source-migrations";
		await migrateHubSchemas(store);
		this.#initializationStage = "source-identity";
		const identity = await HubIdentity.loadOrCreate(store, this.#key);
		this.#sourceIdentity = identity;
		const auditKey = this.#key.derive("audit");
		let audit: AuditChain;
		try {
			audit = new AuditChain(auditKey);
		} finally {
			auditKey.fill(0);
		}
		this.#sourceAudit = audit;
		this.#initializationStage = "source-pin-service";
		const pins = new PinService(store, audit);
		this.#sourcePins = pins;
		const capsule = this.#key.wrapRecovery(this.recoveryCode);
		const binding = createRecoveryBinding(this.#key, capsule);
		let encrypted: Buffer | undefined;
		let header: Buffer | undefined;
		try {
			this.#initializationStage = "synthetic-row-seed";
			store.write((tx) => seedRows(tx, binding));
			this.#initializationStage = "source-pin-initialization";
			await pins.initialize(OWNER, OLD_PIN);
			store.write((tx) =>
				tx.run("UPDATE main.approval_pins SET failures=2,locked_until=1 WHERE user_id=?", [OWNER]),
			);
			this.before = snapshot(store);
			store.read((db) => audit.verify(db));
			pins.lock();
			identity.lock();
			this.#initializationStage = "source-checkpoint-close";
			store.checkpoint();
			store.close();
			this.#sourceClosed = true;
			this.#initializationStage = "artifact-framing";
			encrypted = await fs.readFile(filename);
			header = encodeBackupArtifactHeader(
				capsule,
				binding,
				encrypted.byteLength,
				digest(encrypted),
			);
			const file = await fs.open(this.artifactFile, "wx", 0o600);
			this.#files.add(file);
			const writeOrCloseFailures: unknown[] = [];
			try {
				await file.writeFile(Buffer.concat([header, encrypted]));
				await file.sync();
			} catch (error) {
				writeOrCloseFailures.push(error);
			}
			try {
				await file.close();
				if (file.fd !== -1) {
					this.#fileCloseUncertain = true;
					writeOrCloseFailures.push(new Error("Fixture descriptor closure incomplete"));
				} else {
					this.#files.delete(file);
				}
			} catch (error) {
				this.#fileCloseUncertain = true;
				writeOrCloseFailures.push(error);
			}
			if (writeOrCloseFailures.length)
				throw new AggregateError(writeOrCloseFailures, "Fixture artifact write or close failed");
			this.#initializationStage = "initialized";
		} finally {
			pins.lock();
			identity.lock();
			audit.destroy();
			capsule.fill(0);
			binding.fill(0);
			encrypted?.fill(0);
			header?.fill(0);
		}
	}
	registerPreparation(close: () => Promise<void>): void {
		if (this.#closePreparation) throw new Error("Fixture preparation already registered");
		this.#closePreparation = close;
	}
	track<T>(promise: Promise<T>): Promise<T> {
		this.#pending.add(promise);
		void promise.then(
			() => this.#pending.delete(promise),
			() => this.#pending.delete(promise),
		);
		return promise;
	}
	/** Reads a separate genuine Store only after the production checkpoint. */
	async readCopy(pin?: string): Promise<{ state: AuthorityImageState; pinAccepted?: boolean }> {
		if (!this.imagePath) throw new Error("Fixture image unavailable");
		const filename = path.join(this.root, `readback-${++this.#copyNumber}.db`);
		await fs.copyFile(this.imagePath, filename, constants.COPYFILE_EXCL);
		const key = new MasterKey(this.#rawKey);
		const owner: CopyOwner = {
			store: undefined,
			key,
			audit: undefined,
			pins: undefined,
			closed: false,
			openUncertain: true,
		};
		this.#copies.push(owner);
		try {
			const store = new HubStore({
				filename,
				nativeBinding: this.nativeBinding,
				masterKey: key,
				migrations: HUB_NAMESPACES,
			});
			owner.store = store;
			owner.openUncertain = false;
			const auditKey = key.derive("audit");
			let audit: AuditChain;
			try {
				audit = new AuditChain(auditKey);
			} finally {
				auditKey.fill(0);
			}
			owner.audit = audit;
			const pins = new PinService(store, audit);
			owner.pins = pins;
			store.read((db) => audit.verify(db));
			const state = snapshot(store);
			let pinAccepted: boolean | undefined;
			if (pin !== undefined) {
				try {
					await pins.verify(OWNER, pin, "restore.test");
					pinAccepted = true;
				} catch (error) {
					if (!(error instanceof PinError)) throw error;
					pinAccepted = false;
				}
			}
			return { state, pinAccepted };
		} finally {
			owner.pins?.lock();
			owner.audit?.destroy();
			if (owner.store) {
				owner.store.close();
				owner.closed = true;
				key.destroy();
			}
		}
	}
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		const attempt = this.#close();
		this.#closing = attempt;
		void attempt.catch(() => {
			if (this.#closing === attempt) this.#closing = undefined;
		});
		return attempt;
	}
	async #close(): Promise<void> {
		if (this.#closed) return;
		await Promise.allSettled([...this.#pending]);
		let failed = this.#sourceUncertain || this.#fileCloseUncertain;
		try {
			await this.#closePreparation?.();
		} catch {
			failed = true;
		}
		for (const owner of this.#copies) {
			try {
				if (owner.openUncertain || !owner.store) throw new Error("Fixture native open uncertain");
				owner.pins?.lock();
				if (!owner.closed) {
					owner.store.close();
					owner.closed = true;
				}
				owner.audit?.destroy();
				owner.key.destroy();
			} catch {
				failed = true;
			}
		}
		try {
			this.#sourcePins?.lock();
			this.#sourceIdentity?.lock();
			if (this.#source && !this.#sourceClosed) {
				this.#source.close();
				this.#sourceClosed = true;
			}
			this.#sourceAudit?.destroy();
		} catch {
			failed = true;
		}
		if (this.#files.size || (this.imageHandle && this.imageHandle.fd !== -1)) failed = true;
		if (failed) throw new Error("Fixture physical cleanup incomplete");
		this.#key.destroy();
		this.#rawKey.fill(0);
		this.recoveryCode.fill(0);
		const current = await fs.lstat(this.root);
		if (
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			!this.#rootIdentity ||
			current.dev !== this.#rootIdentity.dev ||
			current.ino !== this.#rootIdentity.ino ||
			(await fs.realpath(this.root)) !== this.root
		)
			throw new Error("Fixture directory identity changed");
		await fs.rm(this.root, { recursive: true });
		this.#closed = true;
	}
}
