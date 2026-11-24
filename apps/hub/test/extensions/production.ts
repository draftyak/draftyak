import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const WORKSPACE_GROUPS = ["apps", "packages", "plugins", "spikes", "tools"] as const;
const PRODUCTION_GROUPS = ["apps", "packages", "plugins"] as const;
const EXCLUDED = new Set([
	"node_modules",
	"dist",
	"coverage",
	".git",
	".cache",
	".turbo",
	"test",
	"tests",
	"__tests__",
	"fixtures",
	"docs",
]);
const SOURCE = /\.(?:[cm]?[jt]sx?|rs|sql|json)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const CONFIG = /^(?:package\.json|tsconfig(?:\..*)?\.json|vitest\.config\.[cm]?[jt]s)$/;

function workspaces(root: string, groups: readonly string[]): string[] {
	return groups.flatMap((group) => {
		const directory = path.join(root, group);
		if (!existsSync(directory)) return [];
		return readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(directory, entry.name));
	});
}

/** Runtime code and module files, not dependencies, generated output, tests or prose. */
export function productionFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (EXCLUDED.has(entry.name)) continue;
			const filename = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(filename);
			else if (
				entry.isFile() &&
				SOURCE.test(entry.name) &&
				!TEST.test(entry.name) &&
				!CONFIG.test(entry.name)
			)
				files.push(path.relative(root, filename));
		}
	};
	for (const directory of workspaces(root, PRODUCTION_GROUPS))
		if (directory !== path.join(root, "packages", "fake-commercial")) visit(directory);
	return files.sort();
}

/** The root and every physical workspace manifest in the workspace's package groups. */
export function workspaceManifests(root: string): string[] {
	return [root, ...workspaces(root, WORKSPACE_GROUPS)]
		.map((directory) => path.join(directory, "package.json"))
		.filter(existsSync)
		.map((filename) => path.relative(root, filename))
		.sort();
}

/** pnpm-workspace.yaml, exactly: one glob per covered group, in order, then the other settings. */
export const WORKSPACE_YAML: string = [
	"packages:",
	...WORKSPACE_GROUPS.map((group) => `  - ${group}/*`),
	"",
	"minimumReleaseAge: 1440",
	"minimumReleaseAgeExclude: []",
	"allowBuilds: {}",
	"engineStrict: true",
	"savePrefix: ''",
	"verifyDepsBeforeRun: error",
	"",
].join("\n");
