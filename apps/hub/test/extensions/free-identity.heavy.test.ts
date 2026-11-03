import type { IdentityProvider } from "@draftyak/extensions";
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const [
	{ SINGLE_OWNER_IDENTITY, singleOwnerIdentity },
	{ ExtensionError },
	{ advanceEpochForRestore, DeviceRegistry },
	{ HubStore },
	{ nativeBinding },
	{ bootstrap, closeFixture, fixture, owner },
] = await Promise.all([
	import("../../src/extensions/free/identity.ts"),
	import("../../src/extensions/errors.ts"),
	import("../../src/identity/devices.ts"),
	import("../../src/store/store.ts"),
	import("../store/helpers.ts"),
	import("../authz/native-fixture.ts"),
]);
type Fixture = Awaited<ReturnType<typeof fixture>>;
let f: Fixture;
const others: Fixture[] = [];
beforeEach(async () => {
	f = await fixture();
});
afterEach(async () => {
	vi.restoreAllMocks();
	for (const other of others.splice(0)) await closeFixture(other);
	await closeFixture(f);
});

it("exposes a frozen single-owner identity projection without browser authentication or native handles", async () => {
	const provider = singleOwnerIdentity(f.registry);
	expectTypeOf(provider).toExtend<IdentityProvider>();
	expect(Object.getPrototypeOf(provider)).toBeNull();
	expect(Object.isFrozen(provider)).toBe(true);
	expect(Reflect.ownKeys(provider).sort()).toEqual(["id", "maxOwners", "users"]);
	expect(provider.id).toBe(SINGLE_OWNER_IDENTITY);
	expect(provider.authenticateBrowser).toBeUndefined();
	expect(provider.maxOwners()).toBe(1);
	expect(await provider.users()).toEqual([]);
});

it("reads the actual owner after native TLS and PIN bootstrap instead of caching the empty state", async () => {
	const provider = singleOwnerIdentity(f.registry);
	const before = await provider.users();
	await bootstrap(f);
	const first = await provider.users();
	const second = await provider.users();
	expect(before).toEqual([]);
	expect(first).toEqual([{ id: owner(f) }]);
	expect(second).toEqual(first);
	expect(second).not.toBe(first);
	expect(second[0]).not.toBe(first[0]);
	expect(Object.isFrozen(first)).toBe(true);
	expect(Object.isFrozen(first[0])).toBe(true);
	expect(provider.maxOwners()).toBe(1);
});

it("projects only the registered owner even when another user row exists", async () => {
	await bootstrap(f);
	f.store.write((db) =>
		db.run("INSERT INTO main.users(id,created_at) VALUES (?,?)", ["01DYTEST000000000000000099", 1]),
	);
	const provider = singleOwnerIdentity(f.registry);
	expect(await provider.users()).toEqual([{ id: owner(f) }]);
	expect(provider.maxOwners()).toBe(1);
});

it("keeps two live native registries bound to their own owners", async () => {
	const other = await fixture();
	others.push(other);
	await bootstrap(f);
	await bootstrap(other);
	expect(owner(other)).not.toBe(owner(f));
	expect(await singleOwnerIdentity(f.registry).users()).toEqual([{ id: owner(f) }]);
	expect(await singleOwnerIdentity(other.registry).users()).toEqual([{ id: owner(other) }]);
});

it("preserves the owner's identity after restore while native approval authority stays unavailable", async () => {
	const client = await bootstrap(f);
	const provider = singleOwnerIdentity(f.registry);
	f.store.write((db) => advanceEpochForRestore(f.registry, db));
	expect(f.registry.currentState()).toMatchObject({ bootstrapDone: false, ownerUserId: owner(f) });
	expect(await provider.users()).toEqual([{ id: owner(f) }]);
	expect(provider.maxOwners()).toBe(1);
	expect(provider.authenticateBrowser).toBeUndefined();
	expect(() =>
		f.store.read((db) => f.authorizer.requirePeerDevice(db, client.peer, "approve")),
	).toThrow();
});

it("uses the captured native reader without invoking replaced instance or prototype methods", async () => {
	await bootstrap(f);
	const replacement = vi.fn(() => ({
		epoch: 0,
		bootstrapDone: true,
		ownerUserId: "PRIVATE_OWNER",
	}));
	Object.defineProperty(f.registry, "currentState", { configurable: true, get: replacement });
	vi.spyOn(DeviceRegistry.prototype, "currentState").mockImplementation(replacement);
	const provider = singleOwnerIdentity(f.registry);
	expect(await provider.users()).toEqual([{ id: owner(f) }]);
	expect(provider.maxOwners()).toBe(1);
	expect(replacement).not.toHaveBeenCalled();
});

it("refuses structural and proxy registries without invoking their hooks", () => {
	const hook = vi.fn(() => {
		throw new Error("PRIVATE_REGISTRY");
	});
	for (const candidate of [
		null,
		{},
		Object.create(DeviceRegistry.prototype),
		Object.defineProperty({}, "currentState", { get: hook }),
		new Proxy(f.registry, { get: hook, getPrototypeOf: hook }),
	]) {
		expect(() => singleOwnerIdentity(candidate as never)).toThrow(ExtensionError);
		expect(() => singleOwnerIdentity(candidate as never)).toThrow("Extension operation refused.");
	}
	expect(hook).not.toHaveBeenCalled();
});

it("refuses calls and construction after the native registry locks", async () => {
	await bootstrap(f);
	const provider = singleOwnerIdentity(f.registry);
	f.registry.lock();
	await expect(provider.users()).rejects.toThrow(ExtensionError);
	expect(() => provider.maxOwners()).toThrow(ExtensionError);
	expect(() => singleOwnerIdentity(f.registry)).toThrow(ExtensionError);
});

it("refuses with a fixed error when its actual encrypted store closes", async () => {
	const provider = singleOwnerIdentity(f.registry);
	f.store.close();
	try {
		await expect(provider.users()).rejects.toThrow("Extension operation refused.");
		expect(() => provider.maxOwners()).toThrow(ExtensionError);
		expect(() => singleOwnerIdentity(f.registry)).toThrow(ExtensionError);
	} finally {
		// A new real connection permits fixture audit verification and cleanup; the provider remains
		// bound to the retired registry/store and cannot use this replacement.
		f.store = new HubStore({ filename: f.filename, nativeBinding, masterKey: f.key });
	}
	await expect(provider.users()).rejects.toThrow(ExtensionError);
});
