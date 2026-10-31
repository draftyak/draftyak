import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { COMMERCIAL_MODULES, type FakeModule, type HostileModule } from "@draftyak/fake-commercial";
import type { ExtensionHost, ExtensionStartOptions } from "../../src/extensions/registry.ts";
import { type Fixture, type ModuleEntry, pin } from "./helpers.ts";

/** Core suites run once per mode: no modules, then the benign commercial set. */
export const EXTENSION_MODES = ["free", "fake-commercial"] as const;
export type ExtensionMode = (typeof EXTENSION_MODES)[number];

/** Copies a catalog module and its migrations into the fixture's module layout and pins them. */
export function installModule(f: Fixture, module: FakeModule): ModuleEntry {
	const folder = path.join(f.dir, "modules", module.id);
	rmSync(folder, { recursive: true, force: true });
	mkdirSync(folder, { recursive: true });
	const source = readFileSync(module.entry);
	const entry = path.join(folder, "index.mjs");
	writeFileSync(entry, source);
	let migrations: ModuleEntry["migrations"];
	if (module.migrations !== undefined) {
		const from = module.migrations;
		const directory = path.join(folder, "migrations");
		mkdirSync(directory);
		const files = readdirSync(from)
			.sort()
			.map((name) => {
				const sql = readFileSync(path.join(from, name));
				writeFileSync(path.join(directory, name), sql);
				return { name, sha512: pin(sql) };
			});
		migrations = { directory, files };
	}
	return {
		id: module.id,
		version: module.version,
		entry,
		sha512: pin(source),
		provides: module.provides,
		...(migrations ? { migrations } : {}),
	};
}

/** "free" removes the fixture's config.json; "fake-commercial" loads the commercial set. */
export function startMode(
	f: Fixture,
	mode: ExtensionMode,
	options?: Partial<ExtensionStartOptions>,
): Promise<ExtensionHost> {
	if (mode === "fake-commercial")
		f.config(COMMERCIAL_MODULES.map((item) => installModule(f, item)));
	else rmSync(path.join(f.dir, "config.json"), { force: true });
	return f.start(options);
}

/**
 * The commercial set plus the given variants, in that order. A variant that replaces a commercial
 * module drops it, since a hub allows one identity and one workspace provider.
 */
export function startWith(
	f: Fixture,
	variants: readonly HostileModule[],
	options?: Partial<ExtensionStartOptions>,
): Promise<ExtensionHost> {
	const replaced = new Set(variants.flatMap((variant) => variant.replaces ?? []));
	const modules = [...COMMERCIAL_MODULES.filter(({ id }) => !replaced.has(id)), ...variants];
	f.config(modules.map((item) => installModule(f, item)));
	return f.start(options);
}
