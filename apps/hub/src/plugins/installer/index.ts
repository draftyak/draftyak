import path from "node:path";
import { isProxy } from "node:util/types";
import { egressDigest, manifestDigest, sendTemplateDigest } from "@draftyak/protocol/digests";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import {
	canonicalDirectory,
	type InstalledBundle,
	type PackageLock,
	type PreparedPackage,
	preparePinnedPackage,
	verifyBundle,
} from "../../artifacts/index.ts";
import { snapshotPackageLock } from "../../artifacts/pin.ts";
import {
	assertNativePluginOwner,
	type NativePluginSessionParts,
	nativePluginInputs,
} from "../../lifecycle/native-session-context.ts";
import { createInstallerMutex } from "./mutex.ts";
import {
	BUNDLED_PLUGIN_IDS,
	type BundledPluginId,
	declaration,
	PluginInstallError,
	record,
	refuse,
} from "./policy.ts";
import {
	discard,
	existingTree,
	materialize,
	place,
	recheckExisting,
	rootDirectory,
	seal,
	stage,
	type Tree,
} from "./tree.ts";

export { BUNDLED_PLUGIN_IDS, type BundledPluginId, PluginInstallError } from "./policy.ts";

export interface BundledPluginPin {
	readonly id: BundledPluginId;
	readonly package: PackageLock;
}

export interface PluginInstallerOptions {
	/**
	 * An existing canonical folder private to the hub, with no other writer. On POSIX it must be
	 * owned by the effective user and not group- or other-writable, and each ancestor owned by that
	 * user or root and not group- or other-writable unless sticky.
	 */
	readonly directory: string;
	/** Native release pins, never a package-provided catalog or an install-request pin. */
	readonly bundles: readonly BundledPluginPin[];
	/** Trusted native startup binding, never supplied by an archive or install request. */
	readonly nativeBinding: string;
}

/** Verified bytes and declarations only; activation and reviewed generations remain M2.25's. */
export interface InstalledPlugin {
	readonly bundle: InstalledBundle;
	readonly manifest: PluginManifestV1;
	readonly digests: {
		readonly manifest: string;
		readonly egress: string;
		readonly send: string | null;
	};
}

export interface PluginInstaller {
	/**
	 * Builds the pinned package under a unique staging name in the directory, verifies it, and renames
	 * it to `<id>-<sha512 hex>`, checking before each attempt that nothing created there has changed
	 * since it was written; an existing name is refused, never adopted. An install stopped midway
	 * can leave a staging folder, and one stopped or failing after the rename a complete tree whose
	 * result was never recorded, which refuses that pin again; removing or recording either is the
	 * plugin registry's recovery (M2.25).
	 */
	install(id: BundledPluginId, version: string, archive: Uint8Array): Promise<InstalledPlugin>;
	/**
	 * Rechecks the existing deterministic target against this factory's native pin and the original
	 * archive. It writes nothing and returns only artifact facts, not installation history, review
	 * or execution authority. A missing, changed, extra, linked or unsealed entry refuses.
	 */
	inspect(id: BundledPluginId, version: string, archive: Uint8Array): Promise<InstalledPlugin>;
	/** Refuses later operations and resolves once every in-flight operation has settled. */
	close(): Promise<void>;
}

interface NativeInstaller {
	readonly parts: NativePluginSessionParts;
	readonly opening: Promise<PluginInstaller>;
	value?: PluginInstaller;
	closing: boolean;
	closePromise?: Promise<void>;
}
const nativeInstallers = new WeakMap<object, NativeInstaller>();

/** Internal native construction: no store, path, catalog or proof is supplied by the caller. */
export function openNativePluginInstaller(session: unknown): Promise<PluginInstaller> {
	try {
		const parts = nativePluginInputs(session),
			key = session as object;
		const previous = nativeInstallers.get(key);
		if (previous) {
			if (previous.closing || previous.parts !== parts) refuse();
			return previous.opening;
		}
		let owner: NativeInstaller;
		const opening = Promise.resolve()
			.then(async () => {
				assertNativePluginOwner(session, parts);
				const value = await createPluginInstaller(
					{
						directory: parts.directory,
						bundles: parts.bundles,
						nativeBinding: parts.nativeBinding,
					},
					{ session, parts },
				);
				owner.value = value;
				if (owner.closing) refuse();
				return value;
			})
			.catch(() => {
				throw new PluginInstallError();
			});
		owner = { parts, opening, closing: false };
		nativeInstallers.set(key, owner);
		void opening.catch(() => undefined);
		return opening;
	} catch {
		return Promise.reject(new PluginInstallError());
	}
}

/** Drains only an existing canonical resource; this never opens a replacement. */
export function closeNativePluginInstaller(session: unknown): Promise<void> {
	const owner =
		session !== null && typeof session === "object" ? nativeInstallers.get(session) : undefined;
	if (!owner) return Promise.resolve();
	owner.closing = true;
	if (owner.closePromise) return owner.closePromise;
	const immediate = owner.value?.close();
	if (immediate) void immediate.catch(() => undefined);
	const closing = Promise.allSettled([owner.opening])
		.then(async () => {
			if (immediate) await immediate;
			else if (owner.value) await owner.value.close();
		})
		.catch(() => {
			owner.closePromise = undefined;
			throw new PluginInstallError();
		});
	owner.closePromise = closing;
	void closing.catch(() => undefined);
	return closing;
}

function installedFacts(
	prepared: PreparedPackage,
	manifest: PluginManifestV1,
	directory: string,
): InstalledPlugin {
	return Object.freeze({
		bundle: Object.freeze({ directory, inventory: prepared.inventory }),
		manifest,
		digests: Object.freeze({
			manifest: manifestDigest(prepared.files.get("draftyak.plugin.json")),
			egress: egressDigest(manifest.egress),
			send: manifest.kind === "channel" && manifest.send ? sendTemplateDigest(manifest.send) : null,
		}),
	});
}

function catalog(raw: unknown): ReadonlyMap<string, BundledPluginPin> {
	if (
		isProxy(raw) ||
		!Array.isArray(raw) ||
		Object.getPrototypeOf(raw) !== Array.prototype ||
		raw.length < 1 ||
		raw.length > 64 ||
		Reflect.ownKeys(raw).length !== raw.length + 1
	)
		refuse();
	const result = new Map<string, BundledPluginPin>();
	for (let index = 0; index < raw.length; index++) {
		const field = Object.getOwnPropertyDescriptor(raw, String(index));
		if (!field?.enumerable || !("value" in field)) refuse();
		const item = record(field.value, ["id", "package"]);
		const id = BUNDLED_PLUGIN_IDS.find((id) => id === item.id);
		if (!id) refuse();
		const lock = snapshotPackageLock(item.package);
		if (lock.name !== `@draftyak/${id}` || !/\.(?:mjs|js)$/.test(lock.entry)) refuse();
		const key = `${id}\0${lock.version}`;
		if (result.has(key)) refuse();
		result.set(key, Object.freeze({ id, package: lock }));
	}
	return result;
}

/** Takes no master key and starts no extension host: it only installs or inspects verified plugin files. */
export async function openPluginInstaller(
	options: PluginInstallerOptions,
): Promise<PluginInstaller> {
	return createPluginInstaller(options);
}

async function createPluginInstaller(
	options: PluginInstallerOptions,
	native?: { readonly session: unknown; readonly parts: NativePluginSessionParts },
): Promise<PluginInstaller> {
	try {
		const assertOwner = (phase: "open" | "held" = "open"): void => {
			if (native) assertNativePluginOwner(native.session, native.parts, phase);
		};
		assertOwner();
		const input = record(options, ["directory", "bundles", "nativeBinding"]);
		const pins = catalog(input.bundles);
		const root = await canonicalDirectory(input.directory);
		assertOwner();
		const rootStat = rootDirectory(root);
		const mutex = createInstallerMutex(root, rootStat, input.nativeBinding);
		let closed = false;
		const settling = new Set<Promise<void>>();
		const active = (): void => {
			if (closed) refuse();
			assertOwner();
			mutex.check();
		};
		const run = async (
			id: unknown,
			version: unknown,
			archive: unknown,
		): Promise<InstalledPlugin> => {
			let tree: Tree | undefined;
			try {
				active();
				if (typeof id !== "string" || typeof version !== "string") refuse();
				const pin = pins.get(`${id}\0${version}`);
				if (!pin) refuse();
				const prepared = preparePinnedPackage(archive, pin.package);
				const manifest = declaration(prepared, pin.id);
				const digest = Buffer.from(pin.package.integrity.slice(7), "base64").toString("hex");
				const destination = path.join(root, `${pin.id}-${digest}`);
				mutex.acquire();
				tree = stage(root, rootStat, destination);
				await materialize(tree, prepared.files, active);
				active();
				await seal(tree);
				active();
				await verifyBundle(Object.freeze({ directory: tree.top, inventory: prepared.inventory }));
				active();
				await place(tree, destination, active);
				active();
				return installedFacts(prepared, manifest, destination);
			} catch {
				try {
					assertOwner("held");
					if (tree) await discard(tree);
				} catch {
					// Substituted or unlisted names stay untouched; no failed install returns an artifact.
				}
				throw new PluginInstallError();
			}
		};
		const reinspect = async (
			id: unknown,
			version: unknown,
			archive: unknown,
		): Promise<InstalledPlugin> => {
			try {
				active();
				if (typeof id !== "string" || typeof version !== "string") refuse();
				const pin = pins.get(`${id}\0${version}`);
				if (!pin) refuse();
				const prepared = preparePinnedPackage(archive, pin.package);
				const manifest = declaration(prepared, pin.id);
				const digest = Buffer.from(pin.package.integrity.slice(7), "base64").toString("hex");
				const destination = path.join(root, `${pin.id}-${digest}`);
				const tree = existingTree(
					root,
					rootStat,
					destination,
					prepared.inventory.files.map((file) => file.path),
				);
				await verifyBundle(
					Object.freeze({ directory: destination, inventory: prepared.inventory }),
				);
				active();
				recheckExisting(tree);
				return installedFacts(prepared, manifest, destination);
			} catch {
				throw new PluginInstallError();
			}
		};
		const track = (result: Promise<InstalledPlugin>): Promise<InstalledPlugin> => {
			const settled = result.then(
				() => undefined,
				() => undefined,
			);
			settling.add(settled);
			void settled.then(() => settling.delete(settled));
			return result;
		};
		const install = (
			id: BundledPluginId,
			version: string,
			archive: Uint8Array,
		): Promise<InstalledPlugin> => {
			return track(run(id, version, archive));
		};
		let closePromise: Promise<void> | undefined;
		const close = (): Promise<void> => {
			closed = true;
			if (!closePromise) {
				closePromise = Promise.all(settling).then(() => mutex.close());
				void closePromise.catch(() => {
					// Explicit close may retry a native connection whose first close failed.
					closePromise = undefined;
				});
			}
			return closePromise;
		};
		return Object.freeze({
			install,
			inspect: (id: BundledPluginId, version: string, archive: Uint8Array) =>
				track(reinspect(id, version, archive)),
			close,
		});
	} catch {
		throw new PluginInstallError();
	}
}
