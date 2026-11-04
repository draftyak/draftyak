import childProcess, { ChildProcess, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	type Stats,
	writeSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { isProxy } from "node:util/types";
import {
	createVitest,
	ForksPoolWorker,
	type PoolOptions,
	type PoolRunnerInitializer,
	type PoolWorker,
	type Reporter,
} from "vitest/node";
import {
	checkWindowsSupervisorReceipts,
	type WindowsSupervisorCaptureInput,
	type WindowsSupervisorCaseId,
	type WindowsSupervisorReportedConsistency,
	windowsSupervisorCases,
} from "../src/windows-supervisor-receipt.ts";

export const WINDOWS_SUPERVISOR_SOURCE = "64dca0a28c1bfeec15e625209d792522a1ec9480";
export type WindowsSupervisorGroup = "A" | "B";
type Reason =
	| "input"
	| "source"
	| "runtime"
	| "worker"
	| "target"
	| "console"
	| "report"
	| "execution"
	| "uncertain";
const POOL_NAME = "draftyak-windows-supervisor";
const ROLE = "DRAFTYAK_WINDOWS_DRIVER_ROLE";
const NONCE = "DRAFTYAK_WINDOWS_DRIVER_NONCE";
const GROUP = "DRAFTYAK_WINDOWS_DRIVER_GROUP";
const ROOT = "DRAFTYAK_WINDOWS_DRIVER_ROOT";
const MARKER = "draftyak-windows-supervisor-resource-v1";
const WIRE_BYTES = 65_536;
const REPORT_BYTES = 1_048_576;
const DRAIN_MS = 10_000;
const GROUP_MS = 600_000;
const moduleUrl = import.meta.url;
let driverActive = false;
let driverPoisoned = false;

/** A resource driver refusal, never an effective-policy or Native acceptance verdict. */
export class WindowsSupervisorDriverError extends Error {
	readonly code = "WINDOWS_SUPERVISOR_DRIVER_INVALID";
	readonly reason: Reason;
	constructor(reason: Reason) {
		super("Windows supervisor driver refused");
		this.name = "WindowsSupervisorDriverError";
		this.reason = reason;
	}
}
const refuse = (reason: Reason): never => {
	throw new WindowsSupervisorDriverError(reason);
};
function check(value: unknown, reason: Reason): asserts value {
	if (!value) refuse(reason);
}
function row(value: unknown, keys: readonly string[], reason: Reason): Record<string, unknown> {
	check(value !== null && typeof value === "object" && !isProxy(value), reason);
	check([Object.prototype, null].includes(Object.getPrototypeOf(value)), reason);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	check(Reflect.ownKeys(descriptors).length === keys.length, reason);
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = descriptors[key];
		check(descriptor && Object.hasOwn(descriptor, "value"), reason);
		result[key] = descriptor.value;
	}
	return result;
}
const pid = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const groupIs = (value: unknown): value is WindowsSupervisorGroup => value === "A" || value === "B";

export interface WindowsSupervisorConsoleFrame {
	readonly id: WindowsSupervisorCaseId;
	readonly json: string;
}
/** Accepts whole original console contents, not the human reporter's decorated stdout. */
export function parseWindowsSupervisorConsole(
	content: string,
	group: WindowsSupervisorGroup,
): readonly WindowsSupervisorConsoleFrame[] {
	check(typeof content === "string" && groupIs(group), "console");
	const maximum = group === "A" ? 2 : 1;
	check(
		content.length > 0 && Buffer.byteLength(content, "utf8") <= maximum * (WIRE_BYTES + 2),
		"console",
	);
	const lines = content.split("\n");
	const terminated = content.endsWith("\n");
	if (lines.at(-1) === "") lines.pop();
	check(lines.length > 0 && lines.length <= maximum, "console");
	const seen = new Set<WindowsSupervisorCaseId>();
	return Object.freeze(
		lines.map((line, index): WindowsSupervisorConsoleFrame => {
			check(!line.endsWith("\r") || terminated || index < lines.length - 1, "console");
			const text = line.endsWith("\r") ? line.slice(0, -1) : line;
			check(text.length > 0 && Buffer.byteLength(text, "utf8") <= WIRE_BYTES, "console");
			let parsed: unknown;
			try {
				parsed = JSON.parse(text) as unknown;
			} catch {
				return refuse("console");
			}
			check(JSON.stringify(parsed) === text, "console");
			const value = row(
				parsed,
				group === "A"
					? ["scope", "case", "measurement", "requestBinding", "receipt"]
					: ["scope", "case", "requestBinding", "receipt", "samples", "postCloseUnreadable"],
				"console",
			);
			check(value.scope === "capture-only" && value.case === group, "console");
			let id: WindowsSupervisorCaseId = "B.natural";
			if (group === "A") {
				check(value.measurement === "growing" || value.measurement === "untouched", "console");
				id = value.measurement === "growing" ? "A.growing" : "A.untouched";
			}
			check(!seen.has(id), "console");
			seen.add(id);
			return Object.freeze({ id, json: text });
		}),
	);
}

interface End {
	readonly code: number | null;
	readonly signal: string | null;
}
export interface WindowsSupervisorTargetObservation {
	readonly pid: number;
	readonly spawned: true;
	readonly exit: End;
	readonly close: End;
}
export interface WindowsSupervisorWorkerObservation {
	readonly pid: number;
	readonly exit: End;
	readonly close: End;
	readonly stdoutEnded: true;
	readonly stderrEnded: true;
	readonly targets: readonly WindowsSupervisorTargetObservation[];
}
export interface WindowsSupervisorPool extends PoolRunnerInitializer {
	observation(): WindowsSupervisorWorkerObservation;
}
function end(value: unknown, reason: Reason): End {
	const data = row(value, ["code", "signal"], reason);
	check(
		data.code === null || (typeof data.code === "number" && Number.isSafeInteger(data.code)),
		reason,
	);
	check(
		data.signal === null || (typeof data.signal === "string" && /^SIG[A-Z0-9]+$/.test(data.signal)),
		reason,
	);
	check(data.code !== null || data.signal !== null, reason);
	return Object.freeze({ code: data.code as number | null, signal: data.signal as string | null });
}
function sameEnd(left: End, right: End): boolean {
	return left.code === right.code && left.signal === right.signal;
}
function deadline<T>(promise: Promise<T>, ms: number, reason: Reason): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new WindowsSupervisorDriverError(reason)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** Uses the public experimental worker, retaining its original emitter instead of a pool ID. */
export function createWindowsSupervisorPool(group: WindowsSupervisorGroup): WindowsSupervisorPool {
	check(groupIs(group), "input");
	const nonce = randomBytes(32).toString("hex");
	let created = false,
		fault = false,
		ready = 0,
		messages = 0;
	let original: ChildProcess | undefined;
	let exited: End | undefined, closed: End | undefined;
	let stdoutEnded = false,
		stderrEnded = false;
	const targets = new Map<number, WindowsSupervisorTargetObservation>();
	let resolveClose: (() => void) | undefined;
	const closePromise = new Promise<void>((resolve) => {
		resolveClose = resolve;
	});
	const matching = (value: unknown): boolean => {
		if (value === null || typeof value !== "object" || isProxy(value)) return false;
		return Object.getOwnPropertyDescriptor(value, "marker")?.value === MARKER;
	};
	const initializer: WindowsSupervisorPool = {
		name: POOL_NAME,
		createPoolWorker(options: PoolOptions): PoolWorker {
			check(!created, "worker");
			created = true;
			const worker = new ForksPoolWorker({
				...options,
				execArgv: [...options.execArgv, "--import", moduleUrl],
				env: {
					...options.env,
					[ROLE]: "worker",
					[NONCE]: nonce,
					[GROUP]: group,
					[ROOT]: options.project.config.root,
				},
			});
			const listeners = new Map<(...args: unknown[]) => void, (...args: unknown[]) => void>();
			const accept = function (this: ChildProcess, value: unknown): void {
				if (!matching(value)) return;
				try {
					check(original === this && ++messages <= 4, "worker");
					const packet = row(value, ["marker", "nonce", "type", "workerPid", "data"], "worker");
					check(Buffer.byteLength(JSON.stringify(packet), "utf8") <= 8192, "worker");
					check(packet.nonce === nonce && packet.workerPid === original.pid, "worker");
					if (packet.type === "ready") {
						check(++ready === 1 && packet.data === null, "worker");
					} else if (packet.type === "target") {
						check(group === "A" && ready === 1, "target");
						const value = row(packet.data, ["id", "pid", "spawned", "exit", "close"], "target");
						check(
							value.id === targets.size + 1 &&
								targets.size < 2 &&
								pid(value.pid) &&
								value.pid !== original.pid &&
								value.spawned === true,
							"target",
						);
						check(![...targets.values()].some((target) => target.pid === value.pid), "target");
						const exit = end(value.exit, "target"),
							close = end(value.close, "target");
						check(sameEnd(exit, close), "target");
						targets.set(
							value.id as number,
							Object.freeze({ pid: value.pid, spawned: true, exit, close }),
						);
					} else refuse("worker");
				} catch {
					fault = true;
				}
			};
			return {
				name: POOL_NAME,
				cacheFs: worker.cacheFs,
				deserialize: (value) => worker.deserialize(value),
				send: (message) => worker.send(message),
				on(event, callback) {
					if (event !== "message") return worker.on(event, callback);
					const filtered = function (this: unknown, ...args: unknown[]): void {
						if (!matching(args[0])) Reflect.apply(callback, this, args);
					};
					listeners.set(callback, filtered);
					worker.on(event, filtered);
				},
				off(event, callback) {
					worker.off(event, event === "message" ? (listeners.get(callback) ?? callback) : callback);
					if (event === "message") listeners.delete(callback);
				},
				async start() {
					// No await may separate the genuine synchronous fork and these listeners.
					const started = worker.start();
					try {
						worker.on("spawn", function (this: ChildProcess): void {
							if (
								!(this instanceof ChildProcess) ||
								original !== undefined ||
								!pid(this.pid) ||
								this.pid === process.pid
							) {
								fault = true;
								return;
							}
							if (
								realpathSync.native(this.spawnfile) !== realpathSync.native(process.execPath) ||
								this.spawnargs.at(-1) !== path.resolve(options.distPath, "workers/forks.js")
							) {
								fault = true;
								return;
							}
							original = this;
							if (this.stdout === null || this.stderr === null) {
								fault = true;
								return;
							}
							this.stdout.once("end", () => {
								stdoutEnded = true;
							});
							this.stderr.once("end", () => {
								stderrEnded = true;
							});
							this.stdout.once("error", () => {
								fault = true;
							});
							this.stderr.once("error", () => {
								fault = true;
							});
						});
						worker.on(
							"exit",
							function (this: ChildProcess, code: number | null, signal: string | null): void {
								if (original !== this || exited !== undefined) fault = true;
								exited = Object.freeze({ code, signal });
							},
						);
						worker.on(
							"close",
							function (this: ChildProcess, code: number | null, signal: string | null): void {
								if (original !== this || exited === undefined || closed !== undefined) fault = true;
								closed = Object.freeze({ code, signal });
								resolveClose?.();
							},
						);
						worker.on("message", accept);
						worker.on("error", () => {
							fault = true;
						});
					} catch {
						fault = true;
						await started.catch(() => {});
						return refuse("worker");
					}
					await started;
				},
				async stop() {
					try {
						await deadline(worker.stop(), DRAIN_MS, "uncertain");
					} finally {
						await deadline(closePromise, DRAIN_MS, "uncertain");
					}
				},
			};
		},
		observation(): WindowsSupervisorWorkerObservation {
			check(
				created &&
					!fault &&
					original &&
					pid(original.pid) &&
					ready === 1 &&
					exited &&
					closed &&
					sameEnd(exited, closed),
				"worker",
			);
			check(stdoutEnded && stderrEnded && targets.size === (group === "A" ? 2 : 0), "worker");
			return Object.freeze({
				pid: original.pid,
				exit: exited,
				close: closed,
				stdoutEnded: true,
				stderrEnded: true,
				targets: Object.freeze([...targets.values()]),
			});
		},
	};
	return Object.freeze(initializer);
}

function installWorkerObservation(): void {
	if (process.env[ROLE] !== "worker") return;
	const nonce = process.env[NONCE],
		group = process.env[GROUP],
		root = process.env[ROOT];
	check(
		typeof nonce === "string" &&
			/^[0-9a-f]{64}$/.test(nonce) &&
			groupIs(group) &&
			typeof root === "string" &&
			path.isAbsolute(root) &&
			typeof process.send === "function",
		"worker",
	);
	const send = process.send.bind(process);
	const packet = (type: "ready" | "target" | "fault", data: unknown): void => {
		const value = { marker: MARKER, nonce, type, workerPid: process.pid, data };
		check(Buffer.byteLength(JSON.stringify(value), "utf8") <= 8192, "worker");
		send(value, (error) => {
			if (error) process.exitCode = 1;
		});
	};
	const original = childProcess.spawn;
	let count = 0;
	const observed = function (
		this: unknown,
		...args: Parameters<typeof original>
	): ReturnType<typeof original> {
		const child = Reflect.apply(original, this, args) as ReturnType<typeof original>;
		const argv = args[1];
		if (!Array.isArray(argv) || argv[0] !== "--permission") return child;
		try {
			check(group === "A" && ++count <= 2 && child instanceof ChildProcess, "target");
			const options = args[2];
			check(
				options !== undefined && typeof options.cwd === "string" && path.isAbsolute(options.cwd),
				"target",
			);
			const cwd = options.cwd;
			check(
				path.basename(cwd) === "line" &&
					path.basename(path.dirname(cwd)) === "bundles" &&
					path.basename(path.dirname(path.dirname(cwd))).startsWith("draftyak-supervisor-"),
				"target",
			);
			check(
				realpathSync.native(args[0]) === realpathSync.native(process.execPath) &&
					options.shell === false &&
					options.detached === false &&
					options.windowsHide === true,
				"target",
			);
			const expected = [
				"--permission",
				`--allow-fs-read=${cwd}`,
				"--no-experimental-sqlite",
				"--disable-sigusr1",
				"--disallow-code-generation-from-strings",
				"--freeze-flags-after-init",
				"--max-old-space-size=256",
				path.join(cwd, "main.mjs"),
			];
			check(
				argv.length === expected.length && argv.every((value, index) => value === expected[index]),
				"target",
			);
			check(
				readFileSync(path.join(cwd, "main.mjs"), "utf8") ===
					'import { start } from "./line-plugin.mjs";\nstart({});\n',
				"target",
			);
			check(
				readFileSync(path.join(cwd, "line-plugin.mjs")).equals(
					readFileSync(path.join(root, "test/plugins/fixtures/supervisor/line-plugin.mjs")),
				),
				"target",
			);
			const id = count;
			let spawned = false,
				failed = false,
				exit: End | undefined;
			child.once("spawn", function (this: ChildProcess): void {
				spawned = this === child && pid(this.pid);
			});
			child.once("error", () => {
				failed = true;
			});
			child.once("exit", function (this: ChildProcess, code, signal): void {
				if (this !== child || !spawned) failed = true;
				exit = Object.freeze({ code, signal });
			});
			child.once("close", function (this: ChildProcess, code, signal): void {
				if (
					this !== child ||
					failed ||
					!spawned ||
					!pid(child.pid) ||
					!exit ||
					!sameEnd(exit, { code, signal })
				) {
					packet("fault", null);
					process.exitCode = 1;
					return;
				}
				packet("target", { id, pid: child.pid, spawned: true, exit, close: { code, signal } });
			});
		} catch {
			packet("fault", null);
			process.exitCode = 1;
		}
		return child;
	} as typeof original;
	childProcess.spawn = observed;
	syncBuiltinESMExports();
	process.once("exit", () => {
		if (childProcess.spawn === observed) {
			childProcess.spawn = original;
			syncBuiltinESMExports();
		}
	});
	packet("ready", null);
}

interface HeldFile {
	readonly file: string;
	readonly fd: number;
	readonly identity: Stats;
}
function hold(file: string): HeldFile {
	const fd = openSync(file, "wx+", 0o600);
	try {
		const identity = fstatSync(fd);
		check(identity.isFile() && !lstatSync(file).isSymbolicLink(), "report");
		return { file, fd, identity };
	} catch (error) {
		try {
			closeSync(fd);
		} catch {
			refuse("uncertain");
		}
		throw error;
	}
}
function checkReportIdentity(original: Stats, held: Stats, named: Stats): void {
	check(
		held.isFile() &&
			named.isFile() &&
			!named.isSymbolicLink() &&
			held.dev === original.dev &&
			held.ino === original.ino &&
			named.dev === held.dev &&
			named.ino === held.ino &&
			named.size === held.size &&
			named.mtimeMs === held.mtimeMs &&
			named.ctimeMs === held.ctimeMs,
		"report",
	);
}
function heldBytes(file: HeldFile, maximum: number): Buffer {
	const current = fstatSync(file.fd),
		linked = lstatSync(file.file);
	checkReportIdentity(file.identity, current, linked);
	check(current.size > 0 && current.size <= maximum, "report");
	const bytes = Buffer.alloc(current.size);
	let at = 0;
	while (at < bytes.length) {
		const count = readSync(file.fd, bytes, at, bytes.length - at, at);
		check(count > 0, "report");
		at += count;
	}
	const after = fstatSync(file.fd),
		namedAfter = lstatSync(file.file);
	checkReportIdentity(file.identity, after, namedAfter);
	check(
		after.size === current.size &&
			after.mtimeMs === current.mtimeMs &&
			after.ctimeMs === current.ctimeMs &&
			namedAfter.size === linked.size &&
			namedAfter.mtimeMs === linked.mtimeMs &&
			namedAfter.ctimeMs === linked.ctimeMs,
		"report",
	);
	return bytes;
}
export interface WindowsSupervisorReport {
	readonly file: string;
	read(): Buffer;
	close(): void;
}
/** Holds one exclusive report identity. Its bytes remain reported DATA, not process authority. */
export function createWindowsSupervisorReport(
	directory: string,
	group: WindowsSupervisorGroup,
): WindowsSupervisorReport {
	check(typeof directory === "string" && path.isAbsolute(directory) && groupIs(group), "input");
	let file: HeldFile;
	try {
		const stat = lstatSync(directory);
		check(stat.isDirectory() && !stat.isSymbolicLink(), "report");
		file = hold(path.join(directory, `${group}.report.json`));
	} catch (error) {
		if (error instanceof WindowsSupervisorDriverError && error.reason === "uncertain") throw error;
		return refuse("report");
	}
	let state: "open" | "closed" | "uncertain" = "open";
	return Object.freeze({
		file: file.file,
		read(): Buffer {
			check(state === "open", "report");
			try {
				return heldBytes(file, REPORT_BYTES);
			} catch {
				return refuse("report");
			}
		},
		close(): void {
			if (state === "closed") return;
			check(state === "open", "uncertain");
			state = "uncertain";
			try {
				closeSync(file.fd);
				state = "closed";
			} catch {
				refuse("uncertain");
			}
		},
	});
}
function writeAll(fd: number, bytes: Buffer): void {
	let at = 0;
	while (at < bytes.length) {
		const count = writeSync(fd, bytes, at, bytes.length - at);
		check(Number.isSafeInteger(count) && count > 0 && count <= bytes.length - at, "report");
		at += count;
	}
}
function boundedOutput(file: HeldFile): { stream: Writable; valid(): boolean } {
	let bytes = 0,
		failed = false;
	const stream = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			bytes += chunk.length;
			if (bytes > REPORT_BYTES) failed = true;
			else {
				try {
					writeAll(file.fd, chunk);
				} catch {
					failed = true;
				}
			}
			callback();
		},
	});
	return { stream, valid: () => !failed };
}

export interface WindowsSupervisorDriverOptions {
	readonly directory: string;
	readonly outputDirectory: string;
	readonly admissionRef: string;
}
export interface WindowsSupervisorDriverResult {
	readonly scope: "resource-test-data";
	readonly source: typeof WINDOWS_SUPERVISOR_SOURCE;
	readonly consistency: WindowsSupervisorReportedConsistency;
	readonly workers: Readonly<Record<WindowsSupervisorGroup, WindowsSupervisorWorkerObservation>>;
	readonly reports: Readonly<
		Record<WindowsSupervisorGroup, Readonly<{ file: string; sha256: string }>>
	>;
	readonly policy: "not-collected";
}

/** Fixed resource/test execution only. Separate operator, guest and policy gates remain required. */
export async function runWindowsSupervisorDriver(
	options: WindowsSupervisorDriverOptions,
): Promise<WindowsSupervisorDriverResult> {
	check(!driverPoisoned, "uncertain");
	check(!driverActive, "execution");
	driverActive = true;
	let unresolved = false;
	try {
		const input = row(options, ["directory", "outputDirectory", "admissionRef"], "input");
		check(
			typeof input.directory === "string" &&
				path.isAbsolute(input.directory) &&
				typeof input.outputDirectory === "string" &&
				path.isAbsolute(input.outputDirectory),
			"input",
		);
		check(
			typeof input.admissionRef === "string" &&
				/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.admissionRef),
			"input",
		);
		const directory = realpathSync.native(input.directory),
			outputDirectory = path.resolve(input.outputDirectory);
		check(process.platform === "win32" && process.version === "v26.12.0", "runtime");
		const require = createRequire(import.meta.url);
		const manifest = require.resolve("vitest/package.json");
		check(
			(JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }).version === "5.0.5",
			"runtime",
		);
		check(
			digest(readFileSync(path.join(path.dirname(manifest), "dist/chunks/index.1TqnEahn.js"))) ===
				"4e311af8b4db378a5c3d4e768b5210b0779d2ae0d0ec05f81a72378dbaf25412",
			"runtime",
		);
		const git = (args: readonly string[]): string =>
			execFileSync(
				"git",
				["-C", directory, "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args],
				{ windowsHide: true, encoding: "utf8", maxBuffer: REPORT_BYTES },
			).trim();
		const clean = (): boolean =>
			git([
				"status",
				"--porcelain=v1",
				"--",
				".",
				":(exclude)*siwc*",
				":(exclude)*dynamic-agent*",
				":(exclude)*dynamic_agent*",
			]) === "";
		check(git(["rev-parse", "HEAD"]) === WINDOWS_SUPERVISOR_SOURCE && clean(), "source");
		mkdirSync(outputDirectory, { mode: 0o700 });
		const workers = {} as Record<WindowsSupervisorGroup, WindowsSupervisorWorkerObservation>;
		const reports = {} as Record<WindowsSupervisorGroup, { file: string; sha256: string }>;
		const reportText = {} as Record<WindowsSupervisorGroup, string>;
		const captures: WindowsSupervisorCaptureInput[] = [];
		for (const group of ["A", "B"] as const) {
			const pool = createWindowsSupervisorPool(group);
			const closers: (() => void)[] = [];
			const acquire = (name: string): HeldFile => {
				const file = hold(path.join(outputDirectory, `${group}.${name}`));
				closers.push(() => closeSync(file.fd));
				return file;
			};
			try {
				const report = createWindowsSupervisorReport(outputDirectory, group);
				closers.push(() => report.close());
				const stdout = acquire("stdout");
				const stderr = acquire("stderr");
				const consoleFile = acquire("console");
				const out = boundedOutput(stdout),
					err = boundedOutput(stderr);
				let consoleBytes = 0,
					consoleFault = false;
				const contents: string[] = [];
				const expectedIds: WindowsSupervisorCaseId[] = [];
				const names = windowsSupervisorCases.filter((item) => item.case === group);
				let reporterContext: Awaited<ReturnType<typeof createVitest>> | undefined;
				const reporter: Reporter = {
					onInit(vitest) {
						reporterContext = vitest;
					},
					onUserConsoleLog(log) {
						if (log.type !== "stdout" || typeof log.content !== "string") {
							consoleFault = true;
							return;
						}
						const entity = log.taskId
							? reporterContext?.state.getReportedEntityById(log.taskId)
							: undefined;
						if (
							entity?.type !== "test" ||
							path.resolve(entity.module.moduleId) !== path.join(directory, names[0]?.file ?? "")
						) {
							consoleFault = true;
							return;
						}
						const selected = names.find(
							(item) => entity.fullName === [item.suite, item.title].filter(Boolean).join(" > "),
						);
						if (!selected) {
							consoleFault = true;
							return;
						}
						consoleBytes += Buffer.byteLength(log.content, "utf8");
						if (consoleBytes > 2 * (WIRE_BYTES + 2)) {
							consoleFault = true;
							return;
						}
						try {
							writeAll(consoleFile.fd, Buffer.from(log.content, "utf8"));
						} catch {
							consoleFault = true;
							return;
						}
						contents.push(log.content);
						expectedIds.push(selected.id);
					},
				};
				const binding = {
					source: WINDOWS_SUPERVISOR_SOURCE,
					route: "supervisor-windows-policy",
					admissionRef: input.admissionRef,
					case: group,
				} as const;
				const pattern = `^(?:${names
					.map((item) =>
						[item.suite, item.title]
							.filter(Boolean)
							.join(" > ")
							.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
					)
					.join("|")})$`;
				let context: Awaited<ReturnType<typeof createVitest>> | undefined;
				// Config factories read the parent environment before worker test.env is applied.
				const expectedEnvironment = {
					DRAFTYAK_STRICT_SKIPS: "1",
					DRAFTYAK_WINDOWS_POLICY_REQUEST: JSON.stringify(binding),
					DRAFTYAK_WINDOWS_POLICY_EXPECTED: JSON.stringify(binding),
				};
				const previousEnvironment = Object.keys(expectedEnvironment).map((key) => ({
					key,
					present: Object.hasOwn(process.env, key),
					value: process.env[key],
				}));
				const modified: string[] = [];
				try {
					for (const [key, value] of Object.entries(expectedEnvironment)) {
						process.env[key] = value;
						modified.push(key);
					}
					context = await createVitest(
						{
							root: path.join(directory, "apps/hub"),
							config:
								group === "A"
									? path.join(directory, "apps/hub/vitest.config.ts")
									: path.join(directory, "apps/hub/vitest.windows-policy.config.ts"),
							mode: "heavy",
							run: true,
							watch: false,
							pool,
							maxWorkers: 1,
							testNamePattern: pattern,
							reporters: ["default", "json", reporter],
							outputFile: report.file,
							passWithNoTests: false,
							exclude: ["**/*siwc*/**", "**/*siwc*", "**/*dynamic-agent*", "**/*dynamic_agent*"],
							env: expectedEnvironment,
						},
						{},
						{ stdout: out.stream, stderr: err.stream },
					);
					unresolved = true;
					await deadline(
						context.start([path.join(directory, names[0]?.file ?? "")]),
						GROUP_MS,
						"uncertain",
					);
				} finally {
					try {
						if (context) await deadline(context.close(), DRAIN_MS * 2, "uncertain");
					} finally {
						try {
							const drains = Promise.all([finished(out.stream), finished(err.stream)]);
							out.stream.end();
							err.stream.end();
							await deadline(drains, DRAIN_MS, "uncertain");
						} finally {
							const unchanged = modified.every(
								(key) =>
									process.env[key] === expectedEnvironment[key as keyof typeof expectedEnvironment],
							);
							for (const previous of previousEnvironment) {
								if (previous.present) process.env[previous.key] = previous.value;
								else delete process.env[previous.key];
							}
							check(unchanged, "uncertain");
						}
					}
				}
				workers[group] = pool.observation();
				unresolved = false;
				check(out.valid() && err.valid() && !consoleFault, "console");
				const frames = contents.flatMap((content, index) => {
					const parsed = parseWindowsSupervisorConsole(content, group);
					check(parsed.length === 1 && parsed[0]?.id === expectedIds[index], "console");
					return parsed;
				});
				check(
					frames.length === names.length &&
						frames.every((frame, index) => frame.id === names[index]?.id),
					"console",
				);
				for (const [index, frame] of frames.entries())
					captures.push({
						id: frame.id,
						json: frame.json,
						expected: binding,
						hubPid: workers[group].pid,
						targetPid:
							group === "A" ? (workers[group].targets[index]?.pid ?? 0) : workers[group].pid,
					});
				const bytes = report.read();
				reportText[group] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				reports[group] = Object.freeze({ file: report.file, sha256: digest(bytes) });
			} finally {
				let failed = false;
				for (const close of closers) {
					try {
						close();
					} catch {
						failed = true;
					}
				}
				check(!failed, "uncertain");
			}
		}
		check(git(["rev-parse", "HEAD"]) === WINDOWS_SUPERVISOR_SOURCE && clean(), "source");
		const consistency = checkWindowsSupervisorReceipts(captures, reportText, directory);
		return Object.freeze({
			scope: "resource-test-data",
			source: WINDOWS_SUPERVISOR_SOURCE,
			consistency,
			workers: Object.freeze(workers),
			reports: Object.freeze(reports),
			policy: "not-collected",
		});
	} catch (error) {
		if (
			unresolved ||
			(error instanceof WindowsSupervisorDriverError && error.reason === "uncertain")
		)
			driverPoisoned = true;
		throw error;
	} finally {
		driverActive = false;
	}
}

// This same-file preload observes original handles only in the pool's closed worker role.
installWorkerObservation();
