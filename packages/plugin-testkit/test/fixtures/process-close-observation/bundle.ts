import { lstat, mkdtemp, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import type { ProcessPluginFiles } from "../../../src/process.ts";
import type { CloseMode } from "./plugin.ts";

export async function bundleCloseObservation(): Promise<{
	files(mode: CloseMode): ProcessPluginFiles;
	close(): Promise<void>;
}> {
	const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "DYTEST-close-observation-"));
	const before = await lstat(directory, { bigint: true });
	const entry = path.join(directory, "main.mjs");
	let member: { dev: bigint; ino: bigint } | undefined;
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closing ??= (async () => {
			const current = await lstat(directory, { bigint: true });
			if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino)
				throw new Error("DYTEST bundle directory changed");
			const names = await readdir(directory);
			if (names.length !== (member ? 1 : 0) || (member && names[0] !== "main.mjs"))
				throw new Error("DYTEST unexpected bundle files");
			if (member) {
				const actual = await lstat(entry, { bigint: true });
				if (!actual.isFile() || actual.isSymbolicLink() || actual.dev !== member.dev || actual.ino !== member.ino)
					throw new Error("DYTEST bundle file changed");
				await unlink(entry);
			}
			await rmdir(directory);
		})();
		return closing;
	};
	try {
		await build({
			config: false,
			entry: { main: fileURLToPath(new URL("./entry.ts", import.meta.url)) },
			outDir: directory,
			format: "esm",
			platform: "node",
			target: "node26",
			fixedExtension: true,
			noExternal: [/.*/],
			dts: false,
			sourcemap: false,
			clean: false,
		});
		const actual = await lstat(entry, { bigint: true });
		if (!actual.isFile() || actual.isSymbolicLink()) throw new Error("DYTEST bundle output refused");
		member = { dev: actual.dev, ino: actual.ino };
		if ((await readdir(directory)).join() !== "main.mjs") throw new Error("DYTEST unexpected bundle output");
		return {
			files: (mode) => Object.freeze({ directory, entry: "main.mjs", files: Object.freeze(["main.mjs"]), args: Object.freeze([mode]) }),
			close,
		};
	} catch (error) {
		try { await close(); }
		catch (cleanup) { throw new AggregateError([error, cleanup], "DYTEST bundle setup and cleanup failed"); }
		throw error;
	}
}
