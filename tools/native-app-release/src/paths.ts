import path from "node:path";
import { portableRelativePath } from "@draftyak/bounded-files";

export type NativeAppReleaseCode = "manifest" | "path" | "file" | "bounds" | "state" | "cleanup";

export class NativeAppReleaseError extends Error {
	readonly code: NativeAppReleaseCode;
	constructor(code: NativeAppReleaseCode) {
		super("Native application release operation refused.");
		this.name = "NativeAppReleaseError";
		this.code = code;
	}
}

export function refuse(code: NativeAppReleaseCode): never {
	throw new NativeAppReleaseError(code);
}

export const MANIFEST_FILE = "release.manifest.json";
export const SIGNATURE_FILE = "release.signature";

export function releasePath(raw: unknown): string {
	try {
		const name = portableRelativePath(raw, {
			maximumLength: 200,
			maximumComponents: 16,
			maximumComponentLength: 200,
		});
		if (name.split("/").some((part) => /^\.env|^\.git$/i.test(part))) refuse("path");
		return name;
	} catch {
		return refuse("path");
	}
}

export function packageEntry(raw: unknown): string {
	const name = releasePath(raw);
	if (name.split("/").some((part) => /^[A-Za-z0-9_@+-][A-Za-z0-9_@.+-]*$/.exec(part)?.[0] !== part))
		refuse("path");
	return name;
}

export function releaseRoot(raw: unknown): string {
	if (
		typeof raw !== "string" ||
		!raw.isWellFormed() ||
		raw.length > 4096 ||
		!path.isAbsolute(raw) ||
		path.resolve(raw) !== raw ||
		/^[/\\]{2}/.test(raw) ||
		raw
			.split(/[\\/]/)
			.some((part) => part === "." || part === ".." || /^\.env|^\.git$/i.test(part)) ||
		(process.platform === "win32" && raw.slice(/^[a-z]:\\/i.test(raw) ? 2 : 0).includes(":"))
	)
		refuse("path");
	return raw;
}
