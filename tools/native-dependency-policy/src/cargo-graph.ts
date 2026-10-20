import { createHash } from "node:crypto";
import { InputError } from "./strict-json.ts";

export interface CargoTargetPath {
	readonly name: string;
	readonly kinds: readonly string[];
	readonly sourcePath: string;
	readonly relativePath: string;
}
export interface CargoPackagePaths {
	readonly id: string;
	readonly manifestPath: string;
	readonly targets: readonly CargoTargetPath[];
}
/** Produced by the runner after realpath containment and expected-root checks. */
export interface ValidatedCargoPaths {
	readonly workspacePackages: readonly CargoPackagePaths[];
	readonly rootIds: readonly string[];
}
export interface AffectedPackage {
	readonly source: string;
	readonly name: string;
	readonly version: string;
}
export type ProjectionTuple = readonly (string | number | boolean | null | ProjectionTuple)[];
export interface CargoGraphProjection {
	readonly version: 1;
	readonly digest: string;
	readonly packageCount: number;
	readonly tuplePayload: ProjectionTuple;
	readonly ancestorDigests: readonly {
		readonly target: AffectedPackage;
		readonly digest: string;
		readonly packageCount: number;
		readonly tuplePayload: ProjectionTuple;
	}[];
}

const graphDomain = "draftyak/native-dependency-policy/graph/v1\0";
const ancestorDomain = "draftyak/native-dependency-policy/ancestor/v1\0";
const packageKeys =
	"authors categories default_run dependencies description documentation edition features homepage id keywords license license_file links manifest_path metadata name publish readme repository rust_version source targets version";
const topKeys =
	"build_directory metadata packages resolve target_directory version workspace_default_members workspace_members workspace_root";

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InputError();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) throw new InputError();
	const result: Record<string, unknown> = Object.create(null);
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if (!Object.hasOwn(descriptor, "value")) throw new InputError();
		result[scalar(key)] = descriptor.value;
	}
	if (Object.getOwnPropertySymbols(value).length) throw new InputError();
	return result;
}

function object(value: unknown, keys: string): Record<string, unknown> {
	const result = record(value);
	const allowed = new Set(keys.split(" "));
	if (Object.keys(result).some((key) => !allowed.has(key))) throw new InputError();
	return result;
}

function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new InputError();
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0)
		throw new InputError();
	if (Object.getOwnPropertySymbols(value).length) throw new InputError();
	for (const key of Object.keys(descriptors)) {
		if (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))
			throw new InputError();
	}
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = descriptors[String(index)];
		if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new InputError();
		result.push(descriptor.value);
	}
	return result;
}

function scalar(value: unknown, empty = false): string {
	if (typeof value !== "string" || (!empty && value.length === 0)) throw new InputError();
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const low = value.charCodeAt(++index);
			if (!Number.isFinite(low) || low < 0xdc00 || low > 0xdfff) throw new InputError();
		} else if (code >= 0xdc00 && code <= 0xdfff) throw new InputError();
	}
	return value;
}

const nullable = (value: unknown): string | null => (value === null ? null : scalar(value));
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const encoded = (row: ProjectionTuple): string => JSON.stringify(row);
const sortRows = (rows: ProjectionTuple[]): ProjectionTuple[] =>
	rows.sort((a, b) => compare(encoded(a), encoded(b)));

function strings(value: unknown, unique = true): string[] {
	const values = array(value).map((entry) => scalar(entry));
	if (unique && new Set(values).size !== values.length) throw new InputError();
	return values.sort(compare);
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw new InputError();
	return value;
}

function kind(value: unknown): string {
	if (value === null) return "normal";
	if (value === "build" || value === "dev") return value;
	throw new InputError();
}

function uniqueRows(rows: ProjectionTuple[]): ProjectionTuple[] {
	if (new Set(rows.map(encoded)).size !== rows.length) throw new InputError();
	return sortRows(rows);
}

function digest(domain: string, tuple: ProjectionTuple): string {
	return createHash("sha256").update(domain).update(encoded(tuple), "utf8").digest("hex");
}

interface Package {
	id: string;
	identity: ProjectionTuple;
	data: Record<string, unknown>;
	row?: ProjectionTuple;
}

function project(
	value: unknown,
	paths: ValidatedCargoPaths,
	affected: readonly AffectedPackage[],
): CargoGraphProjection {
	const input = object(value, topKeys);
	if (input.version !== 1) throw new InputError();
	const bindings = object(paths, "workspacePackages rootIds");
	const aliases = new Map<string, string>();
	const relative = (value: unknown): string => {
		const text = scalar(value);
		// Repository-owned paths use this portable ASCII vocabulary, with exact casing retained.
		if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(text)) throw new InputError();
		if (text.split("/").some((segment) => segment === "." || segment === "..")) {
			throw new InputError();
		}
		const prior = aliases.get(text.toLowerCase());
		if (prior !== undefined && prior !== text) throw new InputError();
		aliases.set(text.toLowerCase(), text);
		return text;
	};
	const bindingById = new Map<string, Record<string, unknown>>();
	const manifests = new Set<string>();
	for (const entry of array(bindings.workspacePackages)) {
		const binding = object(entry, "id manifestPath targets");
		const id = scalar(binding.id);
		const manifest = relative(binding.manifestPath);
		if (bindingById.has(id) || manifests.has(manifest)) throw new InputError();
		manifests.add(manifest);
		bindingById.set(id, binding);
	}
	const packages = new Map<string, Package>();
	const identities = new Set<string>();
	for (const entry of array(input.packages)) {
		const data = object(entry, packageKeys);
		const id = scalar(data.id);
		scalar(data.manifest_path);
		const source = nullable(data.source);
		const binding = bindingById.get(id);
		if ((source === null) !== (binding !== undefined)) throw new InputError();
		const identity: ProjectionTuple = [
			source,
			scalar(data.name),
			scalar(data.version),
			binding ? relative(binding.manifestPath) : null,
		];
		const key = encoded(identity);
		if (packages.has(id) || identities.has(key)) throw new InputError();
		identities.add(key);
		packages.set(id, { id, identity, data });
	}
	if (packages.size === 0) throw new InputError();
	const get = (id: unknown): Package => {
		const found = packages.get(scalar(id));
		if (!found) throw new InputError();
		return found;
	};
	for (const id of bindingById.keys()) get(id);
	const members = strings(input.workspace_members);
	const defaults = strings(input.workspace_default_members);
	const roots = strings(bindings.rootIds);
	if (
		roots.length === 0 ||
		members.length !== bindingById.size ||
		members.some((id) => !bindingById.has(id)) ||
		defaults.some((id) => !members.includes(id)) ||
		roots.some((id) => !members.includes(id))
	) {
		throw new InputError();
	}
	const selection = (ids: string[]): ProjectionTuple[] =>
		sortRows(ids.map((id) => get(id).identity));
	const resolve = object(input.resolve, "nodes root");
	const resolveRoot = resolve.root === null ? null : get(resolve.root).identity;
	const nodes = new Map<string, Record<string, unknown>>();
	for (const entry of array(resolve.nodes)) {
		const node = object(entry, "id dependencies deps features");
		const id = get(node.id).id;
		if (nodes.has(id)) throw new InputError();
		nodes.set(id, node);
	}
	if (nodes.size !== packages.size) throw new InputError();
	const edges: { from: string; to: string; row: ProjectionTuple }[] = [];
	for (const pkg of packages.values()) {
		const node = nodes.get(pkg.id);
		if (!node) throw new InputError();
		const data = pkg.data;
		const binding = bindingById.get(pkg.id);
		const targetBindings = binding
			? array(binding.targets).map((entry) => object(entry, "name kinds sourcePath relativePath"))
			: [];
		const used = new Set<number>();
		const targets = array(data.targets).map((entry): ProjectionTuple => {
			const target = object(
				entry,
				"kind crate_types name src_path edition doc doctest test required-features",
			);
			const name = scalar(target.name);
			const kinds = strings(target.kind);
			const sourcePath = scalar(target.src_path);
			let targetPath: string | null = null;
			if (binding) {
				const matches = targetBindings.flatMap((candidate, index) =>
					scalar(candidate.name) === name &&
					scalar(candidate.sourcePath) === sourcePath &&
					JSON.stringify(strings(candidate.kinds)) === JSON.stringify(kinds)
						? [index]
						: [],
				);
				const index = matches[0];
				if (matches.length !== 1 || index === undefined || used.has(index)) throw new InputError();
				used.add(index);
				targetPath = relative(targetBindings[index]?.relativePath);
			}
			return [
				name,
				kinds,
				strings(target.crate_types),
				targetPath,
				scalar(target.edition),
				Object.hasOwn(target, "required-features") ? strings(target["required-features"]) : [],
				boolean(target.doc),
				boolean(target.doctest),
				boolean(target.test),
			];
		});
		if (targets.length === 0 || used.size !== targetBindings.length) throw new InputError();
		const features = record(data.features);
		const featureRows: ProjectionTuple[] = Object.keys(features).map((name) => [
			scalar(name),
			strings(features[name], false),
		]);
		const declared = array(data.dependencies).map((entry): ProjectionTuple => {
			const dep = object(
				entry,
				"name source req kind rename optional uses_default_features features target registry path",
			);
			let declaredPath: ProjectionTuple | null = null;
			if (Object.hasOwn(dep, "path")) {
				const directory = scalar(dep.path).replaceAll("\\", "/");
				const matches = [...packages.values()].filter(
					(candidate) =>
						candidate.data.source === null &&
						scalar(candidate.data.manifest_path).replaceAll("\\", "/") ===
							`${directory}/Cargo.toml`,
				);
				if (matches.length !== 1 || !matches[0]) throw new InputError();
				declaredPath = matches[0].identity;
			}
			return [
				scalar(dep.name),
				nullable(dep.source),
				scalar(dep.req),
				kind(dep.kind),
				nullable(dep.rename),
				boolean(dep.optional),
				boolean(dep.uses_default_features),
				strings(dep.features, false),
				dep.target === null ? null : scalar(dep.target, true),
				nullable(dep.registry),
				declaredPath,
			];
		});
		const groups = new Set<string>();
		const resolved = array(node.deps).map((entry) => {
			const dep = object(entry, "name pkg dep_kinds");
			const to = get(dep.pkg);
			const group = encoded([to.identity, scalar(dep.name)]);
			if (groups.has(group)) throw new InputError();
			groups.add(group);
			const kinds = array(dep.dep_kinds).map((entry): ProjectionTuple => {
				const item = object(entry, "kind target");
				return [kind(item.kind), item.target === null ? null : scalar(item.target, true)];
			});
			if (kinds.length === 0) throw new InputError();
			const row: ProjectionTuple = [pkg.identity, to.identity, scalar(dep.name), uniqueRows(kinds)];
			edges.push({ from: pkg.id, to: to.id, row });
			return to.id;
		});
		const legacy = strings(node.dependencies);
		if (JSON.stringify(legacy) !== JSON.stringify([...new Set(resolved)].sort(compare))) {
			throw new InputError();
		}
		pkg.row = [
			pkg.identity,
			strings(node.features),
			sortRows(featureRows),
			uniqueRows(targets),
			uniqueRows(declared),
			nullable(data.license),
			scalar(data.edition),
			nullable(data.rust_version),
			nullable(data.links),
			nullable(data.default_run),
		];
	}
	const edgeRows = uniqueRows(edges.map((edge) => edge.row));
	const forward = new Map<string, Set<string>>();
	const reverse = new Map<string, Set<string>>();
	for (const edge of edges) {
		if (!forward.has(edge.from)) forward.set(edge.from, new Set());
		if (!reverse.has(edge.to)) reverse.set(edge.to, new Set());
		forward.get(edge.from)?.add(edge.to);
		reverse.get(edge.to)?.add(edge.from);
	}
	const reachable = new Set(roots);
	const pending = [...roots];
	for (let index = 0; index < pending.length; index++) {
		for (const to of forward.get(pending[index] ?? "") ?? []) {
			if (!reachable.has(to)) {
				reachable.add(to);
				pending.push(to);
			}
		}
	}
	if (reachable.size !== packages.size) throw new InputError();
	const rows = (ids: Set<string>): ProjectionTuple[] =>
		sortRows(
			[...ids].map((id) => {
				const row = get(id).row;
				if (!row) throw new InputError();
				return row;
			}),
		);
	const tuplePayload: ProjectionTuple = [
		"graph",
		1,
		[true, true, selection(roots), selection(members), selection(defaults), resolveRoot],
		rows(new Set(packages.keys())),
		edgeRows,
	];
	const affectedIdentities = new Set<string>();
	const ancestorDigests = array(affected)
		.map((entry) => {
			const target = object(entry, "source name version");
			const parsed: AffectedPackage = {
				source: scalar(target.source),
				name: scalar(target.name),
				version: scalar(target.version),
			};
			const matches = [...packages.values()].filter(
				(pkg) =>
					pkg.data.source === parsed.source &&
					pkg.data.name === parsed.name &&
					pkg.data.version === parsed.version,
			);
			const match = matches[0];
			if (matches.length !== 1 || !match || affectedIdentities.has(encoded(match.identity))) {
				throw new InputError();
			}
			affectedIdentities.add(encoded(match.identity));
			const ancestors = new Set([match.id]);
			const pending = [match.id];
			for (let index = 0; index < pending.length; index++) {
				for (const from of reverse.get(pending[index] ?? "") ?? []) {
					if (!ancestors.has(from)) {
						ancestors.add(from);
						pending.push(from);
					}
				}
			}
			const tuplePayload: ProjectionTuple = [
				"ancestor",
				1,
				match.identity,
				selection(roots.filter((id) => ancestors.has(id))),
				rows(ancestors),
				sortRows(
					edges
						.filter((edge) => ancestors.has(edge.from) && ancestors.has(edge.to))
						.map((edge) => edge.row),
				),
			];
			return {
				target: parsed,
				digest: digest(ancestorDomain, tuplePayload),
				packageCount: ancestors.size,
				tuplePayload,
			};
		})
		.sort((a, b) => compare(JSON.stringify(a.target), JSON.stringify(b.target)));
	return {
		version: 1,
		digest: digest(graphDomain, tuplePayload),
		packageCount: packages.size,
		tuplePayload,
		ancestorDigests,
	};
}

/** Pure projection; the caller's runner establishes path/source/selection provenance separately. */
export function projectCargoGraph(
	value: unknown,
	paths: ValidatedCargoPaths,
	affected: readonly AffectedPackage[],
): CargoGraphProjection {
	try {
		return project(value, paths, affected);
	} catch (error) {
		if (error instanceof InputError) throw error;
		throw new InputError();
	}
}
