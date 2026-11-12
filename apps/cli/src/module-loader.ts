import { moduleUrl } from "./layout.ts";

export async function loadModule(relative: string): Promise<unknown> {
	const namespace: Record<string, unknown> = await import(moduleUrl(relative).href);
	const exports: Record<string, unknown> = Object.create(null);
	for (const key of Object.keys(namespace)) exports[key] = namespace[key];
	return Object.freeze(exports);
}
