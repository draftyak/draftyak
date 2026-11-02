import { isProxy } from "node:util/types";
import { assertPortableFileTree, portableRelativePath } from "@draftyak/bounded-files";

export { readBoundedRegularFile } from "@draftyak/bounded-files";

export interface FileRecord {
	readonly path: string;
	readonly sha256: string;
	readonly bytes: number;
}

interface FileRecordPolicy {
	readonly maximumPathLength: number;
	readonly maximumRecords?: number;
	readonly maximumBytes: number;
	readonly order: "sort" | "require-sorted";
}

export const BUNDLE_FILE_POLICY: FileRecordPolicy = Object.freeze({
	maximumPathLength: 240,
	maximumRecords: 20_000,
	maximumBytes: 512 * 1024 * 1024,
	order: "sort",
});

// A release record describes a file; the separate byte reader retains its own 256 MiB cap.
export const RELEASE_FILE_POLICY: FileRecordPolicy = Object.freeze({
	maximumPathLength: 4096,
	maximumBytes: Number.MAX_SAFE_INTEGER,
	order: "require-sorted",
});

/** Preserve portable spelling while excluding state, credentials and device aliases. */
export function artifactPath(value: unknown, maximumLength: number): string {
	try {
		const file = portableRelativePath(value, {
			maximumLength,
			maximumComponents: maximumLength,
			maximumComponentLength: maximumLength,
		});
		if (
			file
				.split("/")
				.some(
					(part) =>
						/^\.env|^\.git$|\.(?:key|p12|pfx|db|sqlite|sqlite3|log)$/i.test(part) ||
						/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(
							part.split(".")[0]?.trimEnd() ?? "",
						),
				)
		)
			throw new Error();
		return file;
	} catch {
		throw new Error("unsafe or private-state relative file path");
	}
}

function record(value: unknown, policy: FileRecordPolicy): FileRecord {
	if (value === null || typeof value !== "object" || isProxy(value))
		throw new Error("expected an inert file record");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		throw new Error("expected an inert file record");
	const keys = Reflect.ownKeys(value);
	const fields: Record<string, unknown> = Object.create(null);
	if (keys.length !== 3) throw new Error("file record requires path, SHA-256 and byte count");
	for (const key of keys) {
		if (typeof key !== "string" || !["path", "sha256", "bytes"].includes(key))
			throw new Error("unsupported file record field");
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
			throw new Error("expected inert file record fields");
		fields[key] = descriptor.value;
	}
	const file = artifactPath(fields.path, policy.maximumPathLength);
	const sha256 = fields.sha256;
	if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256))
		throw new Error("invalid SHA-256 in file record");
	const bytes = fields.bytes;
	if (
		typeof bytes !== "number" ||
		!Number.isSafeInteger(bytes) ||
		bytes < 0 ||
		bytes > policy.maximumBytes
	)
		throw new Error("invalid byte count in file record");
	return { path: file, sha256, bytes };
}

/** Snapshot one file list, checking its whole tree before applying consumer ordering. */
export function fileRecords(value: unknown, policy: FileRecordPolicy): FileRecord[] {
	if (
		value === null ||
		typeof value !== "object" ||
		isProxy(value) ||
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype
	)
		throw new Error("expected an inert nonempty file list");
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		!Number.isSafeInteger(length) ||
		length < 1 ||
		(policy.maximumRecords !== undefined && length > policy.maximumRecords) ||
		Reflect.ownKeys(value).length !== length + 1
	)
		throw new Error("file list is empty, sparse or exceeds its record limit");
	const files: FileRecord[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
			throw new Error("expected inert file list entries");
		files.push(record(descriptor.value, policy));
	}
	try {
		assertPortableFileTree(files.map((file) => file.path));
	} catch {
		throw new Error("duplicate, case-aliased/colliding path or file is also a directory");
	}
	if (policy.order === "require-sorted") {
		for (let index = 1; index < files.length; index++)
			if ((files[index]?.path ?? "") < (files[index - 1]?.path ?? ""))
				throw new Error("unsorted file records");
		return files;
	}
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
