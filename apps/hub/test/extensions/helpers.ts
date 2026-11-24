import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { ExtensionRegistry } from "@draftyak/extensions";
import Database from "better-sqlite3-multiple-ciphers";
import { expect, vi } from "vitest";
import { ExtensionError } from "../../src/extensions/errors.ts";
import {
	type ExtensionHost,
	type ExtensionStartOptions,
	startExtensions,
} from "../../src/extensions/registry.ts";
import type { TimerClock } from "../../src/kernel/clock.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import type { SqliteDatabase } from "../../src/store/open.ts";
import { nativeBinding } from "../store/helpers.ts";

export { nativeBinding };

const require = createRequire(import.meta.url);
const addon = require(nativeBinding) as { Database: { prototype: { close(): unknown } } };
const temporaryRoot = realpathSync.native(os.tmpdir());
const TRACE = Symbol.for("draftyak.test.extensions");
const REGISTRIES = Symbol.for("draftyak.test.registries");
const CLOCK = Symbol.for("draftyak.test.clock");
const shared = globalThis as Record<symbol, unknown>;

/** Module-side observations: each generated module records what ran. */
export const trace = (): unknown[] => {
	shared[TRACE] ??= [];
	return shared[TRACE] as unknown[];
};
/** The registry object each generated module received, by module id. */
export const registries = (): Map<string, ExtensionRegistry> => {
	shared[REGISTRIES] ??= new Map();
	return shared[REGISTRIES] as Map<string, ExtensionRegistry>;
};
export const registry = (id: string): ExtensionRegistry =>
	registries().get(id) ?? expect.unreachable(`no registry for ${id}`);
export const resetTrace = (): void => {
	trace().splice(0);
	registries().clear();
	delete shared[CLOCK];
};

export const pin = (bytes: string | Uint8Array): string =>
	`sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export interface ModuleOptions {
	readonly version?: string;
	readonly top?: string;
	readonly descriptor?: string;
}

/** A self-contained ESM module; the nonce keeps each module's data: URL distinct. */
export function moduleSource(id: string, register = "", options: ModuleOptions = {}): string {
	return `const trace = (globalThis[Symbol.for("draftyak.test.extensions")] ??= []);
const registries = (globalThis[Symbol.for("draftyak.test.registries")] ??= new Map());
trace.push(${JSON.stringify(`${id}:loaded`)});
${options.top ?? ""}
export default {
	id: ${JSON.stringify(id)},
	version: ${JSON.stringify(options.version ?? "1.0.0")},${options.descriptor ?? ""}
	async register(registry) {
		registries.set(${JSON.stringify(id)}, registry);
		trace.push(${JSON.stringify(`${id}:register`)});
${register}
	},
};
// ${randomUUID()}
`;
}

export interface ModuleEntry {
	readonly id: string;
	readonly version?: string;
	readonly entry: string;
	readonly sha512: string;
	readonly provides: readonly string[];
	readonly migrations?: {
		readonly directory: string;
		readonly files: readonly { readonly name: string; readonly sha512: string }[];
	};
}

export interface Fixture {
	readonly dir: string;
	readonly key: MasterKey;
	readonly hosts: ExtensionHost[];
	module(
		id: string,
		register?: string,
		options?: ModuleOptions & {
			readonly provides?: readonly string[];
			readonly migrations?: Readonly<Record<string, string>>;
		},
	): ModuleEntry;
	config(modules: readonly unknown[]): void;
	start(options?: Partial<ExtensionStartOptions>): Promise<ExtensionHost>;
	remove(): void;
}

export function fixture(): Fixture {
	const dir = realpathSync.native(mkdtempSync(path.join(temporaryRoot, "draftyak-ext-")));
	const key = new MasterKey(randomBytes(32));
	const hosts: ExtensionHost[] = [];
	const birth = lstatSync(dir);
	return {
		dir,
		key,
		hosts,
		module(id, register = "", options = {}) {
			const folder = path.join(dir, "modules", id);
			rmSync(folder, { recursive: true, force: true });
			mkdirSync(folder, { recursive: true });
			const source = moduleSource(id, register, options);
			const entry = path.join(folder, "index.mjs");
			writeFileSync(entry, source);
			let migrations: ModuleEntry["migrations"];
			if (options.migrations) {
				const directory = path.join(folder, "migrations");
				mkdirSync(directory);
				const files = Object.entries(options.migrations).map(([name, sql]) => {
					writeFileSync(path.join(directory, name), sql);
					return { name, sha512: pin(sql) };
				});
				migrations = { directory, files };
			}
			return {
				id,
				...(options.version === undefined ? {} : { version: options.version }),
				entry,
				sha512: pin(source),
				provides: options.provides ?? [],
				...(migrations ? { migrations } : {}),
			};
		},
		config(modules) {
			const document = {
				modules: modules.map((module) =>
					typeof module === "object" && module !== null && "entry" in module
						? { version: "1.0.0", ...module }
						: module,
				),
			};
			writeFileSync(path.join(dir, "config.json"), JSON.stringify(document));
		},
		async start(options = {}) {
			const host = await startExtensions({
				dataDirectory: dir,
				nativeBinding,
				masterKey: key,
				...options,
			});
			hosts.push(host);
			return host;
		},
		remove() {
			for (const host of hosts.splice(0)) host.close();
			key.destroy();
			const current = lstatSync(dir);
			if (
				path.dirname(dir) !== temporaryRoot ||
				!path.basename(dir).startsWith("draftyak-ext-") ||
				current.ino !== birth.ino ||
				current.dev !== birth.dev
			)
				throw new Error("Unowned extension fixture directory");
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export async function refused(code: string, operation: Promise<unknown>): Promise<void> {
	const error = await operation.then(
		() => expect.unreachable("operation was not refused"),
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(ExtensionError);
	expect((error as ExtensionError).code).toBe(code);
	expect((error as Error).message).toBe("Extension operation refused.");
}

export function refusedNow(code: string, operation: () => unknown): void {
	let error: unknown;
	try {
		operation();
	} catch (reason) {
		error = reason;
	}
	expect(error).toBeInstanceOf(ExtensionError);
	expect((error as ExtensionError).code).toBe(code);
}

/** Every native connection keyed while the spy is active, in order. */
export function captureConnections(): { readonly connections: SqliteDatabase[]; restore(): void } {
	const connections: SqliteDatabase[] = [];
	const nativeKey = Database.prototype.key;
	const spy = vi.spyOn(Database.prototype, "key").mockImplementation(function (
		this: SqliteDatabase,
		bytes,
	) {
		connections.push(this);
		return nativeKey.call(this, bytes);
	});
	return { connections, restore: () => spy.mockRestore() };
}

/** Native closes fail while blocked, the way an interrupted close would. */
export function blockNativeClose(): { blocked: boolean; attempts: number; restore(): void } {
	const nativeClose = addon.Database.prototype.close;
	const control = {
		blocked: true,
		attempts: 0,
		restore: () => spy.mockRestore(),
	};
	const spy = vi.spyOn(addon.Database.prototype, "close").mockImplementation(function (
		this: object,
	) {
		control.attempts++;
		if (control.blocked) throw new Error("PRIVATE_NATIVE_CLOSE_CANARY");
		return nativeClose.call(this);
	});
	return control;
}

/**
 * Timers that end only when the test says so; aborts reject like Node's timers. The monotonic
 * reading moves only through advance(), which module code reaches through the latest clock's symbol.
 */
export function manualClock(): TimerClock & {
	readonly waits: number[];
	fire(): void;
	advance(ms: number): void;
} {
	const pending: { resolve: () => void }[] = [];
	const waits: number[] = [];
	let now = 0;
	const clock = {
		waits,
		wallMs: () => 0,
		monotonicMs: () => now,
		after(ms: number, signal?: AbortSignal): Promise<void> {
			waits.push(ms);
			return new Promise<void>((resolve, reject) => {
				pending.push({ resolve });
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		},
		fire() {
			for (const wait of pending.splice(0)) wait.resolve();
		},
		advance(ms: number) {
			now += ms;
		},
	};
	shared[CLOCK] = clock;
	return clock;
}

/** Module code for a busy event loop: a 0 ms callback moves the clock by ms, then the work settles. */
export const busyFor = (ms: number): string =>
	`await new Promise((resolve) => setTimeout(() => { globalThis[Symbol.for("draftyak.test.clock")].advance(${ms}); resolve(); }, 0));`;

export const flush = async (): Promise<void> => {
	for (let round = 0; round < 20; round++) await new Promise((resolve) => setImmediate(resolve));
};

export const ULID = "01HZY6Q4VJ6XGQ3W8Y7N2K5M9R";
export const OTHER_ULID = "01HZY6Q4VJ6XGQ3W8Y7N2K5M9S";
