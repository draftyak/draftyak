import { isBuiltin } from "node:module";
import { isProxy } from "node:util/types";

export const CLI_BUILD_INPUTS_FILE = "cli-build-inputs.json";

export interface BuildComponent {
	readonly id: string;
	readonly name: string;
	readonly kind: "workspace" | "dependency";
	readonly manifestSha256: string;
	readonly version?: string;
	readonly declaredLicense?: string;
}
export interface BuildSource {
	readonly id: string;
	readonly component: string;
	readonly path: string;
	readonly sha256: string;
	readonly size: number;
	readonly imports: readonly (
		| { readonly specifier: string; readonly source: string }
		| { readonly specifier: string; readonly builtin: string }
	)[];
}
export interface BuildCompilerHelper {
	readonly name: "rolldown/runtime.js";
	readonly compilerName: "rolldown";
	readonly compilerVersion: "1.2.14";
	readonly compilerManifestSha256: string;
}
export interface BuildChunk {
	readonly path: string;
	readonly sha256: string;
	readonly size: number;
	readonly sources: readonly string[];
	readonly compilerHelpers: readonly BuildCompilerHelper[];
}
export interface CapturedBuildInputs {
	readonly lockfileSha256: string;
	readonly components: readonly BuildComponent[];
	readonly sources: readonly BuildSource[];
	readonly chunks: readonly BuildChunk[];
}
export interface BuildProvenance extends CapturedBuildInputs {
	readonly v: 1;
	readonly scope: "cli-bundler";
	readonly excludedGenerated: readonly string[];
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_COMPONENTS = 65;
const MAX_SOURCES = 1024;
const MAX_CHUNKS = 1024;
// Even the shortest serialized import record exceeds 32 bytes.
const MAX_IMPORTS = MAX_FILE_BYTES / 32;
const EXCLUDED_GENERATED = [
	"catalog.js",
	CLI_BUILD_INPUTS_FILE,
	"main.mjs",
	"main.d.mts",
	"payload-contract.mjs",
	"payload-contract.d.mts",
	"package.json",
] as const;
const HEX = /^[0-9a-f]{64}$/;

function hasControl(value: string): boolean {
	for (let at = 0; at < value.length; at++) {
		const code = value.charCodeAt(at);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029)
			return true;
	}
	return false;
}

function refuse(): never {
	throw new Error("CLI build provenance refused.");
}
function object(
	raw: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw) || Array.isArray(raw)) refuse();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== null && prototype !== Object.prototype) refuse();
	const fields: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(raw)) {
		if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) refuse();
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) refuse();
		fields[key] = descriptor.value;
	}
	if (required.some((key) => !Object.hasOwn(fields, key))) refuse();
	return fields;
}
function array(raw: unknown, maximum: number, minimum = 0): unknown[] {
	if (isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
		refuse();
	const length: unknown = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < minimum ||
		length > maximum
	)
		refuse();
	if (Reflect.ownKeys(raw).length !== length + 1) refuse();
	const result: unknown[] = [];
	for (let at = 0; at < length; at++) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, String(at));
		if (!descriptor?.enumerable || !("value" in descriptor)) refuse();
		result.push(descriptor.value);
	}
	return result;
}
function size(raw: unknown): number {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_FILE_BYTES)
		refuse();
	return raw;
}
function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Encode captured build DATA; admission and capture remain the build resolver's responsibility. */
export function createBuildProvenance(input: CapturedBuildInputs): BuildProvenance {
	let stringBytes = 0;
	const text = (raw: unknown, maximum: number): string => {
		if (
			typeof raw !== "string" ||
			raw.length === 0 ||
			raw.length > maximum ||
			!raw.isWellFormed() ||
			hasControl(raw)
		)
			refuse();
		const encoded = JSON.stringify(raw);
		if (encoded === undefined) refuse();
		stringBytes += Buffer.byteLength(encoded);
		if (stringBytes > MAX_FILE_BYTES) refuse();
		return raw;
	};
	const hash = (raw: unknown): string => {
		const value = text(raw, 64);
		if (!HEX.test(value)) refuse();
		return value;
	};
	const relative = (raw: unknown): string => {
		const value = text(raw, 4096);
		if (
			value.startsWith("/") ||
			value.includes("\\") ||
			value.includes(":") ||
			value.split("/").some((part) => part === "" || part === "." || part === "..")
		)
			refuse();
		return value;
	};
	const specifier = (raw: unknown): string => {
		const value = text(raw, 4096);
		if (value.startsWith("/") || value.includes("\\") || (value.includes(":") && !isBuiltin(value)))
			refuse();
		return value;
	};
	const root = object(input, ["lockfileSha256", "components", "sources", "chunks"]);
	const lockfileSha256 = hash(root.lockfileSha256);
	const componentIds = new Set<string>();
	const components = array(root.components, MAX_COMPONENTS, 1).map((raw): BuildComponent => {
		const fields = object(
			raw,
			["id", "name", "kind", "manifestSha256"],
			["version", "declaredLicense"],
		);
		const id = hash(fields.id);
		if (componentIds.has(id)) refuse();
		componentIds.add(id);
		const name = text(fields.name, 214);
		if (!/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) refuse();
		const kind = fields.kind;
		if (kind !== "workspace" && kind !== "dependency") refuse();
		const manifestSha256 = hash(fields.manifestSha256);
		const version = fields.version === undefined ? undefined : text(fields.version, 128);
		if (version !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(version)) refuse();
		const declaredLicense =
			fields.declaredLicense === undefined ? undefined : text(fields.declaredLicense, 256);
		if (declaredLicense !== undefined && !/^[A-Za-z0-9(][A-Za-z0-9 .+()_-]*$/.test(declaredLicense))
			refuse();
		return {
			id,
			name,
			kind,
			manifestSha256,
			...(version === undefined ? {} : { version }),
			...(declaredLicense === undefined ? {} : { declaredLicense }),
		};
	});
	const sourceIds = new Set<string>();
	const sourcePaths = new Map<string, Set<string>>();
	let sourceBytes = 0;
	const sources = array(root.sources, MAX_SOURCES, 1).map((raw): BuildSource => {
		const fields = object(raw, ["id", "component", "path", "sha256", "size", "imports"]);
		const id = hash(fields.id);
		const component = hash(fields.component);
		const path = relative(fields.path);
		if (sourceIds.has(id) || !componentIds.has(component)) refuse();
		const paths = sourcePaths.get(component) ?? new Set<string>();
		if (paths.has(path)) refuse();
		paths.add(path);
		sourcePaths.set(component, paths);
		sourceIds.add(id);
		const sha256 = hash(fields.sha256);
		const bytes = size(fields.size);
		sourceBytes += bytes;
		if (sourceBytes > MAX_SOURCE_BYTES) refuse();
		const labels = new Set<string>();
		const imports = array(fields.imports, MAX_IMPORTS).map((raw) => {
			const edge = object(raw, ["specifier"], ["source", "builtin"]);
			const label = specifier(edge.specifier);
			if (labels.has(label) || Object.hasOwn(edge, "source") === Object.hasOwn(edge, "builtin"))
				refuse();
			labels.add(label);
			if (Object.hasOwn(edge, "source")) {
				if (isBuiltin(label)) refuse();
				return { specifier: label, source: hash(edge.source) };
			}
			const builtin = text(edge.builtin, 128);
			if (builtin !== label || !isBuiltin(builtin)) refuse();
			return { specifier: label, builtin };
		});
		imports.sort((left, right) => compare(left.specifier, right.specifier));
		return { id, component, path, sha256, size: bytes, imports };
	});
	for (const source of sources)
		for (const edge of source.imports)
			if ("source" in edge && !sourceIds.has(edge.source)) refuse();
	const chunkPaths = new Set<string>();
	const chunks = array(root.chunks, MAX_CHUNKS, 1).map((raw): BuildChunk => {
		const fields = object(raw, ["path", "sha256", "size", "sources", "compilerHelpers"]);
		const path = relative(fields.path);
		if (chunkPaths.has(path) || EXCLUDED_GENERATED.some((excluded) => path === excluded)) refuse();
		chunkPaths.add(path);
		const sha256 = hash(fields.sha256);
		const bytes = size(fields.size);
		const members = new Set<string>();
		const ids = array(fields.sources, MAX_SOURCES).map((raw) => {
			const id = hash(raw);
			if (!sourceIds.has(id) || members.has(id)) refuse();
			members.add(id);
			return id;
		});
		ids.sort(compare);
		const compilerHelpers = array(fields.compilerHelpers, 1).map((raw): BuildCompilerHelper => {
			const helper = object(raw, [
				"name",
				"compilerName",
				"compilerVersion",
				"compilerManifestSha256",
			]);
			if (
				helper.name !== "rolldown/runtime.js" ||
				helper.compilerName !== "rolldown" ||
				helper.compilerVersion !== "1.2.14"
			)
				refuse();
			return {
				name: "rolldown/runtime.js",
				compilerName: "rolldown",
				compilerVersion: "1.2.14",
				compilerManifestSha256: hash(helper.compilerManifestSha256),
			};
		});
		return { path, sha256, size: bytes, sources: ids, compilerHelpers };
	});
	components.sort((left, right) => compare(left.id, right.id));
	sources.sort((left, right) => compare(left.id, right.id));
	chunks.sort((left, right) => compare(left.path, right.path));
	const result: BuildProvenance = {
		v: 1,
		scope: "cli-bundler",
		lockfileSha256,
		components,
		sources,
		chunks,
		excludedGenerated: [...EXCLUDED_GENERATED],
	};
	if (Buffer.byteLength(`${JSON.stringify(result)}\n`) > MAX_FILE_BYTES) refuse();
	return result;
}

export function serializeBuildProvenance(input: CapturedBuildInputs): string {
	return `${JSON.stringify(createBuildProvenance(input))}\n`;
}
