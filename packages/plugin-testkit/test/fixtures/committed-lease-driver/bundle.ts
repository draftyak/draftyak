import { lstat, mkdtemp, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import type { ProcessPluginFiles } from "../../../src/process.ts";

export interface CommittedLeaseBundle {
	readonly files: ProcessPluginFiles;
	close(): Promise<void>;
}

export async function bundleCommittedLease(): Promise<CommittedLeaseBundle> {
	const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "dytest-committed-lease-"));
	const root = await lstat(directory, { bigint: true });
	const output = path.join(directory, "main.mjs");
	let member: { dev: bigint; ino: bigint } | undefined;
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closing ??= (async () => {
			const current = await lstat(directory, { bigint: true });
			if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== root.dev || current.ino !== root.ino)
				throw new Error("DYTEST bundle directory changed");
			const names = await readdir(directory);
			if (names.length !== (member ? 1 : 0) || (member && names[0] !== "main.mjs"))
				throw new Error("DYTEST unexpected bundle files");
			if (member) {
				const actual = await lstat(output, { bigint: true });
				if (!actual.isFile() || actual.isSymbolicLink() || actual.dev !== member.dev || actual.ino !== member.ino)
					throw new Error("DYTEST bundle file changed");
				await unlink(output);
			}
			await rmdir(directory);
		})();
		return closing;
	};
	try {
		await build({
			config: false, entry: { main: fileURLToPath(new URL("./entry.ts", import.meta.url)) },
			outDir: directory, format: "esm", platform: "node", target: "node26",
			fixedExtension: true, noExternal: [/.*/], dts: false, sourcemap: false, clean: false,
		});
		const actual = await lstat(output, { bigint: true });
		if (!actual.isFile() || actual.isSymbolicLink()) throw new Error("DYTEST bundle output refused");
		member = { dev: actual.dev, ino: actual.ino };
		if ((await readdir(directory)).join() !== "main.mjs") throw new Error("DYTEST unexpected bundle output");
		return { files: Object.freeze({ directory, entry: "main.mjs", files: Object.freeze(["main.mjs"]) }), close };
	} catch (error) {
		try { await close(); }
		catch (cleanup) { throw new AggregateError([error, cleanup], "DYTEST bundle setup and cleanup failed"); }
		throw error;
	}
}
