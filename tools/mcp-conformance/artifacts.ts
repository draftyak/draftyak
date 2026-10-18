import { type BigIntStats, constants, type Dir } from "node:fs";
import { type FileHandle, lstat, open, opendir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRun, type Run } from "./gate.ts";
import { CONFORMANCE_VERSION, type Era, SCENARIOS } from "./policy.ts";

export const MAX_CHECK_BYTES: number = 4 * 1024 * 1024;
export const MAX_RUN_BYTES: number = 32 * 1024 * 1024;
export const MAX_DIRECTORY_ENTRIES: number = 128;
export const MAX_METADATA_BYTES: number = 65_536;
const refused = (): Error => new Error("Invalid conformance artifact file");
interface FileResource {
	readonly kind: "file";
	readonly handle: FileHandle;
	readonly close: () => Promise<void>;
	uncertain: boolean;
}
interface DirectoryResource {
	readonly kind: "directory";
	readonly handle: Dir;
	readonly close: () => Promise<void>;
	uncertain: boolean;
}
type Resource = FileResource | DirectoryResource;
// One operation can hold its directory plus one file. Failed cleanup retains the actual objects.
const resources = new Set<Resource>();
let active = false;
const canOpen = (): void => {
	if (resources.size >= 2) throw refused();
};
function retainFile(handle: FileHandle): FileResource {
	const close = handle.close.bind(handle);
	const resource = { kind: "file" as const, handle, close: () => close(), uncertain: false };
	resources.add(resource);
	return resource;
}
function retainDirectory(handle: Dir): DirectoryResource {
	const close = handle.close.bind(handle);
	const resource = { kind: "directory" as const, handle, close: () => close(), uncertain: false };
	resources.add(resource);
	return resource;
}
async function closeResource(resource: Resource): Promise<void> {
	if (!resources.has(resource)) return;
	if (resource.uncertain) throw refused();
	let failed = false;
	let directoryCloseSucceeded = false;
	for (let attempt = 0; attempt < (resource.kind === "file" ? 2 : 3); attempt++) {
		let closed = false;
		try {
			await resource.close();
			if (resource.kind === "directory") directoryCloseSucceeded = true;
		} catch (error) {
			// FileHandle retires its public fd before awaiting the native close. After a
			// rejection, fd === -1 cannot prove closure, and another close can be a no-op.
			if (resource.kind === "file" && resource.handle.fd === -1) {
				resource.uncertain = true;
				throw refused();
			}
			if (resource.kind === "directory") {
				// Dir marks itself closed before native completion. A marker after a rejected
				// close cannot prove the hidden native resource was released.
				closed =
					directoryCloseSucceeded && (error as NodeJS.ErrnoException).code === "ERR_DIR_CLOSED";
				if (!closed) {
					resource.uncertain = true;
					throw refused();
				}
			}
			if (!closed) failed = true;
		}
		// A resolved close is not evidence by itself. Never look up or close a numeric descriptor.
		if (resource.kind === "file") closed = resource.handle.fd === -1;
		if (closed) {
			resources.delete(resource);
			if (failed) throw refused();
			return;
		}
	}
	throw refused();
}
async function owned<T>(work: () => Promise<T>): Promise<T> {
	if (active) throw refused();
	active = true;
	try {
		for (const resource of resources) {
			try {
				await closeResource(resource);
			} catch {
				// Retry only retained original objects. No new allocation until every close is proved.
			}
		}
		if (resources.size !== 0) throw refused();
		return await work();
	} finally {
		active = false;
	}
}
const same = (left: BigIntStats, right: BigIntStats): boolean =>
	left.dev === right.dev &&
	left.ino === right.ino &&
	left.size === right.size &&
	left.mtimeNs === right.mtimeNs &&
	left.ctimeNs === right.ctimeNs;

async function readArtifact(
	file: string,
	maximum: number,
): Promise<{ readonly value: unknown; readonly bytes: number }> {
	let resource: FileResource | undefined;
	try {
		if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_CHECK_BYTES) throw refused();
		const before = await lstat(file, { bigint: true });
		if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximum))
			throw refused();
		// O_NOFOLLOW/O_NONBLOCK are unavailable on Windows; identity and path checks still apply.
		canOpen();
		const retained = retainFile(
			await open(
				file,
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
			),
		);
		resource = retained;
		const handle = retained.handle;
		const opened = await handle.stat({ bigint: true });
		if (
			!opened.isFile() ||
			!same(before, opened) ||
			!same(before, await lstat(file, { bigint: true }))
		)
			throw refused();
		const buffer = Buffer.alloc(Number(before.size) + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			const { bytesRead: count } = await handle.read(buffer, bytes, buffer.length - bytes, null);
			if (count === 0) break;
			bytes += count;
		}
		const after = await handle.stat({ bigint: true });
		if (
			bytes !== Number(before.size) ||
			bytes > maximum ||
			!same(before, after) ||
			!same(after, await lstat(file, { bigint: true }))
		)
			throw refused();
		return {
			value: JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)),
			),
			bytes,
		};
	} catch {
		throw refused();
	} finally {
		if (resource) await closeResource(resource);
	}
}

export async function readJson(
	file: string | URL,
	maxBytes: number = MAX_CHECK_BYTES,
): Promise<unknown> {
	try {
		// Snapshot a native URL before the cleanup await can yield to another turn.
		const filename = path.resolve(typeof file === "string" ? file : fileURLToPath(file));
		return await owned(async () => (await readArtifact(filename, maxBytes)).value);
	} catch {
		throw refused();
	}
}

/** Inspect metadata only; never import or run code from the supplied package. */
export async function verifyCliPackage(directory: string): Promise<void> {
	const metadata = (await readJson(path.join(directory, "package.json"), MAX_METADATA_BYTES)) as {
		name?: unknown;
		version?: unknown;
	};
	if (
		metadata?.name !== "@modelcontextprotocol/conformance" ||
		metadata.version !== CONFORMANCE_VERSION
	)
		throw new Error("Conformance CLI pin differs");
}

async function directorySnapshot(directory: string): Promise<BigIntStats> {
	const stat = await lstat(directory, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw refused();
	return stat;
}

/** A runner must capture run.json from the actual invocation, not infer it from check contents. */
export async function loadRun(directory: string, era: Era): Promise<Run> {
	try {
		directory = path.resolve(directory);
		return await owned(async () => {
			const root = await directorySnapshot(directory);
			const receipt = await readArtifact(path.join(directory, "run.json"), MAX_METADATA_BYTES);
			const metadata = receipt.value;
			if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw refused();
			let remaining = MAX_RUN_BYTES - receipt.bytes;
			let entries = 0;
			const checks: Record<string, unknown> = Object.create(null);
			canOpen();
			const resource = retainDirectory(await opendir(directory, { bufferSize: 1 }));
			const stream = resource.handle;
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
					const artifact = await readArtifact(
						path.join(target, "checks.json"),
						Math.min(MAX_CHECK_BYTES, remaining),
					);
					if (!same(before, await directorySnapshot(target))) throw refused();
					remaining -= artifact.bytes;
					checks[scenario] = artifact.value;
				}
			} finally {
				await closeResource(resource);
			}
			if (!same(root, await directorySnapshot(directory))) throw refused();
			const run = parseRun({ ...metadata, checks });
			if (run.era !== era) throw refused();
			return run;
		});
	} catch {
		throw new Error("Invalid conformance artifact directory");
	}
}
