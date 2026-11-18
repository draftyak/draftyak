import type { WorkspaceProvider } from "@draftyak/extensions";
import type { Account } from "@draftyak/protocol/entities/account";
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const [
	{ NativeAccounts },
	{ AuditChain },
	{ revokePinScope },
	{ EventLog },
	{ ExtensionError },
	{ SINGLE_OWNER_WORKSPACE, singleOwnerWorkspace },
	{ DeviceRegistry, advanceEpochForRestore },
	{ WorkDatabase },
	{ newId },
	{ HUB_NAMESPACES },
	{ HubStore },
	{ nativeBinding },
	{ bootstrap, closeFixture, fixture, idOf, owner, PIN },
] = await Promise.all([
	import("../../src/accounts/records.ts"),
	import("../../src/audit/chain.ts"),
	import("../../src/authz/scopes.ts"),
	import("../../src/events/log.ts"),
	import("../../src/extensions/errors.ts"),
	import("../../src/extensions/free/workspace.ts"),
	import("../../src/identity/devices.ts"),
	import("../../src/jobs/database.ts"),
	import("../../src/kernel/ids.ts"),
	import("../../src/kernel/namespaces.ts"),
	import("../../src/store/store.ts"),
	import("../store/helpers.ts"),
	import("../authz/native-fixture.ts"),
]);
const extraMigrations = Object.fromEntries(
	Object.entries(HUB_NAMESPACES).filter(([name]) => !["audit", "core", "devices"].includes(name)),
);
type Fixture = Awaited<ReturnType<typeof fixture>>;
let f: Fixture;
const others: Fixture[] = [];
beforeEach(async () => {
	f = await fixture(extraMigrations);
});
afterEach(async () => {
	vi.restoreAllMocks();
	for (const other of others.splice(0)) await closeFixture(other);
	await closeFixture(f);
});
function records(target: Fixture = f) {
	const database = new WorkDatabase(target.store);
	return {
		database,
		accounts: new NativeAccounts(
			database,
			new EventLog(database, () => 2000),
			target.audit,
			() => 2000,
		),
	};
}
function email(userId: string = owner(f)): Account {
	return {
		channel: "email",
		id: newId(),
		userId,
		alias: "dytest-workspace",
		mode: "full",
		status: "active",
		deletionDeadline: null,
		historyLimitDays: 30,
		disclosureVersion: 1,
		createdAt: 1000,
		pluginInstanceId: newId(),
		address: "dytest@example.invalid",
	};
}
function create(value: Account, target: Fixture = f): void {
	const { database, accounts } = records(target);
	database.write((scope) => accounts.create(scope, value));
}

it("exposes only an inert frozen personal-workspace projection before bootstrap", async () => {
	const provider = singleOwnerWorkspace(f.store, f.registry, f.audit);
	expectTypeOf(provider).toExtend<WorkspaceProvider>();
	expect(Object.getPrototypeOf(provider)).toBeNull();
	expect(Object.isFrozen(provider)).toBe(true);
	expect(Reflect.ownKeys(provider).sort()).toEqual(["canAccess", "id", "workspacesFor"]);
	expect(provider.id).toBe(SINGLE_OWNER_WORKSPACE);
	expect(provider.assign).toBeUndefined();
	expect(await provider.workspacesFor(newId())).toEqual([]);
	expect(await provider.canAccess(newId(), newId())).toBe(false);
});

it("reads the real TLS/PIN-bootstrapped owner and native retained account shapes", async () => {
	const provider = singleOwnerWorkspace(f.store, f.registry, f.audit);
	await bootstrap(f);
	const mailbox = email();
	const chat: Account = {
		channel: "chat",
		id: newId(),
		userId: owner(f),
		alias: "dytest-chat",
		mode: "read_only",
		status: "active",
		deletionDeadline: null,
		historyLimitDays: 30,
		disclosureVersion: 1,
		createdAt: 1000,
		pluginInstanceId: newId(),
		teamId: "DYTEST-team",
		selfUserId: "DYTEST-user",
	};
	create(mailbox);
	create(chat);
	const first = await provider.workspacesFor(owner(f));
	const second = await provider.workspacesFor(owner(f));
	expect(first).toEqual([{ id: owner(f) }]);
	expect(first).not.toBe(second);
	expect(first[0]).not.toBe(second[0]);
	expect(Object.isFrozen(first)).toBe(true);
	expect(Object.isFrozen(first[0])).toBe(true);
	expect(await provider.canAccess(owner(f), mailbox.id)).toBe(true);
	expect(await provider.canAccess(owner(f), chat.id)).toBe(true);
});

it("denies unknown users, foreign account owners and missing native accounts", async () => {
	await bootstrap(f);
	const mine = email(),
		foreign = email(newId());
	create(mine);
	create(foreign);
	const provider = singleOwnerWorkspace(f.store, f.registry, f.audit);
	expect(await provider.canAccess(owner(f), mine.id)).toBe(true);
	expect(await provider.workspacesFor(foreign.userId)).toEqual([]);
	expect(await provider.canAccess(foreign.userId, foreign.id)).toBe(false);
	expect(await provider.canAccess(owner(f), foreign.id)).toBe(false);
	expect(await provider.canAccess(owner(f), newId())).toBe(false);
});

it("rechecks durable membership after native replacement and tombstoning", async () => {
	await bootstrap(f);
	const value = email();
	create(value);
	const provider = singleOwnerWorkspace(f.store, f.registry, f.audit);
	expect(await provider.canAccess(owner(f), value.id)).toBe(true);
	const { database, accounts } = records();
	database.write((scope) => accounts.replace(scope, { ...value, status: "disconnecting" }, 1));
	database.write((scope) => accounts.retire(scope, value.userId, value.id, 2));
	expect(await provider.canAccess(owner(f), value.id)).toBe(false);
	expect(await provider.workspacesFor(owner(f))).toEqual([{ id: owner(f) }]);
});

it("refuses corrupt persisted account metadata instead of returning an access fact", async () => {
	await bootstrap(f);
	const value = email();
	create(value);
	const provider = singleOwnerWorkspace(f.store, f.registry, f.audit);
	expect(await provider.canAccess(owner(f), value.id)).toBe(true);
	f.store.write((sql) =>
		sql.run("UPDATE main.accounts SET account_json='{}' WHERE id=?", [value.id]),
	);
	await expect(provider.canAccess(owner(f), value.id)).rejects.toThrow(ExtensionError);
	await expect(provider.canAccess(owner(f), value.id)).rejects.toThrow(
		"Extension operation refused.",
	);
});

it("requires the same real store, registry and authenticated audit binding", async () => {
	const other = await fixture(extraMigrations);
	others.push(other);
	expect(() => singleOwnerWorkspace(f.store, f.registry, f.audit)).not.toThrow();
	expect(() => singleOwnerWorkspace(other.store, other.registry, other.audit)).not.toThrow();
	expect(() => singleOwnerWorkspace(other.store, f.registry, f.audit)).toThrow(ExtensionError);
	expect(() => singleOwnerWorkspace(f.store, other.registry, f.audit)).toThrow(ExtensionError);
	expect(() => singleOwnerWorkspace(f.store, f.registry, other.audit)).toThrow(ExtensionError);
});

it("refuses structural and proxy dependencies without calling their hooks", () => {
	const hook = vi.fn(() => {
		throw new Error("DYTEST hook refused");
	});
	for (const registry of [
		null,
		{},
		Object.create(DeviceRegistry.prototype),
		new Proxy(f.registry, { get: hook, getPrototypeOf: hook }),
	])
		expect(() => singleOwnerWorkspace(f.store, registry as never, f.audit)).toThrow(ExtensionError);
	for (const store of [
		null,
		{},
		Object.create(HubStore.prototype),
		new Proxy(f.store, { get: hook, getPrototypeOf: hook }),
	])
		expect(() => singleOwnerWorkspace(store as never, f.registry, f.audit)).toThrow(ExtensionError);
	for (const audit of [
		null,
		{},
		Object.create(AuditChain.prototype),
		new Proxy(f.audit, { get: hook, getPrototypeOf: hook }),
	])
		expect(() => singleOwnerWorkspace(f.store, f.registry, audit as never)).toThrow(ExtensionError);
	expect(hook).not.toHaveBeenCalled();
});

it("uses captured native methods despite replaced instance and prototype readers", async () => {
	await bootstrap(f);
	const value = email();
	create(value);
	const hook = vi.fn(() => {
		throw new Error("DYTEST replacement refused");
	});
	Object.defineProperty(f.registry, "state", { configurable: true, get: hook });
	Object.defineProperty(f.registry, "assertStore", { configurable: true, get: hook });
	Object.defineProperty(f.store, "write", { configurable: true, get: hook });
	vi.spyOn(DeviceRegistry.prototype, "state").mockImplementation(hook);
	vi.spyOn(DeviceRegistry.prototype, "assertStore").mockImplementation(hook);
	vi.spyOn(WorkDatabase.prototype, "write").mockImplementation(hook);
	vi.spyOn(WorkDatabase.prototype, "sql").mockImplementation(hook);
	vi.spyOn(NativeAccounts.prototype, "get").mockImplementation(hook);
	vi.spyOn(AuditChain.prototype, "verify").mockImplementation(hook);
	const provider = singleOwnerWorkspace(f.store, f.registry, f.audit);
	expect(await provider.workspacesFor(owner(f))).toEqual([{ id: owner(f) }]);
	await expect(provider.canAccess(owner(f), value.id)).resolves.toBe(true);
	expect(hook).not.toHaveBeenCalled();
	Reflect.deleteProperty(f.store, "write");
});

it("rejects malformed and coercible caller identifiers without invoking hooks", async () => {
	await bootstrap(f);
	const value = email();
	create(value);
	const provider = singleOwnerWorkspace(f.store, f.registry, f.audit);
	const hook = vi.fn(() => owner(f));
	for (const input of [
		null,
		undefined,
		0,
		"",
		"x".repeat(1000),
		{ toString: hook },
		new Proxy({}, { get: hook }),
	]) {
		await expect(provider.workspacesFor(input as never)).rejects.toThrow(ExtensionError);
		await expect(provider.canAccess(input as never, value.id)).rejects.toThrow(ExtensionError);
		await expect(provider.canAccess(owner(f), input as never)).rejects.toThrow(ExtensionError);
	}
	expect(hook).not.toHaveBeenCalled();
	expect(await provider.canAccess(owner(f), value.id)).toBe(true);
});

it("keeps personal facts separate from native epoch and revoked-device denial", async () => {
	const client = await bootstrap(f);
	const value = email();
	create(value);
	const provider = singleOwnerWorkspace(f.store, f.registry, f.audit);
	f.store.read((sql) => {
		expect(f.authorizer.requirePeerDevice(sql, client.peer, "read").userId).toBe(owner(f));
	});
	const proof = await f.pins.verify(owner(f), PIN, revokePinScope(idOf(client)));
	f.store.write((sql) => {
		expect(f.registry.revoke(sql, idOf(client), { kind: "device", id: idOf(client), proof })).toBe(
			true,
		);
	});
	expect(await provider.canAccess(owner(f), value.id)).toBe(true);
	f.store.read((sql) => {
		expect(() => f.authorizer.requirePeerDevice(sql, client.peer, "read")).toThrow(
			"DEVICE_REVOKED",
		);
	});
	f.store.write((sql) => advanceEpochForRestore(f.registry, sql));
	expect(await provider.workspacesFor(owner(f))).toEqual([{ id: owner(f) }]);
	expect(await provider.canAccess(owner(f), value.id)).toBe(true);
	f.store.read((sql) => {
		expect(() => f.authorizer.requirePeerDevice(sql, client.peer, "approve")).toThrow();
	});
});

it("refuses construction and calls after the bound registry locks", async () => {
	await bootstrap(f);
	const value = email();
	create(value);
	const provider = singleOwnerWorkspace(f.store, f.registry, f.audit);
	expect(await provider.canAccess(owner(f), value.id)).toBe(true);
	f.registry.lock();
	await expect(provider.workspacesFor(owner(f))).rejects.toThrow(ExtensionError);
	await expect(provider.canAccess(owner(f), value.id)).rejects.toThrow(ExtensionError);
	expect(() => singleOwnerWorkspace(f.store, f.registry, f.audit)).toThrow(ExtensionError);
});

it("refuses a retired store even after its file is reopened through a fresh native connection", async () => {
	await bootstrap(f);
	const value = email();
	create(value);
	const provider = singleOwnerWorkspace(f.store, f.registry, f.audit);
	f.store.close();
	try {
		await expect(provider.workspacesFor(owner(f))).rejects.toThrow(ExtensionError);
		await expect(provider.canAccess(owner(f), value.id)).rejects.toThrow(ExtensionError);
		expect(() => singleOwnerWorkspace(f.store, f.registry, f.audit)).toThrow(ExtensionError);
	} finally {
		f.store = new HubStore({ filename: f.filename, nativeBinding, masterKey: f.key });
	}
	await expect(provider.canAccess(owner(f), value.id)).rejects.toThrow(ExtensionError);
	expect(() => singleOwnerWorkspace(f.store, f.registry, f.audit)).toThrow(ExtensionError);
});
