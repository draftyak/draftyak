import { globSync, readFileSync } from "node:fs";
import path from "node:path";

const vectorsDir = path.resolve(import.meta.dirname, "..", "..", "..", "spec", "vectors");

// Every committed vector file of an area, as [file name, parsed content].
export function vectorFiles<T>(area: string): [string, T][] {
	return globSync("*.json", { cwd: path.join(vectorsDir, area) })
		.toSorted()
		.map((file) => [
			file,
			JSON.parse(readFileSync(path.join(vectorsDir, area, file), "utf8")) as T,
		]);
}

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

// Every `pattern` in a JSON Schema.
export function patterns(schema: unknown): string[] {
	if (Array.isArray(schema)) return schema.flatMap(patterns);
	if (schema === null || typeof schema !== "object") return [];
	return Object.entries(schema).flatMap(([key, value]) =>
		key === "pattern" && typeof value === "string" ? [value] : patterns(value),
	);
}

// \d, \w, \s and \b mean other things in Python's re and Rust's regex, so patterns never use them.
export const ENGINE_DEPENDENT: RegExp = /\\[dDwWsSbB]/;

// The code of the error `run` throws, or "accepted".
export function outcome(run: () => unknown): string {
	try {
		run();
		return "accepted";
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string") return code;
		throw error;
	}
}
