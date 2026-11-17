import path from "node:path";

export type InventoryEntryKind = "directory" | "link" | "other";
export interface InventoryDirectoryEntry {
	readonly name: string;
	readonly kind: InventoryEntryKind;
}
/** Every operation resolves relative to the original opened directory, never a later pathname. */
export interface InventoryDirectory {
	read(components: readonly string[]): Promise<readonly InventoryDirectoryEntry[]>;
	stat(components: readonly string[]): Promise<InventoryEntryKind>;
	current(): Promise<boolean>;
	stop(): void;
	close(): Promise<void>;
}
export type OpenInventoryDirectory = (absoluteRoot: string) => Promise<InventoryDirectory>;

const failed = (): Error => new Error("file-name inventory failed");

/** Convert a lexical label into single components; these labels confer no filesystem authority. */
export function inventoryComponents(root: string, target: string): readonly string[] {
	if (!path.isAbsolute(root) || !path.isAbsolute(target)) throw failed();
	const relative = path.relative(root, target);
	if (relative === "") return [];
	if (path.isAbsolute(relative)) throw failed();
	const components = relative.split(path.sep);
	if (
		components.some(
			(component) =>
				component === "" ||
				component === "." ||
				component === ".." ||
				!component.isWellFormed() ||
				component.includes("\uFFFD") ||
				/[/\0]/.test(component) ||
				(process.platform === "win32" && /[\\:]/.test(component)),
		)
	)
		throw failed();
	return components;
}

/** Loading is explicit and uses only the locally qualified, current-source build. */
export const openInventoryDirectory: OpenInventoryDirectory = async (root) => {
	if (!path.isAbsolute(root) || !root.isWellFormed() || root.includes("\uFFFD")) throw failed();
	const { loadInventoryNativeBinding } = await import("./inventory-native-build.ts");
	const binding = await loadInventoryNativeBinding();
	return binding.openRoot(root);
};
