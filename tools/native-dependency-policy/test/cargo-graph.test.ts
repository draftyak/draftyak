import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type ProjectionTuple, projectCargoGraph } from "../src/cargo-graph.ts";
import { InputError } from "../src/strict-json.ts";

type Row = Record<string, unknown>;
interface Fixture {
	metadata: Row;
	paths: {
		workspacePackages: {
			id: string;
			manifestPath: string;
			targets: { name: string; kinds: string[]; sourcePath: string; relativePath: string }[];
		}[];
		rootIds: string[];
	};
	affected: { source: string; name: string; version: string }[];
}
const registry = "registry+https://github.com/rust-lang/crates.io-index";
const rows = (value: unknown): Row[] => value as Row[];
const pkg = (f: Fixture, id: string): Row => {
	const found = rows(f.metadata.packages).find((p) => p.id === id);
	if (!found) throw new Error("missing fixture package");
	return found;
};
const node = (f: Fixture, id: string): Row => {
	const found = rows((f.metadata.resolve as Row).nodes).find((n) => n.id === id);
	if (!found) throw new Error("missing fixture node");
	return found;
};
const first = <T>(values: readonly T[]): T => {
	const value = values[0];
	if (value === undefined) throw new Error("empty fixture array");
	return value;
};

function edge(f: Fixture, from: string, to: string, kind: string | null = null): void {
	const target = pkg(f, to);
	const parent = node(f, from);
	rows(parent.deps).push({ name: target.name, pkg: to, dep_kinds: [{ kind, target: null }] });
	parent.dependencies = [...new Set(rows(parent.deps).map((d) => d.pkg))];
	rows(pkg(f, from).dependencies).push({
		name: target.name,
		source: target.source,
		req: "*",
		kind,
		rename: null,
		optional: false,
		uses_default_features: true,
		features: [],
		target: null,
		registry: null,
		...(target.source === null
			? { path: String(target.manifest_path).replace(/\/Cargo.toml$/, "") }
			: {}),
	});
}

function fixture(): Fixture {
	const packages = [
		{ id: "root", name: "root", version: "0.0.0", source: null, path: "apps/app" },
		{ id: "helper", name: "helper", version: "0.0.0", source: null, path: "crates/helper" },
		{ id: "glib", name: "glib", version: "0.18.5", source: registry, path: "cache/glib" },
		{ id: "safe", name: "safe", version: "1.0.0", source: registry, path: "cache/safe" },
	].map((p) => ({
		id: p.id,
		name: p.name,
		version: p.version,
		source: p.source,
		manifest_path: `C:/repo/${p.path}/Cargo.toml`,
		dependencies: [],
		targets: [
			{
				name: p.name,
				kind: ["lib"],
				crate_types: ["lib"],
				src_path: `C:/repo/${p.path}/src/lib.rs`,
				edition: "2021",
				doc: true,
				doctest: true,
				test: true,
			},
		],
		features: { default: [] },
		license: "MIT",
		edition: "2021",
		rust_version: "1.95",
		links: null,
		default_run: null,
	}));
	const f: Fixture = {
		metadata: {
			version: 1,
			packages,
			workspace_members: ["root", "helper"],
			workspace_default_members: ["root"],
			workspace_root: "C:/repo",
			target_directory: "C:/repo/target",
			build_directory: "C:/repo/target",
			metadata: null,
			resolve: {
				root: null,
				nodes: packages.map((p) => ({ id: p.id, features: [], dependencies: [], deps: [] })),
			},
		},
		paths: {
			rootIds: ["root"],
			workspacePackages: packages
				.filter((p) => p.source === null)
				.map((p) => ({
					id: p.id,
					manifestPath: p.manifest_path.replace("C:/repo/", ""),
					targets: p.targets.map((t) => ({
						name: t.name,
						kinds: t.kind,
						sourcePath: t.src_path,
						relativePath: t.src_path.replace("C:/repo/", ""),
					})),
				})),
		},
		affected: [{ source: registry, name: "glib", version: "0.18.5" }],
	};
	edge(f, "root", "helper");
	edge(f, "helper", "glib", "build");
	edge(f, "root", "safe");
	return f;
}
const project = (f: Fixture) => projectCargoGraph(f.metadata, f.paths, f.affected);

describe("portable complete Cargo projection", () => {
	it("binds the complete graph and affected ancestor closure with separate domains", () => {
		const result = project(fixture());
		expect(result.version).toBe(1);
		expect(result.packageCount).toBe(4);
		expect(result.digest).toBe(
			createHash("sha256")
				.update("draftyak/native-dependency-policy/graph/v1\0")
				.update(JSON.stringify(result.tuplePayload))
				.digest("hex"),
		);
		const ancestor = first(result.ancestorDigests);
		expect(ancestor.packageCount).toBe(3);
		expect(ancestor.digest).toBe(
			createHash("sha256")
				.update("draftyak/native-dependency-policy/ancestor/v1\0")
				.update(JSON.stringify(ancestor.tuplePayload))
				.digest("hex"),
		);
		expect(ancestor.digest).not.toBe(result.digest);
	});

	it("is invariant to row/property order and checked workspace relocation", () => {
		const original = fixture();
		const relocated = JSON.parse(
			JSON.stringify(original).replaceAll("C:/repo", "D:/relocated"),
		) as Fixture;
		rows(relocated.metadata.packages).reverse();
		rows((relocated.metadata.resolve as Row).nodes).reverse();
		(relocated.metadata.workspace_members as string[]).reverse();
		relocated.paths.workspacePackages.reverse();
		for (const p of rows(relocated.metadata.packages)) rows(p.dependencies).reverse();
		for (const n of rows((relocated.metadata.resolve as Row).nodes)) {
			rows(n.deps).reverse();
			(n.dependencies as string[]).reverse();
		}
		expect(project(relocated)).toEqual(project(original));
	});

	it("replaces opaque Cargo IDs rather than hashing their machine-specific spelling", () => {
		const original = fixture();
		const changed = fixture();
		const ids = new Map(["root", "helper", "glib", "safe"].map((id) => [id, `opaque:${id}`]));
		for (const p of rows(changed.metadata.packages)) p.id = ids.get(String(p.id));
		for (const n of rows((changed.metadata.resolve as Row).nodes)) {
			n.id = ids.get(String(n.id));
			n.dependencies = (n.dependencies as string[]).map((id) => ids.get(id));
			for (const d of rows(n.deps)) d.pkg = ids.get(String(d.pkg));
		}
		changed.metadata.workspace_members = ["opaque:root", "opaque:helper"];
		changed.metadata.workspace_default_members = ["opaque:root"];
		changed.paths.rootIds = ["opaque:root"];
		for (const b of changed.paths.workspacePackages) b.id = String(ids.get(b.id));
		expect(project(changed)).toEqual(project(original));
	});

	it("binds a new alternative ancestor while the original path is unchanged", () => {
		const before = project(fixture());
		const changed = fixture();
		edge(changed, "safe", "glib", "dev");
		const after = project(changed);
		expect(first(after.ancestorDigests).packageCount).toBe(4);
		expect(after.digest).not.toBe(before.digest);
		expect(first(after.ancestorDigests).digest).not.toBe(first(before.ancestorDigests).digest);
	});

	it("terminates on shared ancestry and cycles without dropping their edges", () => {
		const changed = fixture();
		edge(changed, "glib", "helper");
		const result = project(changed);
		expect(first(result.ancestorDigests).packageCount).toBe(3);
		expect(first(result.ancestorDigests).digest).not.toBe(
			first(project(fixture()).ancestorDigests).digest,
		);
	});

	it("binds ancestor edge predicates while package rows and membership stay fixed", () => {
		const original = fixture();
		const changed = fixture();
		first(rows(first(rows(node(changed, "helper").deps)).dep_kinds)).target =
			'cfg(target_os = "linux")';
		expect(changed.metadata.packages).toEqual(original.metadata.packages);
		expect(changed.paths).toEqual(original.paths);

		const before = project(original);
		const after = project(changed);
		const beforeAncestor = first(before.ancestorDigests);
		const afterAncestor = first(after.ancestorDigests);
		expect(after.tuplePayload[3]).toEqual(before.tuplePayload[3]);
		expect(beforeAncestor.packageCount).toBe(3);
		expect(afterAncestor.packageCount).toBe(3);
		expect(afterAncestor.tuplePayload.slice(0, 5)).toEqual(beforeAncestor.tuplePayload.slice(0, 5));
		expect(after.digest).not.toBe(before.digest);
		expect(afterAncestor.digest).not.toBe(beforeAncestor.digest);
	});

	const changes: { name: string; change: (f: Fixture) => void }[] = [
		{
			name: "resolved feature",
			change: (f) => {
				node(f, "glib").features = ["v2_80"];
			},
		},
		{
			name: "declared feature",
			change: (f) => {
				pkg(f, "helper").features = { default: ["special"] };
			},
		},
		{
			name: "dependency rename",
			change: (f) => {
				first(rows(pkg(f, "helper").dependencies)).rename = "renamed";
			},
		},
		{
			name: "dependency requirement",
			change: (f) => {
				first(rows(pkg(f, "helper").dependencies)).req = "=0.18.5";
			},
		},
		{
			name: "dependency optional",
			change: (f) => {
				first(rows(pkg(f, "helper").dependencies)).optional = true;
			},
		},
		{
			name: "dependency defaults",
			change: (f) => {
				first(rows(pkg(f, "helper").dependencies)).uses_default_features = false;
			},
		},
		{
			name: "requested feature",
			change: (f) => {
				first(rows(pkg(f, "helper").dependencies)).features = ["v2_80"];
			},
		},
		{
			name: "declared predicate",
			change: (f) => {
				first(rows(pkg(f, "helper").dependencies)).target = 'cfg(target_os = "linux")';
			},
		},
		{
			name: "resolved predicate",
			change: (f) => {
				first(rows(first(rows(node(f, "helper").deps)).dep_kinds)).target =
					'cfg(target_os = "linux")';
			},
		},
		{
			name: "build to dev edge",
			change: (f) => {
				first(rows(first(rows(node(f, "helper").deps)).dep_kinds)).kind = "dev";
			},
		},
		{
			name: "renamed resolved edge",
			change: (f) => {
				first(rows(node(f, "helper").deps)).name = "renamed";
			},
		},
		{
			name: "proc macro target",
			change: (f) => {
				first(rows(pkg(f, "glib").targets)).kind = ["proc-macro"];
			},
		},
		{
			name: "required target feature",
			change: (f) => {
				first(rows(pkg(f, "glib").targets))["required-features"] = ["special"];
			},
		},
		{
			name: "target crate type",
			change: (f) => {
				first(rows(pkg(f, "glib").targets)).crate_types = ["cdylib"];
			},
		},
		{
			name: "package source",
			change: (f) => {
				pkg(f, "safe").source = "registry+https://mirror.invalid/index";
			},
		},
		{
			name: "package version",
			change: (f) => {
				pkg(f, "safe").version = "1.0.1";
			},
		},
		{
			name: "default members",
			change: (f) => {
				f.metadata.workspace_default_members = ["root", "helper"];
			},
		},
		{
			name: "roots independently",
			change: (f) => {
				f.paths.rootIds = ["root", "helper"];
			},
		},
		{
			name: "manifest casing",
			change: (f) => {
				first(f.paths.workspacePackages).manifestPath = "Apps/app/Cargo.toml";
			},
		},
		{
			name: "actual target source",
			change: (f) => {
				first(first(f.paths.workspacePackages).targets).relativePath = "apps/app/src/actual.rs";
			},
		},
	];
	it.each(changes)("changes the graph binding for $name", ({ change }) => {
		const changed = fixture();
		change(changed);
		expect(project(changed).digest).not.toBe(project(fixture()).digest);
	});

	it("uses UTF-8 byte ordering and preserves declared feature multiplicity", () => {
		const f = fixture();
		pkg(f, "root").features = { é: [], z: ["a", "a"] };
		const result = project(f);
		const packageRows = result.tuplePayload[3] as readonly ProjectionTuple[];
		const row = packageRows.find((r) => (r[0] as ProjectionTuple)[1] === "root");
		const features = row?.[2] as readonly ProjectionTuple[];
		expect(features.map((r) => r[0])).toEqual(["z", "é"]);
		expect(first(features)[1]).toEqual(["a", "a"]);
	});

	it("omits only documented benign fields without inspecting prose", () => {
		const changed = fixture();
		pkg(changed, "glib").description = { arbitrary: "synthetic omitted data" };
		pkg(changed, "glib").authors = ["synthetic"];
		changed.metadata.metadata = { arbitrary: true };
		expect(project(changed)).toEqual(project(fixture()));
	});

	it("retains exact cfg spelling and Unicode feature distinctions", () => {
		const a = fixture();
		const b = fixture();
		first(rows(first(rows(node(a, "helper").deps)).dep_kinds)).target = 'cfg(target_os = "linux")';
		first(rows(first(rows(node(b, "helper").deps)).dep_kinds)).target = 'cfg( target_os="linux" )';
		expect(project(a).digest).not.toBe(project(b).digest);
		const c = fixture();
		const d = fixture();
		pkg(c, "root").features = { é: [] };
		pkg(d, "root").features = { é: [] };
		expect(project(c).digest).not.toBe(project(d).digest);
	});

	it("refuses duplicate identities even when references are otherwise complete", () => {
		const f = fixture();
		rows(f.metadata.packages).push({ ...pkg(f, "glib"), id: "copy" });
		rows((f.metadata.resolve as Row).nodes).push({ ...node(f, "glib"), id: "copy" });
		edge(f, "root", "copy");
		f.affected = [];
		expect(() => project(f)).toThrow(InputError);
	});

	it("refuses a registry source with its otherwise valid local workspace binding retained", () => {
		const original = fixture();
		const changed = fixture();
		expect(project(original).packageCount).toBe(4);
		pkg(changed, "root").source = registry;
		expect(changed.paths).toEqual(original.paths);
		expect(changed.metadata.workspace_members).toEqual(original.metadata.workspace_members);
		expect(changed.metadata.workspace_default_members).toEqual(
			original.metadata.workspace_default_members,
		);

		let failure: unknown;
		try {
			project(changed);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(InputError);
		expect(failure).toMatchObject({ code: "INVALID_INPUT" });
	});

	const refusals: { name: string; change: (f: Fixture) => void }[] = [
		{
			name: "unknown top key",
			change: (f) => {
				f.metadata.future = true;
			},
		},
		{
			name: "unknown package key",
			change: (f) => {
				pkg(f, "root").future = true;
			},
		},
		{
			name: "unknown dependency key",
			change: (f) => {
				first(rows(pkg(f, "helper").dependencies)).future = true;
			},
		},
		{
			name: "unknown target key",
			change: (f) => {
				first(rows(pkg(f, "root").targets)).future = true;
			},
		},
		{
			name: "unknown node key",
			change: (f) => {
				node(f, "root").future = true;
			},
		},
		{
			name: "unknown edge key",
			change: (f) => {
				first(rows(node(f, "root").deps)).future = true;
			},
		},
		{
			name: "missing node",
			change: (f) => {
				rows((f.metadata.resolve as Row).nodes).pop();
			},
		},
		{
			name: "duplicate node",
			change: (f) => {
				rows((f.metadata.resolve as Row).nodes).push(node(f, "root"));
			},
		},
		{
			name: "dangling edge",
			change: (f) => {
				first(rows(node(f, "root").deps)).pkg = "absent";
			},
		},
		{
			name: "duplicate edge",
			change: (f) => {
				rows(node(f, "root").deps).push(first(rows(node(f, "root").deps)));
			},
		},
		{
			name: "incomplete legacy edges",
			change: (f) => {
				node(f, "root").dependencies = [];
			},
		},
		{
			name: "unknown dependency kind",
			change: (f) => {
				first(rows(first(rows(node(f, "root").deps)).dep_kinds)).kind = "host";
			},
		},
		{
			name: "duplicate package ID",
			change: (f) => {
				rows(f.metadata.packages).push(pkg(f, "glib"));
			},
		},
		{
			name: "duplicate identity with different ID",
			change: (f) => {
				rows(f.metadata.packages).push({ ...pkg(f, "glib"), id: "another" });
			},
		},
		{
			name: "missing source",
			change: (f) => {
				delete pkg(f, "glib").source;
			},
		},
		{
			name: "missing binding",
			change: (f) => {
				f.paths.workspacePackages.pop();
			},
		},
		{
			name: "extra binding",
			change: (f) => {
				f.paths.workspacePackages.push({ ...first(f.paths.workspacePackages), id: "unknown" });
			},
		},
		{
			name: "missing target binding",
			change: (f) => {
				first(f.paths.workspacePackages).targets = [];
			},
		},
		{
			name: "extra target binding",
			change: (f) => {
				const p = first(f.paths.workspacePackages);
				p.targets.push({ ...first(p.targets) });
			},
		},
		{
			name: "wrong target source",
			change: (f) => {
				first(first(f.paths.workspacePackages).targets).sourcePath = "C:/outside/lib.rs";
			},
		},
		{
			name: "wrong target kinds",
			change: (f) => {
				first(first(f.paths.workspacePackages).targets).kinds = ["bin"];
			},
		},
		{
			name: "incomplete members",
			change: (f) => {
				f.metadata.workspace_members = ["root"];
			},
		},
		{
			name: "extra default member",
			change: (f) => {
				f.metadata.workspace_default_members = ["root", "glib"];
			},
		},
		{
			name: "root outside members",
			change: (f) => {
				f.paths.rootIds = ["root", "glib"];
			},
		},
		{
			name: "unreachable subset",
			change: (f) => {
				node(f, "root").dependencies = ["helper"];
				rows(node(f, "root").deps).pop();
			},
		},
		{
			name: "duplicate resolved features",
			change: (f) => {
				node(f, "glib").features = ["a", "a"];
			},
		},
		{
			name: "wrong affected version",
			change: (f) => {
				first(f.affected).version = "0.18.6";
			},
		},
		{
			name: "wrong affected name",
			change: (f) => {
				first(f.affected).name = "other";
			},
		},
		{
			name: "wrong affected source",
			change: (f) => {
				first(f.affected).source = "registry+https://other.invalid";
			},
		},
		{
			name: "duplicate affected tuple",
			change: (f) => {
				f.affected.push(first(f.affected));
			},
		},
		{
			name: "lone surrogate string",
			change: (f) => {
				pkg(f, "glib").name = "\ud800";
				f.affected = [];
			},
		},
		{
			name: "case alias",
			change: (f) => {
				const b = f.paths.workspacePackages[1];
				if (b) b.manifestPath = "apps/app/cargo.toml";
			},
		},
	];
	it.each(refusals)("refuses $name", ({ change }) => {
		const f = fixture();
		change(f);
		expect(() => project(f)).toThrow(InputError);
	});

	it.each([
		".",
		"..",
		"./src/lib.rs",
		"src/../lib.rs",
		"src//lib.rs",
		"/src/lib.rs",
		"C:/src/lib.rs",
		"src\\lib.rs",
		"src/é.rs",
		"src/é.rs",
	])("refuses a noncanonical target path %j", (relativePath) => {
		const f = fixture();
		first(first(f.paths.workspacePackages).targets).relativePath = relativePath;
		expect(() => project(f)).toThrow(InputError);
	});

	it("does not invoke property accessors or use mutable property rereads", () => {
		const f = fixture();
		let reads = 0;
		Object.defineProperty(pkg(f, "root"), "description", {
			get: () => {
				reads++;
				throw new Error("synthetic detail");
			},
		});
		expect(() => project(f)).toThrow(InputError);
		expect(reads).toBe(0);
	});
});
