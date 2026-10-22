import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AuthorityError,
	type AuthorityTransport,
	assertAuthorityCurrent,
	loadCurrentAuthority,
	RepositoryAuthority,
} from "../src/authority.ts";

// Every HTTPS call in this file is intercepted before the module is imported.
const network = vi.hoisted(() => ({
	request: (..._args: unknown[]): unknown => {
		throw new Error("unexpected synthetic request");
	},
}));
vi.mock("node:https", () => ({ request: (...args: unknown[]) => network.request(...args) }));

const CURRENT = "a".repeat(40);
const OLD = "b".repeat(40);
const HEAD = "c".repeat(40);
const json = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));

function fixture(
	revisions: string[],
	records: Record<string, Uint8Array>,
): {
	transport: AuthorityTransport;
	requested: string[];
} {
	let index = 0;
	const requested: string[] = [];
	return {
		requested,
		transport: {
			currentRevision: async () => revisions[Math.min(index++, revisions.length - 1)] ?? "",
			recordAt: async (ref) => {
				requested.push(ref);
				const value = records[ref];
				if (!value) throw new Error("synthetic missing record");
				return value;
			},
		},
	};
}

describe("current protected repository record loading", () => {
	it("selects the current base and ignores a forged head approval", async () => {
		const current = { version: 1, state: "refusal-only" };
		const f = fixture([CURRENT], {
			[CURRENT]: json(current),
			[HEAD]: json({ version: 1, approved: true, state: "active" }),
		});
		const loaded = await loadCurrentAuthority(f.transport);
		expect(loaded.revision).toBe(CURRENT);
		expect(loaded.record).toEqual(current);
		expect(loaded.recordDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(f.requested).toEqual([CURRENT]);
	});

	it("freezes the exact digested authority and nested record for the whole capture", async () => {
		const f = fixture([CURRENT], {
			[CURRENT]: json({ version: 1, nested: { gate: "closed" }, values: ["revoked"] }),
		});
		const loaded = await loadCurrentAuthority(f.transport);
		const value = loaded.record as { nested: { gate: string }; values: string[] };
		expect(Object.isFrozen(loaded)).toBe(true);
		expect(() => {
			value.nested.gate = "open";
		}).toThrow(TypeError);
		expect(() => {
			value.values[0] = "active";
		}).toThrow(TypeError);
		expect(value).toEqual({ version: 1, nested: { gate: "closed" }, values: ["revoked"] });
	});

	it("loads a delivered terminal state instead of an older legitimate active record", async () => {
		const terminal = { version: 1, state: "revoked", gate: "closed" };
		const f = fixture([CURRENT], {
			[CURRENT]: json(terminal),
			[OLD]: json({ version: 1, state: "active", gate: "open" }),
		});
		expect((await loadCurrentAuthority(f.transport)).record).toEqual(terminal);
		expect(f.requested).toEqual([CURRENT]);
	});

	it.each(["", HEAD.toUpperCase(), "refs/heads/m4", `${CURRENT}/../${OLD}`])(
		"refuses an unresolved or non-immutable revision",
		async (invalid) => {
			const f = fixture([invalid], { [OLD]: json({ state: "active" }) });
			await expect(loadCurrentAuthority(f.transport)).rejects.toBeInstanceOf(AuthorityError);
			expect(f.requested).toEqual([]);
		},
	);

	it("never falls back to an old local record when the current record is unavailable", async () => {
		const f = fixture([CURRENT], { [OLD]: json({ version: 1, state: "active" }) });
		await expect(loadCurrentAuthority(f.transport)).rejects.toMatchObject({
			code: "AUTHORITY_UNAVAILABLE",
		});
		expect(f.requested).toEqual([CURRENT]);
	});

	it.each([Buffer.from('{"state":"active","state":"revoked"}'), Buffer.from([0xff])])(
		"refuses malformed trusted bytes rather than replacing them with head data",
		async (bytes) => {
			const f = fixture([CURRENT], { [CURRENT]: bytes, [HEAD]: json({ state: "active" }) });
			await expect(loadCurrentAuthority(f.transport)).rejects.toBeInstanceOf(AuthorityError);
			expect(f.requested).toEqual([CURRENT]);
		},
	);

	it("refuses a trusted state change during loading", async () => {
		const f = fixture([OLD, CURRENT], { [OLD]: json({ state: "active" }) });
		await expect(loadCurrentAuthority(f.transport)).rejects.toMatchObject({
			code: "AUTHORITY_CHANGED",
		});
	});

	it("rechecks current state immediately before a later verdict", async () => {
		const f = fixture([OLD, OLD, CURRENT], { [OLD]: json({ state: "active" }) });
		const loaded = await loadCurrentAuthority(f.transport);
		await expect(assertAuthorityCurrent(f.transport, loaded)).rejects.toMatchObject({
			code: "AUTHORITY_CHANGED",
		});
	});
});

describe("fixed repository HTTPS envelopes", () => {
	afterEach(() => {
		vi.useRealTimers();
		network.request = () => {
			throw new Error("unexpected synthetic request");
		};
	});

	function respond(
		body: Uint8Array,
		status = 200,
		complete = true,
	): {
		calls: unknown[][];
		response: EventEmitter;
		operation: EventEmitter;
	} {
		const calls: unknown[][] = [];
		const response = Object.assign(new EventEmitter(), {
			statusCode: status,
			complete,
			destroy: vi.fn(),
		});
		const operation = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
		network.request = (...args) => {
			calls.push(args);
			operation.end.mockImplementation(() => {
				const callback = args[2] as (incoming: IncomingMessage) => void;
				callback(response as unknown as IncomingMessage);
				response.emit("data", Buffer.from(body));
				response.emit("end");
			});
			return operation;
		};
		return { calls, response, operation };
	}

	it("uses only the fixed current branch URL with verified TLS and bounded headers", async () => {
		const f = respond(json({ ref: "refs/heads/m4", object: { type: "commit", sha: CURRENT } }));
		expect(await new RepositoryAuthority().currentRevision()).toBe(CURRENT);
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]?.[0]).toBe("https://api.github.com/repos/draftyak/draftyak/git/ref/heads/m4");
		expect(f.calls[0]?.[1]).toMatchObject({
			method: "GET",
			rejectUnauthorized: true,
			agent: false,
			maxHeaderSize: 16_384,
		});
	});

	it.each([
		{ ref: "refs/heads/other", object: { type: "commit", sha: CURRENT } },
		{ ref: "refs/heads/m4", object: { type: "tag", sha: CURRENT } },
		{ ref: "refs/heads/m4", object: { type: "commit", sha: "HEAD" } },
	])("refuses a different reference or noncommit envelope", async (value) => {
		respond(json(value));
		await expect(new RepositoryAuthority().currentRevision()).rejects.toBeInstanceOf(
			AuthorityError,
		);
	});

	it("binds canonical decoded file bytes to the immutable Git blob", async () => {
		const bytes = json({ version: 1, state: "refusal-only" });
		const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
		const f = respond(
			json({
				type: "file",
				path: "tools/native-dependency-policy/records/authority.json",
				encoding: "base64",
				content: Buffer.from(bytes).toString("base64"),
				size: bytes.length,
				sha,
			}),
		);
		expect(await new RepositoryAuthority().recordAt(CURRENT)).toEqual(bytes);
		expect(f.calls[0]?.[0]).toBe(
			`https://api.github.com/repos/draftyak/draftyak/contents/tools/native-dependency-policy/records/authority.json?ref=${CURRENT}`,
		);
	});

	it.each([
		{ type: "symlink" },
		{ path: "records/elsewhere.json" },
		{ encoding: "none" },
		{ size: -1 },
		{ size: 524_289 },
		{ size: 0 },
		{ content: "e30" },
		{ content: "e31=" },
		{ sha: OLD },
	])("refuses changed file identity, length or content", async (change) => {
		const bytes = Buffer.from("{}");
		respond(
			json({
				type: "file",
				path: "tools/native-dependency-policy/records/authority.json",
				encoding: "base64",
				content: bytes.toString("base64"),
				size: bytes.length,
				sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
				...change,
			}),
		);
		await expect(new RepositoryAuthority().recordAt(CURRENT)).rejects.toBeInstanceOf(
			AuthorityError,
		);
	});

	it.each([301, 403, 404, 429, 500])(
		"refuses HTTP failures without following redirects",
		async (status) => {
			const f = respond(
				json({ ref: "refs/heads/m4", object: { type: "commit", sha: CURRENT } }),
				status,
			);
			await expect(new RepositoryAuthority().currentRevision()).rejects.toMatchObject({
				code: "AUTHORITY_UNAVAILABLE",
			});
			expect(f.calls).toHaveLength(1);
		},
	);

	it("refuses oversized and incomplete bodies", async () => {
		const valid = json({ ref: "refs/heads/m4", object: { type: "commit", sha: CURRENT } });
		respond(Buffer.concat([valid, Buffer.alloc(524_289 - valid.byteLength, 32)]));
		await expect(new RepositoryAuthority().currentRevision()).rejects.toMatchObject({
			code: "AUTHORITY_INVALID",
		});
		respond(valid, 200, false);
		await expect(new RepositoryAuthority().currentRevision()).rejects.toMatchObject({
			code: "AUTHORITY_UNAVAILABLE",
		});
	});

	it("settles synchronous request errors and clears the timer", async () => {
		vi.useFakeTimers();
		network.request = () => {
			throw new Error("synthetic constructor failure");
		};
		await expect(new RepositoryAuthority().currentRevision()).rejects.toMatchObject({
			code: "AUTHORITY_UNAVAILABLE",
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("settles the total deadline even when a child never emits an error", async () => {
		vi.useFakeTimers();
		const operation = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
		network.request = () => operation;
		const pending = new RepositoryAuthority().currentRevision();
		let settled = false;
		void pending.catch(() => {
			settled = true;
		});
		const checked = expect(pending).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(settled).toBe(true);
		await checked;
		expect(operation.destroy).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["aborted", "close", "error"])("settles an interrupted response", async (event) => {
		const response = Object.assign(new EventEmitter(), {
			statusCode: 200,
			complete: false,
			destroy: vi.fn(),
		});
		const operation = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
		network.request = (...args) => {
			operation.end.mockImplementation(() => {
				(args[2] as (incoming: IncomingMessage) => void)(response as unknown as IncomingMessage);
				response.emit(event);
			});
			return operation;
		};
		await expect(new RepositoryAuthority().currentRevision()).rejects.toMatchObject({
			code: "AUTHORITY_UNAVAILABLE",
		});
	});
});
