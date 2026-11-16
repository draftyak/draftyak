import { aiProviderV1 } from "@draftyak/protocol/ai-provider-v1";
import { channelV1 } from "@draftyak/protocol/channel-v1";
import { surfaceDigest } from "@draftyak/protocol/digests";
import { checkPluginSurface, type SurfaceProblemCode } from "@draftyak/protocol/extension";
import { type Json, surfaceJson } from "@draftyak/protocol/manifest/json";

export type RetainedPluginKind = "channel" | "ai-provider";
export type DiscoveryProblemCode = SurfaceProblemCode | "PLUGIN_KIND_UNAVAILABLE";
export type DiscoveryResult =
	| { readonly ok: true; readonly kind: RetainedPluginKind; readonly digest: string }
	| { readonly ok: false; readonly problems: readonly DiscoveryProblemCode[] };

const refused = (...problems: DiscoveryProblemCode[]): DiscoveryResult =>
	Object.freeze({ ok: false, problems: Object.freeze([...new Set(problems)]) });

/** Validate one complete inert discovery exchange; a digest confers no activation authority. */
export function validateDiscovery(
	kind: unknown,
	discover: unknown,
	toolsList: unknown,
): DiscoveryResult {
	if (kind !== "channel" && kind !== "ai-provider") return refused("PLUGIN_KIND_UNAVAILABLE");
	try {
		// Copy both messages before any property read. The protocol's bounded copier
		// rejects proxies, accessors, cycles and non-JSON values without invoking their hooks.
		const discovered = surfaceJson(discover);
		const listed = surfaceJson(toolsList);
		const problems = checkPluginSurface(
			discovered,
			listed,
			kind === "channel" ? channelV1 : aiProviderV1,
		);
		if (problems.length > 0) return refused(...problems.map(({ code }) => code));
		const capabilities = (discovered as Record<string, Json>).capabilities;
		const tools = (listed as Record<string, Json>).tools;
		return Object.freeze({ ok: true, kind, digest: surfaceDigest(capabilities, tools) });
	} catch {
		return refused("SURFACE_MALFORMED");
	}
}

export type SurfaceComparison =
	| { readonly ok: true; readonly status: "pin" | "match"; readonly digest: string }
	| { readonly ok: false; readonly code: "SURFACE_PIN_INVALID" | "SURFACE_DRIFT" };

const isDigest = (value: unknown): value is string =>
	typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/.test(value);

/** Describe the required pin operation; callers must persist it under their generation fence. */
export function compareSurface(pinned: unknown, digest: unknown): SurfaceComparison {
	if (!isDigest(digest) || (pinned !== null && !isDigest(pinned))) {
		return Object.freeze({ ok: false, code: "SURFACE_PIN_INVALID" });
	}
	if (pinned !== null && pinned !== digest) {
		return Object.freeze({ ok: false, code: "SURFACE_DRIFT" });
	}
	return Object.freeze({ ok: true, status: pinned === null ? "pin" : "match", digest });
}
