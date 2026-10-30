import "reflect-metadata";
import { type ChildProcess, spawn } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { X509CertificateGenerator } from "@peculiar/x509";
import Database from "better-sqlite3-multiple-ciphers";
import { expect, it, vi } from "vitest";
import { HubIdentity } from "../../src/identity/hub-key.ts";
import {
	HubKeyRotation,
	openRotatedIdentity,
} from "../../src/identity/hub-key-rotation/rotation.ts";
import { nativeBinding } from "../store/helpers.ts";
import { keyHash, type RotationFixture, rotationFixture } from "./hub-key-rotation/fixture.ts";

interface Reply {
	readonly id: number;
	readonly ok: boolean;
	readonly value?: unknown;
	readonly code?: string;
}

class RotationChild {
	readonly process: ChildProcess;
	readonly closed: Promise<void>;
	readonly #pending = new Map<
		number,
		{ resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	#nextId = 0;
	#output = 0;
	constructor(dir: string) {
		this.process = spawn(
			process.execPath,
			[fileURLToPath(new URL("./hub-key-rotation/child.ts", import.meta.url))],
			{
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				serialization: "advanced",
				windowsHide: true,
				env: { SystemRoot: process.env.SystemRoot, TEMP: dir, TMP: dir, NO_COLOR: "1" },
			},
		);
		const count = (chunk: Buffer): void => {
			this.#output += chunk.length;
		};
		this.process.stdout?.on("data", count);
		this.process.stderr?.on("data", count);
		this.process.on("message", (reply: Reply) => {
			const pending = this.#pending.get(reply.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.#pending.delete(reply.id);
			pending.resolve(reply);
		});
		this.process.on("error", () => {
			for (const pending of this.#pending.values()) pending.reject(new Error("Child failed"));
		});
		this.closed = new Promise((resolve) => {
			this.process.once("close", () => {
				for (const pending of this.#pending.values()) {
					clearTimeout(pending.timer);
					pending.reject(new Error("Child closed before reply"));
				}
				this.#pending.clear();
				resolve();
			});
		});
	}
	request(command: string, input: Record<string, unknown> = {}): Promise<Reply> {
		const id = ++this.#nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error("Child reply timed out"));
			}, 30_000);
			this.#pending.set(id, { resolve, reject, timer });
			this.process.send?.({ ...input, id, command });
		});
	}
	async kill(): Promise<void> {
		if (this.process.exitCode === null && this.process.signalCode === null)
			this.process.kill("SIGKILL");
		await this.closed;
		expect(this.#output).toBe(0);
	}
}

interface Persisted {
	readonly hid: string;
	readonly certificate: string;
	readonly chain: unknown[];
	readonly audit: unknown;
}
function persisted(f: RotationFixture, identity: HubIdentity): Persisted {
	return f.store.read((db) => ({
		hid: identity.hid,
		certificate: identity.certificate,
		chain: db.all("SELECT seq,id,old_key,new_key FROM main.hub_identity_rotations ORDER BY seq"),
		audit: db.get("SELECT audit_seq,audit_head,audit_tag FROM main.audit_meta WHERE singleton=1"),
	}));
}
// A restart: a new connection and the restart loader, which must never make an identity.
async function restart(f: RotationFixture): Promise<{ identity: HubIdentity; state: Persisted }> {
	f.reopen();
	const create = vi.spyOn(X509CertificateGenerator, "createSelfSigned");
	try {
		const identity = await openRotatedIdentity(f.store, f.key, f.audit);
		expect(create).not.toHaveBeenCalled();
		return { identity, state: persisted(f, identity) };
	} finally {
		create.mockRestore();
	}
}
async function withChildren(
	work: (
		f: RotationFixture,
		start: () => Promise<RotationChild>,
		genesis: Persisted,
	) => Promise<void>,
): Promise<void> {
	const f = await rotationFixture();
	const children: RotationChild[] = [];
	const errors: unknown[] = [];
	try {
		const identity = await HubIdentity.loadOrCreate(f.store, f.key);
		const genesis = persisted(f, identity);
		identity.lock();
		const start = async (): Promise<RotationChild> => {
			const child = new RotationChild(f.dir);
			children.push(child);
			const key = f.masterBytes();
			try {
				const reply = await child.request("init", { dir: f.dir, filename: f.filename, key });
				expect(reply).toMatchObject({
					ok: true,
					value: { pid: child.process.pid, hid: genesis.hid },
				});
			} finally {
				key.fill(0);
			}
			expect(await child.request("prepare")).toMatchObject({ ok: true });
			return child;
		};
		await work(f, start, genesis);
	} catch (error) {
		errors.push(error);
	} finally {
		for (const result of await Promise.allSettled(children.map((child) => child.kill())))
			if (result.status === "rejected") errors.push(result.reason);
		try {
			f.cleanup();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length) throw new AggregateError(errors, "Rotation process test failed");
}

it.each(["hold-clock", "hold-commit"])(
	"keeps the old identity when a process dies inside an uncommitted rotation (%s)",
	async (command) => {
		await withChildren(async (f, start, genesis) => {
			const child = await start();
			expect(await child.request(command, { epoch: 2 })).toMatchObject({
				ok: true,
				value: { staged: true },
			});
			await child.kill();
			const { identity, state } = await restart(f);
			try {
				expect(state).toEqual(genesis);
			} finally {
				identity.lock();
			}
		});
	},
	120_000,
);

it("keeps the rotated identity when a process dies right after the rotation commits", async () => {
	await withChildren(async (f, start, genesis) => {
		const child = await start();
		const reply = await child.request("commit", { epoch: 2 });
		await child.kill();
		expect(reply).toMatchObject({ ok: true, value: { seq: 1 } });
		const { newKey } = reply.value as { newKey: string };
		const { identity, state } = await restart(f);
		const rotation = new HubKeyRotation(f.store, f.key, f.audit);
		try {
			expect(state.hid).toBe(keyHash(newKey));
			expect(state.certificate).not.toBe(genesis.certificate);
			expect(state.chain).toMatchObject([{ seq: 1, new_key: newKey }]);
			expect(f.store.read((db) => rotation.chain(db))).toMatchObject([{ seq: 1, newKey }]);
		} finally {
			identity.lock();
			rotation.lock();
		}
	});
}, 120_000);

it("lets exactly one of two processes rotate the same identity", async () => {
	await withChildren(async (f, start, genesis) => {
		const children = await Promise.all([start(), start()]);
		expect(children[0].process.pid).not.toBe(children[1].process.pid);
		const replies = await Promise.all(
			children.map((child) => child.request("commit", { epoch: 2 })),
		);
		const winners = replies.filter((reply) => reply.ok);
		expect(winners).toHaveLength(1);
		expect(replies.filter((reply) => !reply.ok)).toEqual([
			expect.objectContaining({ code: "Hub identity rotation unavailable" }),
		]);
		const { newKey } = (winners[0]?.value ?? {}) as { newKey?: string };
		const { identity, state } = await restart(f);
		try {
			expect(state.hid).toBe(keyHash(newKey ?? ""));
			expect(state.chain).toMatchObject([{ seq: 1, new_key: newKey }]);
			expect(state.hid).not.toBe(genesis.hid);
		} finally {
			identity.lock();
		}
	});
}, 120_000);

it("never writes the outgoing or successor private key to the database files", async () => {
	const f = await rotationFixture();
	const needles: Buffer[] = [];
	let identity: HubIdentity | undefined;
	let rotation: HubKeyRotation | undefined;
	const scan = (bytes: Buffer): boolean[] => needles.map((needle) => bytes.includes(needle));
	const keyBytes = (pem: Buffer): void => {
		needles.push(pem, createPrivateKey(pem).export({ format: "der", type: "pkcs8" }));
	};
	try {
		identity = await HubIdentity.loadOrCreate(f.store, f.key);
		keyBytes(identity.tlsPrivateKey());
		rotation = new HubKeyRotation(f.store, f.key, f.audit);
		const current = rotation;
		const prepared = await current.prepareSuccessor(identity);
		f.store.write((tx) =>
			current.commit(tx, prepared, { epoch: 1, actor: { kind: "cli", id: null } }),
		);
		identity = await openRotatedIdentity(f.store, f.key, f.audit);
		keyBytes(identity.tlsPrivateKey());
		const control = path.join(f.dir, "plaintext-control.db");
		const plain = new Database(control, { nativeBinding });
		try {
			plain.exec("CREATE TABLE controls(value BLOB)");
			for (const needle of needles) plain.prepare("INSERT INTO controls VALUES(?)").run(needle);
		} finally {
			plain.close();
		}
		expect(scan(readFileSync(control))).toEqual(needles.map(() => true));
		unlinkSync(control);
		const scanFiles = (): void => {
			const files = readdirSync(f.dir, { withFileTypes: true }).filter((entry) => entry.isFile());
			expect(files.map((entry) => entry.name)).toContain("draftyak.db");
			for (const entry of files)
				expect(scan(readFileSync(path.join(f.dir, entry.name)))).toEqual(needles.map(() => false));
		};
		scanFiles();
		f.store.checkpoint();
		scanFiles();
		identity.lock();
		rotation.lock();
		f.store.close();
		scanFiles();
	} finally {
		identity?.lock();
		rotation?.lock();
		for (const needle of needles) needle.fill(0);
		f.cleanup();
	}
}, 120_000);
