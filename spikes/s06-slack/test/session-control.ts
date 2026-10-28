import { createHash } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readSync,
	writeSync,
} from "node:fs";
import path from "node:path";
import type { Cue } from "./live-session.ts";

// This private opt-in channel carries no log text or evidence content. Its parent owns the
// protected directory and retains its independent identity/lease; these checks add no OS ACL
// or same-user isolation claim. Version 2 requires a separate reviewed consumer binding.
const NAMES = [
	"DRAFTYAK_S6_CONTROL_FILE",
	"DRAFTYAK_S6_CONTROL_RUN_ID",
	"DRAFTYAK_S6_CONTROL_NONCE",
	"DRAFTYAK_S6_CONTROL_IDENTITY",
] as const;
const ID = /^[a-f0-9]{32}$/;
const NONCE = /^[a-f0-9]{64}$/;
const IDENTITY = /^[a-f0-9]{1,16}:[a-f0-9]{1,16}$/;
const HASH = /^[a-f0-9]{64}$/;
const KINDS = ["send", "uninstall", "delete", "artifact"] as const;
export const CONTROL_MAX_BYTES = 4096;
// Opt-in channel admission only: excess preserves the entire already-written evidence file.
// This ceiling is not proof of live-envelope compatibility and never changes ordinary recording.
export const CONTROL_EVIDENCE_MAX_BYTES: number = 64 * 1024 * 1024;
const RECORD_MAX_BYTES = 1024;
const REFUSED = "S6 session control refused";

function need(ok: unknown): asserts ok {
	if (!ok) throw new Error(REFUSED);
}

export interface Binding {
	readonly runId: string;
	readonly nonce: string;
	readonly identity: string;
}

function binding(value: Binding): void {
	need(ID.test(value.runId) && NONCE.test(value.nonce) && IDENTITY.test(value.identity));
}

type Stat = BigIntStats;
function identity(stat: Stat): string {
	return `${stat.dev.toString(16)}:${stat.ino.toString(16)}`;
}

function regular(stat: Stat): void {
	need(stat.isFile() && stat.nlink === 1n && stat.ino !== 0n);
}

function ancestors(file: string): void {
	let current = path.dirname(file);
	for (;;) {
		const stat = lstatSync(current);
		need(stat.isDirectory() && !stat.isSymbolicLink());
		const next = path.dirname(current);
		if (next === current) return;
		current = next;
	}
}

function sameFile(file: string, descriptor: number, expected: string): Stat {
	ancestors(file);
	const named = lstatSync(file, { bigint: true });
	const held = fstatSync(descriptor, { bigint: true });
	regular(named);
	regular(held);
	need(!named.isSymbolicLink() && identity(named) === expected && identity(held) === expected);
	return held;
}

function readExact(descriptor: number, bytes: number, at = 0): Buffer {
	const result = Buffer.alloc(bytes);
	let got = 0;
	while (got < bytes) {
		const count = readSync(descriptor, result, got, bytes - got, at + got);
		need(count > 0);
		got += count;
	}
	return result;
}

interface Artifact {
	readonly sha256: string;
	readonly bytes: number;
	readonly identity: string;
}

export type ControlRecord =
	| { readonly kind: Cue; readonly seq: number }
	| ({ readonly kind: "artifact"; readonly seq: 4 } & Artifact);

function frame(bound: Binding, seq: number, artifact?: Artifact): Buffer {
	const record = {
		v: 2,
		runId: bound.runId,
		nonce: bound.nonce,
		seq,
		kind: KINDS[seq - 1],
		...(artifact ?? {}),
	};
	const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
	need(bytes.length <= RECORD_MAX_BYTES);
	return bytes;
}

// The consumer validates cumulative snapshots, including partial writes. A malformed prefix,
// replacement, truncation or late contradiction permanently poisons this reader instance.
export class ControlReader {
	private seen = Buffer.alloc(0);
	private count = 0;
	private failed = false;
	private readonly bound: Binding;
	constructor(value: Binding) {
		binding(value);
		this.bound = Object.freeze({ ...value });
	}
	accept(bytes: Uint8Array, fileIdentity: string, complete = false): readonly ControlRecord[] {
		try {
			need(!this.failed && fileIdentity === this.bound.identity);
			need(bytes instanceof Uint8Array && bytes.length <= CONTROL_MAX_BYTES);
			const current = Buffer.from(bytes);
			need(current.length <= CONTROL_MAX_BYTES && current.length >= this.seen.length);
			need(current.subarray(0, this.seen.length).equals(this.seen));
			need(current.every((byte) => byte === 10 || (byte >= 32 && byte <= 126)));
			const lines = current.toString("ascii").split("\n");
			const partial = lines.pop() ?? "";
			need(lines.length <= 4 && partial.length < RECORD_MAX_BYTES);
			need(!complete || (lines.length === 4 && partial === ""));
			need(lines.length < 4 || partial === "");
			const records: ControlRecord[] = [];
			for (let index = 0; index < lines.length; index++) {
				const line = lines[index] ?? "";
				need(line.length + 1 <= RECORD_MAX_BYTES);
				const actual = Buffer.from(`${line}\n`);
				if (index < 3) {
					need(actual.equals(frame(this.bound, index + 1)));
					records.push({ kind: KINDS[index] as Cue, seq: index + 1 });
				} else {
					const row = JSON.parse(line) as Artifact;
					need(HASH.test(row.sha256) && IDENTITY.test(row.identity));
					need(Number.isSafeInteger(row.bytes) && row.bytes >= 0);
					need(
						actual.equals(
							frame(this.bound, 4, {
								sha256: row.sha256,
								bytes: row.bytes,
								identity: row.identity,
							}),
						),
					);
					records.push({
						kind: "artifact",
						seq: 4,
						sha256: row.sha256,
						bytes: row.bytes,
						identity: row.identity,
					});
				}
			}
			const fresh = records.slice(this.count);
			this.count = lines.length;
			this.seen = current;
			return fresh;
		} catch {
			this.failed = true;
			throw new Error(REFUSED);
		}
	}
}

export interface SessionControl {
	readonly cue: (step: Cue) => void;
	readonly artifact: (file: string) => void;
	readonly close: () => void;
}

function openControl(env: NodeJS.ProcessEnv, evidenceFile: string): SessionControl | undefined {
	const values = NAMES.map((name) => env[name]);
	if (values.every((value) => value === undefined)) return undefined;
	need(values.every((value) => typeof value === "string" && value !== ""));
	const [file = "", runId = "", nonce = "", expected = ""] = values;
	const bound = { runId, nonce, identity: expected };
	binding(bound);
	need(env.DRAFTYAK_S6_KEEP_APP !== "1");
	need(path.isAbsolute(file) && path.resolve(file) === file);
	need(
		path.basename(file) === "control.private.jsonl" && path.basename(path.dirname(file)) === runId,
	);
	need(path.isAbsolute(evidenceFile) && path.resolve(evidenceFile) !== file);
	ancestors(file);
	const named = lstatSync(file, { bigint: true });
	regular(named);
	need(!named.isSymbolicLink() && identity(named) === expected && named.size === 0n);
	const descriptor = openSync(
		file,
		constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
	);
	let closed = false;
	let failed = false;
	let seq = 0;
	let prefix = Buffer.alloc(0);
	const close = (): void => {
		if (!closed) {
			closed = true;
			try {
				closeSync(descriptor);
			} catch {
				throw new Error(REFUSED);
			}
		}
	};
	const check = (): void => {
		const held = sameFile(file, descriptor, expected);
		need(held.size === BigInt(prefix.length));
		need(readExact(descriptor, prefix.length).equals(prefix));
	};
	try {
		check();
	} catch {
		close();
		throw new Error(REFUSED);
	}
	const append = (kind: (typeof KINDS)[number], artifact?: Artifact): void => {
		try {
			need(!closed && !failed && kind === KINDS[seq]);
			check();
			const next = frame(bound, seq + 1, artifact);
			need(prefix.length + next.length <= CONTROL_MAX_BYTES);
			let wrote = 0;
			while (wrote < next.length) {
				const count = writeSync(
					descriptor,
					next,
					wrote,
					next.length - wrote,
					prefix.length + wrote,
				);
				need(count > 0);
				wrote += count;
			}
			fsyncSync(descriptor);
			prefix = Buffer.concat([prefix, next]);
			check();
			seq++;
		} catch {
			failed = true;
			close();
			throw new Error(REFUSED);
		}
	};
	return {
		cue: (step) => append(step),
		artifact: (target) => {
			let evidence: number | undefined;
			try {
				need(
					!closed && !failed && seq === 3 && path.resolve(target) === path.resolve(evidenceFile),
				);
				ancestors(target);
				regular(lstatSync(target, { bigint: true }));
				evidence = openSync(
					target,
					constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
				);
				const before = fstatSync(evidence, { bigint: true });
				regular(before);
				const expectedEvidence = identity(before);
				sameFile(target, evidence, expectedEvidence);
				need(before.size <= BigInt(CONTROL_EVIDENCE_MAX_BYTES));
				const bytes = Number(before.size);
				const hash = createHash("sha256");
				// Hash exactly the admitted initial length without imposing an evidence-record cap.
				for (let at = 0; at < bytes; at += 65536) {
					hash.update(readExact(evidence, Math.min(65536, bytes - at), at));
				}
				const after = sameFile(target, evidence, expectedEvidence);
				need(
					after.size === before.size &&
						after.mtimeNs === before.mtimeNs &&
						after.ctimeNs === before.ctimeNs,
				);
				append("artifact", { sha256: hash.digest("hex"), bytes, identity: expectedEvidence });
			} catch {
				failed = true;
				close();
				throw new Error(REFUSED);
			} finally {
				if (evidence !== undefined) closeSync(evidence);
			}
		},
		close,
	};
}

// Opening/refusing the channel happens before the supplied body can load tokens or call an API.
// Missing configuration leaves the body unchanged. All diagnostics here are fixed and private.
export async function withSessionControl<T>(
	env: NodeJS.ProcessEnv,
	evidenceFile: string,
	body: (control: SessionControl | undefined) => Promise<T>,
): Promise<T> {
	let control: SessionControl | undefined;
	try {
		control = openControl(env, evidenceFile);
	} catch {
		throw new Error(REFUSED);
	}
	try {
		return await body(control);
	} finally {
		control?.close();
	}
}
