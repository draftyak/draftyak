import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const applications = [
	["apps/cli", "@draftyak/cli"],
	["apps/hub", "@draftyak/hub"],
] as const;

export type HeavyApplication = (typeof applications)[number][0];

// Only the reviewed native application roots participate. A directory or a manifest without a
// genuine heavy script is not a suite; in particular, an older hub package remains ineligible.
export function heavyApplications(root: string): readonly HeavyApplication[] {
	return applications.flatMap(([dir, name]) => {
		const manifestPath = path.join(root, dir, "package.json");
		try {
			for (const folder of ["apps", dir]) {
				const entry = lstatSync(path.join(root, folder));
				if (!entry.isDirectory() || entry.isSymbolicLink()) return [];
			}
			const entry = lstatSync(manifestPath);
			if (!entry.isFile() || entry.isSymbolicLink()) return [];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw new Error(`cannot inspect heavy application manifest: ${dir}`);
		}
		let manifest: unknown;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		} catch {
			throw new Error(`invalid heavy application manifest: ${dir}`);
		}
		if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return [];
		const data = manifest as { name?: unknown; scripts?: unknown };
		if (data.name !== name || data.scripts === null || typeof data.scripts !== "object") return [];
		if (Array.isArray(data.scripts)) return [];
		const script = (data.scripts as Record<string, unknown>)["test:heavy"];
		return typeof script === "string" && script.trim().length > 0 ? [dir] : [];
	});
}

export function changedApplication(file: string): HeavyApplication | undefined {
	// Do not normalize a lookalike into a reviewed root. The emitted filters are fixed literals.
	if (
		file.includes("\\") ||
		[...file].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
	)
		return undefined;
	const parts = file.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
	return applications.find(([dir]) => file.startsWith(`${dir}/`))?.[0];
}
