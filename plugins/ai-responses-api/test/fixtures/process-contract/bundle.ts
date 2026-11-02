import { existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessPluginFiles } from "@draftyak/plugin-testkit";
import { build } from "tsdown";

export async function processContractBundle(): Promise<{
	readonly files: ProcessPluginFiles;
	cleanup(): Promise<void>;
}> {
	const temporary = await realpath(tmpdir());
	const root = await realpath(await mkdtemp(path.join(temporary, "draftyak-responses-contract-")));
	const owned = await lstat(root);
	let cleaned = false;
	const cleanup = async (): Promise<void> => {
		if (cleaned) return;
		if (
			path.dirname(root) !== temporary ||
			!path.basename(root).startsWith("draftyak-responses-contract-")
		)
			throw new Error("Provider contract cleanup boundary refused");
		const stat = await lstat(root);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.dev !== owned.dev ||
			stat.ino !== owned.ino ||
			stat.birthtimeMs !== owned.birthtimeMs ||
			(await realpath(root)) !== root
		)
			throw new Error("Provider contract cleanup ownership changed");
		await rm(root, { recursive: true, force: true });
		if (existsSync(root)) throw new Error("Provider contract cleanup left a directory");
		cleaned = true;
	};
	try {
		await build({
			config: false,
			entry: { server: fileURLToPath(new URL("./entry.ts", import.meta.url)) },
			outDir: root,
			platform: "node",
			format: "esm",
			target: "node26",
			fixedExtension: true,
			deps: { alwaysBundle: [/.*/] },
			// The fixture entry explicitly starts the imported production adapter once.
			define: { "import.meta.main": "false" },
			dts: false,
			sourcemap: false,
			clean: false,
			exports: false,
			report: false,
			logLevel: "warn",
			failOnWarn: true,
		});
		if ((await readdir(root)).sort().join() !== "server.mjs")
			throw new Error("Provider contract requires one self-contained module");
		const file = path.join(root, "server.mjs");
		const stat = await lstat(file);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.nlink !== 1 ||
			stat.size < 1 ||
			stat.size > 16 * 1024 ** 2 ||
			(await realpath(file)) !== file
		)
			throw new Error("Provider contract bundle inventory refused");
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
