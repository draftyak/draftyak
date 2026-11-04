import { createPublicKey } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { portableRelativePath } from "@draftyak/bounded-files";
import { parseStrict } from "@draftyak/protocol/jcs";
import { preparePinnedPackage } from "../artifacts/index.ts";
import {
	assertNativePluginOwner,
	type NativePluginSessionParts,
	nativePluginInputs,
} from "../lifecycle/native-session-context.ts";
import type { BundledPluginPin } from "../plugins/installer/index.ts";
import {
	type NativeReleaseV2,
	type NativeReleaseV2Bundle,
	verifyNativeReleaseV2,
} from "../plugins/installer/native-release-v2.ts";
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

/** Authenticated descriptor DATA only; this is not accepted review or an execution grant. */
export interface NativeAppAdmissionBundleFacts extends BundledPluginPin {
	readonly expectedSurfaceDigest: string;
}

/** V2 facts from the same original capture, without native paths or caller-selected archives. */
export interface NativeAppAdmissionReviewInputs {
	readonly version: string;
	readonly bundles: readonly NativeAppAdmissionBundleFacts[];
	readonly candidates: readonly NativeAppAdmissionBundleFacts[];
}

type CapturedRelease = NativeAppRelease | NativeReleaseV2;

interface Capture {
	readonly owner: object;
	readonly parts: NativePluginSessionParts;
	readonly handle: NativeAppAdmission;
	closing: boolean;
	closed: boolean;
	files?: NativeAppFiles;
	release?: CapturedRelease;
	inputs?: NativeAppAdmissionInputs;
	reviewInputs?: NativeAppAdmissionReviewInputs;
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

function releaseVersion(manifest: Uint8Array): 1 | 2 {
	const parsed: unknown = parseStrict(manifest);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) refuse();
	const version = Object.getOwnPropertyDescriptor(parsed, "v");
	if (!version || !("value" in version) || (version.value !== 1 && version.value !== 2)) refuse();
	return version.value;
}

function bundleFacts(bundle: NativeReleaseV2Bundle): NativeAppAdmissionBundleFacts {
	return Object.freeze({
		id: bundle.id,
		package: bundle.package,
		expectedSurfaceDigest: bundle.expectedSurfaceDigest,
	});
}

function releaseMatchesHost(release: CapturedRelease, trust: NativeAppReleaseTrust): void {
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
		// Dispatch only by the explicit tag; neither signed grammar falls back to the other.
		const release =
			releaseVersion(signed.manifest) === 1
				? verifyNativeAppRelease(signed.manifest, signed.signature, key)
				: verifyNativeReleaseV2(signed.manifest, signed.signature, key);
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
		if (release.v === 2)
			capture.reviewInputs = Object.freeze({
				version: release.version,
				bundles: Object.freeze(release.bundles.map(bundleFacts)),
				candidates: Object.freeze(release.candidates.map(bundleFacts)),
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

/** Undefined denotes unconfigured legacy DATA only; it is never native review provenance. */
export async function nativeAppAdmissionFormat(
	originalSession: unknown,
): Promise<1 | 2 | undefined> {
	try {
		if (arguments.length !== 1) refuse();
		const parts = nativePluginInputs(originalSession);
		const existing = sessions.get(originalSession as object);
		if (fixedTrust === undefined && existing === undefined) {
			assertNativePluginOwner(originalSession, parts);
			return undefined;
		}
		// An existing failed, closing or retained capture never downgrades to legacy DATA.
		const admission = await openNativeAppAdmission(originalSession);
		const capture = captures.get(admission);
		if (!capture || capture.owner !== originalSession || capture.parts !== parts) refuse();
		live(capture);
		if (!capture.files || !capture.release) refuse();
		await capture.files.verify(capture.release);
		live(capture);
		return capture.release.v;
	} catch {
		refuse();
	}
}

/** Synchronous retained v2 origin/lifetime only; fresh App file verification remains asynchronous. */
export function assertNativeAppAdmissionCurrent(
	admission: unknown,
	originalSession: unknown,
): void {
	try {
		if (arguments.length !== 2 || admission === null || typeof admission !== "object") refuse();
		const capture = captures.get(admission);
		if (
			!capture ||
			capture.owner !== originalSession ||
			capture.handle !== admission ||
			sessions.get(capture.owner) !== capture
		)
			refuse();
		const files = capture.files;
		const release = capture.release;
		const facts = capture.reviewInputs;
		const parts = capture.parts;
		if (!files || !release || release.v !== 2 || !capture.inputs || !facts) refuse();
		live(capture);
		files.assertAvailable();
		if (
			captures.get(admission) !== capture ||
			sessions.get(capture.owner) !== capture ||
			capture.owner !== originalSession ||
			capture.handle !== admission ||
			capture.parts !== parts ||
			capture.closing ||
			capture.closed ||
			capture.files !== files ||
			capture.release !== release ||
			capture.reviewInputs !== facts
		)
			refuse();
	} catch {
		refuse();
	}
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

/** Revalidated v2 DATA only; v1 never supplies an invented expected surface digest. */
export async function nativeAppAdmissionReviewInputs(
	admission: unknown,
	originalSession: unknown,
): Promise<NativeAppAdmissionReviewInputs> {
	if (arguments.length !== 2 || admission === null || typeof admission !== "object") refuse();
	const capture = captures.get(admission);
	if (!capture || capture.owner !== originalSession) refuse();
	live(capture);
	if (!capture.files || !capture.release || capture.release.v !== 2 || !capture.reviewInputs)
		refuse();
	await capture.files.verify(capture.release);
	live(capture);
	return capture.reviewInputs;
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

/** Exact signed candidate selection only; the returned bytes grant no installation or review. */
export async function nativeAppAdmissionCandidateArchive(
	admission: unknown,
	originalSession: unknown,
	id: BundledPluginId,
	version: string,
): Promise<Uint8Array> {
	if (
		arguments.length !== 4 ||
		admission === null ||
		typeof admission !== "object" ||
		typeof version !== "string"
	)
		refuse();
	const capture = captures.get(admission);
	if (!capture || capture.owner !== originalSession) refuse();
	live(capture);
	if (!capture.files || !capture.release || capture.release.v !== 2 || !capture.reviewInputs)
		refuse();
	const candidate = capture.release.candidates.find(
		(bundle) => bundle.id === id && bundle.package.version === version,
	);
	if (!candidate) refuse();
	const archive = await capture.files.archive(candidate.archive);
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
