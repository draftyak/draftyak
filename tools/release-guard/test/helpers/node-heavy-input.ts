import path from "node:path";
import { json, localPath, object, read, text } from "../../src/integrity.ts";
import type { NodeSource } from "../../src/trusted-node.ts";

export interface NodeHeavyInput {
	readonly source: NodeSource;
	readonly version: string;
	readonly binary: "node" | "node.exe";
	readonly bytes: Buffer;
}

// Setup only: these bytes are not authenticated until the production probe verifies them.
export function nodeHeavyInput(cacheInput: unknown, host: string, arch: string): NodeHeavyInput {
	if (cacheInput === undefined || cacheInput === "")
		throw new Error("explicit offline Node archive cache is required");
	const platform =
		host === "win32" ? "win" : host === "linux" || host === "darwin" ? host : undefined;
	const selectedArch = arch === "x64" || arch === "arm64" ? arch : undefined;
	if (platform === undefined || selectedArch === undefined)
		throw new Error("unsupported offline Node test target");
	if (typeof cacheInput !== "string" || !path.isAbsolute(cacheInput))
		throw new Error("unsafe offline Node archive cache");
	let cache: string;
	try {
		cache = localPath(cacheInput);
	} catch {
		throw new Error("unsafe offline Node archive cache");
	}
	const version = text(
		object(json(path.resolve(import.meta.dirname, "../../../fetch-node"), "versions.json")).bundled,
	);
	const binary = platform === "win" ? "node.exe" : "node";
	const cached = `${platform}-${selectedArch}/${binary}`;
	const archive = `node-v${version}-${platform}-${selectedArch}.${platform === "win" ? "zip" : "tar.gz"}`;
	let candidate: Buffer | undefined;
	try {
		for (const file of ["SHASUMS256.txt", "SHASUMS256.txt.sig", archive, cached]) {
			const bytes = read(cache, file);
			if (bytes.length === 0) throw new Error("empty offline Node test input");
			if (file === cached) candidate = bytes;
		}
		if (candidate === undefined) throw new Error("missing offline Node test candidate");
	} catch {
		throw new Error("required offline Node test inputs are missing or unsafe");
	}
	return {
		source: { root: cache, platform, arch: selectedArch },
		version,
		binary,
		bytes: candidate,
	};
}
