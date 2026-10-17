import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { exec } from "./exec.ts";
import { repoRoot } from "./repo.ts";

export interface NodeTarget {
	readonly platform: "win" | "linux" | "darwin";
	readonly arch: "x64" | "arm64";
}

const VERSION = /^\d+\.\d+\.\d+$/;
const fetchNode = (root: string): string =>
	path.join(root, "tools", "fetch-node", "fetch-node.mjs");

export function hostTarget(): NodeTarget {
	const platform = ({ win32: "win", linux: "linux", darwin: "darwin" } as const)[
		process.platform as "win32" | "linux" | "darwin"
	];
	const arch = process.arch;
	if (platform === undefined || (arch !== "x64" && arch !== "arm64")) {
		throw new Error(`no official Node build for ${process.platform}-${arch}`);
	}
	return { platform, arch };
}

// The two Nodes every spike runs on, from fetch-node's versions.json, the single bump point.
export function nodeVersions(root: string = repoRoot): { minimum: string; bundled: string } {
	const file = path.join(root, "tools", "fetch-node", "versions.json");
	const versions: Record<string, string> = JSON.parse(readFileSync(file, "utf8"));
	const { minimum = "", bundled = "" } = versions;
	if (!VERSION.test(minimum) || !VERSION.test(bundled)) throw new Error(`${file}: bad versions`);
	return { minimum, bundled };
}

// A verified official Node binary: fetch-node's fixed CLI (M0.5) with --print-path.
export async function nodeBinary(
	version: string,
	target: NodeTarget = hostTarget(),
	options: { readonly root?: string; readonly offline?: boolean } = {},
): Promise<string> {
	const clean = version.replace(/^v/, "");
	if (!VERSION.test(clean)) throw new Error(`not a Node version: ${version}`);
	const root = options.root ?? repoRoot;
	if (!existsSync(fetchNode(root))) {
		throw new Error(`${fetchNode(root)} is missing (fetch-node, M0.5)`);
	}
	const args = ["--version", clean, "--platform", target.platform, "--arch", target.arch];
	const flags = ["--print-path", ...(options.offline ? ["--offline"] : [])];
	const result = await exec(process.execPath, [fetchNode(root), ...args, ...flags], {
		cwd: root,
		timeoutMs: 900_000,
	});
	const lastLine = (text: string): string => text.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
	const label = `fetch-node ${clean} ${target.platform}-${target.arch}`;
	if (result.code !== 0) {
		throw new Error(
			`${label} exited with ${result.code}: ${lastLine(result.stderr || result.stdout)}`,
		);
	}
	const binary = lastLine(result.stdout);
	if (!path.isAbsolute(binary) || !existsSync(binary)) throw new Error(`${label} printed no path`);
	const host = hostTarget();
	if (target.platform === host.platform && target.arch === host.arch) {
		const reported = (await exec(binary, ["--version"], { timeoutMs: 30_000 })).stdout.trim();
		if (reported !== `v${clean}`) throw new Error(`${label}: ${binary} reports ${reported}`);
	}
	return binary;
}
