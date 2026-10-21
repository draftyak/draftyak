import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
	type CommunityInputs,
	checkCommunity,
	communityFiles,
	communityLinks,
	permittedCommunityPath,
} from "./community.ts";
import { loadMetadata } from "./metadata-cli.ts";

export async function loadCommunity(root: string): Promise<CommunityInputs> {
	root = path.resolve(root);
	const metadata = await loadMetadata(root);
	async function text(relative: string, directoryTarget = false): Promise<string | undefined> {
		if (!permittedCommunityPath(relative)) throw new Error("unsupported input path");
		let current = root;
		try {
			for (const segment of relative.split("/")) {
				current = path.join(current, segment);
				if ((await lstat(current)).isSymbolicLink()) throw new Error("linked input");
			}
			const stat = await lstat(current);
			if (directoryTarget && stat.isDirectory()) return "";
			if (!stat.isFile() || stat.size >= 3 * 1024 * 1024) throw new Error("unsafe input");
			return await readFile(current, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
	}
	const documents: Record<string, string> = {};
	for (const file of communityFiles) {
		const source = await text(file);
		if (source !== undefined) documents[file] = source;
	}
	const targets: Record<string, string | undefined> = { ...documents };
	const links = communityLinks(documents);
	// Refused syntax never becomes an input path; the pure checker reports it.
	for (const link of links.links) {
		if (Object.hasOwn(targets, link.target)) continue;
		if (
			!metadata.trackedPaths.some(
				(file) => file === link.target || file.startsWith(`${link.target}/`),
			)
		)
			targets[link.target] = undefined;
		else targets[link.target] = await text(link.target, true);
	}
	return { metadata, documents, targets };
}

export async function main(argv: string[]): Promise<number> {
	const args = argv[0] === "--" ? argv.slice(1) : argv;
	if (args.length !== 1 || !args[0] || args[0].startsWith("-")) {
		console.error("usage: launch-community <repository-root>");
		return 2;
	}
	try {
		const problems = checkCommunity(await loadCommunity(args[0]));
		for (const problem of problems) console.error(`${problem.file}: ${problem.rule}`);
		console.log(`launch community: ${problems.length} problems`);
		return problems.length ? 1 : 0;
	} catch {
		console.error("launch community: missing, unreadable, unsafe or invalid input");
		return 2;
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
