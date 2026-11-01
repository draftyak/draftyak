import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import type { ProcessPluginFiles } from "../../../src/index.ts";

export interface AiProcessFixtures {
	readonly good: ProcessPluginFiles;
	readonly recipientBad: ProcessPluginFiles;
	readonly progressBad: ProcessPluginFiles;
	cleanup(): Promise<void>;
}

/** Builds only the provider contract's self-contained SDK entries. */
export async function aiProcessFixtures(): Promise<AiProcessFixtures> {
	const temporary = await realpath(tmpdir());
	const root = await realpath(await mkdtemp(path.join(temporary, "draftyak-ai-contract-")));
	let cleaned = false;
	const cleanup = async (): Promise<void> => {
		if (cleaned) return;
		if (
			path.dirname(root) !== temporary ||
			!path.basename(root).startsWith("draftyak-ai-contract-") ||
			(await lstat(root)).isSymbolicLink() ||
			(await realpath(root)) !== root
		)
			throw new Error("Provider fixture cleanup root changed");
		await rm(root, { recursive: true, force: true });
		if (existsSync(root)) throw new Error("Provider fixture cleanup left a directory");
		cleaned = true;
	};
	const bundle = async (name: string, source: string): Promise<ProcessPluginFiles> => {
		const directory = path.join(root, name);
		await mkdir(directory, { mode: 0o700 });
		await build({
			config: false,
			entry: { server: fileURLToPath(new URL(source, import.meta.url)) },
			outDir: directory,
			platform: "node",
			format: "esm",
			target: "node26",
			fixedExtension: true,
			deps: { alwaysBundle: [/.*/] },
			dts: false,
			sourcemap: false,
			clean: false,
			exports: false,
			report: false,
			logLevel: "warn",
			failOnWarn: true,
		});
		if ((await readdir(directory)).sort().join() !== "server.mjs")
			throw new Error("Provider fixture must be one self-contained module");
		return Object.freeze({ directory, entry: "server.mjs", files: Object.freeze(["server.mjs"]) });
	};
	try {
		const good = await bundle("good", "./server.ts");
		const recipientBad = await bundle("recipient-bad", "../ai-fixture-bad/server.ts");
		const progressBad = await bundle("progress-bad", "../ai-fixture-progress-bad/server.ts");
		return Object.freeze({ good, recipientBad, progressBad, cleanup });
	} catch (error) {
		await cleanup();
		throw error;
	}
}
