import { lstatSync, opendirSync, realpathSync } from "node:fs";
import path from "node:path";
import { types } from "node:util";
import type { ExtensionRegistry } from "./registry.ts";
import { isMigrationDirectoryPath, migrationNumber } from "./validation.ts";

export interface HubModule<Id extends string = string> {
	readonly id: Id;
	readonly version: string;
	readonly migrations?: string;
	readonly register: (registry: ExtensionRegistry<Id>) => Promise<void>;
}

const refused = (): Error => new Error("Extension module definition refused");
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const versionPattern =
	/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function migrationDirectory(directory: string): string {
	if (!isMigrationDirectoryPath(directory)) throw refused();
	const absolute = path.resolve(directory);
	const canonical = realpathSync(absolute);
	const comparable = (value: string): string =>
		process.platform === "win32" ? value.toLowerCase() : value;
	if (comparable(absolute) !== comparable(canonical) || !lstatSync(absolute).isDirectory())
		throw refused();
	const numbers = new Set<string>();
	const entries = opendirSync(canonical);
	try {
		for (let count = 0; ; count++) {
			const entry = entries.readSync();
			if (entry === null) break;
			if (count >= 256) throw refused();
			const number = migrationNumber(entry.name);
			if (!number || numbers.has(number) || !entry.isFile()) throw refused();
			const file = lstatSync(path.join(canonical, entry.name));
			if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw refused();
			numbers.add(number);
		}
	} finally {
		entries.closeSync();
	}
	return canonical;
}

/** Descriptor validation only; no module code, SQL, listener or authority is executed here. */
export function defineExtensionModule<const Id extends string>(
	definition: HubModule<Id>,
): HubModule<Id> {
	try {
		if (
			definition === null ||
			typeof definition !== "object" ||
			types.isProxy(definition) ||
			Object.getPrototypeOf(definition) !== Object.prototype
		)
			throw refused();
		const properties = Object.getOwnPropertyDescriptors(definition);
		const names = Reflect.ownKeys(properties);
		if (
			names.some(
				(name) =>
					typeof name !== "string" || !["id", "version", "migrations", "register"].includes(name),
			)
		)
			throw refused();
		if (Object.values(properties).some((property) => !Object.hasOwn(property, "value")))
			throw refused();
		const id: unknown = properties.id?.value;
		const version: unknown = properties.version?.value;
		const register: unknown = properties.register?.value;
		const migrations: unknown = properties.migrations?.value;
		if (
			typeof id !== "string" ||
			identifier.exec(id)?.[0] !== id ||
			typeof version !== "string" ||
			version.length > 128 ||
			typeof register !== "function" ||
			types.isProxy(register)
		)
			throw refused();
		const match = versionPattern.exec(version);
		if (
			!match ||
			match[0] !== version ||
			match[4]
				?.split(".")
				.some((part) => /^[0-9]+$/.test(part) && part.length > 1 && part.startsWith("0"))
		)
			throw refused();
		if (migrations !== undefined && typeof migrations !== "string") throw refused();
		const directory =
			migrations === undefined ? undefined : migrationDirectory(migrations as string);
		return Object.freeze({
			id: id as Id,
			version,
			...(directory === undefined ? {} : { migrations: directory }),
			register: register as HubModule<Id>["register"],
		});
	} catch {
		throw refused();
	}
}
