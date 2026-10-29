import { createHash, timingSafeEqual } from "node:crypto";
import { isProxy } from "node:util/types";
import { parseStrict } from "@draftyak/protocol/jcs";
import { ArtifactError, portablePath, snapshotArchive, unpackTarball } from "./archive.ts";
import type { PackageLock, PreparedPackage } from "./index.ts";

const versionPattern =
	/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Snapshot the exact native lock fields; no package metadata chooses its trusted pin. */
export function snapshotPackageLock(raw: unknown): PackageLock {
	try {
		if (
			raw === null ||
			typeof raw !== "object" ||
			isProxy(raw) ||
			![Object.prototype, null].includes(Object.getPrototypeOf(raw))
		)
			throw new ArtifactError();
		const fields: Record<string, string> = Object.create(null);
		const keys = Reflect.ownKeys(raw);
		if (keys.length !== 4) throw new ArtifactError();
		for (const key of keys) {
			if (typeof key !== "string" || !["name", "version", "integrity", "entry"].includes(key))
				throw new ArtifactError();
			const field = Object.getOwnPropertyDescriptor(raw, key);
			if (!field?.enumerable || !("value" in field) || typeof field.value !== "string")
				throw new ArtifactError();
			fields[key] = field.value;
		}
		const { name, version, integrity, entry } = fields;
		if (
			!name ||
			name.length > 214 ||
			/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.exec(name)?.[0] !== name ||
			!version ||
			version.length > 128 ||
			!integrity ||
			/^sha512-[A-Za-z0-9+/]{86}==$/.exec(integrity)?.[0] !== integrity
		)
			throw new ArtifactError();
		const match = versionPattern.exec(version);
		if (
			match?.[0] !== version ||
			match[4]
				?.split(".")
				.some((part) => /^[0-9]+$/.test(part) && part.length > 1 && part[0] === "0")
		)
			throw new ArtifactError();
		const expected = Buffer.from(integrity.slice(7), "base64");
		if (expected.length !== 64 || expected.toString("base64") !== integrity.slice(7))
			throw new ArtifactError();
		return Object.freeze({ name, version, integrity, entry: portablePath(entry) });
	} catch {
		throw new ArtifactError();
	}
}

/** Pin and parse one owned byte snapshot synchronously; no materialization or load authority. */
export function preparePinnedPackage(rawArchive: unknown, rawLock: PackageLock): PreparedPackage {
	try {
		const archive = snapshotArchive(rawArchive);
		const lock = snapshotPackageLock(rawLock);
		const expected = Buffer.from(lock.integrity.slice(7), "base64");
		const actual = createHash("sha512").update(archive).digest();
		if (!timingSafeEqual(actual, expected)) throw new ArtifactError();
		const files = unpackTarball(archive);
		const manifest = files.get("package.json");
		if (!files.has(lock.entry) || !manifest) throw new ArtifactError();
		const metadata = parseStrict(manifest);
		if (
			metadata === null ||
			typeof metadata !== "object" ||
			Array.isArray(metadata) ||
			!Object.hasOwn(metadata, "name") ||
			!Object.hasOwn(metadata, "version") ||
			!Object.hasOwn(metadata, "type")
		)
			throw new ArtifactError();
		const data = metadata as Record<string, unknown>;
		if (data.name !== lock.name || data.version !== lock.version || data.type !== "module")
			throw new ArtifactError();
		const rows = [...files]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([path, bytes]) =>
				Object.freeze({
					path,
					bytes: bytes.length,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				}),
			);
		return Object.freeze({
			inventory: Object.freeze({ ...lock, files: Object.freeze(rows) }),
			files,
			metadata: Object.freeze(data),
		});
	} catch {
		throw new ArtifactError();
	}
}
