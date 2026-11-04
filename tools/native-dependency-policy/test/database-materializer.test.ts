import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	tool: "",
	local: "",
	useLocalGit: false,
	rejectClose: false,
	mode: "success" as "success" | "hold" | "nonzero" | "signal" | "error" | "cap" | "mutate",
	calls: [] as Array<{ file: string; args: string[]; options: SpawnOptions }>,
	child: null as
		| null
		| (EventEmitter & {
				stdout: PassThrough;
				stderr: PassThrough;
				exitCode: number | null;
				signalCode: string | null;
		  }),
	closeFallbacks: [] as Array<() => Promise<void>>,
	openFiles: [] as fs.FileHandle[],
	actualChildren: [] as Array<{ child: ChildProcess; closed: boolean }>,
	selectedGit: "",
	localDiagnostics: [] as string[],
	entered: null as null | (() => void),
}));

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		realpath: async (file: string) => {
			if (
				!state.useLocalGit &&
				[
					"C:\\Program Files\\Git\\cmd\\git.exe",
					"C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
					"/usr/bin/git",
				].includes(file)
			)
				return state.tool;
			return actual.realpath(file);
		},
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			if (state.rejectClose && path.basename(String(args[0])) === "empty") {
				state.rejectClose = false;
				state.closeFallbacks.push(handle.close.bind(handle));
				state.openFiles.push(handle);
				Object.defineProperty(handle, "close", {
					value: async () => {
						throw new Error("invented close failure");
					},
				});
			}
			return handle;
		},
	};
});

vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (file: string, args: string[], options: SpawnOptions) => {
			state.calls.push({ file, args, options });
			if (state.useLocalGit) {
				// TEST ONLY: assert the product command before redirecting just its fixed remote
				// to an invented local Git fixture. No product URL or tool injection exists.
				let child: ChildProcess;
				if (args.includes("clone")) {
					state.selectedGit = file;
					expect(args.at(-2)).toBe("https://github.com/RustSec/advisory-db");
					expect(options.env?.GIT_ALLOW_PROTOCOL).toBe("https");
					child = actual.spawn(file, [...args.slice(0, -2), state.local, args.at(-1) as string], {
						...options,
						env: { ...options.env, GIT_ALLOW_PROTOCOL: "file" },
					});
				} else if (path.basename(file) === "taskkill.exe") {
					expect(path.basename(file)).toBe("taskkill.exe");
					expect(
						state.actualChildren.some(
							(entry) => !entry.closed && String(entry.child.pid) === args[1],
						),
					).toBe(true);
					child = actual.spawn(file, args, options);
				} else {
					expect(file).toBe(state.selectedGit);
					expect(args[0]).toBe("--no-optional-locks");
					expect(args[1]).toBe("--no-replace-objects");
					child = actual.spawn(file, args, options);
				}
				child.stderr?.on("data", (bytes: Buffer) => {
					const text = bytes.toString("utf8");
					for (const [code, pattern] of [
						[
							"PROTOCOL",
							/transport .*not allowed|protocol .*not supported|unable to find remote helper/i,
						],
						[
							"REPOSITORY",
							/not a git repository|does not appear to be a git repository|repository .*does not exist/i,
						],
						["CONFIGURATION", /bad config|invalid config|unable to read config/i],
						["PROCESS", /cannot spawn|cannot run|unable to fork|cannot exec|could not find/i],
						[
							"FILESYSTEM",
							/cannot copy|unable to create|cannot create|invalid path|permission denied/i,
						],
						["OBJECT", /bad object|invalid object|corrupt|invalid author|invalid committer/i],
					] as const)
						if (pattern.test(text) && !state.localDiagnostics.includes(code))
							state.localDiagnostics.push(code);
				});
				const entry = { child, closed: false };
				state.actualChildren.push(entry);
				child.once("close", () => {
					entry.closed = true;
				});
				return child;
			}
			// A synthetic process has no OS PID; tests cannot terminate an unrelated process.
			const child = Object.assign(new EventEmitter(), {
				pid: undefined,
				exitCode: null as number | null,
				signalCode: null as string | null,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});
			state.child = child;
			queueMicrotask(async () => {
				try {
					const root = args.at(-1) as string;
					await fs.mkdir(path.join(root, ".git"), { recursive: true });
					state.entered?.();
					if (state.mode === "hold") return;
					if (state.mode === "mutate") await fs.appendFile(state.tool, "changed");
					if (state.mode === "cap") child.stdout.write(Buffer.alloc(65_537));
					if (state.mode === "error") child.emit("error", new Error("invented child failure"));
					child.exitCode = state.mode === "nonzero" ? 7 : state.mode === "signal" ? null : 0;
					child.signalCode = state.mode === "signal" ? "SIGTERM" : null;
					child.stdout.destroy();
					child.stderr.destroy();
					setImmediate(() => child.emit("close", child.exitCode, child.signalCode));
				} catch {
					child.emit("error", new Error("invented fixture failure"));
				}
			});
			return child as unknown as ChildProcess;
		},
	};
});

let temporary: string;
let root: string;
let materializeAdvisoryDatabase: typeof import("../src/database-materializer.ts").materializeAdvisoryDatabase;
const CHILD = "advisory-db-3157b0e258782691";

beforeEach(async () => {
	state.useLocalGit = false;
	state.rejectClose = false;
	state.mode = "success";
	state.calls.length = 0;
	state.child = null;
	state.entered = null;
	state.closeFallbacks.length = 0;
	state.openFiles.length = 0;
	state.actualChildren.length = 0;
	state.selectedGit = "";
	state.localDiagnostics.length = 0;
	vi.resetModules();
	({ materializeAdvisoryDatabase } = await import("../src/database-materializer.ts"));
	temporary = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "draftyak-db-materializer-test-")),
	);
	state.tool = path.join(temporary, process.platform === "win32" ? "git.exe" : "git");
	await fs.writeFile(
		state.tool,
		process.platform === "win32" ? Buffer.from("MZ00") : Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
	);
	root = path.join(temporary, "output", CHILD);
});

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	for (const close of state.closeFallbacks) await close();
	// An unexpectedly unconfirmed real fixture child keeps its exact tree untouched.
	expect(state.actualChildren.every((entry) => entry.closed)).toBe(true);
	expect(path.basename(temporary).startsWith("draftyak-db-materializer-test-")).toBe(true);
	expect(path.dirname(temporary)).toBe(await fs.realpath(os.tmpdir()));
	const stat = await fs.lstat(temporary);
	expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
	expect(await fs.realpath(temporary)).toBe(temporary);
	await fs.rm(temporary, { recursive: true, force: true });
	await expect(fs.lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
});

async function refuses(code: string): Promise<void> {
	await expect(materializeAdvisoryDatabase(root)).rejects.toMatchObject({
		name: "DatabaseMaterializationError",
		code,
		message: "database materialization refused",
	});
}

async function enteredOrTerminal(entered: Promise<void>, operation: Promise<void>): Promise<void> {
	await Promise.race([
		entered,
		operation.then(() => {
			throw new Error("invented child did not hold");
		}),
	]);
}

describe("fresh advisory database DATA materialization", () => {
	it("uses one fixed full clone with isolated configuration and removes only its empty controls", async () => {
		vi.stubEnv("GIT_CONFIG_COUNT", "1");
		vi.stubEnv("GIT_CONFIG_KEY_0", "credential.helper");
		vi.stubEnv("GIT_CONFIG_VALUE_0", "invented");
		vi.stubEnv("DRAFTYAK_NATIVE_POLICY_DATABASE_ROOT", "invented");
		await materializeAdvisoryDatabase(root);
		expect(state.calls).toHaveLength(1);
		const call = state.calls[0];
		expect(call?.file).toBe(state.tool);
		expect(call?.args).toEqual([
			"-c",
			"gc.auto=0",
			"-c",
			"maintenance.auto=false",
			"-c",
			"core.autocrlf=false",
			"-c",
			"core.eol=lf",
			"-c",
			`core.attributesFile=${path.join(path.dirname(root), "empty")}`,
			"-c",
			`core.hooksPath=${path.join(path.dirname(root), "hooks")}`,
			"-c",
			"credential.helper=",
			"-c",
			"http.followRedirects=false",
			"-c",
			"http.sslVerify=true",
			"clone",
			"--quiet",
			"--no-hardlinks",
			"--",
			"https://github.com/RustSec/advisory-db",
			root,
		]);
		expect(call?.options.shell).toBe(false);
		expect(call?.options.env?.GIT_CONFIG_COUNT).toBe("0");
		expect(call?.options.env?.GIT_CONFIG_KEY_0).toBeUndefined();
		expect(call?.options.env?.DRAFTYAK_NATIVE_POLICY_DATABASE_ROOT).toBeUndefined();
		expect(call?.options.env?.GIT_CONFIG_GLOBAL).toBe(path.join(path.dirname(root), "empty"));
		expect(call?.options.env?.HOME).toBe(path.join(path.dirname(root), "home"));
		expect(call?.options.env?.GIT_TEMPLATE_DIR).toBe(path.join(path.dirname(root), "templates"));
		expect(call?.options.env?.GIT_ALLOW_PROTOCOL).toBe("https");
		const keys = Object.keys(call?.options.env ?? {}).map((key) => key.toUpperCase());
		expect(new Set(keys).size).toBe(keys.length);
		expect(await fs.readdir(path.dirname(root))).toEqual([CHILD]);
	});

	it("refuses existing parents, inside-repository outputs, and malformed input before dispatch", async () => {
		await fs.mkdir(path.dirname(root));
		await refuses("DATABASE_MATERIALIZATION_IO");
		const inside = path.resolve(import.meta.dirname, "..", "refused-output", CHILD);
		await expect(materializeAdvisoryDatabase(inside)).rejects.toMatchObject({
			code: "DATABASE_MATERIALIZATION_PATH",
		});
		await expect(materializeAdvisoryDatabase(true as unknown as string)).rejects.toMatchObject({
			code: "DATABASE_MATERIALIZATION_PATH",
		});
		expect(state.calls).toHaveLength(0);
	});

	it.each(["nonzero", "signal", "error"] as const)(
		"keeps %s failure and preserves its exclusive output",
		async (mode) => {
			state.mode = mode;
			await refuses("DATABASE_MATERIALIZATION_PROCESS");
			expect(state.calls).toHaveLength(1);
			expect((await fs.lstat(path.join(path.dirname(root), "empty"))).isFile()).toBe(true);
		},
	);

	it("refuses excessive discarded output even when the final exit is zero", async () => {
		state.mode = "cap";
		await refuses("DATABASE_MATERIALIZATION_OUTPUT");
		expect(state.child?.exitCode).toBe(0);
		expect((await fs.lstat(path.join(path.dirname(root), "empty"))).isFile()).toBe(true);
	});

	it("waits for actual child and both stream closes before success", async () => {
		state.mode = "hold";
		const entered = new Promise<void>((resolve) => {
			state.entered = resolve;
		});
		let settled = false;
		const operation = materializeAdvisoryDatabase(root).finally(() => {
			settled = true;
		});
		await enteredOrTerminal(entered, operation);
		const child = state.child;
		expect(child).not.toBeNull();
		await expect(
			materializeAdvisoryDatabase(path.join(temporary, "second", CHILD)),
		).rejects.toMatchObject({ code: "DATABASE_MATERIALIZATION_UNCONFIRMED" });
		child?.stdout.destroy();
		child?.stderr.destroy();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		if (child) {
			child.exitCode = 0;
			child.emit("close", 0, null);
		}
		await operation;
		expect(settled).toBe(true);
	});

	it("keeps a timeout refusal after a later clean terminal", async () => {
		state.mode = "hold";
		const entered = new Promise<void>((resolve) => {
			state.entered = resolve;
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const operation = materializeAdvisoryDatabase(root);
		await enteredOrTerminal(entered, operation);
		const refusal = expect(operation).rejects.toMatchObject({
			code: "DATABASE_MATERIALIZATION_DEADLINE",
		});
		await vi.advanceTimersByTimeAsync(300_000);
		const child = state.child;
		if (child) {
			child.stdout.destroy();
			child.stderr.destroy();
			child.exitCode = 0;
			setImmediate(() => child.emit("close", 0, null));
		}
		await refusal;
		expect(state.child?.exitCode).toBe(0);
		expect((await fs.lstat(path.join(path.dirname(root), "empty"))).isFile()).toBe(true);
	});

	it("accepts a clean primary close before both stream close listeners finish", async () => {
		state.mode = "hold";
		const entered = new Promise<void>((resolve) => {
			state.entered = resolve;
		});
		const operation = materializeAdvisoryDatabase(root);
		const completion = operation.then(
			() => null,
			(error: { code: string }) => error.code,
		);
		await enteredOrTerminal(entered, operation);
		const child = state.child;
		if (child) {
			child.exitCode = 0;
			child.emit("close", 0, null);
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		child?.stdout.destroy();
		child?.stderr.destroy();
		expect(await completion).toBeNull();
		expect(await fs.readdir(path.dirname(root))).toEqual([CHILD]);
	});

	it("refuses an unconfirmed child after the deadline and preserves its output", async () => {
		state.mode = "hold";
		const entered = new Promise<void>((resolve) => {
			state.entered = resolve;
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const operation = materializeAdvisoryDatabase(root);
		await enteredOrTerminal(entered, operation);
		const refusal = expect(operation).rejects.toMatchObject({
			code: "DATABASE_MATERIALIZATION_UNCONFIRMED",
		});
		await vi.advanceTimersByTimeAsync(305_000);
		await refusal;
		expect(state.calls).toHaveLength(1);
		expect((await fs.lstat(path.join(path.dirname(root), "empty"))).isFile()).toBe(true);
		state.mode = "success";
		await expect(
			materializeAdvisoryDatabase(path.join(temporary, "second", CHILD)),
		).rejects.toMatchObject({ code: "DATABASE_MATERIALIZATION_UNCONFIRMED" });
		const child = state.child;
		if (child) {
			child.stdout.destroy();
			child.stderr.destroy();
			child.exitCode = 0;
			child.emit("close", 0, null);
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		await expect(
			materializeAdvisoryDatabase(path.join(temporary, "second", CHILD)),
		).rejects.toMatchObject({ code: "DATABASE_MATERIALIZATION_UNCONFIRMED" });
		expect(state.calls).toHaveLength(1);
	});

	it("cannot succeed with one output stream still unconfirmed after child close", async () => {
		state.mode = "hold";
		const entered = new Promise<void>((resolve) => {
			state.entered = resolve;
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const operation = materializeAdvisoryDatabase(root);
		await enteredOrTerminal(entered, operation);
		const refusal = expect(operation).rejects.toMatchObject({
			code: "DATABASE_MATERIALIZATION_UNCONFIRMED",
		});
		const child = state.child;
		if (child) {
			child.stdout.destroy();
			child.exitCode = 0;
			child.emit("close", 0, null);
		}
		await vi.advanceTimersByTimeAsync(5_000);
		await refusal;
		expect((await fs.lstat(path.join(path.dirname(root), "empty"))).isFile()).toBe(true);
		child?.stderr.destroy();
	});

	it("does not dispatch after an actual owned file close rejects before physical close", async () => {
		state.rejectClose = true;
		await refuses("DATABASE_MATERIALIZATION_IO");
		expect(state.calls).toHaveLength(0);
		expect(state.closeFallbacks).toHaveLength(1);
		expect((await state.openFiles[0]?.stat())?.isFile()).toBe(true);
		await expect(
			materializeAdvisoryDatabase(path.join(temporary, "second", CHILD)),
		).rejects.toMatchObject({ code: "DATABASE_MATERIALIZATION_UNCONFIRMED" });
		expect(state.calls).toHaveLength(0);
		expect((await fs.lstat(path.join(path.dirname(root), "empty"))).isFile()).toBe(true);
	});

	it("refuses a selected executable mutation after an otherwise clean clone", async () => {
		state.mode = "mutate";
		await refuses("DATABASE_MATERIALIZATION_CHANGED");
		expect(state.child?.exitCode).toBe(0);
	});

	it("clones a real invented local Git object graph with unchanged LF bytes", async () => {
		const bare = path.join(temporary, "invented.git");
		await fs.mkdir(path.join(bare, "objects"), { recursive: true });
		await fs.mkdir(path.join(bare, "refs", "heads"), { recursive: true });
		const object = async (kind: string, bytes: Buffer): Promise<string> => {
			const raw = Buffer.concat([Buffer.from(`${kind} ${bytes.length}\0`), bytes]);
			const id = createHash("sha1").update(raw).digest("hex");
			await fs.mkdir(path.join(bare, "objects", id.slice(0, 2)), { recursive: true });
			await fs.writeFile(path.join(bare, "objects", id.slice(0, 2), id.slice(2)), deflateSync(raw));
			return id;
		};
		const content = Buffer.from("invented advisory fixture\nsecond line\n");
		const blob = await object("blob", content);
		const tree = await object(
			"tree",
			Buffer.concat([Buffer.from("100644 fixture.txt\0"), Buffer.from(blob, "hex")]),
		);
		const commit = await object(
			"commit",
			Buffer.from(
				`tree ${tree}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\ninvented fixture\n`,
			),
		);
		await fs.writeFile(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
		await fs.writeFile(path.join(bare, "refs", "heads", "main"), `${commit}\n`);
		await fs.writeFile(
			path.join(bare, "config"),
			"[core]\nrepositoryformatversion = 0\nbare = true\n",
		);
		state.local = bare;
		state.useLocalGit = true;
		const code = await materializeAdvisoryDatabase(root).then(
			() => null,
			(error: { code: string }) => error.code,
		);
		expect({ code, diagnostics: state.localDiagnostics }).toEqual({ code: null, diagnostics: [] });
		expect((await fs.readFile(path.join(root, "fixture.txt"))).equals(content)).toBe(true);
		expect((await fs.lstat(path.join(root, ".git"))).isDirectory()).toBe(true);
		expect(await fs.readdir(path.dirname(root))).toEqual([CHILD]);
		const { databaseSourceTestInterface } = await import("../src/database-source.ts");
		const source = databaseSourceTestInterface.create({
			databaseRoot: root,
			head: async () => commit,
		});
		const observation = await source.observe();
		const metadata = databaseSourceTestInterface.metadata(source, observation);
		expect(metadata.delivery).toBe("test-only");
		expect(metadata.commit).toBe(commit);
		expect(metadata.currentCommit).toBe(commit);
		expect(metadata.revision).toMatch(/^[a-f0-9]{64}$/u);
	});
});
