import {
	type ApiDependency,
	type ApiVersion,
	apiDependency,
	apiVersion,
	type IndexVersion,
	indexVersion,
	publicationFromLiteral,
} from "./release-c2.ts";
import {
	C2_CRATES,
	type C2Name,
	copyData,
	features,
	list,
	name,
	object,
	record,
	refuse,
	unique,
	version,
} from "./release-c2-data.ts";
import { type JsonNumberSources, parseStrictJsonWithNumberSources } from "./strict-json.ts";

const limits = {
	maxBytes: 8 * 1024 * 1024,
	maxDepth: 64,
	maxNodes: 1_000_000,
	maxStringBytes: 65_536,
};
function decode(bytes: Uint8Array): JsonNumberSources {
	try {
		return parseStrictJsonWithNumberSources(bytes, limits);
	} catch {
		return refuse();
	}
}
function identity(crate: C2Name): void {
	if (!C2_CRATES.some(([n]) => n === crate)) refuse();
}
function noPagination(row: Record<string, unknown>): void {
	if (
		["meta", "pagination", "next_page", "next", "total", "truncated", "has_more"].some((key) =>
			Object.hasOwn(row, key),
		)
	)
		refuse();
}
function allowed(row: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(row).some((key) => !keys.includes(key))) refuse();
}
/** Selected technical fields only. Ignored metadata is neither returned nor interpreted. */
export function parseC2Api(
	bytes: Uint8Array,
	crate: C2Name,
): readonly Omit<ApiVersion, "dependencies">[] {
	identity(crate);
	const root = record(decode(bytes).value);
	noPagination(root);
	allowed(root, ["crate", "versions", "keywords", "categories"]);
	const c = record(root.crate);
	if (c.id !== crate || c.name !== crate) refuse();
	const rows = unique(
		list(root.versions, 4096).map((raw) => {
			const r = record(raw);
			if (r.crate !== crate) refuse();
			const normalized = apiVersion(
				copyData({
					version: r.num,
					publication: publicationFromLiteral(r.created_at),
					license: r.license,
					checksum: r.checksum,
					yanked: r.yanked,
					features: r.features,
					dependencies: [],
				}),
			);
			const { dependencies: _dependencies, ...selected } = normalized;
			return Object.freeze(selected);
		}),
		(r) => r.version,
	);
	if (!rows.length) refuse();
	return Object.freeze(rows);
}

/** Row ids use the original JSON integer token, never a rounded parsed approximation. */
export function parseC2Dependencies(
	bytes: Uint8Array,
	crate: C2Name,
	release: string,
): readonly ApiDependency[] {
	identity(crate);
	version(release);
	const parsed = decode(bytes),
		root = object(parsed.value, ["dependencies"]);
	const rows = list(root.dependencies, 4096)
		.map((raw) => {
			const r = record(raw);
			allowed(r, [
				"id",
				"version_id",
				"crate_id",
				"req",
				"optional",
				"default_features",
				"features",
				"target",
				"kind",
				"downloads",
			]);
			const lexeme = parsed.numberSource(r, "id");
			if (!lexeme || !/^[1-9][0-9]*$/.test(lexeme) || BigInt(lexeme) > 9007199254740991n) refuse();
			if (r.id !== Number(lexeme)) refuse();
			// The fixed parent resource supplies the crate/version join. version_id is not a surrogate.
			const result = apiDependency(
				copyData({
					rowId: r.id,
					name: r.crate_id,
					requirement: r.req,
					kind: r.kind,
					target: r.target,
					optional: r.optional,
					defaultFeatures: r.default_features,
					features: r.features,
					rename: { state: "not-supplied-by-this-api-method" },
					registry: { state: "not-supplied-by-this-api-method" },
				}),
			);
			return result;
		})
		.sort((a, b) => a.rowId - b.rowId);
	if (new Set(rows.map((r) => r.rowId)).size !== rows.length) refuse();
	// Validate the exact fixed resource version even for an empty dependency list.
	return Object.freeze(rows);
}
function rawState(r: Record<string, unknown>, key: string): unknown {
	if (!Object.hasOwn(r, key)) return { state: "absent" };
	return r[key] === null ? { state: "null" } : { state: "value", value: r[key] };
}
export function parseC2Index(bytes: Uint8Array, crate: C2Name): readonly IndexVersion[] {
	identity(crate);
	if (bytes.byteLength > limits.maxBytes) refuse();
	let source: string;
	try {
		source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return refuse();
	}
	const lines = source.split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (!lines.length || lines.length > 4096 || lines.some((line) => line.trim().length === 0))
		refuse();
	const rows = unique(
		lines.map((line) => {
			const r = record(decode(new TextEncoder().encode(line)).value);
			allowed(r, [
				"name",
				"vers",
				"deps",
				"cksum",
				"features",
				"yanked",
				"links",
				"v",
				"features2",
				"pubtime",
			]);
			if (
				r.name !== crate ||
				(Object.hasOwn(r, "v") && r.v !== 1 && r.v !== 2) ||
				(Object.hasOwn(r, "features2") && r.v !== 2)
			)
				refuse();
			const first = features(r.features),
				hasExtra = Object.hasOwn(r, "features2"),
				extra = hasExtra ? features(r.features2) : Object.create(null);
			if (Object.keys(extra).some((key) => Object.hasOwn(first, key))) refuse();
			const dependencies = list(r.deps, 4096).map((raw) => {
				const d = record(raw);
				allowed(d, [
					"name",
					"req",
					"features",
					"optional",
					"default_features",
					"target",
					"kind",
					"registry",
					"package",
				]);
				name(d.name);
				return {
					name: d.name,
					package: rawState(d, "package"),
					registry: rawState(d, "registry"),
					requirement: d.req,
					kind: d.kind,
					target: d.target,
					optional: d.optional,
					defaultFeatures: d.default_features,
					features: d.features,
				};
			});
			return indexVersion(
				copyData({
					version: r.vers,
					publication: publicationFromLiteral(r.pubtime),
					checksum: r.cksum,
					yanked: r.yanked,
					features: { ...first, ...extra },
					featureEncoding: {
						features: first,
						features2: hasExtra ? { state: "value", value: extra } : { state: "absent" },
					},
					dependencies,
				}),
			);
		}),
		(r) => r.version,
	);
	return Object.freeze(rows);
}
