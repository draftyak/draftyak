import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { isProxy } from "node:util/types";
import { buildPluginArgv, isPluginNodeVersionSupported } from "@draftyak/protocol/plugin-argv";
import {
	openPluginStdio,
	type PluginProcessIo,
	type PluginStdio,
	type PluginStdioResult,
} from "@draftyak/protocol/plugin-stdio";
import { type InstalledBundle, verifyBundle } from "../../artifacts/index.ts";
import { retainInstalledBundle } from "./bundle-input.ts";

export class PluginProcessError extends Error {
	readonly code = "PLUGIN_PROCESS_UNAVAILABLE";
	constructor() {
		super("Plugin process unavailable");
		this.name = "PluginProcessError";
	}
}

export interface OwnedPluginProcess {
	readonly pid: number | null;
	readonly io: PluginProcessIo;
	readonly closed: Promise<PluginStdioResult>;
	close(): Promise<PluginStdioResult>;
}

export interface PluginProcessCloseResult {
	readonly cleanupFailures: 0;
}

export interface PluginProcessOptions {
	readonly stdioParentDir: string;
}

export interface PluginProcessOwner {
	launch(bundle: InstalledBundle, signal?: AbortSignal): Promise<OwnedPluginProcess>;
	owns(value: unknown): boolean;
	close(): Promise<PluginProcessCloseResult>;
}

function unavailable(): never {
	throw new PluginProcessError();
}

function retainStdioParent(options: PluginProcessOptions | undefined): string | undefined {
	if (options === undefined) return undefined;
	try {
		if (options === null || typeof options !== "object" || isProxy(options)) unavailable();
		const prototype = Object.getPrototypeOf(options);
		if (prototype !== Object.prototype && prototype !== null) unavailable();
		const keys = Reflect.ownKeys(options);
		if (keys.length !== 1 || keys[0] !== "stdioParentDir") unavailable();
		const field = Object.getOwnPropertyDescriptor(options, "stdioParentDir");
		if (!field?.enumerable || !("value" in field)) unavailable();
		const value: unknown = field.value;
		if (
			typeof value !== "string" ||
			value.length === 0 ||
			value.includes("\0") ||
			!path.isAbsolute(value)
		)
			unavailable();
		return value;
	} catch {
		throw new PluginProcessError();
	}
}

const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const anySignal = AbortSignal.any;

function copySignal(raw: AbortSignal | undefined): AbortSignal | undefined {
	if (raw === undefined) return undefined;
	if (isProxy(raw) || aborted === undefined) unavailable();
	if (Reflect.apply(aborted, raw, [])) unavailable();
	const signal = Reflect.apply(anySignal, AbortSignal, [[raw]]) as AbortSignal;
	if (signal.aborted) unavailable();
	return signal;
}

function environment(): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = Object.create(null);
	for (const key of [
		"SystemRoot",
		"WINDIR",
		"TEMP",
		"TMP",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"TZ",
		"__CF_USER_TEXT_ENCODING",
	]) {
		const value = process.env[key];
		if (typeof value === "string" && value.length <= 4096 && !value.includes("\0"))
			result[key] = value;
	}
	return Object.freeze(result);
}

interface ProcessRecord {
	readonly launch: Promise<OwnedPluginProcess>;
	readonly cleanup: Promise<void>;
	stop(): void;
	owns(value: unknown): boolean;
}

/** Owns OS children only. Artifact DATA and this handle grant no plugin activation authority. */
export function createPluginProcessOwner(options?: PluginProcessOptions): PluginProcessOwner {
	const stdioParentDir = retainStdioParent(options);
	const records = new Set<ProcessRecord>();
	let fenced = false;
	let failed = false;
	let closing: Promise<PluginProcessCloseResult> | undefined;
	const owner: PluginProcessOwner = {
		launch(bundle, rawSignal) {
			if (fenced || failed) return Promise.reject(new PluginProcessError());
			let retained: InstalledBundle;
			let signal: AbortSignal | undefined;
			let env: NodeJS.ProcessEnv;
			const executable = process.execPath;
			try {
				if (!isPluginNodeVersionSupported(process.versions.node)) unavailable();
				retained = retainInstalledBundle(bundle);
				signal = copySignal(rawSignal);
				env = environment();
			} catch {
				return Promise.reject(new PluginProcessError());
			}
			let stdio: PluginStdio | undefined;
			let child: ChildProcess | undefined;
			let io: PluginProcessIo | undefined;
			let handle: OwnedPluginProcess | undefined;
			let stopping = false;
			let stopApplied = false;
			let attachmentSettled = false;
			let spawned = false;
			let exited = false;
			let originalClosed = false;
			let broken = false;
			let term: ReturnType<typeof setTimeout> | undefined;
			let kill: ReturnType<typeof setTimeout> | undefined;
			let join: Promise<void> | undefined;
			const spawnEvent = Promise.withResolvers<void>();
			const closeEvent = Promise.withResolvers<void>();
			const cleanup = Promise.withResolvers<void>();
			const closed = Promise.withResolvers<PluginStdioResult>();
			void spawnEvent.promise.catch(() => {});
			void closed.promise.catch(() => {});
			const clearTimers = (): void => {
				if (term) clearTimeout(term);
				if (kill) clearTimeout(kill);
				term = undefined;
				kill = undefined;
			};
			const send = (name: NodeJS.Signals): void => {
				if (!child || exited || originalClosed) return;
				try {
					child.kill(name);
				} catch {
					broken = true;
				}
			};
			const applyStop = (): void => {
				if (!stopping || stopApplied || !child || !attachmentSettled) return;
				stopApplied = true;
				if (originalClosed) return;
				try {
					io?.input.end();
				} catch {
					broken = true;
				}
				if (!exited) {
					term = setTimeout(() => {
						send("SIGTERM");
						if (!exited && !originalClosed) kill = setTimeout(() => send("SIGKILL"), 1000);
					}, 250);
				}
			};
			const stop = (): void => {
				stopping = true;
				applyStop();
			};
			const onSpawn = (): void => {
				spawned = true;
				spawnEvent.resolve();
			};
			const onExit = (): void => {
				exited = true;
				clearTimers();
			};
			const onClose = (): void => {
				originalClosed = true;
				if (spawned && !exited) broken = true;
				clearTimers();
				closeEvent.resolve();
			};
			const onError = (): void => {
				spawnEvent.reject(new PluginProcessError());
				stop();
			};
			const assertOpen = (): void => {
				if (fenced || failed || stopping || signal?.aborted) unavailable();
			};
			const finish = (): Promise<void> => {
				if (join) return join;
				join = Promise.resolve().then(async () => {
					if (child) await closeEvent.promise;
					const outcomes = await Promise.allSettled([io?.completion, stdio?.destroy()]);
					clearTimers();
					signal?.removeEventListener("abort", stop);
					child?.removeListener("spawn", onSpawn);
					child?.removeListener("exit", onExit);
					child?.removeListener("close", onClose);
					child?.removeListener("error", onError);
					if (broken || outcomes.some((result) => result.status === "rejected")) unavailable();
					const result = outcomes[0];
					if (io && result?.status === "fulfilled" && result.value) closed.resolve(result.value);
					else closed.reject(new PluginProcessError());
				});
				void join.then(cleanup.resolve, () => {
					failed = true;
					closed.reject(new PluginProcessError());
					cleanup.reject(new PluginProcessError());
				});
				return join;
			};
			const launch = Promise.resolve().then(async (): Promise<OwnedPluginProcess> => {
				try {
					signal?.addEventListener("abort", stop, { once: true });
					assertOpen();
					stdio = await openPluginStdio(
						stdioParentDir === undefined ? undefined : { parentDir: stdioParentDir },
					);
					assertOpen();
					const entry = await verifyBundle(retained);
					assertOpen();
					const argv = buildPluginArgv({ pluginDir: retained.directory, entry });
					child = spawn(executable, argv, {
						cwd: retained.directory,
						env,
						stdio: [...stdio.stdio],
						windowsHide: true,
					});
					child.once("spawn", onSpawn);
					child.once("exit", onExit);
					child.once("close", onClose);
					child.on("error", onError);
					try {
						io = stdio.attach(child);
					} finally {
						attachmentSettled = true;
						applyStop();
					}
					Object.freeze(io.outputs);
					Object.freeze(io);
					void io.completion.then(stop, () => {
						broken = true;
						stop();
					});
					void finish();
					await spawnEvent.promise;
					assertOpen();
					handle = Object.freeze({
						pid: child.pid ?? null,
						io,
						closed: closed.promise,
						close() {
							stop();
							return closed.promise;
						},
					});
					return handle;
				} catch {
					stop();
					await finish();
					throw new PluginProcessError();
				}
			});
			const record: ProcessRecord = {
				launch,
				cleanup: cleanup.promise,
				stop,
				owns: (value) =>
					handle !== undefined && value === handle && spawned && !exited && !originalClosed,
			};
			records.add(record);
			let cleaned = false;
			let launchSettled = false;
			const forget = (): void => {
				if (cleaned && launchSettled) records.delete(record);
			};
			void launch.then(
				() => {
					launchSettled = true;
					forget();
				},
				() => {
					launchSettled = true;
					forget();
				},
			);
			void cleanup.promise.then(
				() => {
					cleaned = true;
					forget();
				},
				() => {
					failed = true;
				},
			);
			return launch;
		},
		owns(value) {
			return [...records].some((record) => record.owns(value));
		},
		close() {
			fenced = true;
			if (closing) return closing;
			const completion = Promise.withResolvers<PluginProcessCloseResult>();
			closing = completion.promise;
			const original = [...records];
			for (const record of original) record.stop();
			void Promise.resolve()
				.then(async () => {
					await Promise.allSettled(original.map((record) => record.launch));
					const outcomes = await Promise.allSettled(original.map((record) => record.cleanup));
					if (failed || outcomes.some((result) => result.status === "rejected")) unavailable();
					return Object.freeze<PluginProcessCloseResult>({ cleanupFailures: 0 });
				})
				.then(completion.resolve, () => completion.reject(new PluginProcessError()));
			return closing;
		},
	};
	return Object.freeze(owner);
}
