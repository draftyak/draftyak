import { existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import type { ProcessPluginFiles } from "../../../src/index.ts";
import type { CompatibleFixtureFormat } from "./plugin.ts";

const entries: Record<CompatibleFixtureFormat, string> = {
	json_schema: "./server-json-schema.ts",
	json_object: "./server-json-object.ts",
	ollama: "./server-ollama.ts",
};

export async function compatibleProcessFixture(format: CompatibleFixtureFormat): Promise<{
	readonly files: ProcessPluginFiles;
	cleanup(): Promise<void>;
}> {
	const temporary = await realpath(tmpdir());
	const root = await realpath(await mkdtemp(path.join(temporary, "draftyak-compatible-provider-")));
	const born = await lstat(root, { bigint: true });
	let cleaned = false;
	let closing: Promise<void> | undefined;
	const cleanup = (): Promise<void> => {
		if (cleaned) return Promise.resolve();
		if (closing) return closing;
		closing = (async () => {
			const current = await lstat(root, { bigint: true });
			if (
				path.dirname(root) !== temporary ||
				!path.basename(root).startsWith("draftyak-compatible-provider-") ||
				current.isSymbolicLink() ||
				current.dev !== born.dev ||
				current.ino !== born.ino ||
				current.birthtimeNs !== born.birthtimeNs ||
				(await realpath(root)) !== root
			)
				throw new Error("DYTEST compatible fixture cleanup root changed");
			await rm(root, { recursive: true, force: true });
			if (existsSync(root)) throw new Error("DYTEST compatible fixture cleanup left a directory");
			cleaned = true;
		})().catch((error: unknown) => {
			closing = undefined;
			throw error;
		});
		return closing;
	};
	try {
		await build({
			config: false,
			entry: { server: fileURLToPath(new URL(entries[format], import.meta.url)) },
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
			throw new Error("DYTEST compatible fixture must be one self-contained module");
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
