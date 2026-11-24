// Match complete components, including the terminal character. Names alone are
// a conservative heuristic: an unknown name does not establish local storage.
const syncedComponent =
	/^(?:onedrive(?: - .*|-.*)?|dropbox(?:\s*\([^)]*\))?|google ?drive(?:-.*)?|icloud(?:drive)?|nextcloud|syncthing|box(?:-.*)?|my drive|shared drives)$(?![\s\S])/i;

/**
 * Classify known sync-folder names in a supplied path spelling.
 *
 * This module performs no I/O, reads no environment or configuration, and does
 * not resolve dot segments, links, aliases, mounts or configured sync roots.
 * Both separators are recognized on every platform. Native path validation,
 * identity checks and the decision to warn or refuse belong to the caller.
 */
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
