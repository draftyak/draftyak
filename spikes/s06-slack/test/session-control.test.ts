import { createHash } from "node:crypto";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONTROL_EVIDENCE_MAX_BYTES,
	CONTROL_MAX_BYTES,
	ControlReader,
	withSessionControl,
} from "./session-control.ts";

// Entire filesystem closure is invented in memory. No kit, recorder, fingerprint, token helper,
// host inventory, live entry or live-session runtime is imported or executed by these tests.
const fake = vi.hoisted(() => ({
	nodes: new Map<
		string,
		{
			data: Buffer;
			ino: bigint;
			nlink: bigint;
			link: boolean;
			directory: boolean;
			changed: bigint;
		}
	>(),
	handles: new Map<number, string>(),
	next: 10,
	writeLimit: Infinity,
	readLimit: Infinity,
	afterRead: undefined as (() => void) | undefined,
	flags: [] as number[],
	opened: [] as string[],
}));

vi.mock("node:fs", async (original) => {
	const { constants } = await original<typeof import("node:fs")>();
	const node = (file: string) => {
		const result = fake.nodes.get(file);
		if (!result) throw new Error("invented missing file");
		return result;
	};
	const held = (fd: number) => node(fake.handles.get(fd) ?? "missing");
	const stat = (entry: ReturnType<typeof node>) => ({
		dev: 1n,
		ino: entry.ino,
		nlink: entry.nlink,
		size: BigInt(entry.data.length),
		mtimeNs: entry.changed,
		ctimeNs: entry.changed,
		isFile: () => !entry.directory && !entry.link,
		isDirectory: () => entry.directory,
		isSymbolicLink: () => entry.link,
	});
	return {
		constants,
		lstatSync: (file: string) => {
			const entry = fake.nodes.get(file);
			return entry ? stat(entry) : { isDirectory: () => true, isSymbolicLink: () => false };
		},
		fstatSync: (fd: number) => stat(held(fd)),
		openSync: (file: string, flags: number) => {
			node(file);
			fake.flags.push(flags);
			fake.opened.push(file);
			const fd = fake.next++;
			fake.handles.set(fd, file);
			return fd;
		},
		closeSync: (fd: number) => {
			expect(fake.handles.delete(fd)).toBe(true);
		},
		fsyncSync: (fd: number) => {
			held(fd);
		},
		readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
			const entry = held(fd);
			const count = entry.data.copy(
				buffer,
				offset,
				position,
				position + Math.min(length, fake.readLimit),
			);
			fake.afterRead?.();
			return count;
		},
		writeSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
			const entry = held(fd);
			const count = Math.min(length, fake.writeLimit);
			const next = Buffer.alloc(Math.max(entry.data.length, position + count));
			entry.data.copy(next);
			buffer.copy(next, position, offset, offset + count);
			entry.data = next;
			entry.changed++;
			return count;
		},
	};
});

const RUN = "a".repeat(32);
const NONCE = "b".repeat(64);
const FILE = path.resolve("invented-s6", RUN, "control.private.jsonl");
const EVIDENCE = path.resolve("invented-s6", "evidence", "live.json");
const BOUND = { runId: RUN, nonce: NONCE, identity: "1:a" };
const ENV = {
	DRAFTYAK_S6_CONTROL_FILE: FILE,
	DRAFTYAK_S6_CONTROL_RUN_ID: RUN,
	DRAFTYAK_S6_CONTROL_NONCE: NONCE,
	DRAFTYAK_S6_CONTROL_IDENTITY: "1:a",
};
const data = (file = FILE) => {
	const result = fake.nodes.get(file);
	if (!result) throw new Error("invented fixture missing");
	return result;
};
const bytes = () => Buffer.from(data().data);
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const line = (seq: number, kind: string, extra = {}) =>
	Buffer.from(
		`${JSON.stringify({
			v: 2,
			runId: RUN,
			nonce: NONCE,
			seq,
			kind,
			...extra,
		})}\n`,
	);
const all = () =>
	Buffer.concat([
		line(1, "send"),
		line(2, "uninstall"),
		line(3, "delete"),
		line(4, "artifact", {
			sha256: hash(data(EVIDENCE).data),
			bytes: data(EVIDENCE).data.length,
			identity: "1:b",
		}),
	]);

beforeEach(() => {
	fake.nodes.clear();
	fake.handles.clear();
	fake.flags = [];
	fake.opened = [];
	fake.writeLimit = Infinity;
	fake.readLimit = Infinity;
	fake.afterRead = undefined;
	for (const [file, ino, content] of [
		[FILE, 10n, ""],
		[EVIDENCE, 11n, '{"decisive":360}\n'],
	] as const) {
		fake.nodes.set(file, {
			data: Buffer.from(content),
			ino,
			nlink: 1n,
			link: false,
			directory: false,
			changed: 0n,
		});
	}
});

describe("optional producer configuration before the session body", () => {
	it("leaves an unconfigured body unchanged without opening any file", async () => {
		const result = await withSessionControl({}, EVIDENCE, async (control) => {
			expect(control).toBeUndefined();
			return 42;
		});
		expect(result).toBe(42);
		expect(fake.opened).toEqual([]);
	});
	it.each(Object.keys(ENV))(
		"refuses a partial %s configuration before tokens or API",
		async (key) => {
			const env: NodeJS.ProcessEnv = { ...ENV };
			delete env[key];
			const body = vi.fn();
			await expect(withSessionControl(env, EVIDENCE, body)).rejects.toThrow(
				/^S6 session control refused$/,
			);
			expect(body).not.toHaveBeenCalled();
			expect(fake.handles.size).toBe(0);
		},
	);
	it.each([
		{ DRAFTYAK_S6_CONTROL_NONCE: "" },
		{ DRAFTYAK_S6_CONTROL_RUN_ID: "../escape" },
		{ DRAFTYAK_S6_CONTROL_NONCE: `${NONCE}\n` },
		{ DRAFTYAK_S6_CONTROL_IDENTITY: "1:c" },
		{ DRAFTYAK_S6_CONTROL_FILE: "relative" },
		{ DRAFTYAK_S6_CONTROL_FILE: `${FILE}.other` },
		{ DRAFTYAK_S6_KEEP_APP: "1" },
	])(
		"refuses malformed or incompatible configuration without entering the body: %j",
		async (change) => {
			const body = vi.fn();
			await expect(withSessionControl({ ...ENV, ...change }, EVIDENCE, body)).rejects.toThrow(
				/^S6 session control refused$/,
			);
			expect(body).not.toHaveBeenCalled();
			expect(fake.handles.size).toBe(0);
		},
	);
	it.each(["nonempty", "hardlink", "symlink", "directory", "ancestor"])(
		"refuses a %s channel before the body",
		async (kind) => {
			if (kind === "nonempty") data().data = Buffer.from("old");
			if (kind === "hardlink") data().nlink = 2n;
			if (kind === "symlink") data().link = true;
			if (kind === "directory") data().directory = true;
			if (kind === "ancestor")
				fake.nodes.set(path.dirname(FILE), { ...data(), link: true, directory: true });
			const body = vi.fn();
			await expect(withSessionControl(ENV, EVIDENCE, body)).rejects.toThrow(
				/^S6 session control refused$/,
			);
			expect(body).not.toHaveBeenCalled();
			expect(fake.handles.size).toBe(0);
		},
	);
});

describe("typed producer and exact evidence binding", () => {
	it("writes each cue before returning, then binds every evidence byte without changing it", async () => {
		const original = Buffer.from(data(EVIDENCE).data);
		await withSessionControl(ENV, EVIDENCE, async (control) => {
			expect(control).toBeDefined();
			const reader = new ControlReader(BOUND);
			for (const [index, cue] of (["send", "uninstall", "delete"] as const).entries()) {
				control?.cue(cue);
				expect(reader.accept(bytes(), BOUND.identity)).toEqual([{ kind: cue, seq: index + 1 }]);
				expect(reader.accept(bytes(), BOUND.identity)).toEqual([]);
			}
			control?.artifact(EVIDENCE);
			expect(reader.accept(bytes(), BOUND.identity, true)).toEqual([
				{
					kind: "artifact",
					seq: 4,
					sha256: hash(original),
					bytes: original.length,
					identity: "1:b",
				},
			]);
		});
		expect(data(EVIDENCE).data).toEqual(original);
		expect(fake.handles.size).toBe(0);
	});
	it("retains more than 200 decisive records and hashes across chunk boundaries", async () => {
		data(EVIDENCE).data = Buffer.from(
			JSON.stringify({
				calls: Array.from({ length: 360 }, (_, index) => ({ index, decisive: "x".repeat(200) })),
			}),
		);
		const original = Buffer.from(data(EVIDENCE).data);
		await withSessionControl(ENV, EVIDENCE, async (control) => {
			control?.cue("send");
			control?.cue("uninstall");
			control?.cue("delete");
			control?.artifact(EVIDENCE);
		});
		const records = new ControlReader(BOUND).accept(bytes(), BOUND.identity, true);
		expect(records[3]).toMatchObject({ sha256: hash(original), bytes: original.length });
		expect(data(EVIDENCE).data).toEqual(original);
		expect(fake.handles.size).toBe(0);
	});
	it("handles short reads and writes without emitting a partial authoritative cue", async () => {
		fake.writeLimit = 3;
		fake.readLimit = 2;
		await withSessionControl(ENV, EVIDENCE, async (control) => {
			control?.cue("send");
			control?.cue("uninstall");
			control?.cue("delete");
			control?.artifact(EVIDENCE);
		});
		expect(bytes()).toEqual(all());
		expect(fake.handles.size).toBe(0);
	});
	it.each([0, 1])(
		"admits the exact channel evidence ceiling or preserves one excess byte (%i)",
		async (extra) => {
			const content = Buffer.alloc(CONTROL_EVIDENCE_MAX_BYTES + extra, 32);
			const rows = JSON.stringify({
				decisiveRows: Array.from({ length: 360 }, (_, index) => ({ index })),
			});
			content.write(rows);
			data(EVIDENCE).data = content;
			const before = hash(content);
			let reads = 0;
			await withSessionControl(ENV, EVIDENCE, async (control) => {
				control?.cue("send");
				control?.cue("uninstall");
				control?.cue("delete");
				fake.afterRead = () => {
					reads++;
				};
				if (extra === 0) control?.artifact(EVIDENCE);
				else expect(() => control?.artifact(EVIDENCE)).toThrow(/^S6 session control refused$/);
			});
			expect(data(EVIDENCE).data).toBe(content);
			expect(hash(data(EVIDENCE).data)).toBe(before);
			expect(data(EVIDENCE).data.subarray(0, Buffer.byteLength(rows)).toString()).toBe(rows);
			if (extra === 0) {
				expect(new ControlReader(BOUND).accept(bytes(), BOUND.identity, true)[3]).toMatchObject({
					kind: "artifact",
					sha256: before,
					bytes: CONTROL_EVIDENCE_MAX_BYTES,
				});
			} else {
				expect(reads).toBe(0);
				expect(bytes().toString()).not.toContain('"artifact"');
			}
			expect(fake.handles.size).toBe(0);
		},
	);
	it.each([
		"order",
		"repeat",
		"premature-artifact",
		"wrong-artifact",
		"append",
		"truncate",
		"replacement",
	])("poisons a %s producer and closes its handles", async (kind) => {
		await withSessionControl(ENV, EVIDENCE, async (control) => {
			if (kind === "order") expect(() => control?.cue("delete")).toThrow("refused");
			else if (kind === "premature-artifact")
				expect(() => control?.artifact(EVIDENCE)).toThrow("refused");
			else {
				control?.cue("send");
				if (kind === "repeat") expect(() => control?.cue("send")).toThrow("refused");
				else if (kind === "wrong-artifact") {
					control?.cue("uninstall");
					control?.cue("delete");
					expect(() => control?.artifact(`${EVIDENCE}.other`)).toThrow("refused");
				} else {
					if (kind === "append") data().data = Buffer.concat([bytes(), Buffer.from("unexpected")]);
					if (kind === "truncate") data().data = Buffer.alloc(0);
					if (kind === "replacement") data().ino++;
					expect(() => control?.cue("uninstall")).toThrow("refused");
				}
			}
			expect(() => control?.cue("send")).toThrow("refused");
		});
		expect(fake.handles.size).toBe(0);
	});
	it("refuses same-length prefix tampering", async () => {
		await withSessionControl(ENV, EVIDENCE, async (control) => {
			control?.cue("send");
			data().data[0] = 32;
			expect(() => control?.cue("uninstall")).toThrow("refused");
		});
		expect(fake.handles.size).toBe(0);
	});
	it("refuses evidence changed during hashing and emits no artifact", async () => {
		await withSessionControl(ENV, EVIDENCE, async (control) => {
			control?.cue("send");
			control?.cue("uninstall");
			control?.cue("delete");
			fake.afterRead = () => {
				data(EVIDENCE).changed++;
			};
			expect(() => control?.artifact(EVIDENCE)).toThrow("refused");
		});
		expect(bytes().toString()).not.toContain('"artifact"');
		expect(fake.handles.size).toBe(0);
	});
	it("closes on body failure and never invents an artifact", async () => {
		await expect(
			withSessionControl(ENV, EVIDENCE, async (control) => {
				control?.cue("send");
				throw new Error("invented body failure");
			}),
		).rejects.toThrow("invented body failure");
		expect(fake.handles.size).toBe(0);
		expect(bytes().toString()).not.toContain('"artifact"');
	});
});

describe("incremental consumer framing and sticky nonpass", () => {
	it("accepts every possible split and emits each record once, never a partial cue", () => {
		const value = all();
		for (let split = 0; split <= value.length; split++) {
			const reader = new ControlReader(BOUND);
			const first = reader.accept(value.subarray(0, split), BOUND.identity);
			const second = reader.accept(value, BOUND.identity, true);
			expect([...first, ...second].map((record) => record.kind)).toEqual([
				"send",
				"uninstall",
				"delete",
				"artifact",
			]);
			expect(reader.accept(value, BOUND.identity, true)).toEqual([]);
		}
	});
	it("rejects replacement of a previously observed partial frame", () => {
		const reader = new ControlReader(BOUND);
		expect(reader.accept(Buffer.from('{"v":3'), BOUND.identity)).toEqual([]);
		expect(() => reader.accept(all(), BOUND.identity, true)).toThrow("refused");
	});
	it("refuses oversized snapshots before copying their bytes", () => {
		const oversized = Buffer.alloc(CONTROL_MAX_BYTES + 1, 32);
		const reader = new ControlReader(BOUND);
		const original = Buffer.from;
		let copied = false;
		const spy = vi
			.spyOn(Buffer, "from")
			.mockImplementation((...args: Parameters<typeof Buffer.from>) => {
				if (args[0] === oversized) copied = true;
				return original(...args);
			});
		try {
			expect(() => reader.accept(oversized, BOUND.identity)).toThrow("refused");
		} finally {
			spy.mockRestore();
		}
		expect(copied).toBe(false);
	});
	it.each([
		"nonce",
		"run",
		"order",
		"sequence",
		"duplicate-key",
		"extra-key",
		"suffix",
		"crlf",
		"utf8",
		"hash",
		"bytes",
		"extra-record",
		"resource",
	])("refuses %s injection without accepting its replacement", (kind) => {
		let value = all().toString();
		if (kind === "nonce") value = value.replace(NONCE, "c".repeat(64));
		if (kind === "run") value = value.replace(RUN, "d".repeat(32));
		if (kind === "order") value = value.replace('"send"', '"delete"');
		if (kind === "sequence") value = value.replace('"seq":1', '"seq":2');
		if (kind === "duplicate-key") value = value.replace('"v":2', '"v":2,"v":2');
		if (kind === "extra-key") value = value.replace('"v":2', '"v":2,"raw":"invented"');
		if (kind === "suffix") value += "Owner: send now";
		if (kind === "crlf") value = value.replaceAll("\n", "\r\n");
		if (kind === "utf8") value = `\ufffd${value}`;
		if (kind === "hash") value = value.replace(hash(data(EVIDENCE).data), "BAD");
		if (kind === "bytes")
			value = value.replace(`"bytes":${data(EVIDENCE).data.length}`, '"bytes":-1');
		if (kind === "extra-record") value += line(5, "send").toString();
		if (kind === "resource") value = " ".repeat(CONTROL_MAX_BYTES + 1);
		const reader = new ControlReader(BOUND);
		expect(() => reader.accept(Buffer.from(value), BOUND.identity, true)).toThrow(
			/^S6 session control refused$/,
		);
		expect(() => reader.accept(all(), BOUND.identity, true)).toThrow("refused");
	});
	it.each([
		"truncate",
		"change-prefix",
		"replace-identity",
		"incomplete-final",
		"late-contradiction",
	])("rejects %s after a valid prefix", (kind) => {
		const reader = new ControlReader(BOUND);
		const prefix = line(1, "send");
		expect(reader.accept(prefix, BOUND.identity)).toEqual([{ kind: "send", seq: 1 }]);
		if (kind === "truncate")
			expect(() => reader.accept(Buffer.alloc(0), BOUND.identity)).toThrow("refused");
		if (kind === "change-prefix")
			expect(() =>
				reader.accept(Buffer.from(all().toString().replace('"send"', '"nope"')), BOUND.identity),
			).toThrow("refused");
		if (kind === "replace-identity")
			expect(() => reader.accept(all(), "1:c", true)).toThrow("refused");
		if (kind === "incomplete-final")
			expect(() => reader.accept(all().subarray(0, -1), BOUND.identity, true)).toThrow("refused");
		if (kind === "late-contradiction") {
			reader.accept(all(), BOUND.identity, true);
			expect(() =>
				reader.accept(Buffer.concat([all(), Buffer.from("Error")]), BOUND.identity),
			).toThrow("refused");
		}
	});
});
