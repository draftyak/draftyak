export interface CatalogFile {
	readonly path: string;
	readonly sha256: string | null;
}
export interface PayloadCatalog {
	readonly files: readonly CatalogFile[];
	readonly directories: readonly string[];
	readonly commands: readonly string[];
	readonly checks: readonly string[];
}

// The build replaces this source-mode value with the generated installed file catalog.
export const installedCatalog: PayloadCatalog | undefined = undefined;
