// Whole path components only. This is a conservative name heuristic, not a
// filesystem, environment, mount, or arbitrary sync-client detector.
const syncedComponent =
	/^(?:onedrive(?: - .*|-.*)?|dropbox(?:\s*\([^)]*\))?|google ?drive(?:-.*)?|icloud(?:drive)?|nextcloud|syncthing|box(?:-.*)?|my drive|shared drives)$(?![\s\S])/i;

/** Identify known sync-folder names without filesystem or environment reads. */
export function isKnownSyncedPath(value: unknown): boolean {
	if (typeof value !== "string" || value.length === 0 || value.length > 4_096)
		throw new Error("Path classification refused");
	const components = value.split(/[\\/]+/);
	for (const [index, component] of components.entries()) {
		if (syncedComponent.test(component)) return true;
		if (
			component.toLowerCase() === "library" &&
			/^(?:cloudstorage|mobile documents)$(?![\s\S])/i.test(components[index + 1] ?? "")
		)
			return true;
	}
	return false;
}
