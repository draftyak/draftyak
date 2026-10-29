import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";

export interface PackedFixture {
	readonly directory: string;
	readonly entry: "server.mjs";
	readonly files: readonly ["server.mjs"];
}

export interface ProcessBundles {
	readonly channel: PackedFixture;
	readonly probe: PackedFixture;
	readonly tool: PackedFixture;
	cleanup(): Promise<void>;
}

/** Real bundled SDK servers, staged without access to the workspace's node_modules. */
export async function processBundles(): Promise<ProcessBundles> {
	const temporary = await realpath(tmpdir());
	const root = await realpath(await mkdtemp(path.join(temporary, "draftyak-testkit-process-")));
	let cleaned = false;
	const cleanup = async (): Promise<void> => {
		if (cleaned) return;
		if (
			path.dirname(root) !== temporary ||
			!path.basename(root).startsWith("draftyak-testkit-process-") ||
			(await lstat(root)).isSymbolicLink() ||
			(await realpath(root)) !== root
		)
			throw new Error("Process fixture cleanup root changed");
		await rm(root, { recursive: true, force: true });
		cleaned = true;
	};
	async function bundle(name: string, source: string): Promise<PackedFixture> {
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
			throw new Error("Process fixture must be one self-contained module");
		return Object.freeze({ directory, entry: "server.mjs", files: ["server.mjs"] as const });
	}
	try {
		const channel = await bundle("channel", "./fixtures/channel/server.ts");
		const probe = await bundle("probe", "./fixtures/process-probe/server.ts");
		const tool = await bundle("tool", "./fixtures/process-tool/server.ts");
		return Object.freeze({ channel, probe, tool, cleanup });
	} catch (error) {
		await cleanup();
		throw error;
	}
}
