import { HUB_NAMESPACES, migrateHubSchemas } from "./kernel/namespaces.ts";
import { HubStore, type StoreOptions } from "./store/store.ts";

export type NativeStorageOptions = Omit<StoreOptions, "migrations" | "snapshots">;

/** Opens the current native component schemas; it does not activate an account or controller. */
export async function openNativeStorage(options: NativeStorageOptions): Promise<HubStore> {
	const store = new HubStore({
		filename: options.filename,
		nativeBinding: options.nativeBinding,
		masterKey: options.masterKey,
		create: options.create === true,
		migrations: HUB_NAMESPACES,
	});
	try {
		await migrateHubSchemas(store);
		return store;
	} catch (error) {
		store.close();
		throw error;
	}
}
