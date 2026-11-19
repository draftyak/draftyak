import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@draftyak/protocol/hash";
import type { HostMethod } from "@draftyak/protocol/host-channel";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import { expect } from "vitest";
import type { InstalledBundle } from "../../src/artifacts/index.ts";
import {
	createPluginSupervisor,
	type PluginHostRequestContext,
	type PluginSupervisor,
	type ReviewedGeneration,
	type SupervisorEvent,
} from "../../src/plugins/supervisor/index.ts";

export const FIXTURES: string = fileURLToPath(new URL("./fixtures/supervisor/", import.meta.url));
export const LINE_PLUGIN: string = readFileSync(path.join(FIXTURES, "line-plugin.mjs"), "utf8");

/** Fresh ULIDs for instance ids: 26 Crockford base32 characters, first one 0-7. */
export function ulid(): string {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	const bytes = randomBytes(26);
	return `0${Array.from(bytes.subarray(1), (byte) => alphabet[byte % 32]).join("")}`;
}

export function canary(label: string): string {
	return `DYTEST-${label}-${randomBytes(12).toString("hex")}`;
}

export interface Roots {
	readonly base: string;
	readonly dataRoot: string;
	readonly stdioRoot: string;
	readonly bundles: string;
	/** Makes trees writable again, removes everything and checks nothing is left. */
	cleanup(): void;
}

/** Canonical 0700 roots under the real temp folder; never anything of the owner's. */
export function makeRoots(): Roots {
	const base = realpathSync.native(
		mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "draftyak-supervisor-")),
	);
	chmodSync(base, 0o700);
	const dataRoot = path.join(base, "data");
	const stdioRoot = path.join(base, "run");
	const bundles = path.join(base, "bundles");
	for (const folder of [dataRoot, stdioRoot, bundles]) mkdirSync(folder, { mode: 0o700 });
	return {
		base,
		dataRoot,
		stdioRoot,
		bundles,
		cleanup() {
			const writable = (target: string): void => {
				const stat = lstatSync(target);
				if (stat.isSymbolicLink()) return;
				if (stat.isDirectory()) {
					chmodSync(target, 0o700);
					for (const name of readdirSync(target)) writable(path.join(target, name));
				} else chmodSync(target, 0o600);
			};
			if (existsSync(base)) writable(base);
			rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			expect(existsSync(base)).toBe(false);
		},
	};
}

export interface BundleFile {
	readonly path: string;
	readonly content: string | Buffer;
}

const INTEGRITY = `sha512-${createHash("sha512").update("DYTEST bundle").digest("base64")}`;

/** Writes a bundle tree and its exact inventory, as an installer would have verified it. */
export function writeBundle(
	directory: string,
	files: readonly BundleFile[],
	entry: string,
): InstalledBundle {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const rows = [...files]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((file) => {
			const target = path.join(directory, ...file.path.split("/"));
			mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
			const bytes = Buffer.from(file.content);
			writeFileSync(target, bytes);
			return { path: file.path, bytes: bytes.length, sha256: sha256Hex(bytes) };
		});
	return {
		directory,
		inventory: {
			name: "dytest-plugin",
			version: "1.0.0",
			integrity: INTEGRITY,
			entry,
			files: rows,
		},
	};
}

export interface LineOptions {
	readonly startup?: "ok" | "silent" | "crash" | "exit-now";
	readonly tools?: readonly string[];
	readonly nextCursor?: boolean;
	/** Sends this host request before answering the first discover, so before the plugin is ready. */
	readonly hostAtStartup?: { readonly method: string; readonly params: unknown };
}

/** The line-protocol fixture plus a generated entry that starts it with `options`. */
export function lineBundle(
	directory: string,
	options: LineOptions = {},
	extra: readonly BundleFile[] = [],
): InstalledBundle {
	return writeBundle(
		directory,
		[
			{ path: "line-plugin.mjs", content: LINE_PLUGIN },
			{
				path: "main.mjs",
				content: `import { start } from "./line-plugin.mjs";\nstart(${JSON.stringify(options)});\n`,
			},
			...extra,
		],
		"main.mjs",
	);
}

export function manifest(
	pluginId: string,
	kind: "channel" | "ai-provider" = "ai-provider",
	permissions: { dataDir?: boolean } = {},
): PluginManifestV1 {
	const base = {
		id: pluginId,
		version: "1.0.0",
		sdk: "1.0.0",
		isolation: "standard",
		auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
		credentials: { mode: "brokered", urlSecrets: [] },
		permissions,
		license: "Apache-2.0",
	};
	return (
		kind === "channel"
			? {
					...base,
					kind,
					contract: { extension: "io.github.draftyak/channel", version: 1 },
					dataClasses: ["slack.content"],
					egress: { profile: "slack-v1" },
				}
			: {
					...base,
					kind,
					contract: { extension: "io.github.draftyak/ai-provider", version: 1 },
					dataClasses: ["dytest.content"],
					egress: { profile: "messages-api-v1" },
				}
	) as PluginManifestV1;
}

export function generation(
	bundle: InstalledBundle,
	options: {
		readonly pluginId?: string;
		readonly generation?: string;
		readonly kind?: "channel" | "ai-provider";
		readonly dataDir?: boolean;
		readonly acceptSurface?: ReviewedGeneration["acceptSurface"];
	} = {},
): ReviewedGeneration {
	const pluginId = options.pluginId ?? "dytest-plugin";
	return {
		pluginId,
		generation: options.generation ?? "g1",
		bundle,
		manifest: manifest(pluginId, options.kind, options.dataDir ? { dataDir: true } : {}),
		acceptSurface: options.acceptSurface ?? (() => true),
	};
}

export interface HostCall {
	readonly method: HostMethod;
	readonly params: unknown;
	readonly context: PluginHostRequestContext;
}

/** A recording host handler; `answer` decides each reply (null by default, as host/log needs). */
export function recordingHost(answer: (call: HostCall) => unknown = () => null): {
	readonly calls: HostCall[];
	request(method: HostMethod, params: unknown, context: PluginHostRequestContext): Promise<never>;
} {
	const calls: HostCall[] = [];
	return {
		calls,
		async request(method, params, context) {
			const call = { method, params, context };
			calls.push(call);
			return (await answer(call)) as never;
		},
	};
}

const epochControllers = new WeakMap<object, AbortController>();

/** An activation epoch as a caller supplies it: exactly an id and a signal. */
export function epoch(id = "e1"): { readonly id: string; readonly signal: AbortSignal } {
	const controller = new AbortController();
	const value = { id, signal: controller.signal };
	epochControllers.set(value, controller);
	return value;
}

/** The caller's authority, configuration or credential state changed. */
export function endEpoch(value: object): void {
	epochControllers.get(value)?.abort();
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Waits (real time) for a condition the test cannot drive itself, such as an OS process exit. */
export async function until(check: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("Condition not reached in time");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export interface Harness {
	readonly roots: Roots;
	readonly supervisor: PluginSupervisor;
	readonly events: SupervisorEvent[];
}

export async function harness(
	roots: Roots,
	host: {
		request(
			method: HostMethod,
			params: unknown,
			context: PluginHostRequestContext,
		): Promise<unknown>;
	},
	clock?: import("../../src/kernel/clock.ts").TimerClock,
): Promise<Harness> {
	const events: SupervisorEvent[] = [];
	const supervisor = await createPluginSupervisor({
		dataRoot: roots.dataRoot,
		stdioRoot: roots.stdioRoot,
		host: host as never,
		...(clock ? { clock } : {}),
		onEvent: (event) => events.push(event),
	});
	return { roots, supervisor, events };
}
