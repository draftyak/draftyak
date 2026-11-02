import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseObservation } from "../src/database-source.ts";

const network = vi.hoisted(() => ({
	status: 200,
	media: "application/vnd.github.sha",
	body: Buffer.alloc(0),
	stall: false,
	calls: [] as { url: unknown; options: unknown }[],
}));
const gitDiagnostics = vi.hoisted(() => ({
	commands: [] as {
		stage: string;
		exit: number | null;
		signal: string | null;
		stdinError: string | null;
		stdinMode: string;
		stderrBytes: number;
		reasons: string[];
	}[],
}));
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (
			command: string,
			args: readonly string[],
			options: import("node:child_process").SpawnOptions,
		) => {
			const child = actual.spawn(command, args, options);
			const stage = ["--version", "rev-parse", "ls-tree", "cat-file"].find((arg) =>
				args.includes(arg),
			);
			let stderr = "";
			let stderrBytes = 0;
			let stdinError: string | null = null;
			child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
				stdinError = /^[A-Z_]+$/.test(error.code ?? "") ? (error.code ?? null) : "OTHER";
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrBytes += chunk.length;
				if (stderr.length < 65_536)
					stderr += chunk.toString("utf8").slice(0, 65_536 - stderr.length);
			});
			child.once("close", (exit, signal) => {
				const reasons = [
					["HOME_REQUIRED", /HOME[^\n]*(?:not set|required)/i],
					["NOT_REPOSITORY", /not a git repository/i],
					["DUBIOUS_OWNERSHIP", /dubious ownership/i],
					["CONFIGURATION", /bad config|invalid config|unable to read config|GIT_CONFIG/i],
					["OBJECT_UNAVAILABLE", /bad object|invalid object|missing blob|missing tree/i],
					["OPTION_UNSUPPORTED", /unknown option|unrecognized option/i],
					["EXECUTABLE_UNAVAILABLE", /cannot run|cannot exec|not found/i],
				] as const;
				gitDiagnostics.commands.push({
					stage: stage ?? "OTHER",
					exit,
					signal,
					stdinError,
					stdinMode: Array.isArray(options.stdio) ? String(options.stdio[0]) : "OTHER",
					stderrBytes,
					reasons: reasons.filter(([, pattern]) => pattern.test(stderr)).map(([name]) => name),
				});
			});
			return child;
		},
	};
});
vi.mock("node:https", async () => {
	const { EventEmitter } = await import("node:events");
	return {
		request: (url: unknown, options: unknown, callback: (response: unknown) => void) => {
			network.calls.push({ url, options });
			const operation = Object.assign(new EventEmitter(), {
				destroy: vi.fn(),
				end: () => {
					if (network.stall) return;
					queueMicrotask(() => {
						const response = Object.assign(new EventEmitter(), {
							statusCode: network.status,
							headers: { "content-type": network.media },
							complete: true,
							destroy: vi.fn(),
						});
						callback(response);
						queueMicrotask(() => {
							response.emit("data", network.body);
							response.emit("end");
						});
					});
				},
			});
			return operation;
		},
	};
});
const { createDatabaseSource, databaseSourceTestInterface, DatabaseSourceError } = await import(
	"../src/database-source.ts"
);
const NOW = 1_800_000_000_000;
const roots: string[] = [];
let base = "";
interface GitObject {
	id: string;
	type: "commit" | "tree" | "blob";
	bytes: Buffer;
}
function gitObject(type: GitObject["type"], bytes: Buffer): GitObject {
	const header = Buffer.from(`${type} ${bytes.length}\0`);
	return { id: createHash("sha1").update(header).update(bytes).digest("hex"), type, bytes };
}
function tree(entries: readonly { mode: string; name: string; id: string }[]): GitObject {
	return gitObject(
		"tree",
		Buffer.concat(
			entries.map((entry) =>
				Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.id, "hex")]),
			),
		),
	);
}
async function fixture(options: { body?: string; mode?: string } = {}) {
	const root = await fs.mkdtemp(path.join(base, ".database-source-test-"));
	roots.push(root);
	const blob = gitObject("blob", Buffer.from(options.body ?? "DYTEST opaque advisory\n"));
	const child = tree([
		{ mode: options.mode ?? "100644", name: "RUSTSEC-2099-0001.toml", id: blob.id },
	]);
	const top = tree([{ mode: "40000", name: "advisories", id: child.id }]);
	const commit = gitObject(
		"commit",
		Buffer.from(
			`tree ${top.id}\nauthor DYTEST <dytest@example.invalid> 0 +0000\ncommitter DYTEST <dytest@example.invalid> 0 +0000\n\nDYTEST opaque message\n`,
		),
	);
	const objects = [blob, child, top, commit];
	await fs.mkdir(path.join(root, ".git/objects"), { recursive: true });
	await fs.mkdir(path.join(root, ".git/refs/heads"), { recursive: true });
	for (const object of objects) {
		const directory = path.join(root, ".git/objects", object.id.slice(0, 2));
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(
			path.join(directory, object.id.slice(2)),
			deflateSync(
				Buffer.concat([Buffer.from(`${object.type} ${object.bytes.length}\0`), object.bytes]),
			),
		);
	}
	await fs.writeFile(path.join(root, ".git/HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(path.join(root, ".git/refs/heads/main"), `${commit.id}\n`);
	// Reading this repository's configuration would fail. Only the synthetic context is used.
	await fs.writeFile(path.join(root, ".git/config"), "DYTEST invalid Git configuration\n");
	await fs.mkdir(path.join(root, "advisories"));
	const file = path.join(root, "advisories/RUSTSEC-2099-0001.toml");
	await fs.writeFile(file, blob.bytes);
	if (process.platform !== "win32") await fs.chmod(file, options.mode === "100755" ? 0o755 : 0o644);
	return { root, file, commit, top, child, blob, objects };
}
function simulated(root: string, head: () => Promise<string>, clock = () => NOW) {
	return databaseSourceTestInterface.create({ databaseRoot: root, head, clock });
}
function code(value: string) {
	return expect.objectContaining({
		name: "DatabaseSourceError",
		code: value,
		message: "database source refused",
	});
}
beforeEach(async () => {
	base = await fs.realpath(process.cwd());
	network.status = 200;
	network.media = "application/vnd.github.sha";
	network.body = Buffer.alloc(0);
	network.stall = false;
	network.calls.length = 0;
	gitDiagnostics.commands.length = 0;
});
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		const resolved = await fs.realpath(root);
		if (!resolved.startsWith(`${base}${path.sep}.database-source-test-`))
			throw Error("test cleanup containment refused");
		await fs.rm(resolved, { recursive: true, force: true });
	}
});

describe("official-source and physical database observations", () => {
	it("verifies real local Git objects and files without consulting local configuration", async () => {
		const data = await fixture();
		const head = vi.fn(async () => data.commit.id);
		let now = NOW;
		const source = simulated(data.root, head, () => now);
		const receipt = await source.observe().catch(() => {
			// Emit only fixed stages, numeric outcomes and predefined reason tags, never Git prose or paths.
			throw Error(`DYTEST_GIT_DIAGNOSTIC ${JSON.stringify(gitDiagnostics.commands)}`);
		});
		const fact = databaseSourceTestInterface.metadata(source, receipt);
		expect(fact).toMatchObject({
			delivery: "test-only",
			commit: data.commit.id,
			currentCommit: data.commit.id,
			observedAt: NOW,
		});
		expect(fact.revision).toMatch(/^[a-f0-9]{64}$/);
		expect(Object.isFrozen(receipt)).toBe(true);
		expect(Object.isFrozen(fact)).toBe(true);
		expect(Object.keys(receipt)).toEqual([]);
		expect(head).toHaveBeenCalledTimes(2);
		expect(() => source.basis(receipt)).toThrow(code("DATABASE_SOURCE_TEST_ONLY"));
		now += 1000;
		const checked = await source.revalidate(receipt);
		const refreshed = databaseSourceTestInterface.metadata(source, checked);
		expect(refreshed.revision).toBe(fact.revision);
		expect(refreshed.observedAt).toBe(now);
		expect(checked).not.toBe(receipt);
		expect(head).toHaveBeenCalledTimes(4);
	});
	it("does not open an unused input pipe for read-only Git commands", async () => {
		const data = await fixture();
		await simulated(data.root, async () => data.commit.id).observe();
		const readonly = gitDiagnostics.commands.filter((row) => row.stage !== "cat-file");
		expect(readonly.map((row) => row.stage).sort()).toEqual(["--version", "ls-tree", "rev-parse"]);
		for (const row of readonly) {
			expect(row.stdinMode).toBe("ignore");
			expect(row.stdinError).toBeNull();
			expect(row.exit).toBe(0);
		}
		const batch = gitDiagnostics.commands.filter((row) => row.stage === "cat-file");
		expect(batch).toHaveLength(1);
		expect(batch[0]).toMatchObject({ stdinMode: "pipe", stdinError: null, exit: 0 });
	});
	it("uses only the fixed SHA-only endpoint and produces facts, never an audit or allowance", async () => {
		const data = await fixture();
		network.body = Buffer.from(data.commit.id);
		const source = createDatabaseSource({ databaseRoot: data.root });
		const receipt = await source.observe(),
			fact = source.basis(receipt);
		expect(fact.delivery).toBe("independent-current-head");
		expect(fact.commit).toBe(data.commit.id);
		expect(Object.keys(fact).sort()).toEqual([
			"commit",
			"currentCommit",
			"delivery",
			"observedAt",
			"revision",
		]);
		expect(network.calls).toHaveLength(2);
		for (const call of network.calls) {
			expect(call.url).toBe("https://api.github.com/repos/RustSec/advisory-db/commits/HEAD");
			expect(call.options).toMatchObject({
				method: "GET",
				rejectUnauthorized: true,
				agent: false,
				headers: { accept: "application/vnd.github.sha" },
			});
			expect(call.options).not.toHaveProperty("auth");
			expect(call.options).not.toHaveProperty("headers.authorization");
		}
	});
	it("binds different exact physical/Git data to a different revision", async () => {
		const first = await fixture(),
			second = await fixture({ body: "DYTEST changed advisory\n" });
		const a = simulated(first.root, async () => first.commit.id),
			b = simulated(second.root, async () => second.commit.id);
		const before = databaseSourceTestInterface.metadata(a, await a.observe());
		const after = databaseSourceTestInterface.metadata(b, await b.observe());
		expect(after.revision).not.toBe(before.revision);
	});
	it("reads a packed selected HEAD without accepting a caller-selected revision", async () => {
		const data = await fixture();
		await fs.unlink(path.join(data.root, ".git/refs/heads/main"));
		await fs.writeFile(
			path.join(data.root, ".git/packed-refs"),
			`# pack-refs with: peeled fully-peeled sorted\n${data.commit.id} refs/heads/main\n`,
		);
		const source = simulated(data.root, async () => data.commit.id);
		expect(databaseSourceTestInterface.metadata(source, await source.observe()).commit).toBe(
			data.commit.id,
		);
	});
	it("refuses a physical advisory whose bytes differ from its verified object", async () => {
		const data = await fixture();
		await fs.writeFile(data.file, "DYTEST wrong physical bytes\n");
		await expect(simulated(data.root, async () => data.commit.id).observe()).rejects.toBeInstanceOf(
			DatabaseSourceError,
		);
	});
	it("refuses a local HEAD different from the independently read official SHA", async () => {
		const data = await fixture();
		await expect(simulated(data.root, async () => "a".repeat(40)).observe()).rejects.toEqual(
			code("DATABASE_SOURCE_CHANGED"),
		);
	});
	it("refuses malformed independently supplied SHA metadata", async () => {
		const data = await fixture();
		await expect(
			simulated(data.root, async () => "DYTEST malformed SHA").observe(),
		).rejects.toEqual(code("DATABASE_SOURCE_CHANGED"));
	});
	it("refuses an official HEAD change after object and physical checks", async () => {
		const data = await fixture();
		let calls = 0;
		await expect(
			simulated(data.root, async () => (++calls === 1 ? data.commit.id : "b".repeat(40))).observe(),
		).rejects.toEqual(code("DATABASE_SOURCE_CHANGED"));
	});
	it("rereads physical data after the awaited current-source check", async () => {
		const data = await fixture();
		let calls = 0;
		await expect(
			simulated(data.root, async () => {
				if (++calls === 2) await fs.writeFile(data.file, "DYTEST mutation during source await\n");
				return data.commit.id;
			}).observe(),
		).rejects.toEqual(code("DATABASE_SOURCE_CHANGED"));
	});
	it("revalidates the selected physical HEAD after the final source await", async () => {
		const data = await fixture();
		let calls = 0;
		await expect(
			simulated(data.root, async () => {
				if (++calls === 2)
					await fs.writeFile(path.join(data.root, ".git/refs/heads/main"), `${"a".repeat(40)}\n`);
				return data.commit.id;
			}).observe(),
		).rejects.toEqual(code("DATABASE_SOURCE_CHANGED"));
	});
	it("revalidates physical object-store identity after the final source await", async () => {
		const data = await fixture();
		let calls = 0;
		await expect(
			simulated(data.root, async () => {
				if (++calls === 2) {
					const object = gitObject("blob", Buffer.from("DYTEST extra unreachable object\n"));
					const directory = path.join(data.root, ".git/objects", object.id.slice(0, 2));
					await fs.mkdir(directory, { recursive: true });
					await fs.writeFile(
						path.join(directory, object.id.slice(2)),
						deflateSync(
							Buffer.concat([Buffer.from(`blob ${object.bytes.length}\0`), object.bytes]),
						),
					);
				}
				return data.commit.id;
			}).observe(),
		).rejects.toEqual(code("DATABASE_SOURCE_CHANGED"));
	});
	it("refuses changed data during later full revalidation", async () => {
		const data = await fixture();
		const source = simulated(data.root, async () => data.commit.id);
		const first = await source.observe();
		await fs.writeFile(data.file, "DYTEST changed after receipt\n");
		await expect(source.revalidate(first)).rejects.toBeInstanceOf(DatabaseSourceError);
	});
	it("rejects extra advisory paths without treating them as an accepted prefix", async () => {
		const data = await fixture();
		await fs.writeFile(path.join(data.root, "advisories/untracked.toml"), "DYTEST extra\n");
		await expect(simulated(data.root, async () => data.commit.id).observe()).rejects.toBeInstanceOf(
			DatabaseSourceError,
		);
	});
	it("rejects hard-linked advisory files", async () => {
		const data = await fixture();
		await fs.link(data.file, path.join(data.root, "linked-copy"));
		await expect(simulated(data.root, async () => data.commit.id).observe()).rejects.toBeInstanceOf(
			DatabaseSourceError,
		);
	});
	it("rejects a directory link instead of reading outside the physical tree", async () => {
		const data = await fixture();
		const moved = path.join(data.root, "moved");
		await fs.rename(path.join(data.root, "advisories"), moved);
		await fs.symlink(
			moved,
			path.join(data.root, "advisories"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await expect(simulated(data.root, async () => data.commit.id).observe()).rejects.toBeInstanceOf(
			DatabaseSourceError,
		);
	});
	it("rejects alternates without opening their referenced destination", async () => {
		const data = await fixture();
		await fs.mkdir(path.join(data.root, ".git/objects/info"));
		await fs.writeFile(
			path.join(data.root, ".git/objects/info/alternates"),
			"DYTEST not a selected object directory\n",
		);
		const head = vi.fn(async () => data.commit.id);
		await expect(simulated(data.root, head).observe()).rejects.toBeInstanceOf(DatabaseSourceError);
		expect(head).not.toHaveBeenCalled();
	});
	it("refuses symlink/submodule Git modes before physical materialization", async () => {
		for (const mode of ["120000", "160000"]) {
			const data = await fixture({ mode });
			await expect(
				simulated(data.root, async () => data.commit.id).observe(),
			).rejects.toBeInstanceOf(DatabaseSourceError);
		}
	});
	it("does not invent Unix executable-mode verification on Windows", async () => {
		const data = await fixture({ mode: "100755" });
		const source = simulated(data.root, async () => data.commit.id);
		if (process.platform === "win32")
			await expect(source.observe()).rejects.toEqual(code("DATABASE_SOURCE_UNAVAILABLE"));
		else
			expect(databaseSourceTestInterface.metadata(source, await source.observe()).commit).toBe(
				data.commit.id,
			);
	});
	it("refuses missing or corrupted Git object bytes", async () => {
		const data = await fixture();
		await fs.writeFile(
			path.join(data.root, ".git/objects", data.blob.id.slice(0, 2), data.blob.id.slice(2)),
			Buffer.from("DYTEST invalid loose object"),
		);
		await expect(simulated(data.root, async () => data.commit.id).observe()).rejects.toBeInstanceOf(
			DatabaseSourceError,
		);
	});
	it("refuses a genuine oversized blob before issuing a database receipt", async () => {
		const data = await fixture({ body: "x".repeat(8 * 1024 * 1024 + 1) });
		await expect(simulated(data.root, async () => data.commit.id).observe()).rejects.toEqual(
			code("DATABASE_SOURCE_INVALID"),
		);
	});
	it("keeps completion clock reads after temporary Git context cleanup", async () => {
		const data = await fixture();
		const before = new Set(readdirSync(tmpdir()));
		let reads = 0;
		const source = simulated(
			data.root,
			async () => data.commit.id,
			() => {
				if (++reads >= 4)
					expect(
						readdirSync(tmpdir()).filter(
							(name) => name.startsWith("draftyak-database-") && !before.has(name),
						),
					).toEqual([]);
				return NOW;
			},
		);
		await source.observe();
		expect(reads).toBeGreaterThanOrEqual(4);
	});
	it("refuses exact one-hour age and never refreshes it with a getter", async () => {
		const data = await fixture();
		let now = NOW;
		const head = vi.fn(async () => data.commit.id),
			source = simulated(data.root, head, () => now);
		const receipt = await source.observe();
		now += 3_600_000;
		await expect(source.revalidate(receipt)).rejects.toEqual(code("DATABASE_SOURCE_STALE"));
		expect(() => source.basis(receipt)).toThrow(code("DATABASE_SOURCE_STALE"));
		expect(head).toHaveBeenCalledTimes(2);
	});
	it("refuses a wall clock crossing the whole collection freshness bound", async () => {
		const data = await fixture();
		let now = NOW,
			calls = 0;
		await expect(
			simulated(
				data.root,
				async () => {
					if (++calls === 2) now += 3_600_000;
					return data.commit.id;
				},
				() => now,
			).observe(),
		).rejects.toEqual(code("DATABASE_SOURCE_STALE"));
	});
	it("refuses backward clocks", async () => {
		const data = await fixture();
		let now = NOW;
		await expect(
			simulated(
				data.root,
				async () => {
					now--;
					return data.commit.id;
				},
				() => now,
			).observe(),
		).rejects.toEqual(code("DATABASE_SOURCE_CLOCK"));
	});
	it("refuses a clock which moves backward at the first source check then recovers", async () => {
		const data = await fixture();
		let reads = 0;
		await expect(
			simulated(
				data.root,
				async () => data.commit.id,
				() => (++reads === 2 ? NOW - 1 : NOW),
			).observe(),
		).rejects.toEqual(code("DATABASE_SOURCE_CLOCK"));
	});
	it("refuses forged and cross-observer opaque receipts", async () => {
		const data = await fixture();
		const first = simulated(data.root, async () => data.commit.id),
			second = simulated(data.root, async () => data.commit.id);
		const receipt = await first.observe();
		await expect(second.revalidate(receipt)).rejects.toBeInstanceOf(DatabaseSourceError);
		expect(() => first.basis({} as DatabaseObservation)).toThrow(DatabaseSourceError);
	});
	it.each([".", "../outside", "//host/share", "\\\\host\\share", "a".repeat(4097)])(
		"refuses unsupported root paths",
		(databaseRoot) => {
			expect(() => createDatabaseSource({ databaseRoot })).toThrow(DatabaseSourceError);
		},
	);
	it("refuses caller source/ref/executable/approval overrides and effectful options", async () => {
		const data = await fixture();
		for (const key of ["source", "ref", "commit", "executable", "native", "approved", "head"])
			expect(() =>
				createDatabaseSource({ databaseRoot: data.root, [key]: true } as { databaseRoot: string }),
			).toThrow(DatabaseSourceError);
		let reads = 0;
		const options = Object.defineProperty({}, "databaseRoot", {
			get() {
				reads++;
				return data.root;
			},
		});
		expect(() => createDatabaseSource(options as { databaseRoot: string })).toThrow(
			DatabaseSourceError,
		);
		expect(() =>
			createDatabaseSource(
				new Proxy(
					{ databaseRoot: data.root },
					{
						ownKeys() {
							reads++;
							return [];
						},
					},
				),
			),
		).toThrow(DatabaseSourceError);
		expect(reads).toBe(0);
	});
	it.each([
		[302, "application/vnd.github.sha", "a".repeat(40)],
		[200, "application/json", '{"sha":"DYTEST"}'],
		[200, "application/vnd.github.sha", "a".repeat(42)],
		[200, "application/vnd.github.sha", "A".repeat(40)],
		[200, "application/vnd.github.sha", `${"a".repeat(40)}\r\n`],
	])("refuses unsupported HTTP status/media/body", async (status, media, body) => {
		const data = await fixture();
		network.status = status;
		network.media = media;
		network.body = Buffer.from(body);
		await expect(
			createDatabaseSource({ databaseRoot: data.root }).observe(),
		).rejects.toBeInstanceOf(DatabaseSourceError);
	});
	it("rejects high-bit bytes rather than masking them to ASCII SHA characters", async () => {
		const data = await fixture();
		network.body = Buffer.from(data.commit.id);
		network.body[0] = (network.body[0] ?? 0) | 0x80;
		await expect(
			createDatabaseSource({ databaseRoot: data.root }).observe(),
		).rejects.toBeInstanceOf(DatabaseSourceError);
	});
	it("enforces the stalled source deadline without retrying", async () => {
		const data = await fixture();
		network.stall = true;
		const original = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) =>
			original(callback, delay === 10_000 ? 5 : delay)) as typeof setTimeout);
		await expect(createDatabaseSource({ databaseRoot: data.root }).observe()).rejects.toEqual(
			code("DATABASE_SOURCE_DEADLINE"),
		);
		expect(network.calls).toHaveLength(1);
	});
	it("backs off HTTP403 and issues no further source request", async () => {
		const data = await fixture();
		network.status = 403;
		const source = createDatabaseSource({ databaseRoot: data.root });
		await expect(source.observe()).rejects.toEqual(code("DATABASE_SOURCE_RATE_LIMIT"));
		await expect(source.observe()).rejects.toEqual(code("DATABASE_SOURCE_RATE_LIMIT"));
		expect(network.calls).toHaveLength(1);
	});
});
