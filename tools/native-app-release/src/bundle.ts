import { types } from "node:util";
import type { NativeAppReleaseBuilder } from "./builder.ts";
import { type NativeAppReleaseManifest, releaseDescriptor } from "./manifest.ts";
import { refuse } from "./paths.ts";

function member(raw: unknown, key: string): unknown {
	if (
		!raw ||
		typeof raw !== "object" ||
		types.isProxy(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		refuse("manifest");
	const slot = Object.getOwnPropertyDescriptor(raw, key);
	if (!slot?.enumerable || !("value" in slot)) refuse("manifest");
	return slot.value;
}

/** Build release DATA from bundle.json and separately supplied package/archive tuples.
 * The caller retains the builder, including responsibility for retrying close on failure.
 */
export async function buildNativeAppReleaseFromBundle(
	builder: NativeAppReleaseBuilder,
	metadata: unknown,
	bundles: unknown,
): Promise<NativeAppReleaseManifest> {
	if (member(metadata, "schemaVersion") !== 1) refuse("manifest");
	const target = member(metadata, "target");
	const platform = member(target, "platform");
	if (platform !== "win" && platform !== "darwin" && platform !== "linux") refuse("manifest");
	const executable = member(member(metadata, "node"), "binary");
	if (executable !== (platform === "win" ? "node.exe" : "node")) refuse("manifest");
	const entry = member(member(metadata, "hub"), "entry");
	if (entry !== "hub/hub.mjs") refuse("manifest");
	const descriptor = releaseDescriptor({
		version: member(metadata, "version"),
		platform: platform === "win" ? "win32" : platform,
		arch: member(target, "arch"),
		executable,
		entry,
		bundles,
	});
	return builder.build(descriptor);
}
