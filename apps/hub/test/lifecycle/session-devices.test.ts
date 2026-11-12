import { afterEach, beforeEach, expect, it } from "vitest";
import { DeviceRegistry, isDeviceRegistry } from "../../src/identity/devices.ts";
import {
	expectErased,
	refusalNow,
	type SessionFixture,
	sessionFixture,
} from "./session-helpers.ts";

let f: SessionFixture;
beforeEach(() => {
	f = sessionFixture("draftyak-session-devices-");
});
afterEach(() => f.remove());

it("owns one real native device registry bound to the session's store", async () => {
	const session = await f.open();
	expect(session.devices).toBeInstanceOf(DeviceRegistry);
	expect(isDeviceRegistry(session.devices)).toBe(true);
	expect(session.devices.currentState()).toEqual({
		epoch: 0,
		bootstrapDone: false,
		ownerUserId: null,
	});
	expect(() => session.devices.assertStore(session.store)).not.toThrow();
	expect(session.identityProvider.id).toBe("single-owner");
	expect(session.identityProvider.maxOwners()).toBe(1);
	expect(await session.identityProvider.users()).toEqual([]);
	expect(Object.getOwnPropertyDescriptor(session, "devices")).toMatchObject({
		value: session.devices,
		writable: false,
	});
	const other = sessionFixture("draftyak-session-devices-other-");
	try {
		const foreign = await other.open();
		expect(() => session.devices.assertStore(foreign.store)).toThrow("UNAVAILABLE");
	} finally {
		other.remove();
	}
});

it("locks the registry when a real busy store forces a close retry", async () => {
	const key = f.key();
	const session = await f.open({ masterKey: key });
	session.store.read(() => {
		expect(refusalNow(() => session.close()).code).toBe("CLOSE_INCOMPLETE");
		expect(() => session.devices.currentState()).toThrow("UNAVAILABLE");
	});
	expectErased(key);
	session.close();
	const next = await f.open();
	expect(next.devices).not.toBe(session.devices);
	expect(next.devices.currentState()).toEqual({
		epoch: 0,
		bootstrapDone: false,
		ownerUserId: null,
	});
	expect(() => session.devices.currentState()).toThrow("UNAVAILABLE");
});
