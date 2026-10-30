import { fileURLToPath } from "node:url";

// From source this module is src/kernel/namespaces.ts; built, it is part of dist/index.mjs, and the
// build copies each folder to the same place under dist/ as under src/.
const root = new URL(import.meta.url.endsWith(".ts") ? "../" : "./", import.meta.url);
const bundled = (folder: string): string => fileURLToPath(new URL(folder, root));

/** The kernel's bundled migration folders by store namespace; later items add their own lines. */
export const HUB_NAMESPACES: Readonly<Record<"audit" | "core", string>> = Object.freeze({
	audit: bundled("store/migrations/audit"),
	core: bundled("store/migrations/core"),
});
