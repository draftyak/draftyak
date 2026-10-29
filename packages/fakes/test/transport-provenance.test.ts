import { expect, it, vi } from "vitest";
import { createFake, resolveFakeTransport } from "../src/index.ts";
import { resolveFakeTransport as resolveServerTransport } from "../src/server.ts";

const HOST = "transport.draftyak.example";

function fixture() {
	const app = {
		fetch: vi.fn((request: Request) => Response.json({ path: new URL(request.url).pathname })),
	};
	return { app, fake: createFake(app, { host: HOST.toUpperCase() }) };
}

it("resolves only genuine results through both package entry points", async () => {
	const { app, fake } = fixture();
	const transport = resolveFakeTransport(fake);
	if (!transport) throw new Error("Expected a genuine transport");
	expect(resolveServerTransport(fake)).toBe(transport);
	expect(transport.host).toBe(HOST);
	expect(await (await transport.fetch("/fixture")).json()).toEqual({ path: "/fixture" });
	expect(app.fetch).toHaveBeenCalledOnce();
	expect(fake.recorder.takeRequests()).toMatchObject([{ host: HOST, path: "/fixture" }]);
	for (const forged of [
		{ ...fake },
		Object.assign(Object.create(null), fake),
		Object.create(fake),
		{ host: HOST, fetch: fake.fetch },
		fake.fetch,
		null,
		undefined,
		false,
		0,
		HOST,
		Symbol("DYTEST-transport"),
	])
		expect(resolveFakeTransport(forged)).toBeUndefined();
});

it("does not inspect accessors, proxies or revoked proxies", () => {
	const { fake } = fixture();
	const trap = vi.fn(() => {
		throw new Error("DYTEST-input-hook");
	});
	const accessor = Object.defineProperties({}, { host: { get: trap }, fetch: { get: trap } });
	const handler: ProxyHandler<object> = {
		get: trap,
		getOwnPropertyDescriptor: trap,
		getPrototypeOf: trap,
		ownKeys: trap,
	};
	const revoked = Proxy.revocable(fake, handler);
	revoked.revoke();
	for (const value of [accessor, new Proxy(fake, handler), new Proxy({}, handler), revoked.proxy])
		expect(resolveFakeTransport(value)).toBeUndefined();
	expect(trap).not.toHaveBeenCalled();
});

it("captures the original host and fetch before public members change", async () => {
	const { app, fake } = fixture();
	const replacement = vi.fn(() => Promise.reject(new Error("DYTEST-replacement")));
	Object.defineProperty(fake, "host", { value: "changed.draftyak.example" });
	fake.fetch = replacement;
	const transport = resolveFakeTransport(fake);
	if (!transport) throw new Error("Expected a genuine transport");
	expect(transport.host).toBe(HOST);
	expect(await (await transport.fetch("/original")).json()).toEqual({ path: "/original" });
	expect(app.fetch).toHaveBeenCalledOnce();
	expect(replacement).not.toHaveBeenCalled();
	const trap = vi.fn(() => {
		throw new Error("DYTEST-mutated-accessor");
	});
	Object.defineProperties(fake, { host: { get: trap }, fetch: { get: trap } });
	expect(resolveFakeTransport(fake)).toBe(transport);
	expect(await (await transport.fetch("/captured")).json()).toEqual({ path: "/captured" });
	expect(trap).not.toHaveBeenCalled();
});

it("freezes each transport record and keeps separate results separate", async () => {
	const { fake } = fixture();
	const other = fixture().fake;
	const transport = resolveFakeTransport(fake);
	if (!transport) throw new Error("Expected a genuine transport");
	expect(Object.isFrozen(transport)).toBe(true);
	expect(() =>
		Object.defineProperty(transport, "host", { value: "changed.draftyak.example" }),
	).toThrow(TypeError);
	expect(() => Object.defineProperty(transport, "fetch", { value: vi.fn() })).toThrow(TypeError);
	expect(resolveFakeTransport(fake)).toBe(transport);
	expect(resolveFakeTransport(other)).not.toBe(transport);
	expect(await (await transport.fetch.call(other, "/bound")).json()).toEqual({ path: "/bound" });
	expect(fake.recorder.takeRequests()).toMatchObject([{ path: "/bound" }]);
	expect(other.recorder.takeRequests()).toHaveLength(0);
});
