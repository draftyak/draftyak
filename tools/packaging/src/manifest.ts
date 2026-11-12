import { lstatSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { jsonValue } from "../../bundle-hub/src/inventory.ts";
import { type Manifest, manifest } from "../../release-guard/src/guard.ts";
import {
	directory,
	fields,
	inventory,
	localPath,
	object,
	read,
	relative,
} from "../../release-guard/src/integrity.ts";

const defaultRepo = path.resolve(import.meta.dirname, "../../..");

export interface ManifestOutput {
	readonly root: string;
	readonly out: string;
	readonly repo?: string;
}

function checkedPath(value: string): string {
	const absolute = localPath(value);
	if (
		absolute
			.slice(path.parse(absolute).root.length)
			.split(path.sep)
			.some((part) => /[. ]$/.test(part))
	) {
		throw new Error("trailing-dot or space path aliases are refused");
	}
	return absolute;
}

function inside(root: string, target: string): boolean {
	const child = path.relative(root, target);
	return (
		child === "" ||
		(!path.isAbsolute(child) && child !== ".." && !child.startsWith(`..${path.sep}`))
	);
}

function manifestConfig(config: unknown): Record<string, unknown> {
	const row = object(config);
	if (Object.hasOwn(row, "runtime"))
		throw new Error("Python runtime inputs require an available reviewed runtime producer");
	fields(row, ["schemaVersion", "version", "npm", "node", "nodeSource", "nodes", "notices"]);
	return row;
}

// Hash existing files only. Archive contents, runtime provenance and readiness remain guard checks.
export function createManifest(config: unknown, root: string): Manifest {
	const row = manifestConfig(config);
	const staged = directory(checkedPath(root));
	const artifacts = inventory(staged);
	const byPath = new Map(artifacts.map((record) => [record.path, record]));
	const measureNode = (value: unknown, perArtifact: boolean): unknown => {
		const input = object(value);
		fields(input, perArtifact ? ["path", "version", "source"] : ["path", "version"]);
		const record = byPath.get(relative(input.path));
		if (!record) throw new Error("referenced Node file is absent from staged inventory");
		return {
			...record,
			version: input.version,
			...(perArtifact ? { source: input.source } : {}),
		};
	};
	const perArtifact = Object.hasOwn(row, "nodes");
	const legacy = Object.hasOwn(row, "node") || Object.hasOwn(row, "nodeSource");
	const mixed = perArtifact && legacy;
	const admitted = manifest({
		schemaVersion: row.schemaVersion,
		version: row.version,
		artifacts,
		npm: row.npm,
		...(Object.hasOwn(row, "node")
			? { node: mixed || row.node === undefined ? row.node : measureNode(row.node, false) }
			: {}),
		...(Object.hasOwn(row, "nodeSource") ? { nodeSource: row.nodeSource } : {}),
		...(perArtifact
			? {
					nodes:
						mixed || !Array.isArray(row.nodes)
							? row.nodes
							: row.nodes.map((value) => measureNode(value, true)),
				}
			: {}),
		...(Object.hasOwn(row, "notices") ? { notices: row.notices } : {}),
	});
	const { node, nodeSource, nodes, notices, ...required } = admitted;
	const result: Manifest = {
		...required,
		...(node === undefined ? {} : { node }),
		...(nodeSource === undefined ? {} : { nodeSource }),
		...(nodes === undefined ? {} : { nodes }),
		...(notices === undefined ? {} : { notices }),
	};
	const requireFile = (file: string): void => {
		if (!byPath.has(file))
			throw new Error(`referenced file is absent from staged inventory: ${file}`);
	};
	for (const item of result.npm) requireFile(item.path);
	if (result.notices) {
		requireFile(result.notices.path);
		requireFile(result.notices.sbom);
	}
	if (result.nodeSource) directory(checkedPath(result.nodeSource.root));
	for (const artifact of result.nodes ?? []) directory(checkedPath(artifact.source.root));
	return result;
}

export function writeManifest(config: unknown, options: ManifestOutput): Manifest {
	const row = manifestConfig(config);
	// Reject network/device/environment paths before any filesystem lookup.
	const stagedPath = checkedPath(options.root);
	const repoPath = checkedPath(options.repo ?? defaultRepo);
	const out = checkedPath(options.out);
	const staged = directory(stagedPath);
	const repo = directory(repoPath);
	if (!inside(repo, out) || out === repo)
		throw new Error("manifest output must stay within the repository workspace");
	if (inside(staged, out)) throw new Error("manifest output must be outside the staged root");
	relative(path.basename(out));
	directory(path.dirname(out));
	try {
		lstatSync(out);
		throw new Error("manifest output already exists");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	const result = createManifest(row, staged);
	writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	return result;
}

const usage =
	"usage: node tools/packaging/src/manifest.ts --config <config.json> --root <staged-directory> --out <new-manifest.json> [--repo <repository>]";

export function main(argv: readonly string[]): number {
	try {
		const { values } = parseArgs({
			args: argv[0] === "--" ? argv.slice(1) : [...argv],
			options: {
				config: { type: "string" },
				root: { type: "string" },
				out: { type: "string" },
				repo: { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		});
		if (values.help) {
			console.log(usage);
			return 0;
		}
		if (!values.config || !values.root || !values.out) {
			console.error(usage);
			return 2;
		}
		const configPath = checkedPath(values.config);
		checkedPath(values.root);
		checkedPath(values.out);
		checkedPath(values.repo ?? defaultRepo);
		const config = jsonValue(
			read(path.dirname(configPath), path.basename(configPath)).toString("utf8"),
		);
		const result = writeManifest(config, {
			root: values.root,
			out: values.out,
			repo: values.repo ?? defaultRepo,
		});
		console.log(
			`release-manifest: wrote ${result.artifacts.length} actual file records; artifact inspection and release readiness are not asserted`,
		);
		return 0;
	} catch (error) {
		console.error(`release-manifest: ${error instanceof Error ? error.message : "invalid input"}`);
		return 1;
	}
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
