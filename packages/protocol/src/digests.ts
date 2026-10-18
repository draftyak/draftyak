import { jcsSha256 } from "./hash.ts";
import { manifestJson, surfaceJson } from "./manifest/json.ts";

// Hash the exact declared JSON, without adding defaults, stripping members or sorting arrays.
export const manifestDigest = (manifest: unknown): string => jcsSha256(manifestJson(manifest));
export const egressDigest = (egress: unknown): string => jcsSha256(manifestJson(egress));
export const sendTemplateDigest = (send: unknown): string => jcsSha256(manifestJson(send));
export const toolKindsDigest = (kinds: unknown): string => jcsSha256(manifestJson(kinds));
export const surfaceDigest = (capabilities: unknown, tools: unknown): string =>
	jcsSha256(surfaceJson({ capabilities, tools }));
