import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Internal packages resolve only from the workspace: the @draftyak scope and the unscoped names
// are unclaimed on npm, so any other spec could install a package someone else published.
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");

type Deps = Readonly<Record<string, string>>;
interface Manifest {
	readonly name?: string;
	readonly dependencies?: Deps;
	readonly devDependencies?: Deps;
	readonly optionalDependencies?: Deps;
	readonly peerDependencies?: Deps;
}

const groups = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;
// Reserved before any package of that name exists; §11 names the CLI npm `draftyak`.
const reserved = /^(?:@draftyak\/.+|create-draftyak-plugin|draftyak)$/;
// npm:<name>[@<range>] aliases another package, which may be an internal one; without a range,
// pnpm installs its latest version.
const aliased = (spec: string): string | undefined => /^npm:(@?[^@]+)(?:@|$)/.exec(spec)?.[1];

// pnpm-workspace.yaml's `packages:` list, then every workspace package's manifest.
function workspaceManifests(): { dir: string; manifest: Manifest }[] {
	const lines = read("pnpm-workspace.yaml").split(/\r?\n/);
	const listed = lines.slice(lines.indexOf("packages:") + 1);
	const end = listed.findIndex((line) => !line.startsWith("  - "));
	const globs = listed.slice(0, end === -1 ? listed.length : end).map((line) => line.slice(4));
	const dirs = globSync(
		globs.map((glob) => `${glob}/package.json`),
		{ cwd: root },
	).map((file) => path.dirname(file).split(path.sep).join("/"));
	return [".", ...dirs.toSorted()].map((dir) => ({
		dir,
		manifest: JSON.parse(read(`${dir}/package.json`)) as Manifest,
	}));
}

const manifests = workspaceManifests();
const workspaceNames: ReadonlySet<string> = new Set(
	manifests.flatMap(({ manifest }) => manifest.name ?? []),
);

// A dependency on an internal package, by its name or through an npm: alias.
function internalTo(names: ReadonlySet<string>): (name: string, spec: string) => boolean {
	const internal = (name: string | undefined): boolean =>
		name !== undefined && (reserved.test(name) || names.has(name));
	return (name, spec) => internal(name) || internal(aliased(spec));
}

function internalDeps(manifest: Manifest, names = workspaceNames): string[] {
	const internal = internalTo(names);
	return groups.flatMap((group) =>
		Object.entries(manifest[group] ?? {})
			.filter(([name, spec]) => internal(name, spec) && !spec.startsWith("workspace:"))
			.map(([name, spec]) => `${group}: ${name}@${spec}`),
	);
}

// pnpm-lock.yaml's importers as pnpm writes them: a folder at two spaces, a dependency group at
// four, a name at six, and its specifier and version at eight.
function unlinked(lockfile: string, names = workspaceNames): string[] {
	const internal = internalTo(names);
	const unquote = (text: string): string => /^'(.*)'$/.exec(text)?.[1] ?? text;
	const found: string[] = [];
	let importers = false;
	let [importer, group, name, specifier] = ["", "", "", ""];
	for (const line of lockfile.split(/\r?\n/)) {
		if (/^\S/.test(line)) importers = line === "importers:";
		const match = /^( +)(.+?):(?: (.*))?$/.exec(line);
		if (!importers || !match) continue;
		const [, indent = "", rawKey = "", rawValue = ""] = match;
		const [key, value] = [unquote(rawKey), unquote(rawValue)];
		if (indent.length === 2) importer = key;
		else if (indent.length === 4) group = key;
		else if (indent.length === 6) [name, specifier] = [key, ""];
		else if (indent.length === 8 && key === "specifier") specifier = value;
		else if (indent.length === 8 && key === "version" && internal(name, specifier)) {
			if (!value.startsWith("link:")) found.push(`${importer}: ${group}: ${name} → ${value}`);
		}
	}
	return found;
}

describe("internal dependencies", () => {
	it("depend on every workspace package through workspace:", () => {
		const loose = manifests.flatMap(({ dir, manifest }) =>
			internalDeps(manifest).map((problem) => `${dir}: ${problem}`),
		);
		expect(loose).toEqual([]);
	});

	it("resolve to workspace links in pnpm-lock.yaml, whatever overrides or catalogs say", () => {
		expect(unlinked(read("pnpm-lock.yaml"))).toEqual([]);
	});

	it("flags a version, a range, a file: path and an npm: alias of an internal package", () => {
		const manifest: Manifest = {
			dependencies: { "@draftyak/protocol": "0.0.0", zod: "4.6.7", draftyak: "1.0.0" },
			devDependencies: {
				"create-draftyak-plugin": "^0.1.0",
				"@draftyak/fakes": "file:../fakes",
				proto: "npm:@draftyak/protocol@0.0.0",
				latest: "npm:create-draftyak-plugin",
			},
			peerDependencies: { "@draftyak/sdk": ">=0.0.0", sdk: "npm:@draftyak/sdk" },
		};
		expect(internalDeps(manifest)).toEqual([
			"dependencies: @draftyak/protocol@0.0.0",
			"dependencies: draftyak@1.0.0",
			"devDependencies: create-draftyak-plugin@^0.1.0",
			"devDependencies: @draftyak/fakes@file:../fakes",
			"devDependencies: proto@npm:@draftyak/protocol@0.0.0",
			"devDependencies: latest@npm:create-draftyak-plugin",
			"peerDependencies: @draftyak/sdk@>=0.0.0",
			"peerDependencies: sdk@npm:@draftyak/sdk",
		]);
	});

	it("treats a workspace package's name as internal even outside the reserved names", () => {
		const manifest: Manifest = {
			dependencies: { "channel-hello": "1.0.0", "draftyak-like": "1.0.0" },
			devDependencies: { hello: "npm:channel-hello", other: "npm:@draftyakx/other@1.0.0" },
		};
		expect(internalDeps(manifest, new Set(["channel-hello"]))).toEqual([
			"dependencies: channel-hello@1.0.0",
			"devDependencies: hello@npm:channel-hello",
		]);
	});

	it("accepts workspace: specs, aliases included, and leaves external packages alone", () => {
		const manifest: Manifest = {
			dependencies: { "@draftyak/protocol": "workspace:*", zod: "4.6.7" },
			devDependencies: {
				"@draftyak/spike-kit": "workspace:*",
				"create-draftyak-plugin": "workspace:^",
				testkit: "workspace:@draftyak/plugin-testkit@*",
				"draftyak-like": "1.0.0",
				zod3: "npm:zod@3.25.76",
			},
		};
		expect(internalDeps(manifest)).toEqual([]);
	});

	it("flags a lockfile entry that resolves an internal package from the registry", () => {
		const lockfile = [
			"lockfileVersion: '9.0'",
			"",
			"overrides:",
			"  '@draftyak/protocol': 0.0.0",
			"",
			"importers:",
			"",
			"  .:",
			"    devDependencies:",
			"      turbo:",
			"        specifier: 2.11.8",
			"        version: 2.11.8",
			"",
			"  packages/sdk:",
			"    dependencies:",
			"      '@draftyak/fakes':",
			"        specifier: workspace:*",
			"        version: link:../fakes",
			"      '@draftyak/protocol':",
			"        specifier: workspace:*",
			"        version: 0.0.0",
			"      draftyak:",
			"        specifier: 'catalog:'",
			"        version: 1.0.0",
			"      proto:",
			"        specifier: npm:@draftyak/protocol",
			"        version: '@draftyak/protocol@0.0.0'",
			"      zod:",
			"        specifier: 4.6.7",
			"        version: 4.6.7",
			"",
			"packages:",
			"",
			"  '@draftyak/protocol@0.0.0':",
			"    version: 0.0.0",
		].join("\n");
		expect(unlinked(lockfile)).toEqual([
			"packages/sdk: dependencies: @draftyak/protocol → 0.0.0",
			"packages/sdk: dependencies: draftyak → 1.0.0",
			"packages/sdk: dependencies: proto → @draftyak/protocol@0.0.0",
		]);
	});
});
