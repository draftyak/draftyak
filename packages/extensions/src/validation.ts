import path from "node:path";

/** Pure preflight: refuse Windows namespaces, streams and DOS device components before lookup. */
export function isMigrationDirectoryPath(
	directory: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (directory.length > 4_096 || directory.includes("\0")) return false;
	if (platform !== "win32") return path.posix.isAbsolute(directory);
	if (!/^[a-z]:[\\/][^:]*$/i.test(directory)) return false;
	return directory
		.split(/[\\/]/)
		.slice(1)
		.every((component) => {
			const control = [...component].some(
				(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			);
			if (control || /[<>"|?*]/.test(component) || /[. ]$/.test(component)) return false;
			const base = component.split(".")[0]?.trimEnd() ?? "";
			return !/^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(base);
		});
}

/** Filename metadata only. The native migrator separately validates SQL and table ownership. */
export function migrationNumber(name: string): string | undefined {
	const match = /^([0-9]{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/.exec(name);
	return match?.[0] === name && match[1] !== "0000" && (match[2]?.length ?? 97) <= 96
		? match[1]
		: undefined;
}
