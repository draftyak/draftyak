import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

export interface SourceCopies {
	// The first file's module, imported from a fresh copy of every file, with `from` replaced by `to`
	// in that first file; `from` must be there exactly once. With no change the copy is byte for byte.
	load<T>(change?: readonly [from: string, to: string]): Promise<T>;
	remove(): void;
}

// Copies of this repository's source files (paths below its root, with / separators), each set in a
// folder of its own under the system temp folder at the same paths, so their relative imports load
// the copies: mutation cases remove a check from a copy and run a committed case's input through it.
export function sourceCopies(files: readonly [string, ...string[]]): SourceCopies {
	const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-ci-checks-copies-")));
	let serial = 0;
	return {
		async load<T>(change?: readonly [string, string]): Promise<T> {
			const dir = path.join(base, String(++serial));
			for (const file of files) {
				mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
				writeFileSync(path.join(dir, file), readFileSync(path.join(repoRoot, file)));
			}
			const entry = path.join(dir, files[0]);
			if (change !== undefined) {
				const [from, to] = change;
				const parts = readFileSync(entry, "utf8").split(from);
				if (parts.length !== 2)
					throw new Error(`${files[0]} must hold ${JSON.stringify(from)} once`);
				writeFileSync(entry, parts.join(to));
			}
			return (await import(pathToFileURL(entry).href)) as T;
		},
		remove: () => rmSync(base, { recursive: true, force: true }),
	};
}
