import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export class ClientFormatError extends Error {
	readonly code = "CLIENT_FORMAT_FAILED";

	constructor() {
		super("Client type formatting failed");
		this.name = "ClientFormatError";
	}
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GENERATED = resolve(ROOT, "packages/client/src/generated.ts");
const MAX_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const TIMEOUT_MS = 15_000;
const require = createRequire(import.meta.url);

function fail(): never {
	throw new ClientFormatError();
}

/** Resolve only declared and selected package metadata, never implementation text. */
async function biomeBin(): Promise<string> {
	const metadataPath = require.resolve("@biomejs/biome/package.json");
	const metadataBytes = await readFile(metadataPath);
	if (metadataBytes.byteLength > 65_536) fail();
	const metadata: unknown = JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes),
	);
	if (metadata === null || typeof metadata !== "object") fail();
	const item = metadata as Record<string, unknown>;
	if (item.name !== "@biomejs/biome" || item.version !== "2.5.15") fail();
	if (
		!["win32", "darwin", "linux"].includes(process.platform) ||
		!["x64", "arm64"].includes(process.arch)
	)
		fail();
	// Only the declared GNU Linux package is selected; no musl package is supported.
	const selected = `@biomejs/cli-${process.platform}-${process.arch}`;
	const dependencies = item.optionalDependencies;
	if (
		dependencies === null ||
		typeof dependencies !== "object" ||
		(dependencies as Record<string, unknown>)[selected] !== "2.5.15"
	)
		fail();
	const nativeRequire = createRequire(metadataPath);
	const nativeMetadataPath = nativeRequire.resolve(`${selected}/package.json`);
	const nativeMetadataBytes = await readFile(nativeMetadataPath);
	if (nativeMetadataBytes.byteLength > 65_536) fail();
	const nativeMetadata: unknown = JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(nativeMetadataBytes),
	);
	if (nativeMetadata === null || typeof nativeMetadata !== "object") fail();
	const native = nativeMetadata as Record<string, unknown>;
	if (native.name !== selected || native.version !== "2.5.15") fail();
	const packageRoot = dirname(nativeMetadataPath);
	// The native executable is adjacent to its selected package metadata.
	const target = resolve(packageRoot, process.platform === "win32" ? "biome.exe" : "biome");
	const child = relative(packageRoot, target);
	if (child.length === 0 || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`))
		fail();
	return target;
}

/**
 * Formats staged types with the declared CLI and ordinary root configuration.
 * The caller publishes or compares these exact bytes only after this promise resolves.
 * This function owns its formatter child, not the destination file or any install.
 */
export async function formatClientTypes(raw: string): Promise<string> {
	try {
		if (
			typeof raw !== "string" ||
			raw.length > MAX_BYTES ||
			Buffer.byteLength(raw, "utf8") > MAX_BYTES
		)
			fail();
		const input = Buffer.from(raw, "utf8");
		if (input.toString("utf8") !== raw) fail();
		const bin = await biomeBin();
		const output = Buffer.alloc(MAX_BYTES);
		const child = spawn(bin, ["format", "--stdin-file-path", GENERATED, "--config-path", ROOT], {
			cwd: ROOT,
			shell: false,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let failed = false;
		let closed = false;
		let killAttempted = false;
		let outputLength = 0;
		let stderrLength = 0;
		function stop(): void {
			failed = true;
			if (closed || killAttempted) return;
			killAttempted = true;
			try {
				child.kill("SIGKILL");
			} catch {
				/* Still join the actual child close event. */
			}
		}
		const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
			(resolveClose) => {
				child.once("close", (code, signal) => {
					closed = true;
					resolveClose({ code, signal });
				});
			},
		);
		child.on("error", stop);
		child.stdin?.on("error", stop);
		child.stdout?.on("error", stop);
		child.stderr?.on("error", stop);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (failed) return;
			if (chunk.byteLength > MAX_BYTES - outputLength) {
				stop();
				return;
			}
			chunk.copy(output, outputLength);
			outputLength += chunk.byteLength;
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (failed) return;
			if (chunk.byteLength > MAX_STDERR_BYTES - stderrLength) {
				stop();
				return;
			}
			stderrLength += chunk.byteLength;
		});
		const timeout = setTimeout(stop, TIMEOUT_MS);
		let outcome: { code: number | null; signal: NodeJS.Signals | null };
		try {
			if (child.stdin === null || child.stdout === null || child.stderr === null) stop();
			try {
				if (!failed) child.stdin?.end(input);
			} catch {
				stop();
			}
			outcome = await completion;
		} finally {
			clearTimeout(timeout);
		}
		if (
			failed ||
			outcome.code !== 0 ||
			outcome.signal !== null ||
			(input.length > 0 && outputLength === 0)
		)
			fail();
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			output.subarray(0, outputLength),
		);
	} catch {
		throw new ClientFormatError();
	}
}
