import type { Workspace, WorkspaceProvider } from "@draftyak/extensions";
import { Ulid } from "@draftyak/protocol/scalars";
import { NativeAccounts } from "../../accounts/records.ts";
import { AuditChain } from "../../audit/chain.ts";
import { EventLog } from "../../events/log.ts";
import { type AuthorityState, DeviceRegistry, isDeviceRegistry } from "../../identity/devices.ts";
import { WorkDatabase, type WorkScope } from "../../jobs/database.ts";
import type { HubStore } from "../../store/store.ts";
import { refuse } from "../errors.ts";

export const SINGLE_OWNER_WORKSPACE: string = "single-owner";

const assertStore = DeviceRegistry.prototype.assertStore;
const state = DeviceRegistry.prototype.state;
const write = WorkDatabase.prototype.write;
const sqlFor = WorkDatabase.prototype.sql;
const verifyAudit = AuditChain.prototype.verify;
const getAccount = NativeAccounts.prototype.get;
const now = Date.now;

function userId(value: Ulid): Ulid {
	if (typeof value !== "string" || value.length !== 26 || !Ulid.safeParse(value).success)
		refuse("unavailable");
	return value;
}

/** Personal ownership facts only. Native routing, device and approval checks remain mandatory. */
export function singleOwnerWorkspace(
	store: HubStore,
	registry: DeviceRegistry,
	audit: AuditChain,
): WorkspaceProvider {
	if (!isDeviceRegistry(registry)) refuse("unavailable");
	const database = new WorkDatabase(store);
	const accounts = new NativeAccounts(database, new EventLog(database, now), audit, now);
	function read<T>(work: (scope: WorkScope, authority: AuthorityState) => T): T {
		try {
			assertStore.call(registry, store);
			return write.call(database, (scope: WorkScope) => {
				const sql = sqlFor.call(database, scope);
				verifyAudit.call(audit, sql);
				return work(scope, state.call(registry, sql));
			}) as T;
		} catch {
			return refuse("unavailable");
		}
	}
	read(() => undefined);
	return Object.freeze(
		Object.assign(Object.create(null) as object, {
			id: SINGLE_OWNER_WORKSPACE,
			workspacesFor: async (user: Ulid): Promise<readonly Workspace[]> => {
				const id = userId(user);
				return read((_scope, authority) =>
					Object.freeze(authority.ownerUserId === id ? [Object.freeze({ id })] : []),
				);
			},
			canAccess: async (user: Ulid, account: Ulid): Promise<boolean> => {
				const owner = userId(user);
				const id = userId(account);
				return read(
					(scope, authority) =>
						authority.ownerUserId === owner &&
						getAccount.call(accounts, scope, owner, id) !== undefined,
				);
			},
		}),
	) as WorkspaceProvider;
}
