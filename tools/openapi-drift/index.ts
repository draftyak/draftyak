import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatClientTypes } from "./format-types.ts";
import { generateOpenApiTypes, OpenApiTypesError } from "./schema-types.ts";

export type ClientGenerationErrorCode =
	| "INPUT_INVALID"
	| "OUTPUT_INVALID"
	| "FORMAT_FAILED"
	| "WRITE_FAILED"
	| "CLI_INVALID";

export class ClientGenerationError extends Error {
	readonly code: ClientGenerationErrorCode;
	constructor(code: ClientGenerationErrorCode) {
		super("Client type generation failed");
		this.name = "ClientGenerationError";
		this.code = code;
	}
}

export interface ClientGenerationOptions {
	readonly inputPath: string;
	readonly outputPath: string;
	readonly check: boolean;
}

export type ClientGenerationResult = "written" | "unchanged" | "different";

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(code: ClientGenerationErrorCode): never {
	throw new ClientGenerationError(code);
}

function missing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function unchanged(left: BigIntStats, right: BigIntStats): boolean {
	return (
		sameFile(left, right) &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs &&
		left.mode === right.mode
	);
}

function pathOption(value: unknown, code: ClientGenerationErrorCode): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 32_768 ||
		value.includes("\0")
	)
		return fail(code);
	return resolve(value);
}

async function readBounded(
	path: string,
	limit: number,
	code: ClientGenerationErrorCode,
): Promise<{ bytes: Buffer; stat: BigIntStats }> {
	try {
		const before = await lstat(path, { bigint: true });
		if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limit))
			return fail(code);
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const opened = await file.stat({ bigint: true });
			if (!opened.isFile() || !unchanged(before, opened)) return fail(code);
			const bytes = Buffer.allocUnsafe(limit + 1);
			let length = 0;
			while (length < bytes.length) {
				const result = await file.read(bytes, length, bytes.length - length, length);
				if (result.bytesRead === 0) break;
				length += result.bytesRead;
			}
			const after = await file.stat({ bigint: true });
			if (length > limit || BigInt(length) !== after.size || !unchanged(opened, after))
				return fail(code);
			return { bytes: bytes.subarray(0, length), stat: after };
		} finally {
			await file.close();
		}
	} catch {
		return fail(code);
	}
}

async function outputStat(path: string): Promise<BigIntStats | undefined> {
	try {
		const stat = await lstat(path, { bigint: true });
		if (!stat.isFile() || stat.isSymbolicLink()) return fail("OUTPUT_INVALID");
		return stat;
	} catch (error) {
		if (missing(error)) return undefined;
		return fail("OUTPUT_INVALID");
	}
}

async function directoryUnchanged(path: string, expected: BigIntStats): Promise<void> {
	const current = await lstat(path, { bigint: true });
	if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(current, expected))
		return fail("WRITE_FAILED");
	if (!samePath(await realpath(path), path)) return fail("WRITE_FAILED");
}

/** Renders completely before any mutation; the output parent must already exist. */
export async function generateClientTypes(
	options: ClientGenerationOptions,
): Promise<ClientGenerationResult> {
	if (options === null || typeof options !== "object" || typeof options.check !== "boolean")
		return fail("CLI_INVALID");
	const inputPath = pathOption(options.inputPath, "INPUT_INVALID");
	const requestedOutput = pathOption(options.outputPath, "OUTPUT_INVALID");
	const name = basename(requestedOutput);
	if (
		name.length === 0 ||
		Array.from(name).some((character) => character.charCodeAt(0) < 0x20) ||
		/[<>:"|?*]/.test(name) ||
		/[. ]$/.test(name) ||
		/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
	)
		return fail("OUTPUT_INVALID");
	const input = await readBounded(inputPath, MAX_INPUT_BYTES, "INPUT_INVALID");
	let document: unknown;
	try {
		if (input.bytes[0] === 0xef && input.bytes[1] === 0xbb && input.bytes[2] === 0xbf)
			return fail("INPUT_INVALID");
		document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
	} catch {
		return fail("INPUT_INVALID");
	}
	const raw = await generateOpenApiTypes(document);
	let formatted: string;
	try {
		formatted = await formatClientTypes(raw);
	} catch {
		return fail("FORMAT_FAILED");
	}
	const rendered = Buffer.from(formatted, "utf8");
	if (rendered.length > MAX_OUTPUT_BYTES) return fail("OUTPUT_INVALID");
	let directory: string;
	let directoryStat: BigIntStats;
	try {
		directory = await realpath(dirname(requestedOutput));
		directoryStat = await lstat(directory, { bigint: true });
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
			return fail("OUTPUT_INVALID");
	} catch (error) {
		if (options.check && missing(error)) return "different";
		return fail("OUTPUT_INVALID");
	}
	const output = join(directory, name);
	if (!samePath(dirname(output), directory) || samePath(inputPath, output))
		return fail("OUTPUT_INVALID");
	const previous = await outputStat(output);
	if (previous !== undefined && sameFile(previous, input.stat)) return fail("OUTPUT_INVALID");
	if (previous !== undefined && previous.size === BigInt(rendered.length)) {
		const current = await readBounded(output, MAX_OUTPUT_BYTES, "OUTPUT_INVALID");
		if (!unchanged(previous, current.stat)) return fail("OUTPUT_INVALID");
		if (current.bytes.equals(rendered)) return "unchanged";
	}
	if (options.check) return "different";
	const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
	if (!samePath(dirname(temporary), directory)) return fail("WRITE_FAILED");
	let ownedTemporary: BigIntStats | undefined;
	try {
		await directoryUnchanged(directory, directoryStat);
		const file = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			0o644,
		);
		try {
			ownedTemporary = await file.stat({ bigint: true });
			await file.writeFile(rendered);
			await file.sync();
			ownedTemporary = await file.stat({ bigint: true });
			if (ownedTemporary.size !== BigInt(rendered.length)) return fail("WRITE_FAILED");
		} finally {
			await file.close();
		}
		await directoryUnchanged(directory, directoryStat);
		const current = await outputStat(output);
		if (
			(previous === undefined && current !== undefined) ||
			(previous !== undefined && (current === undefined || !unchanged(previous, current)))
		)
			return fail("WRITE_FAILED");
		const staged = await lstat(temporary, { bigint: true });
		if (!staged.isFile() || staged.isSymbolicLink() || !unchanged(staged, ownedTemporary))
			return fail("WRITE_FAILED");
		await rename(temporary, output);
		return "written";
	} catch {
		if (ownedTemporary !== undefined) {
			try {
				await directoryUnchanged(directory, directoryStat);
				const current = await lstat(temporary, { bigint: true });
				if (current.isFile() && !current.isSymbolicLink() && sameFile(current, ownedTemporary))
					await unlink(temporary);
			} catch {
				// Never remove a replacement path or a file in a changed directory.
			}
		}
		return fail("WRITE_FAILED");
	}
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
	try {
		let inputPath = join(ROOT, "apps/hub/openapi.json");
		let outputPath = join(ROOT, "packages/client/src/generated.ts");
		let check = false;
		const seen = new Set<string>();
		for (let index = args[0] === "--" ? 1 : 0; index < args.length; index++) {
			const flag = args[index];
			if (typeof flag !== "string" || seen.has(flag)) return fail("CLI_INVALID");
			seen.add(flag);
			if (flag === "--check") check = true;
			else if (flag === "--input" || flag === "--output") {
				const value = args[++index];
				if (typeof value !== "string" || value.length === 0 || value.startsWith("--"))
					return fail("CLI_INVALID");
				if (flag === "--input") inputPath = value;
				else outputPath = value;
			} else return fail("CLI_INVALID");
		}
		const result = await generateClientTypes({ inputPath, outputPath, check });
		if (result === "different") {
			console.error("Client types differ");
			return 1;
		}
		console.log(result === "written" ? "Client types written" : "Client types unchanged");
		return 0;
	} catch (error) {
		if (error instanceof ClientGenerationError || error instanceof OpenApiTypesError)
			console.error(`Client type generation failed: ${error.code}`);
		else console.error("Client type generation failed");
		return 1;
	}
}

if (
	process.argv[1] !== undefined &&
	samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))
) {
	void main().then((code) => {
		process.exitCode = code;
	});
}
