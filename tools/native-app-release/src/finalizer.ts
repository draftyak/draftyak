import type { KeyObject } from "node:crypto";
import { NativeAppReleaseBuilder } from "./builder.ts";
import type { NativeAppReleaseManifest } from "./manifest.ts";
import { NativeAppReleaseError } from "./paths.ts";

const finalize = NativeAppReleaseBuilder.prototype.finalizeFromBundle;

/** Finalize one explicit offline candidate; this does not publish or install it.
 * A failed commit retains partial metadata and reports cleanup rather than deleting a possible replacement.
 * The caller keeps the genuine Builder and must close it, retaining it for retry if close fails.
 * Closing settles handles; it does not remove retained candidate files.
 */
export async function finalizeNativeAppReleaseFromBundle(
	builder: NativeAppReleaseBuilder,
	metadata: unknown,
	bundles: unknown,
	privateKey: KeyObject,
): Promise<NativeAppReleaseManifest> {
	try {
		return await Reflect.apply(finalize, builder, [metadata, bundles, privateKey]);
	} catch (error) {
		if (error instanceof NativeAppReleaseError) throw error;
		throw new NativeAppReleaseError("state");
	}
}
