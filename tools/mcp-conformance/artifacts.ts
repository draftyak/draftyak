import type { BigIntStats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readBoundedRegularFile } from "@draftyak/bounded-files";
import { parseRun, type Run } from "./gate.ts";
import { type Era, SCENARIOS } from "./policy.ts";
import { assertPinnedReferee } from "./referee.ts";

export const MAX_CHECK_BYTES: number = 4 * 1024 * 1024;
export const MAX_RUN_BYTES: number = 32 * 1024 * 1024;
export const MAX_DIRECTORY_ENTRIES: number = 128;
export const MAX_METADATA_BYTES: number = 65_536;
const refused = (): Error => new Error("Invalid conformance artifact file");
const same = (left: BigIntStats, right: BigIntStats): boolean =>
	left.dev === right.dev &&
	left.ino === right.ino &&
	left.size === right.size &&
	left.mtimeNs === right.mtimeNs &&
	left.ctimeNs === right.ctimeNs;

function readArtifact(
	file: string,
	maximum: number,
): { readonly value: unknown; readonly bytes: number } {
	try {
		if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_CHECK_BYTES) throw refused();
		const bytes = readBoundedRegularFile(file, { maximum });
		return {
			value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
			bytes: bytes.length,
		};
	} catch {
		throw refused();
	}
}

export async function readJson(
	file: string | URL,
	maxBytes: number = MAX_CHECK_BYTES,
): Promise<unknown> {
	try {
		// Capture a native URL before any asynchronous work; preserve raw string spelling.
		const filename = typeof file === "string" ? file : fileURLToPath(file);
		return readArtifact(filename, maxBytes).value;
	} catch {
		throw refused();
	}
}

const require = createRequire(import.meta.url);

/** Resolve the package-local, lock-pinned referee entry point without executing it. */
export function refereeEntryPoint(): string {
	return path.join(
		path.dirname(require.resolve("@modelcontextprotocol/conformance/package.json")),
		"dist/index.js",
	);
}

/** Inspect the locally resolved dependency; no caller-selected package can supply the pin. */
export async function verifyCliPackage(): Promise<void> {
	// Fixed installed dependency JSON is trusted metadata, not a caller-supplied artifact.
	const resolved = require.resolve("@modelcontextprotocol/conformance/package.json");
	const { default: metadata } = await import(pathToFileURL(resolved).href, {
		with: { type: "json" },
	});
	assertPinnedReferee(metadata);
}

async function directorySnapshot(directory: string): Promise<BigIntStats> {
	const stat = await lstat(directory, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw refused();
	return stat;
}

/** Admit directory spelling before child paths or directory I/O can erase it. */
function artifactDirectory(raw: string): string {
	if (
		typeof raw !== "string" ||
		!raw.isWellFormed() ||
		raw.length > 4096 ||
		!path.isAbsolute(raw) ||
		/^[/\\]{2}/.test(raw) ||
		(process.platform === "win32" && raw.slice(/^[a-z]:\\/i.test(raw) ? 2 : 0).includes(":"))
	)
		throw refused();
	const directory = path.resolve(raw);
	if (raw !== directory && (directory.endsWith(path.sep) || raw !== directory + path.sep))
		throw refused();
	return directory;
}

/** A runner must capture run.json from the actual invocation, not infer it from check contents. */
export async function loadRun(directory: string, era: Era): Promise<Run> {
	try {
		directory = artifactDirectory(directory);
		const root = await directorySnapshot(directory);
		const receipt = readArtifact(path.join(directory, "run.json"), MAX_METADATA_BYTES);
		const metadata = receipt.value;
		if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw refused();
		let remaining = MAX_RUN_BYTES - receipt.bytes;
		let entries = 0;
		const checks: Record<string, unknown> = Object.create(null);
		const stream = await opendir(directory, { bufferSize: 1 });
		try {
			for (let entry = await stream.read(); entry; entry = await stream.read()) {
				if (++entries > MAX_DIRECTORY_ENTRIES) throw refused();
				if (entry.name === "run.json") continue;
				const scenario = /^server-(.+)-\d{4}-\d\d-\d\dT[\d-]+Z$/.exec(entry.name)?.[1];
				if (!scenario) {
					if (entry.name.startsWith("server-")) throw refused();
					continue;
				}
				if (
					!entry.isDirectory() ||
					entry.isSymbolicLink() ||
					!SCENARIOS[era].includes(scenario) ||
					Object.hasOwn(checks, scenario)
				)
					throw refused();
				const target = path.join(directory, entry.name),
					before = await directorySnapshot(target);
				const artifact = readArtifact(
					path.join(target, "checks.json"),
					Math.min(MAX_CHECK_BYTES, remaining),
				);
				if (!same(before, await directorySnapshot(target))) throw refused();
				remaining -= artifact.bytes;
				checks[scenario] = artifact.value;
			}
		} finally {
			await stream.close();
		}
		if (!same(root, await directorySnapshot(directory))) throw refused();
		const run = parseRun({ ...metadata, checks });
		if (run.era !== era || !run.args[8] || path.resolve(run.args[8]) !== directory) throw refused();
		return run;
	} catch {
		throw new Error("Invalid conformance artifact directory");
	}
}
