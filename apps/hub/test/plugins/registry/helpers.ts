import path from "node:path";
import { AuditChain } from "../../../src/audit/chain.ts";
import { EVENT_MIGRATIONS, EventLog } from "../../../src/events/log.ts";
import { DEVICE_MIGRATIONS, DeviceRegistry } from "../../../src/identity/devices.ts";
import { HubIdentity } from "../../../src/identity/hub-key.ts";
import { PinService } from "../../../src/identity/pin.ts";
import { WorkDatabase } from "../../../src/jobs/database.ts";
import { JOB_MIGRATIONS } from "../../../src/jobs/queue.ts";
import {
	openPluginRegistry,
	PLUGIN_REGISTRY_MIGRATIONS,
	type PluginRegistry,
} from "../../../src/plugins/registry/index.ts";
import { HubStore } from "../../../src/store/store.ts";
import { bootstrap, closeFixture, fixture as nativeFixture } from "../../authz/native-fixture.ts";
import { nativeBinding } from "../../store/helpers.ts";
import {
	type Bundle,
	bundle,
	fixture as installerFixture,
	removeFixtures,
} from "../installer-fixtures.ts";

export { bundle, removeFixtures };
export async function fixture(
	bootstrapped = true,
	bundles: readonly Bundle[] = [bundle()],
): Promise<{
	native: Awaited<ReturnType<typeof nativeFixture>>;
	files: ReturnType<typeof installerFixture>;
	bundles: readonly Bundle[];
	clock: { failed: boolean };
	database: WorkDatabase;
	events: EventLog;
	open(): Promise<PluginRegistry>;
	reopen(): Promise<PluginRegistry>;
	close(): Promise<void>;
}> {
	const migrations = {
		jobs: JOB_MIGRATIONS,
		events: EVENT_MIGRATIONS,
		pluginregistry: PLUGIN_REGISTRY_MIGRATIONS,
	};
	const native = await nativeFixture(migrations),
		files = installerFixture(),
		opened: PluginRegistry[] = [];
	if (bootstrapped) await bootstrap(native);
	const clock = { failed: false };
	let database = new WorkDatabase(native.store);
	let events = new EventLog(database, () => {
		if (clock.failed) throw new Error("DYTEST event clock unavailable");
		return 1_800_000_000_000;
	});
	const open = async (): Promise<PluginRegistry> => {
		const registry = await openPluginRegistry({
			store: native.store,
			database,
			devices: native.registry,
			audit: native.audit,
			events,
			installer: files.options(bundles),
		});
		opened.push(registry);
		return registry;
	};
	return {
		native,
		files,
		bundles,
		clock,
		get database() {
			return database;
		},
		get events() {
			return events;
		},
		open,
		async reopen() {
			for (const registry of opened.splice(0)) await registry.close();
			await native.tls.close();
			native.registry.lock();
			native.pins.lock();
			native.identity.lock();
			native.store.close();
			native.store = new HubStore({
				filename: native.filename,
				nativeBinding,
				masterKey: native.key,
				migrations: {
					audit: path.resolve(import.meta.dirname, "../../../src/store/migrations/audit"),
					core: path.resolve(import.meta.dirname, "../../../src/store/migrations/core"),
					devices: DEVICE_MIGRATIONS,
					...migrations,
				},
			});
			const key = native.key.derive("audit");
			native.audit.destroy();
			native.audit = new AuditChain(key);
			key.fill(0);
			native.identity = await HubIdentity.loadOrCreate(native.store, native.key);
			native.pins = new PinService(native.store, native.audit);
			native.registry = new DeviceRegistry(native.store, native.audit, native.pins, {
				identity: native.identity,
			});
			database = new WorkDatabase(native.store);
			events = new EventLog(database, () => 1_800_000_000_000);
			return open();
		},
		async close() {
			for (const registry of opened.splice(0)) await registry.close();
			await closeFixture(native);
		},
	};
}
