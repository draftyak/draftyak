import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuditChain } from "../../src/audit/chain.ts";
import type { EventLog } from "../../src/events/log.ts";
import type { ExtensionHost } from "../../src/extensions/registry.ts";
import type { DeviceRegistry } from "../../src/identity/devices.ts";
import { HubIdentity } from "../../src/identity/hub-key.ts";
import type { PinService } from "../../src/identity/pin.ts";
import type { WorkDatabase } from "../../src/jobs/database.ts";
import type { MasterKey } from "../../src/kernel/master-key.ts";
import { assertHubSessionAdmission, HubSessionError } from "../../src/lifecycle/session.ts";
import type { HubStore } from "../../src/store/store.ts";
import {
	configureModule,
	expectErased,
	noRows,
	PIN,
	refusal,
	type SessionFixture,
	sessionFixture,
} from "./session-helpers.ts";

// session.ts captures the methods it calls when it loads, so these mocks wrap them before then.
const seen = vi.hoisted(() => ({
	steps: [] as string[],
	chains: [] as { chain: AuditChain; key: Uint8Array }[],
	pins: [] as PinService[],
	identities: [] as HubIdentity[],
	devices: [] as DeviceRegistry[],
	deviceRevocation: [] as boolean[],
	hosts: [] as ExtensionHost[],
	databases: [] as WorkDatabase[],
	events: [] as EventLog[],
}));
const faults = vi.hoisted(() => ({
	identityProvider: false,
	onClose: undefined as (() => void) | undefined,
}));
vi.mock("../../src/extensions/free/identity.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/extensions/free/identity.ts")>();
	return {
		...actual,
		singleOwnerIdentity: (registry: DeviceRegistry) => {
			if (faults.identityProvider) throw new Error("DYTEST-PRIVATE-IDENTITY-PROVIDER");
			return actual.singleOwnerIdentity(registry);
		},
	};
});
vi.mock("../../src/extensions/registry.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/extensions/registry.ts")>();
	const startExtensions: typeof actual.startExtensions = async (options) => {
		const host = await actual.startExtensions(options);
		seen.hosts.push(host);
		return Object.freeze({
			...host,
			close: () => {
				seen.steps.push("extensions.close");
				faults.onClose?.();
				host.close();
			},
		});
	};
	return { ...actual, startExtensions };
});
vi.mock("../../src/jobs/database.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/jobs/database.ts")>();
	class RecordedDatabase extends actual.WorkDatabase {
		constructor(...args: ConstructorParameters<typeof actual.WorkDatabase>) {
			super(...args);
			seen.databases.push(this);
		}
	}
	return { ...actual, WorkDatabase: RecordedDatabase };
});
vi.mock("../../src/events/log.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/events/log.ts")>();
	class RecordedEvents extends actual.EventLog {
		constructor(...args: ConstructorParameters<typeof actual.EventLog>) {
			super(...args);
			seen.events.push(this);
		}
	}
	return { ...actual, EventLog: RecordedEvents };
});
vi.mock("../../src/identity/pin.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/identity/pin.ts")>();
	class RecordedPins extends actual.PinService {
		constructor(...args: ConstructorParameters<typeof actual.PinService>) {
			super(...args);
			seen.pins.push(this);
		}
		lock(): void {
			const devices = seen.devices.at(-1);
			if (devices) {
				let revoked = false;
				try {
					devices.currentState();
				} catch {
					revoked = true;
				}
				seen.deviceRevocation.push(revoked);
			}
			seen.steps.push("pins.lock");
			super.lock();
		}
	}
	return { ...actual, PinService: RecordedPins };
});
vi.mock("../../src/identity/devices.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/identity/devices.ts")>();
	class RecordedDevices extends actual.DeviceRegistry {
		constructor(...args: ConstructorParameters<typeof actual.DeviceRegistry>) {
			super(...args);
			seen.devices.push(this);
		}
		lock(): void {
			seen.steps.push("devices.lock");
			super.lock();
		}
	}
	return { ...actual, DeviceRegistry: RecordedDevices };
});
vi.mock("../../src/identity/hub-key.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/identity/hub-key.ts")>();
	const identities = actual.HubIdentity;
	const { loadOrCreate } = identities;
	const { lock } = identities.prototype;
	identities.loadOrCreate = async (...args) => {
		const identity = await loadOrCreate.apply(identities, args);
		seen.identities.push(identity);
		return identity;
	};
	identities.prototype.lock = function (this: HubIdentity) {
		seen.steps.push("identity.lock");
		lock.call(this);
	};
	return { ...actual };
});
vi.mock("../../src/audit/chain.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/audit/chain.ts")>();
	class RecordedChain extends actual.AuditChain {
		constructor(key: Uint8Array) {
			super(key);
			seen.chains.push({ chain: this, key });
		}
		destroy(): void {
			seen.steps.push("audit.destroy");
			super.destroy();
		}
	}
	return { ...actual, AuditChain: RecordedChain };
});
vi.mock("../../src/store/store.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/store/store.ts")>();
	const { close } = actual.HubStore.prototype;
	actual.HubStore.prototype.close = function (this: HubStore) {
		seen.steps.push("store.close");
		close.call(this);
	};
	return { ...actual };
});
vi.mock("../../src/kernel/master-key.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/kernel/master-key.ts")>();
	const { destroy } = actual.MasterKey.prototype;
	actual.MasterKey.prototype.destroy = function (this: MasterKey) {
		seen.steps.push("key.destroy");
		destroy.call(this);
	};
	return { ...actual };
});

let f: SessionFixture;
beforeEach(() => {
	f = sessionFixture();
	faults.identityProvider = false;
	faults.onClose = undefined;
	for (const list of Object.values(seen)) list.length = 0;
});
afterEach(async () => {
	faults.onClose = undefined;
	try {
		for (const host of seen.hosts) host.close();
	} finally {
		await f.remove();
	}
});

const ERASED = Buffer.alloc(32);

it("asserts original admission without constructing plugin database or event services", async () => {
	const session = await f.open();
	const state = session.devices.currentState();
	expect(state.bootstrapDone).toBe(false);
	expect([seen.databases.length, seen.events.length]).toEqual([0, 0]);
	expect(assertHubSessionAdmission(session)).toBeUndefined();
	expect(assertHubSessionAdmission(session)).toBeUndefined();
	expect([seen.databases.length, seen.events.length]).toEqual([0, 0]);
	expect(session.devices.currentState()).toEqual(state);
	expect(seen.steps).toEqual([]);
	session.store.read((db) => session.audit.verify(db));
});

it("rejects admission as close begins while the original Store and key are still live", async () => {
	const key = f.key();
	const session = await f.open({ masterKey: key });
	expect(assertHubSessionAdmission(session)).toBeUndefined();
	let calls = 0;
	const observed = {
		storeLive: false,
		keyLive: false,
		error: undefined as unknown,
		returned: undefined as unknown,
	};
	faults.onClose = () => {
		calls++;
		let storeLive = false;
		let keyLive = false;
		let error: unknown;
		let returned: unknown;
		try {
			storeLive =
				session.store.read((db) => db.get<{ alive: number }>("SELECT 1 AS alive"))?.alive === 1;
		} catch {
			// Record the actual boundary; assertions run outside stop()'s failure-catching callback.
		}
		let derived: Uint8Array | undefined;
		try {
			derived = key.derive("db");
			keyLive = derived.byteLength === 32;
		} catch {
			// A dead key must not masquerade as a phase-only refusal.
		} finally {
			derived?.fill(0);
		}
		try {
			returned = assertHubSessionAdmission(session);
		} catch (reason) {
			error = reason;
		}
		Object.assign(observed, { storeLive, keyLive, error, returned });
	};
	const closing = session.close();
	faults.onClose = undefined;
	await closing;
	expect(calls).toBe(1);
	expect(observed.storeLive).toBe(true);
	expect(observed.keyLive).toBe(true);
	expect(observed.error).toBeInstanceOf(HubSessionError);
	expect(observed.error).toMatchObject({
		name: "HubSessionError",
		code: "SESSION_UNAVAILABLE",
		message: "SESSION_UNAVAILABLE",
	});
	expect(Object.hasOwn(observed.error as object, "cause")).toBe(false);
	expect(observed.returned).toBeUndefined();
	expectErased(key);
});

it("makes one audit chain and one PIN service per open and erases the audit subkey", async () => {
	const session = await f.open();
	expect([seen.chains.length, seen.pins.length, seen.identities.length]).toEqual([1, 1, 1]);
	expect(seen.chains[0]?.chain).toBe(session.audit);
	expect(seen.pins[0]).toBe(session.pins);
	expect(seen.identities[0]).toBe(session.identity);
	expect(seen.devices).toEqual([session.devices]);
	expect(seen.chains[0]?.key).toEqual(ERASED);
	session.store.read((db) => session.audit.verify(db));
	expect(seen.steps).toEqual([]);
});

it("closes the extensions, PIN service, identity, audit key and store, then erases the key", async () => {
	const session = await f.open();
	await session.close();
	await session.close();
	expect(seen.deviceRevocation).toEqual([true]);
	expect(seen.steps).toEqual([
		"extensions.close",
		"devices.lock",
		"pins.lock",
		"identity.lock",
		"audit.destroy",
		"store.close",
		"key.destroy",
	]);
});

it("locks every service a failed open made, in the same order", async () => {
	writeFileSync(path.join(f.folder, "config.json"), "{ not json");
	const key = f.key();
	expect((await refusal(f.open({ masterKey: key }))).code).toBe("EXTENSIONS_UNAVAILABLE");
	expect(seen.deviceRevocation).toEqual([true]);
	expect(seen.steps).toEqual([
		"devices.lock",
		"pins.lock",
		"identity.lock",
		"audit.destroy",
		"store.close",
		"key.destroy",
	]);
	expectErased(key);
	expect([seen.chains.length, seen.pins.length, seen.identities.length]).toEqual([1, 1, 1]);
	expect(seen.chains[0]?.key).toEqual(ERASED);
	expect(() => seen.chains[0]?.chain.verify(noRows)).toThrow("Audit is locked");
	expect(() => seen.identities[0]?.tlsPrivateKey()).toThrow("Hub is locked");
	await expect(seen.pins[0]?.verify("not-a-user", PIN, "approval")).rejects.toThrow("PIN_REQUIRED");
	expect(() => seen.devices[0]?.currentState()).toThrow("UNAVAILABLE");
});

it("destroys the audit key when the identity cannot load", async () => {
	const load = vi
		.spyOn(HubIdentity, "loadOrCreate")
		.mockRejectedValueOnce(new Error("DYTEST identity fault"));
	try {
		const key = f.key();
		expect((await refusal(f.open({ masterKey: key }))).code).toBe("IDENTITY_UNAVAILABLE");
		expect(seen.steps).toEqual(["audit.destroy", "store.close", "key.destroy"]);
		expectErased(key);
		expect([seen.chains.length, seen.pins.length]).toEqual([1, 0]);
		expect(() => seen.chains[0]?.chain.verify(noRows)).toThrow("Audit is locked");
	} finally {
		load.mockRestore();
	}
});

it("retires the started extensions and device authority if identity selection fails", async () => {
	configureModule(f, "provider-selection");
	faults.identityProvider = true;
	const key = f.key();
	const error = await refusal(f.open({ masterKey: key }));
	expect(error).toMatchObject({
		code: "IDENTITY_PROVIDER_UNAVAILABLE",
		message: "IDENTITY_PROVIDER_UNAVAILABLE",
	});
	expect(String(error)).not.toContain("DYTEST-PRIVATE");
	expect(seen.deviceRevocation).toEqual([true]);
	expect(error.cause).toBeUndefined();
	expect(seen.hosts[0]?.providers("auditSink")).toEqual([]);
	expect(seen.steps).toEqual([
		"extensions.close",
		"devices.lock",
		"pins.lock",
		"identity.lock",
		"audit.destroy",
		"store.close",
		"key.destroy",
	]);
	expectErased(key);
	expect(() => seen.devices[0]?.currentState()).toThrow("UNAVAILABLE");
});
