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
	assertNativeAppAdmissionCurrent,
	type NativeAppAdmission,
	type NativeAppAdmissionBundleFacts,
	nativeAppAdmissionArchive,
	nativeAppAdmissionCandidateArchive,
	nativeAppAdmissionFormat,
	nativeAppAdmissionReviewInputs,
	openNativeAppAdmission,
} from "../../installer/native-app-admission.ts";
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

export interface NativePluginInstallerSurface {
	readonly id: BundledPluginId;
	readonly version: string;
	readonly expectedSurfaceDigest: string;
}

/** Current capture DATA only; neither this view nor its mode is an accepted review issuer. */
export type NativePluginInstallerCatalogue =
	| Readonly<{
			mode: "legacy-inert" | "v1-inert";
			pins: readonly BundledPluginPin[];
			expectedSurfaces: null;
	  }>
	| Readonly<{
			mode: "v2-data";
			pins: readonly BundledPluginPin[];
			expectedSurfaces: readonly NativePluginInstallerSurface[];
	  }>;

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

interface NativeInstallerRelease {
	readonly admission: NativeAppAdmission;
	readonly selected: readonly NativeAppAdmissionBundleFacts[];
	readonly candidates: readonly NativeAppAdmissionBundleFacts[];
}
interface NativeInstallerContext {
	readonly session: unknown;
	readonly parts: NativePluginSessionParts;
	readonly format: 1 | 2 | undefined;
	readonly release: NativeInstallerRelease | undefined;
	readonly catalogue: ReadonlyMap<string, BundledPluginPin>;
	readonly lifetime: { closed: boolean };
}
interface NativeInstaller {
	readonly parts: NativePluginSessionParts;
	readonly opening: Promise<PluginInstaller>;
	/** Capture DATA classification only: no mode is an accepted administrative issuer. */
	mode: "opening" | "legacy-inert" | "v1-inert" | "v2-data";
	readonly lifetime: { closed: boolean };
	admission?: NativeAppAdmission;
	release?: NativeInstallerRelease;
	catalogue?: NativePluginInstallerCatalogue;
	value?: PluginInstaller;
	closing: boolean;
	closePromise?: Promise<void>;
}
const nativeInstallers = new WeakMap<object, NativeInstaller>();

function copyReleaseFacts(facts: NativeAppAdmissionBundleFacts): NativeAppAdmissionBundleFacts {
	return Object.freeze({
		id: facts.id,
		package: snapshotPackageLock(facts.package),
		expectedSurfaceDigest: facts.expectedSurfaceDigest,
	});
}

function catalogueFacts(
	format: 1 | 2 | undefined,
	pins: ReadonlyMap<string, BundledPluginPin>,
	release: NativeInstallerRelease | undefined,
): NativePluginInstallerCatalogue {
	const copied = Object.freeze([...pins.values()]);
	if (format !== 2)
		return Object.freeze({
			mode: format === 1 ? "v1-inert" : "legacy-inert",
			pins: copied,
			expectedSurfaces: null,
		});
	if (!release) refuse();
	const facts = [...release.selected, ...release.candidates];
	const surfaces = copied.map((pin) => {
		const actual = facts.find(
			(fact) => fact.id === pin.id && fact.package.version === pin.package.version,
		);
		if (!actual) refuse();
		return Object.freeze({
			id: pin.id,
			version: pin.package.version,
			expectedSurfaceDigest: actual.expectedSurfaceDigest,
		});
	});
	return Object.freeze({
		mode: "v2-data",
		pins: copied,
		expectedSurfaces: Object.freeze(surfaces),
	});
}

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
		const lifetime = { closed: false };
		const opening = Promise.resolve()
			.then(async () => {
				assertNativePluginOwner(session, parts);
				const format = await nativeAppAdmissionFormat(session);
				assertNativePluginOwner(session, parts);
				if (owner.closing) refuse();
				let bundles = parts.bundles;
				let release: NativeInstallerRelease | undefined;
				if (format !== undefined) {
					const admission = await openNativeAppAdmission(session);
					owner.admission = admission;
					assertNativePluginOwner(session, parts);
					if (format === 2) {
						const facts = await nativeAppAdmissionReviewInputs(admission, session);
						assertNativePluginOwner(session, parts);
						const selected = Object.freeze(facts.bundles.map(copyReleaseFacts));
						const candidates = Object.freeze(facts.candidates.map(copyReleaseFacts));
						if (selected.length !== 5 || candidates.length > 5) refuse();
						release = Object.freeze({ admission, selected, candidates });
						owner.release = release;
						bundles = Object.freeze(
							[...selected, ...candidates].map(({ id, package: lock }) =>
								Object.freeze({ id, package: lock }),
							),
						);
					}
				}
				owner.mode = format === undefined ? "legacy-inert" : format === 1 ? "v1-inert" : "v2-data";
				if (owner.closing) refuse();
				const captured = catalog(bundles);
				const value = await createPluginInstaller(
					{
						directory: parts.directory,
						bundles,
						nativeBinding: parts.nativeBinding,
					},
					{ session, parts, format, release, catalogue: captured, lifetime },
				);
				owner.value = value;
				if (owner.closing) refuse();
				owner.catalogue = catalogueFacts(format, captured, release);
				return value;
			})
			.catch(() => {
				throw new PluginInstallError();
			});
		owner = { parts, opening, mode: "opening", lifetime, closing: false };
		nativeInstallers.set(key, owner);
		void opening.catch(() => undefined);
		return opening;
	} catch {
		return Promise.reject(new PluginInstallError());
	}
}

/** Data from the real opened cached factory only; this never opens or registers a replacement. */
export async function nativePluginInstallerCatalogue(
	originalSession: unknown,
): Promise<NativePluginInstallerCatalogue> {
	try {
		if (arguments.length !== 1 || originalSession === null || typeof originalSession !== "object")
			refuse();
		const owner = nativeInstallers.get(originalSession);
		if (!owner || owner.closing || owner.lifetime.closed || !owner.value || !owner.catalogue)
			refuse();
		const parts = nativePluginInputs(originalSession);
		if (parts !== owner.parts) refuse();
		const value = owner.value;
		const captured = owner.catalogue;
		const format = await nativeAppAdmissionFormat(originalSession);
		assertNativePluginOwner(originalSession, parts);
		if (
			owner.closing ||
			owner.lifetime.closed ||
			owner.value !== value ||
			owner.catalogue !== captured ||
			owner.mode !== captured.mode ||
			format !== (captured.mode === "v2-data" ? 2 : captured.mode === "v1-inert" ? 1 : undefined)
		)
			refuse();
		return captured;
	} catch {
		throw new PluginInstallError();
	}
}

/**
 * Synchronous retained v2 capture liveness only. Async inspection must establish current App
 * bytes separately; neither this assertion nor a catalogue DATA value issues review authority.
 */
export function assertNativePluginInstallerCatalogueCurrent(
	originalSession: unknown,
	expectedInstaller: PluginInstaller,
	expectedCatalogue: NativePluginInstallerCatalogue,
): void {
	try {
		if (arguments.length !== 3 || originalSession === null || typeof originalSession !== "object")
			refuse();
		const owner = nativeInstallers.get(originalSession);
		if (
			!owner ||
			owner.closing ||
			owner.lifetime.closed ||
			!owner.value ||
			owner.value !== expectedInstaller ||
			!owner.catalogue ||
			owner.catalogue !== expectedCatalogue ||
			owner.mode !== "v2-data" ||
			owner.catalogue.mode !== "v2-data" ||
			!owner.admission ||
			!owner.release ||
			owner.release.admission !== owner.admission
		)
			refuse();
		const parts = owner.parts;
		const admission = owner.admission;
		const release = owner.release;
		const lifetime = owner.lifetime;
		assertNativePluginOwner(originalSession, parts);
		assertNativeAppAdmissionCurrent(admission, originalSession);
		if (
			nativeInstallers.get(originalSession) !== owner ||
			owner.parts !== parts ||
			owner.closing ||
			owner.lifetime !== lifetime ||
			lifetime.closed ||
			owner.value !== expectedInstaller ||
			owner.catalogue !== expectedCatalogue ||
			owner.mode !== "v2-data" ||
			owner.admission !== admission ||
			owner.release !== release
		)
			refuse();
	} catch {
		throw new PluginInstallError();
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
	native?: NativeInstallerContext,
): Promise<PluginInstaller> {
	try {
		const assertOwner = (phase: "open" | "held" = "open"): void => {
			if (native) assertNativePluginOwner(native.session, native.parts, phase);
		};
		assertOwner();
		const input = record(options, ["directory", "bundles", "nativeBinding"]);
		const pins = native ? native.catalogue : catalog(input.bundles);
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
		const originalArchive = async (pin: BundledPluginPin, supplied: unknown): Promise<unknown> => {
			if (!native) return supplied;
			const format = await nativeAppAdmissionFormat(native.session);
			active();
			if (format !== native.format) refuse();
			if (format !== 2) return supplied;
			const capture = native.release;
			if (!capture) refuse();
			const selected = capture.selected.some(
				(facts) => facts.id === pin.id && facts.package.version === pin.package.version,
			);
			const candidate = capture.candidates.some(
				(facts) => facts.id === pin.id && facts.package.version === pin.package.version,
			);
			if (selected === candidate) refuse();
			const archive = selected
				? await nativeAppAdmissionArchive(capture.admission, native.session, pin.id)
				: await nativeAppAdmissionCandidateArchive(
						capture.admission,
						native.session,
						pin.id,
						pin.package.version,
					);
			active();
			// Caller bytes remain validated DATA; only the original captured archive is consumed.
			preparePinnedPackage(supplied, pin.package);
			return archive;
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
				const source = native ? await originalArchive(pin, archive) : archive;
				active();
				const prepared = preparePinnedPackage(source, pin.package);
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
				const source = native ? await originalArchive(pin, archive) : archive;
				active();
				const prepared = preparePinnedPackage(source, pin.package);
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
			if (native) native.lifetime.closed = true;
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
