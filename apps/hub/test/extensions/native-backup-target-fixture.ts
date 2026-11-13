import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackupManifest, BackupTarget } from "@draftyak/extensions";
import type { DataClass } from "@draftyak/protocol/data-class";
import { type ExtensionHost, startExtensions } from "../../src/extensions/registry.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { nativeBinding } from "../store/helpers.ts";

type Stage = "before" | "chunk" | "after";
export interface NativeBackupTargetGate {
	readonly entered: Promise<void>;
	release(): void;
}
export interface NativeBackupTargetCall {
	readonly receiver: unknown;
	readonly name: string;
	readonly manifest: BackupManifest;
	readonly chunks: Buffer[];
}
export interface NativeBackupTargetFixtureProvider extends Omit<BackupTarget, "id" | "refuses"> {
	id: string;
	refuses: DataClass[];
}
export interface NativeBackupTargetFixture {
	readonly host: ExtensionHost;
	readonly targetId: string;
	readonly provider: NativeBackupTargetFixtureProvider;
	readonly calls: NativeBackupTargetCall[];
	readonly received: Buffer[];
	pause(stage: Stage): NativeBackupTargetGate;
	track<T>(promise: Promise<T>): Promise<T>;
	openSecondHost(): Promise<NativeBackupTargetFixture>;
	close(): Promise<void>;
}
interface Gate extends NativeBackupTargetGate {
	readonly wait: Promise<void>;
	signal(): void;
}

/** A real pinned module creates the provider; observations grant no production authority. */
export async function createNativeBackupTargetFixture(
	refuses: readonly DataClass[] = [],
): Promise<NativeBackupTargetFixture> {
	const selected = [...refuses];
	const temp = realpathSync.native(os.tmpdir());
	const root = realpathSync.native(mkdtempSync(path.join(temp, "draftyak-backup-target-")));
	chmodSync(root, 0o700);
	const birth = lstatSync(root);
	const raw = randomBytes(32);
	let key: MasterKey;
	try {
		key = new MasterKey(raw);
	} finally {
		raw.fill(0);
	}
	const slot = Symbol.for(`draftyak.test.backup-target.${randomUUID()}`);
	const shared = globalThis as Record<symbol, unknown>;
	const gates = new Map<Stage, Gate>();
	const tracked = new Set<Promise<unknown>>();
	const pending = new Set<Promise<void>>();
	const children: NativeBackupTargetFixture[] = [];
	let host: ExtensionHost | undefined;
	let stopping = false;
	let closing: Promise<void> | undefined;
	const control = {
		provider: undefined as NativeBackupTargetFixtureProvider | undefined,
		calls: [] as NativeBackupTargetCall[],
		received: [] as Buffer[],
		pending,
		async wait(stage: Stage): Promise<void> {
			const gate = gates.get(stage);
			if (!gate) return;
			gate.signal();
			await gate.wait;
			if (gates.get(stage) === gate) gates.delete(stage);
		},
	};
	shared[slot] = control;
	const close = (): Promise<void> => {
		if (closing) return closing;
		stopping = true;
		closing = (async () => {
			for (const gate of gates.values()) gate.release();
			let failure = false;
			try {
				host?.close();
			} catch {
				failure = true;
			}
			while (pending.size || tracked.size) await Promise.allSettled([...pending, ...tracked]);
			const closed = await Promise.allSettled(children.map((child) => child.close()));
			key.destroy();
			delete shared[slot];
			if (failure || closed.some((result) => result.status === "rejected"))
				throw new Error("Backup target fixture cleanup unavailable");
			const current = lstatSync(root);
			if (
				path.dirname(root) !== temp ||
				!path.basename(root).startsWith("draftyak-backup-target-") ||
				current.isSymbolicLink() ||
				current.dev !== birth.dev ||
				current.ino !== birth.ino
			)
				throw new Error("Unowned backup target fixture directory");
			rmSync(root, { recursive: true, force: true });
		})();
		return closing;
	};
	try {
		const modules = path.join(root, "modules"),
			folder = path.join(modules, "backup-fixture");
		mkdirSync(modules, { mode: 0o700 });
		mkdirSync(folder, { mode: 0o700 });
		const source = `const observer = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(slot))})];
const provider = {
  id: "fixture-target", refuses: ${JSON.stringify(selected)},
  async put(name, sealed, manifest) {
    const operation = (async () => {
      const call = { receiver: this, name, manifest, chunks: [] };
      observer.calls.push(call);
      await observer.wait("before");
      for await (const chunk of sealed) {
        const copy = Buffer.from(chunk);
        call.chunks.push(copy); observer.received.push(copy);
        await observer.wait("chunk");
      }
      await observer.wait("after");
    })();
    observer.pending.add(operation);
    try { await operation; } finally { observer.pending.delete(operation); }
  },
  async list() { return []; }, async *get() {}, async delete() {}
};
observer.provider = provider;
export default { id: "backup-fixture", version: "1.0.0", register(registry) { registry.backup(provider); } };
`;
		const entry = path.join(folder, "index.mjs");
		writeFileSync(entry, source, { flag: "wx", mode: 0o600 });
		const config = {
			modules: [
				{
					id: "backup-fixture",
					version: "1.0.0",
					entry,
					sha512: `sha512-${createHash("sha512").update(source).digest("base64")}`,
					provides: ["backup"],
				},
			],
		};
		writeFileSync(path.join(root, "config.json"), JSON.stringify(config), {
			flag: "wx",
			mode: 0o600,
		});
		host = await startExtensions({ dataDirectory: root, nativeBinding, masterKey: key });
		if (!control.provider || host.providers("backup").length !== 1)
			throw new Error("Backup target fixture registration unavailable");
		return {
			host,
			targetId: "fixture-target",
			provider: control.provider,
			calls: control.calls,
			received: control.received,
			pause(stage: Stage): NativeBackupTargetGate {
				if (stopping || gates.has(stage)) throw new Error("Backup target fixture gate unavailable");
				let signal!: () => void, release!: () => void;
				const entered = new Promise<void>((resolve) => {
					signal = resolve;
				});
				const wait = new Promise<void>((resolve) => {
					release = resolve;
				});
				gates.set(stage, { entered, wait, signal, release });
				return { entered, release };
			},
			track<T>(promise: Promise<T>): Promise<T> {
				tracked.add(promise);
				void promise.then(
					() => {
						tracked.delete(promise);
					},
					() => {
						tracked.delete(promise);
					},
				);
				return promise;
			},
			async openSecondHost(): Promise<NativeBackupTargetFixture> {
				if (stopping) throw new Error("Backup target fixture is closing");
				const opening = createNativeBackupTargetFixture(selected);
				tracked.add(opening);
				try {
					const child = await opening;
					children.push(child);
					return child;
				} finally {
					tracked.delete(opening);
				}
			},
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
