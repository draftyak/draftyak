import { isProxy } from "node:util/types";
import { type PluginManifestV1, validateManifest } from "@draftyak/protocol/manifest";
import type { InstalledBundle } from "../../artifacts/index.ts";
import { refuse, type SupervisorErrorCode } from "./errors.ts";

export type PluginKind = "channel" | "ai-provider";

/** What the plugin answered at startup or at a liveness check. */
export interface PluginSurface {
	readonly discover: unknown;
	readonly tools: unknown;
}

/**
 * A generation the caller has already reviewed. The supervisor checks its mechanics only; this
 * seam holds no authority of its own, and a synthetic generation authorizes nothing.
 */
export interface ReviewedGeneration {
	readonly pluginId: string;
	readonly generation: string;
	readonly bundle: InstalledBundle;
	readonly manifest: PluginManifestV1;
	/** Must return exactly true for the plugin's discover and tools/list answers. */
	readonly acceptSurface: (surface: PluginSurface) => boolean;
}

/**
 * The authority, configuration and credential state the caller activated under. The caller aborts
 * `signal` as soon as any of them changes; `id` names that state and travels with every handle.
 */
export interface ActivationEpoch {
	readonly id: string;
	readonly signal: AbortSignal;
}

export interface ActivationOptions {
	readonly epoch: ActivationEpoch;
}

export interface GenerationSnapshot {
	readonly pluginId: string;
	readonly generation: string;
	readonly kind: PluginKind;
	readonly bundle: InstalledBundle;
	readonly manifest: PluginManifestV1;
	readonly dataGrant: boolean;
	readonly acceptSurface: (surface: PluginSurface) => boolean;
}

export const PLUGIN_ID: RegExp = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const GENERATION_ID: RegExp = /^[!-~]{1,128}$/;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_INVENTORY_FILES = 1024;

/** Own enumerable data properties only, with exactly the named keys; no proxy, getter or extra. */
export function inertRecord(
	raw: unknown,
	keys: readonly string[],
	optional: readonly string[],
	code: SupervisorErrorCode,
): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) return refuse(code);
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== Object.prototype && prototype !== null) return refuse(code);
	const result = Object.create(null) as Record<string, unknown>;
	for (const name of Reflect.ownKeys(raw)) {
		if (typeof name !== "string" || (!keys.includes(name) && !optional.includes(name)))
			return refuse(code);
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return refuse(code);
		result[name] = descriptor.value;
	}
	for (const key of keys) if (!Object.hasOwn(result, key)) return refuse(code);
	return result;
}

function primitive(value: unknown, code: SupervisorErrorCode): string | number {
	if (typeof value !== "string" && typeof value !== "number") return refuse(code);
	return value;
}

/** A frozen own-data copy, so later caller mutation cannot change what each spawn verifies. */
function bundleCopy(raw: unknown): InstalledBundle {
	const code = "GENERATION_INVALID";
	const bundle = inertRecord(raw, ["directory", "inventory"], [], code);
	const inventory = inertRecord(
		bundle.inventory,
		["name", "version", "integrity", "entry", "files"],
		[],
		code,
	);
	const list = inventory.files;
	if (
		!Array.isArray(list) ||
		isProxy(list) ||
		Object.getPrototypeOf(list) !== Array.prototype ||
		list.length < 1 ||
		list.length > MAX_INVENTORY_FILES ||
		Reflect.ownKeys(list).length !== list.length + 1
	)
		return refuse(code);
	const files = [];
	for (let index = 0; index < list.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
		if (!descriptor || !("value" in descriptor)) return refuse(code);
		const file = inertRecord(descriptor.value, ["path", "bytes", "sha256"], [], code);
		files.push(
			Object.freeze({
				path: primitive(file.path, code) as string,
				bytes: primitive(file.bytes, code) as number,
				sha256: primitive(file.sha256, code) as string,
			}),
		);
	}
	return Object.freeze({
		directory: primitive(bundle.directory, code) as string,
		inventory: Object.freeze({
			name: primitive(inventory.name, code) as string,
			version: primitive(inventory.version, code) as string,
			integrity: primitive(inventory.integrity, code) as string,
			entry: primitive(inventory.entry, code) as string,
			files: Object.freeze(files),
		}),
	});
}

/** Freezes a JSON-like value and everything it holds. */
export function deepFreeze<T>(value: T): T {
	const pending: unknown[] = [value];
	while (pending.length) {
		const item = pending.pop();
		if (item === null || typeof item !== "object" || Object.isFrozen(item)) continue;
		Object.freeze(item);
		for (const key of Reflect.ownKeys(item))
			pending.push((item as Record<PropertyKey, unknown>)[key]);
	}
	return value;
}

/** Mechanics only: an inert copy of a node channel or AI-provider generation, else GENERATION_INVALID. */
export function snapshotGeneration(raw: unknown): GenerationSnapshot {
	const code = "GENERATION_INVALID";
	const input = inertRecord(
		raw,
		["pluginId", "generation", "bundle", "manifest", "acceptSurface"],
		[],
		code,
	);
	const { pluginId, generation, acceptSurface } = input;
	if (typeof pluginId !== "string" || !PLUGIN_ID.test(pluginId) || DEVICE_NAME.test(pluginId))
		return refuse(code);
	if (typeof generation !== "string" || !GENERATION_ID.test(generation)) return refuse(code);
	if (typeof acceptSurface !== "function" || isProxy(acceptSurface)) return refuse(code);
	const checked = validateManifest(input.manifest);
	if (!checked.ok) return refuse(code);
	const manifest = deepFreeze(checked.manifest);
	if (manifest.id !== pluginId) return refuse(code);
	// Tool-instance rules are postponed, and other runtimes need their own launch boundary.
	if (manifest.kind !== "channel" && manifest.kind !== "ai-provider") return refuse(code);
	if (manifest.runtime !== undefined && manifest.runtime !== "node") return refuse(code);
	if (manifest.isolation !== "standard") return refuse(code);
	const bundle = bundleCopy(input.bundle);
	if (!/\.(?:mjs|js)$/.test(bundle.inventory.entry)) return refuse(code);
	return Object.freeze({
		pluginId,
		generation,
		kind: manifest.kind,
		bundle,
		manifest,
		dataGrant: manifest.permissions.dataDir === true,
		acceptSurface: acceptSurface as GenerationSnapshot["acceptSurface"],
	});
}

export interface EpochSnapshot {
	readonly id: string;
	/** A fresh native signal that follows the caller's; no caller code runs when it is read. */
	readonly signal: AbortSignal;
}

export function snapshotActivationOptions(raw: unknown): EpochSnapshot {
	const code = "EPOCH_INVALID";
	const options = inertRecord(raw, ["epoch"], [], code);
	const epoch = inertRecord(options.epoch, ["id", "signal"], [], code);
	const { id, signal } = epoch;
	if (typeof id !== "string" || !GENERATION_ID.test(id)) return refuse(code);
	let follower: AbortSignal;
	try {
		follower = AbortSignal.any([signal as AbortSignal]);
	} catch {
		return refuse(code);
	}
	if (follower.aborted) return refuse(code);
	return Object.freeze({ id, signal: follower });
}
