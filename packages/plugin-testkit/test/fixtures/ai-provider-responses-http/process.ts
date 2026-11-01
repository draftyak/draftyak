import { existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import type { ProcessPluginFiles } from "../../../src/index.ts";

export async function responsesProcessFixture(): Promise<{
	readonly files: ProcessPluginFiles;
	cleanup(): Promise<void>;
}> {
	const temporary = await realpath(tmpdir());
	const root = await realpath(await mkdtemp(path.join(temporary, "draftyak-bound-provider-")));
	let cleaned = false;
	const cleanup = async (): Promise<void> => {
		if (cleaned) return;
		if (
			path.dirname(root) !== temporary ||
			!path.basename(root).startsWith("draftyak-bound-provider-") ||
			(await lstat(root)).isSymbolicLink() ||
			(await realpath(root)) !== root
		)
			throw new Error("Bound provider fixture cleanup root changed");
		await rm(root, { recursive: true, force: true });
		if (existsSync(root)) throw new Error("Bound provider fixture cleanup left a directory");
		cleaned = true;
	};
	try {
		await build({
			config: false,
			entry: { server: fileURLToPath(new URL("./server.ts", import.meta.url)) },
			outDir: root,
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
		if ((await readdir(root)).sort().join() !== "server.mjs")
			throw new Error("Bound provider fixture must be one self-contained module");
		return {
			files: Object.freeze({
				directory: root,
				entry: "server.mjs",
				files: Object.freeze(["server.mjs"]),
			}),
			cleanup,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}
