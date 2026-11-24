import { isProxy } from "node:util/types";
import { MAX_FILES } from "../../artifacts/archive.ts";
import type { FileDigest, InstalledBundle } from "../../artifacts/index.ts";

function invalid(): never {
	throw new TypeError("Invalid plugin process bundle");
}

function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) invalid();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== Object.prototype && prototype !== null) invalid();
	const names = Reflect.ownKeys(raw);
	if (names.length !== keys.length) invalid();
	const retained: Record<string, unknown> = Object.create(null);
	for (const name of names) {
		if (typeof name !== "string" || !keys.includes(name)) invalid();
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
		retained[name] = descriptor.value;
	}
	return retained;
}

function string(raw: unknown): string {
	if (typeof raw !== "string") invalid();
	return raw;
}

function file(raw: unknown): FileDigest {
	const retained = record(raw, ["path", "bytes", "sha256"]);
	const bytes = retained.bytes;
	if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) invalid();
	return Object.freeze({ path: string(retained.path), bytes, sha256: string(retained.sha256) });
}

/** Retain inert input data before asynchronous artifact verification and launch. */
export function retainInstalledBundle(raw: InstalledBundle): InstalledBundle {
	try {
		const bundle = record(raw, ["directory", "inventory"]);
		const inventory = record(bundle.inventory, ["name", "version", "integrity", "entry", "files"]);
		const input = inventory.files;
		if (
			input === null ||
			typeof input !== "object" ||
			isProxy(input) ||
			!Array.isArray(input) ||
			Object.getPrototypeOf(input) !== Array.prototype
		)
			invalid();
		const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
		if (
			typeof length !== "number" ||
			!Number.isSafeInteger(length) ||
			length < 1 ||
			length > MAX_FILES ||
			Reflect.ownKeys(input).length !== length + 1
		)
			invalid();
		const files: FileDigest[] = [];
		for (let index = 0; index < length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
			files.push(file(descriptor.value));
		}
		return Object.freeze({
			directory: string(bundle.directory),
			inventory: Object.freeze({
				name: string(inventory.name),
				version: string(inventory.version),
				integrity: string(inventory.integrity),
				entry: string(inventory.entry),
				files: Object.freeze(files),
			}),
		});
	} catch {
		invalid();
	}
}
