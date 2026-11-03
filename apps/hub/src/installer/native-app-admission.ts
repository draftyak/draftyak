import { createPublicKey } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { portableRelativePath } from "@draftyak/bounded-files";
import { preparePinnedPackage } from "../artifacts/index.ts";
import {
	assertNativePluginOwner,
	type NativePluginSessionParts,
	nativePluginInputs,
} from "../lifecycle/native-session-context.ts";
import type { BundledPluginPin } from "../plugins/installer/index.ts";
import { type BundledPluginId, declaration } from "../plugins/installer/policy.ts";
import { createNativeAppFiles, type NativeAppFiles } from "./native-app-files.ts";
import { type NativeAppRelease, verifyNativeAppRelease } from "./native-app-release.ts";
import { type NativeAppReleaseTrust, nativeAppReleaseTrust } from "./native-app-trust.ts";

/** An original native application capture. Its shape alone confers no authority. */
export interface NativeAppAdmission {
	close(): Promise<void>;
}

/** Authenticated content for the private activation consumer; it grants no account or run rights. */
export interface NativeAppAdmissionInputs {
	readonly version: string;
	readonly bundles: readonly BundledPluginPin[];
}

interface Capture {
	readonly owner: object;
	readonly parts: NativePluginSessionParts;
	readonly handle: NativeAppAdmission;
	closing: boolean;
	closed: boolean;
	files?: NativeAppFiles;
	release?: NativeAppRelease;
	inputs?: NativeAppAdmissionInputs;
	opening?: Promise<NativeAppAdmission>;
	closingAttempt?: Promise<void>;
}

// Capture the original host before any session-specific asynchronous allocation.
const host = Object.freeze({
	executable: process.execPath,
	entry: process.argv[1],
	module: fileURLToPath(import.meta.url),
	platform: process.platform,
	arch: process.arch,
	preloaded:
		process.execArgv.length !== 1 ||
		process.execArgv[0] !== "--disable-sigusr1" ||
		Boolean(process.env.NODE_OPTIONS) ||
		Boolean(process.env.NODE_PATH),
});
const fixedTrust =
	nativeAppReleaseTrust === undefined
		? undefined
		: Object.freeze({
				version: nativeAppReleaseTrust.version,
				publicKeyDer: nativeAppReleaseTrust.publicKeyDer,
				executable: nativeAppReleaseTrust.executable,
				entry: nativeAppReleaseTrust.entry,
				module: nativeAppReleaseTrust.module,
			});
const sessions = new WeakMap<object, Capture>();
const captures = new WeakMap<object, Capture>();
const limits = Object.freeze({
	maximumLength: 512,
	maximumComponents: 32,
	maximumComponentLength: 128,
});

function refuse(): never {
	throw new Error("Native application admission unavailable.");
}

function live(capture: Capture): void {
	if (capture.closing || capture.closed) refuse();
	assertNativePluginOwner(capture.owner, capture.parts);
}

function relative(name: string): string {
	return portableRelativePath(name, limits);
}

function installedRoot(trust: NativeAppReleaseTrust): string {
	if (host.preloaded || !host.entry || !path.isAbsolute(host.executable)) refuse();
	const executable = relative(trust.executable);
	let root = host.executable;
	for (const _component of executable.split("/")) root = path.dirname(root);
	if (
		path.join(root, ...executable.split("/")) !== host.executable ||
		path.join(root, ...relative(trust.entry).split("/")) !== host.entry ||
		path.join(root, ...relative(trust.module).split("/")) !== host.module
	)
		refuse();
	return root;
}

function releaseMatchesHost(release: NativeAppRelease, trust: NativeAppReleaseTrust): void {
	if (
		release.version !== trust.version ||
		release.platform !== host.platform ||
		release.arch !== host.arch ||
		release.executable !== trust.executable ||
		release.entry !== trust.entry ||
		!release.files.some((file) => file.path === trust.module)
	)
		refuse();
}

async function captureInstalledRelease(capture: Capture): Promise<NativeAppAdmission> {
	try {
		live(capture);
		const trust = fixedTrust;
		if (!trust) refuse();
		const root = installedRoot(trust);
		const keyBytes = Buffer.from(trust.publicKeyDer, "base64");
		if (keyBytes.toString("base64") !== trust.publicKeyDer) refuse();
		const key = createPublicKey({ key: keyBytes, type: "spki", format: "der" });
		live(capture);
		// Retain the resource before the first asynchronous open, including failed captures.
		const files = createNativeAppFiles(root);
		capture.files = files;
		const signed = await files.readRelease();
		live(capture);
		const release = verifyNativeAppRelease(signed.manifest, signed.signature, key);
		releaseMatchesHost(release, trust);
		await files.verify(release);
		live(capture);
		const bundles: BundledPluginPin[] = [];
		for (const bundle of release.bundles) {
			const archive = await files.archive(bundle.archive);
			live(capture);
			const prepared = preparePinnedPackage(archive, bundle.package);
			declaration(prepared, bundle.id);
			bundles.push(Object.freeze({ id: bundle.id, package: bundle.package }));
		}
		await files.verify(release);
		live(capture);
		capture.release = release;
		capture.inputs = Object.freeze({
			version: release.version,
			bundles: Object.freeze(bundles),
		});
		return capture.handle;
	} catch {
		capture.closing = true;
		// The cached capture remains reachable for a later close retry if any handle refuses close.
		try {
			await capture.files?.close();
			capture.closed = true;
		} catch {
			capture.closed = false;
		}
		refuse();
	}
}

/** Fixed host capture only: no caller path, publisher key, pins, proof DTO or verifier callback. */
export function openNativeAppAdmission(originalSession: unknown): Promise<NativeAppAdmission> {
	if (arguments.length !== 1) refuse();
	const parts = nativePluginInputs(originalSession);
	const owner = originalSession as object;
	const existing = sessions.get(owner);
	if (existing) {
		live(existing);
		if (!existing.opening) refuse();
		return existing.opening;
	}
	const handle: NativeAppAdmission = Object.freeze({
		close: () => closeNativeAppAdmission(owner),
	});
	const capture: Capture = { owner, parts, handle, closing: false, closed: false };
	sessions.set(owner, capture);
	captures.set(handle, capture);
	// Publish the pending operation before entering the fallible capture path.
	const opening = Promise.resolve().then(() => captureInstalledRelease(capture));
	capture.opening = opening;
	return opening;
}

/** Revalidate the original captured installation before exposing its authenticated content. */
export async function nativeAppAdmissionInputs(
	admission: unknown,
	originalSession: unknown,
): Promise<NativeAppAdmissionInputs> {
	if (arguments.length !== 2 || admission === null || typeof admission !== "object") refuse();
	const capture = captures.get(admission);
	if (!capture || capture.owner !== originalSession) refuse();
	live(capture);
	if (!capture.files || !capture.release || !capture.inputs) refuse();
	await capture.files.verify(capture.release);
	live(capture);
	return capture.inputs;
}

/** Detached bytes for a fixed signed bundle, after rechecking the same original live capture. */
export async function nativeAppAdmissionArchive(
	admission: unknown,
	originalSession: unknown,
	id: BundledPluginId,
): Promise<Uint8Array> {
	if (arguments.length !== 3 || admission === null || typeof admission !== "object") refuse();
	const capture = captures.get(admission);
	if (!capture || capture.owner !== originalSession) refuse();
	live(capture);
	if (!capture.files || !capture.release || !capture.inputs) refuse();
	const bundle = capture.release.bundles.find((bundle) => bundle.id === id);
	if (!bundle) refuse();
	// The file owner registers this read before opening and joins it during close.
	const archive = await capture.files.archive(bundle.archive);
	live(capture);
	return Buffer.from(archive);
}

/** Fence admission synchronously, join capture and close every retained file; failed closes retry. */
export function closeNativeAppAdmission(originalSession: unknown): Promise<void> {
	if (arguments.length !== 1) refuse();
	if (originalSession === null || typeof originalSession !== "object") refuse();
	const capture = sessions.get(originalSession);
	if (!capture) return Promise.resolve();
	capture.closing = true;
	if (capture.closingAttempt) return capture.closingAttempt;
	if (capture.closed) return Promise.resolve();
	const attempt = Promise.resolve().then(async () => {
		await capture.opening?.catch(() => undefined);
		await capture.files?.close();
		capture.closed = true;
	});
	capture.closingAttempt = attempt;
	void attempt.then(
		() => {
			capture.closingAttempt = undefined;
		},
		() => {
			capture.closingAttempt = undefined;
		},
	);
	return attempt;
}
