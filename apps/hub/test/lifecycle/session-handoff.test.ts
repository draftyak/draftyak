import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuditChain } from "../../src/audit/chain.ts";
import { HubIdentity } from "../../src/identity/hub-key.ts";
import type { PinService } from "../../src/identity/pin.ts";
import type { MasterKey } from "../../src/kernel/master-key.ts";
import type { HubStore } from "../../src/store/store.ts";
import {
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
}));
vi.mock("../../src/extensions/registry.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/extensions/registry.ts")>();
	const startExtensions: typeof actual.startExtensions = async (options) => {
		const host = await actual.startExtensions(options);
		return Object.freeze({
			...host,
			close: () => {
				seen.steps.push("extensions.close");
				host.close();
			},
		});
	};
	return { ...actual, startExtensions };
});
vi.mock("../../src/identity/pin.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/identity/pin.ts")>();
	class RecordedPins extends actual.PinService {
		constructor(...args: ConstructorParameters<typeof actual.PinService>) {
			super(...args);
			seen.pins.push(this);
		}
		lock(): void {
			seen.steps.push("pins.lock");
			super.lock();
		}
	}
	return { ...actual, PinService: RecordedPins };
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
	for (const list of Object.values(seen)) list.length = 0;
});
afterEach(() => f.remove());

const ERASED = Buffer.alloc(32);

it("makes one audit chain and one PIN service per open and erases the audit subkey", async () => {
	const session = await f.open();
	expect([seen.chains.length, seen.pins.length, seen.identities.length]).toEqual([1, 1, 1]);
	expect(seen.chains[0]?.chain).toBe(session.audit);
	expect(seen.pins[0]).toBe(session.pins);
	expect(seen.identities[0]).toBe(session.identity);
	expect(seen.chains[0]?.key).toEqual(ERASED);
	session.store.read((db) => session.audit.verify(db));
	expect(seen.steps).toEqual([]);
});

it("closes the extensions, PIN service, identity, audit key and store, then erases the key", async () => {
	const session = await f.open();
	session.close();
	session.close();
	expect(seen.steps).toEqual([
		"extensions.close",
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
	expect(seen.steps).toEqual([
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
