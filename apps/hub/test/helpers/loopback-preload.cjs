"use strict";

// Install before DNS consumers initialize; never ship this test-only preload.
if (process.env.NODE_ENV !== "test") throw new Error("Test network preload requires NODE_ENV=test");
const tcp = process.binding("tcp_wrap");
const cares = process.binding("cares_wrap");
const denialCode = process.binding("uv").UV_EACCES;
if (!Number.isInteger(denialCode) || denialCode >= 0)
	throw new Error("Native denial code unavailable");
const key = Symbol.for("draftyak.test.loopback-network");
if (Object.hasOwn(globalThis, key)) throw new Error("Test network preload already installed");
const entries = [];
const loopbackAddress = (address) => address === "127.0.0.1" || address === "::1";
function restrictConnect(original) {
	return function (...args) {
		if (!loopbackAddress(args[1])) return denialCode;
		return Reflect.apply(original, this, args);
	};
}
function deny() {
	return denialCode;
}
function replace(object, property, replacement) {
	const before = Object.getOwnPropertyDescriptor(object, property);
	if (!before || !Object.hasOwn(before, "value") || typeof before.value !== "function")
		throw new Error("Test network native entry point unavailable");
	Object.defineProperty(object, property, { ...before, value: replacement });
	entries.push({ object, property, replacement });
}
for (const property of ["connect", "connect6"])
	replace(tcp.TCP.prototype, property, restrictConnect(tcp.TCP.prototype[property]));
for (const property of ["getaddrinfo", "getnameinfo"]) replace(cares, property, deny);
for (const property of Object.getOwnPropertyNames(cares.ChannelWrap.prototype)) {
	if (property.startsWith("query") || property === "getHostByAddr")
		replace(cares.ChannelWrap.prototype, property, deny);
}
function assertActive() {
	if (process.env.NODE_ENV !== "test" || process.env.VITEST !== "true")
		throw new Error("Test network guard requires the test runner");
	if (
		entries.length !== 18 ||
		entries.some(
			({ object, property, replacement }) =>
				Object.getOwnPropertyDescriptor(object, property)?.value !== replacement,
		)
	)
		throw new Error("Test network native guard is not installed");
	// Fake receivers cannot perform I/O; refusal must precede every C++ operation.
	for (const method of [tcp.TCP.prototype.connect, tcp.TCP.prototype.connect6]) {
		for (const address of ["192.0.2.1", "2001:db8::1", "example.invalid", undefined]) {
			const refused = Reflect.apply(method, {}, [{}, address, 9]) === denialCode;
			if (!refused) throw new Error("Test network native denial proof failed");
		}
	}
	for (const { object, property, replacement } of entries) {
		if (object === tcp.TCP.prototype) continue;
		const refused = Reflect.apply(replacement, {}, []) === denialCode;
		if (!refused || object[property] !== replacement)
			throw new Error("Test DNS native denial proof failed");
	}
}
const guard = Object.freeze({ assertActive, loopbackAddress, restrictConnect, denialCode });
Object.defineProperty(globalThis, key, { value: guard, configurable: false, writable: false });
module.exports = guard;
