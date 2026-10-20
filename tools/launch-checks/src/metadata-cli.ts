import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { checkMetadata, type MetadataInputs, requiredForms } from "./metadata.ts";

export function parseMetadataYaml(source: string): unknown {
	const document = parseDocument(source, {
		uniqueKeys: true,
		stringKeys: true,
		prettyErrors: false,
	});
	if (document.errors.length || document.warnings.length) throw new Error("invalid YAML");
	return document.toJS({ maxAliasCount: 0 });
}

export async function loadMetadata(
	root: string,
	parseYaml: (source: string) => unknown = parseMetadataYaml,
): Promise<MetadataInputs> {
	root = path.resolve(root);
	let ancestor = path.parse(root).root;
	for (const segment of root.slice(ancestor.length).split(path.sep)) {
		ancestor = path.join(ancestor, segment);
		if ((await lstat(ancestor)).isSymbolicLink()) throw new Error("linked repository root");
	}
	if (!(await lstat(root)).isDirectory()) throw new Error("repository root must be a directory");
	const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	if ((await realpath(gitRoot)) !== (await realpath(root)))
		throw new Error("expected the repository root");
	async function text(relative: string): Promise<string> {
		const filename = path.join(root, relative);
		let current = root;
		for (const segment of relative.split("/")) {
			current = path.join(current, segment);
			if ((await lstat(current)).isSymbolicLink()) throw new Error("linked metadata input");
		}
		const stat = await lstat(filename);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size >= 3 * 1024 * 1024)
			throw new Error("unsafe metadata input");
		return readFile(filename, "utf8");
	}
	const forms: Record<string, unknown> = {};
	for (const name of requiredForms)
		forms[name] = parseYaml(await text(`.github/ISSUE_TEMPLATE/${name}.yml`));
	return {
		labels: parseYaml(await text(".github/labels.yml")),
		chooser: parseYaml(await text(".github/ISSUE_TEMPLATE/config.yml")),
		forms,
		codeowners: await text(".github/CODEOWNERS"),
		pullRequest: await text(".github/pull_request_template.md"),
		contributing: await text("CONTRIBUTING.md"),
		trackedPaths: execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
			.split("\0")
			.filter(Boolean),
	};
}

export async function main(argv: string[]): Promise<number> {
	const args = argv[0] === "--" ? argv.slice(1) : argv;
	const root = args[0];
	if (args.length !== 1 || !root || root.startsWith("-")) {
		console.error("usage: launch-metadata <repository-root>");
		return 2;
	}
	try {
		const problems = checkMetadata(await loadMetadata(path.resolve(root)));
		for (const problem of problems) console.error(`${problem.file}: ${problem.rule}`);
		console.log(`launch metadata: ${problems.length} problems`);
		return problems.length ? 1 : 0;
	} catch {
		console.error("launch metadata: missing, unreadable, unsafe or invalid input");
		return 2;
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
