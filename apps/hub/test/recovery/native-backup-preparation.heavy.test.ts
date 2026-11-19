import {
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { DataFolder } from "../../src/kernel/data-directory.ts";
import type { MasterKey } from "../../src/kernel/master-key.ts";
import { BACKUP_ARTIFACT_HEADER_SIZE } from "../../src/recovery/backup-artifact.ts";
import {
	closeNativeBackupPreparation,
	type NativeBackupPreparation,
	NativeBackupRestoreError,
	prepareNativeBackup,
} from "../../src/recovery/backup-restore.ts";
import { generateRecoveryCode, RECOVERY_FILE } from "../../src/recovery/recovery-code.ts";
import { originalKeyErased } from "../identity/native-backup-fixture.ts";
import { nativeBinding } from "../lifecycle/session-helpers.ts";
import { runNativeRestoreChild } from "./native-restore-child.ts";
import { selectedRestoreArtifact } from "./restore-artifact-fixture.ts";

const observed = vi.hoisted(() => ({
	keys: [] as MasterKey[],
	admissions: new Map<string, DataFolder>(),
}));
// Observe original returned owners only; no key, Store or admission is substituted.
vi.mock("../../src/recovery/recovery-code.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/recovery/recovery-code.ts")>();
	return {
		...original,
		openRecoveryBytes(...args: Parameters<typeof original.openRecoveryBytes>) {
			const key = original.openRecoveryBytes(...args);
			observed.keys.push(key);
			return key;
		},
	};
});
vi.mock("../../src/kernel/data-directory.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/kernel/data-directory.ts")>();
	return {
		...original,
		admitDataFolder(...args: Parameters<typeof original.admitDataFolder>) {
			const folder = original.admitDataFolder(...args);
			observed.admissions.set(args[0], folder);
			return folder;
		},
	};
});

const openFile = fs.open;
const handles: NativeBackupPreparation[] = [];
const pending: Promise<unknown>[] = [];
const bodies: Promise<void>[] = [];
let admittedWithoutToken = false;
const releases: (() => void)[] = [];
const restoreHandles: (() => void)[] = [];
let setup: ReturnType<typeof selectedRestoreArtifact> | undefined;
let setupPending = false;
let setupFailed = false;
let root = "";
let rootIdentity: { dev: bigint; ino: bigint };
let artifact = "";
let code: Buffer;
function destination(): string {
	const folder = path.join(root, `destination-${readdirSync(root).length}`);
	mkdirSync(folder, { mode: 0o700 });
	return folder;
}
function input(folder: string) {
	return { artifactFile: artifact, destination: folder, recoveryCode: code, nativeBinding };
}
function track<T>(task: Promise<T>): Promise<T> {
	pending.push(task);
	void task.catch(() => undefined);
	return task;
}
function prepare(raw: unknown): Promise<NativeBackupPreparation> {
	const before = new Set(observed.admissions.values());
	return track(
		prepareNativeBackup(raw).then(
			(token) => {
				handles.push(token);
				return token;
			},
			(error: unknown) => {
				if ([...observed.admissions.values()].some((owner) => !before.has(owner)))
					admittedWithoutToken = true;
				throw error;
			},
		),
	);
}
function retainBody<T extends unknown[]>(
	run: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
	return (...args) => {
		const body = Promise.resolve().then(() => run(...args));
		bodies.push(body);
		void body.catch(() => undefined);
		return body;
	};
}
async function refused(task: Promise<unknown>): Promise<void> {
	const { error } = await task.then(
		() => ({ error: undefined }),
		(error: unknown) => ({ error }),
	);
	expect(error instanceof NativeBackupRestoreError).toBe(true);
	if (!(error instanceof NativeBackupRestoreError))
		throw new Error("DYTEST preparation refusal missing");
	expect(
		error.name === "NativeBackupRestoreError" &&
			error.code === "BACKUP_RESTORE_UNAVAILABLE" &&
			error.message === "Backup restore unavailable",
	).toBe(true);
	expect(Object.hasOwn(error, "cause")).toBe(false);
}
function noPublication(folder: string): void {
	for (const name of ["draftyak.db", RECOVERY_FILE])
		expect(existsSync(path.join(folder, name))).toBe(false);
}
function cleaned(folder: string): void {
	noPublication(folder);
	expect(readdirSync(folder)).toEqual(["run"]);
	expect(readdirSync(path.join(folder, "run"))).toEqual(["hub.lock"]);
	const lock = lstatSync(path.join(folder, "run", "hub.lock"), { bigint: true });
	expect(lock.isFile() && !lock.isSymbolicLink() && lock.nlink === 1n && lock.size === 0n).toBe(
		true,
	);
}
beforeAll(async () => {
	setupPending = true;
	root = realpathSync.native(
		mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "draftyak-preparation-test-")),
	);
	rootIdentity = lstatSync(root, { bigint: true });
	artifact = path.join(root, "selected.dyb");
	code = generateRecoveryCode();
	setup = selectedRestoreArtifact(artifact, code);
	const [ready] = await Promise.allSettled([setup.ready]);
	try {
		await setup.close();
		setupPending = false;
	} catch {
		setupFailed = true;
		throw new Error("DYTEST preparation source retained");
	}
	if (ready.status === "rejected") throw ready.reason;
}, 120_000);
afterAll(async () => {
	if (setupPending) throw new Error("DYTEST preparation source still active");
	for (const release of releases) release();
	await Promise.allSettled(bodies);
	await Promise.allSettled(pending);
	for (const restore of restoreHandles) restore();
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	const closed = await Promise.allSettled(
		handles.map((token) => closeNativeBackupPreparation(token)),
	);
	const source = await Promise.allSettled(setup ? [setup.close()] : []);
	if (
		setupFailed ||
		admittedWithoutToken ||
		[...closed, ...source].some((result) => result.status === "rejected") ||
		observed.keys.some((key) => !originalKeyErased(key))
	)
		throw new Error("DYTEST preparation resources retained");
	code?.fill(0);
	if (!root) return;
	const current = lstatSync(root, { bigint: true });
	expect(
		realpathSync.native(root) === root &&
			current.dev === rootIdentity.dev &&
			current.ino === rootIdentity.ino &&
			!current.isSymbolicLink() &&
			path.dirname(root) === realpathSync.native(os.tmpdir()) &&
			path.basename(root).startsWith("draftyak-preparation-test-"),
	).toBe(true);
	rmSync(root, { recursive: true, force: true });
}, 120_000);

it(
	"holds a genuine private preparation until its original close joins",
	retainBody(async () => {
		const folder = destination();
		const keys = observed.keys.length;
		const token = await prepare(input(folder));
		expect(Object.isFrozen(token) && Reflect.ownKeys(token).length === 0).toBe(true);
		const originalKey = observed.keys[keys]!;
		expect(observed.keys.length === keys + 1 && !originalKeyErased(originalKey)).toBe(true);
		const admitted = observed.admissions.get(folder);
		expect(admitted !== undefined).toBe(true);
		expect(() => admitted?.assertHeld()).not.toThrow();
		noPublication(folder);
		const stage = readdirSync(folder).filter((name) => name.startsWith(".backup-image-restore-"));
		expect(stage.length === 1).toBe(true);
		const stageEntries = readdirSync(path.join(folder, stage[0]!)).toSorted();
		expect(stageEntries).toEqual(["image.db", "image.db-shm", "image.db-wal"]);
		let hooks = 0;
		const proxy = new Proxy(token, {
			get() {
				hooks++;
				throw new Error("DYTEST token proxy");
			},
		});
		await refused(track(closeNativeBackupPreparation({ ...token })));
		await refused(track(closeNativeBackupPreparation(proxy)));
		await refused(prepare(input(destination())));
		expect(hooks).toBe(0);
		expect(() => admitted?.assertHeld()).not.toThrow();
		await track(closeNativeBackupPreparation(token));
		expect(originalKeyErased(originalKey)).toBe(true);
		expect(() => admitted?.assertHeld()).toThrow();
		cleaned(folder);
		await track(closeNativeBackupPreparation(token));
		cleaned(folder);
	}),
);

it.each(["code", "body"] as const)(
	"refuses a genuine artifact with changed %s and erases returned keys",
	retainBody(async (fault: "code" | "body") => {
		const folder = destination();
		const raw = input(folder);
		const alteredCode = Buffer.from(code);
		let encrypted: Buffer | undefined;
		try {
			if (fault === "code") {
				alteredCode[0] = (alteredCode[0] ?? 0) ^ 1;
				raw.recoveryCode = alteredCode;
			} else {
				encrypted = readFileSync(artifact);
				expect(encrypted.length > BACKUP_ARTIFACT_HEADER_SIZE).toBe(true);
				encrypted[BACKUP_ARTIFACT_HEADER_SIZE] = (encrypted[BACKUP_ARTIFACT_HEADER_SIZE] ?? 0) ^ 1;
				raw.artifactFile = path.join(root, "changed-body.dyb");
				writeFileSync(raw.artifactFile, encrypted, { flag: "wx", mode: 0o600 });
			}
			const keys = observed.keys.length;
			await refused(prepare(raw));
			expect(observed.keys.length === keys + (fault === "body" ? 1 : 0)).toBe(true);
			expect(observed.keys.slice(keys).every(originalKeyErased)).toBe(true);
			expect(observed.admissions.has(folder)).toBe(false);
			noPublication(folder);
			expect(readdirSync(folder)).toEqual([]);
		} finally {
			alteredCode.fill(0);
			encrypted?.fill(0);
		}
	}),
);

it(
	"retries only the same original positive image descriptor after a definite close rejection",
	retainBody(async () => {
		const folder = destination();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releases.push(() => release.resolve());
		let image: FileHandle | undefined;
		let calls = 0;
		vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
			const handle = await openFile(...args);
			if (
				typeof args[0] === "string" &&
				args[0].startsWith(`${folder}${path.sep}`) &&
				path.basename(args[0]) === "image.db" &&
				args[1] === "wx+"
			) {
				image = handle;
				const original = handle.close;
				restoreHandles.push(() => {
					handle.close = original;
				});
				handle.close = async () => {
					calls++;
					if (calls === 1) {
						entered.resolve();
						await release.promise;
						throw new Error("DYTEST definite pre-close refusal");
					}
					await original.call(handle);
				};
			}
			return handle;
		});
		syncBuiltinESMExports();
		const keys = observed.keys.length;
		const token = await prepare(input(folder));
		const originalImage = image;
		expect(originalImage !== undefined && originalImage.fd >= 0).toBe(true);
		const descriptor = originalImage?.fd;
		const first = track(closeNativeBackupPreparation(token));
		await Promise.race([
			entered.promise,
			first.then(
				() => {
					throw new Error("DYTEST close settled before its original attempt");
				},
				() => {
					throw new Error("DYTEST close refused before its original attempt");
				},
			),
		]);
		expect(originalKeyErased(observed.keys[keys]!)).toBe(true);
		noPublication(folder);
		expect(originalImage?.fd === descriptor && calls === 1).toBe(true);
		release.resolve();
		await refused(first);
		expect(originalImage?.fd === descriptor && (descriptor ?? -1) >= 0).toBe(true);
		await track(closeNativeBackupPreparation(token));
		expect(originalImage?.fd === -1 && calls === 2).toBe(true);
		cleaned(folder);
	}),
);

function counter(value: unknown, minimum: number, maximum = 32, name = "counter"): void {
	expect(Number.isSafeInteger(value), name).toBe(true);
	expect(value, name).toBeGreaterThanOrEqual(minimum);
	expect(value, name).toBeLessThanOrEqual(maximum);
}

for (const fault of ["constructor", "inventory", "plan", "audit", "binding"] as const) {
	const title =
		fault === "constructor"
			? "isolates genuine native preparation refusal after authenticating a recomputed damaged image"
			: `refuses a constructor-accepted image at the ${fault} validation boundary`;
	it(
		title,
		retainBody(async () => {
			const folder = destination();
			const selected = path.join(root, `native-${fault}.dyb`);
			copyFileSync(artifact, selected, constants.COPYFILE_EXCL);
			const childFile = path.join(root, `preparation-${fault}-child.ts`);
			const receiverUrl = new URL("../../src/recovery/backup-restore.ts", import.meta.url).href;
			const childSource = `
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const receiverUrl = ${JSON.stringify(receiverUrl)};
const moduleUrl = (name) => new URL(name, new URL("../", receiverUrl));
const load = (name) => import(moduleUrl(name).href);
const require = createRequire(moduleUrl("store/store.ts"));
const fault = ${JSON.stringify(fault)};
const codeLength = ${code.byteLength};
let entered = false;
async function send(message) {
	if (!process.send || !process.connected) throw new Error("DYTEST child IPC unavailable");
	await new Promise((resolve, reject) => process.send(message, (error) => error ? reject(new Error("DYTEST child IPC failed")) : resolve()));
}
async function run(input) {
	let bytes;
	let entry;
	let original;
	let wrapped;
	let fixtureKey;
	let raw;
	let probe;
	let token;
	let receiver;
	let encoded;
	let header;
	let capsule;
	let binding;
	let frame;
	let artifactBytes;
	let service = false;
	let probeAccepted = false;
	let dbDerives = 0;
	let nativeAttempts = 0;
	let nativeReturned = 0;
	let encryptedReadAttempts = 0;
	let encryptedReadRefusals = 0;
	let serviceReads = 0;
	const methods = [];
	function observe(owner, name, wrapper) {
		const before = Object.getOwnPropertyDescriptor(owner, name);
		const method = owner[name];
		if (typeof method !== "function") throw new Error("DYTEST original method unavailable");
		methods.push({ owner, name, before });
		owner[name] = wrapper(method);
	}
	const checkpoint = (db) => {
		if (db.pragma("wal_checkpoint(TRUNCATE)")[0]?.busy !== 0) throw new Error("DYTEST original checkpoint refused");
		db.close();
		if (db.open) throw new Error("DYTEST original native close incomplete");
	};
	let result = { kind: "child-failed" };
	try {
		if (!input || typeof input !== "object" || Object.keys(input).sort().join(",") !== "artifactFile,destination,nativeBinding,recoveryCode" ||
			typeof input.artifactFile !== "string" || typeof input.destination !== "string" || typeof input.nativeBinding !== "string" ||
			!Buffer.isBuffer(input.recoveryCode) || input.recoveryCode.length !== codeLength) throw new Error("DYTEST child input invalid");
		bytes = Buffer.from(input.recoveryCode);
		input.recoveryCode.fill(0);
		const id = require.resolve("better-sqlite3-multiple-ciphers");
		const compile = Object.getOwnPropertyDescriptor(Module.prototype, "_compile");
		if (!compile || typeof compile.value !== "function") throw new Error("DYTEST original compiler unavailable");
		Module.prototype._compile = function (...args) {
			const compiled = Reflect.apply(compile.value, this, args);
			if (args[1] === id) {
				entry = this;
				original = this.exports;
				wrapped = new Proxy(original, {
					construct(target, args) {
						const filename = args[0];
						const relative = typeof filename === "string" ? path.relative(input.destination, filename) : "";
						const image = typeof filename === "string" && path.basename(filename) === "image.db" && relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
						if (image) nativeAttempts = Math.min(33, nativeAttempts + 1);
						const actual = Reflect.construct(target, args, target);
						if (image) {
							nativeReturned = Math.min(33, nativeReturned + 1);
							if (nativeReturned > 32) throw new Error("DYTEST native read counter overflow");
							observe(actual, "prepare", (prepare) => function (...args) {
								const read = this === actual && args[0] === "SELECT count(*) FROM sqlite_master";
								if (read) encryptedReadAttempts = Math.min(33, encryptedReadAttempts + 1);
								let statement;
								try { statement = Reflect.apply(prepare, this, args); }
								catch (error) {
									if (read) encryptedReadRefusals = Math.min(33, encryptedReadRefusals + 1);
									throw error;
								}
								if (read) observe(statement, "get", (get) => function (...args) {
									try { return Reflect.apply(get, this, args); }
									catch (error) {
										if (this === statement) encryptedReadRefusals = Math.min(33, encryptedReadRefusals + 1);
										throw error;
									}
								});
								return statement;
							});
						}
						return actual;
					},
				});
				this.exports = wrapped;
			}
			return compiled;
		};
		try {
			if (require(id) !== wrapped) throw new Error("DYTEST native require capture refused");
		} finally {
			Object.defineProperty(Module.prototype, "_compile", compile);
		}
		if (!entry || require.cache[id] !== entry || entry.exports !== wrapped || typeof original !== "function") throw new Error("DYTEST native constructor unavailable");
		if ((await import(pathToFileURL(id).href)).default !== wrapped) throw new Error("DYTEST native export capture refused");
		const { MasterKey } = await load("kernel/master-key.ts");
		observe(MasterKey.prototype, "derive", (derive) => function (...args) {
			if (service && args[0] === "db" && ++dbDerives > 32) throw new Error("DYTEST derivation counter overflow");
			return Reflect.apply(derive, this, args);
		});
		const { HubStore } = await load("store/store.ts");
		observe(HubStore.prototype, "read", (read) => function (...args) {
			if (service && ++serviceReads > 32) throw new Error("DYTEST Store read counter overflow");
			return Reflect.apply(read, this, args);
		});
		const codec = await load("recovery/backup-artifact.ts");
		frame = readFileSync(input.artifactFile);
		header = codec.decodeBackupArtifactHeader(frame.subarray(0, codec.BACKUP_ARTIFACT_HEADER_SIZE));
		if (fault === "constructor") {
			frame[codec.BACKUP_ARTIFACT_HEADER_SIZE] ^= 1;
		} else {
			const { openEncrypted } = await load("store/open.ts");
			const { HUB_NAMESPACES } = await load("kernel/namespaces.ts");
			const { migrationTables } = await load("store/migrator.ts");
			const { openRecoveryBytes } = await load("recovery/recovery-code.ts");
			const { createRecoveryBinding } = await load("recovery/backup-bindings.ts");
			fixtureKey = openRecoveryBytes(header.capsule, bytes);
			const image = input.artifactFile + ".image.db";
			writeFileSync(image, frame.subarray(codec.BACKUP_ARTIFACT_HEADER_SIZE), { flag: "wx", mode: 0o600 });
			raw = openEncrypted({ filename: image, nativeBinding: input.nativeBinding }, fixtureKey, "db");
			const ledger = migrationTables("events");
			if (fault === "inventory" || fault === "plan") {
				raw.exec("DROP TABLE main.events; DROP TABLE main.event_meta");
				if (fault === "plan") raw.exec('DELETE FROM main."' + ledger.table + '"');
				else raw.exec('DROP TABLE main."' + ledger.table + '"; DROP TABLE main."' + ledger.lock + '"');
			} else if (fault === "audit") {
				if (raw.prepare("DELETE FROM main.audit_meta WHERE singleton=1").run().changes !== 1) throw new Error("DYTEST actual audit head absent");
			}
			checkpoint(raw);
			raw = undefined;
			probe = new HubStore({ filename: image, nativeBinding: input.nativeBinding, masterKey: fixtureKey, migrations: HUB_NAMESPACES });
			probeAccepted = true;
			probe.checkpoint();
			probe.close();
			probe = undefined;
			if (fault === "binding") {
				capsule = fixtureKey.wrapRecovery(bytes);
				binding = createRecoveryBinding(fixtureKey, capsule);
				if (capsule.equals(header.capsule) || binding.equals(header.binding)) throw new Error("DYTEST genuine replacement binding unchanged");
			}
			frame.fill(0);
			frame = readFileSync(image);
			fixtureKey.destroy();
			fixtureKey = undefined;
		}
		const body = fault === "constructor" ? frame.subarray(codec.BACKUP_ARTIFACT_HEADER_SIZE) : frame;
		encoded = codec.encodeBackupArtifactHeader(capsule ?? header.capsule, binding ?? header.binding, body.length, createHash("sha256").update(body).digest("hex"));
		artifactBytes = Buffer.concat([encoded, body]);
		writeFileSync(input.artifactFile, artifactBytes);
		receiver = await import(receiverUrl);
		let fixedRefusal = false;
		service = true;
		try { token = await receiver.prepareNativeBackup({ artifactFile: input.artifactFile, destination: input.destination, recoveryCode: bytes, nativeBinding: input.nativeBinding }); }
		catch (error) {
			fixedRefusal = error instanceof receiver.NativeBackupRestoreError && error.name === "NativeBackupRestoreError" && error.code === "BACKUP_RESTORE_UNAVAILABLE" && error.message === "Backup restore unavailable" && !Object.hasOwn(error, "cause");
		}
		const tokenReturned = token !== undefined;
		if (token) {
			await receiver.closeNativeBackupPreparation(token);
			token = undefined;
		}
		result = {
			kind: fault === "constructor" ? "constructor-refusal" : "validation-refusal",
			fixedRefusal,
			dbDerives,
			nativeAttempts,
			nativeReturned,
			encryptedReadAttempts,
			encryptedReadRefusals,
			probeAccepted,
			serviceReads,
			tokenReturned,
			unpublished: !existsSync(path.join(input.destination, "draftyak.db")) && !existsSync(path.join(input.destination, ${JSON.stringify(RECOVERY_FILE)})),
		};
		process.exitCode = 0;
	} catch {
		process.exitCode = 2;
	} finally {
		try {
			if (token) await receiver.closeNativeBackupPreparation(token);
			probe?.close();
			if (raw?.open) raw.close();
		} catch { process.exitCode = 2; }
		fixtureKey?.destroy();
		for (const method of methods.reverse()) {
			try {
				if (method.before) Object.defineProperty(method.owner, method.name, method.before);
				else delete method.owner[method.name];
			} catch { process.exitCode = 2; }
		}
		if (entry && entry.exports === wrapped) entry.exports = original;
		for (const value of [bytes, encoded, frame, artifactBytes, capsule, binding, header?.capsule, header?.binding]) value?.fill(0);
		if (input && Buffer.isBuffer(input.recoveryCode)) input.recoveryCode.fill(0);
	}
	try { await send(result); } catch { process.exitCode = 2; }
	if (process.connected) process.disconnect();
}
process.once("message", (input) => {
	entered = true;
	void run(input).catch(() => { process.exitCode = 2; if (process.connected) process.disconnect(); });
});
process.on("disconnect", () => { if (!entered) process.exitCode = 2; });
await send({ kind: "ready" });
`;
			writeFileSync(childFile, childSource, { flag: "wx", mode: 0o600 });
			const report = await runNativeRestoreChild({
				script: childFile,
				artifactFile: selected,
				destination: folder,
				root,
				recoveryCode: code,
				expectedKind: fault === "constructor" ? "constructor-refusal" : "validation-refusal",
				expectedKeys:
					"dbDerives,encryptedReadAttempts,encryptedReadRefusals,fixedRefusal,kind,nativeAttempts,nativeReturned,probeAccepted,serviceReads,tokenReturned,unpublished",
				pending,
			});
			expect(
				report.fixedRefusal === true &&
					report.unpublished === true &&
					report.tokenReturned === false,
			).toBe(true);
			for (const name of ["dbDerives", "nativeAttempts", "encryptedReadAttempts"] as const)
				counter(report[name], 1, 32, name);
			counter(report.nativeReturned, 0, report.nativeAttempts as number);
			if (fault === "constructor") {
				counter(report.encryptedReadRefusals, 1, report.encryptedReadAttempts as number);
				expect(report.probeAccepted === false && report.serviceReads === 0).toBe(true);
			} else {
				expect(
					report.probeAccepted === true &&
						report.nativeReturned === 1 &&
						report.encryptedReadRefusals === 0,
				).toBe(true);
				counter(report.serviceReads, 1);
			}
			noPublication(folder);
		}),
		120_000,
	);
}
