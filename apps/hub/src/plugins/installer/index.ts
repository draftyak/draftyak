import path from "node:path";
import { isProxy } from "node:util/types";
import { egressDigest, manifestDigest, sendTemplateDigest } from "@draftyak/protocol/digests";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import {
	canonicalDirectory,
	type InstalledBundle,
	type PackageLock,
	preparePinnedPackage,
	verifyBundle,
} from "../../artifacts/index.ts";
import { snapshotPackageLock } from "../../artifacts/pin.ts";
import {
	BUNDLED_PLUGIN_IDS,
	type BundledPluginId,
	declaration,
	PluginInstallError,
	record,
	refuse,
} from "./policy.ts";
import { discard, materialize, place, rootDirectory, seal, stage, type Tree } from "./tree.ts";

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
	/** Refuses later installs and resolves once every in-flight install has settled. */
	close(): Promise<void>;
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

/** Takes no master key and starts no extension host: it only writes verified plugin files. */
export async function openPluginInstaller(
	options: PluginInstallerOptions,
): Promise<PluginInstaller> {
	try {
		const input = record(options, ["directory", "bundles"]);
		const pins = catalog(input.bundles);
		const root = await canonicalDirectory(input.directory);
		const rootStat = rootDirectory(root);
		let closed = false;
		const settling = new Set<Promise<void>>();
		const active = (): void => {
			if (closed) refuse();
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
				tree = stage(root, rootStat, destination);
				await materialize(tree, prepared.files, active);
				await seal(tree);
				await verifyBundle(Object.freeze({ directory: tree.top, inventory: prepared.inventory }));
				await place(tree, destination, active);
				return Object.freeze({
					bundle: Object.freeze({ directory: destination, inventory: prepared.inventory }),
					manifest,
					digests: Object.freeze({
						manifest: manifestDigest(prepared.files.get("draftyak.plugin.json")),
						egress: egressDigest(manifest.egress),
						send:
							manifest.kind === "channel" && manifest.send
								? sendTemplateDigest(manifest.send)
								: null,
					}),
				});
			} catch {
				try {
					if (tree) await discard(tree);
				} catch {
					// Substituted or unlisted names stay untouched; no failed install returns an artifact.
				}
				throw new PluginInstallError();
			}
		};
		const install = (
			id: BundledPluginId,
			version: string,
			archive: Uint8Array,
		): Promise<InstalledPlugin> => {
			const result = run(id, version, archive);
			const settled = result.then(
				() => undefined,
				() => undefined,
			);
			settling.add(settled);
			void settled.then(() => settling.delete(settled));
			return result;
		};
		const close = async (): Promise<void> => {
			closed = true;
			await Promise.all(settling);
		};
		return Object.freeze({ install, close });
	} catch {
		throw new PluginInstallError();
	}
}
