import { describe, expect, it } from "vitest";
import { routeAllows } from "../src/device-api.ts";
import { DeviceCapability } from "../src/entities/device.ts";

const peer = () => ({
	role: "device",
	known: true,
	revoked: false,
	epoch: 3,
	confirmedEpoch: 3,
	capabilities: ["read", "draft", "organize", "approve", "admin"],
	sidecarClaim: false,
	bootstrapDone: true,
});
const fields = Object.keys(peer());

describe("device API peer data", () => {
	it.each(["status", "pairing-window", "admin", "events"])(
		"keeps valid plain peers admitted on %s",
		(route) => {
			expect(routeAllows(route, peer())).toBe(true);
			expect(routeAllows(route, Object.assign(Object.create(null), peer()))).toBe(true);
		},
	);

	it("requires own fields instead of an inherited valid peer", () => {
		expect(routeAllows("admin", Object.create(peer()))).toBe(false);
		for (const field of fields) {
			const original = peer();
			const inherited = Object.assign(
				Object.create({ [field]: Reflect.get(original, field) }),
				original,
			);
			Reflect.deleteProperty(inherited, field);
			expect(routeAllows("admin", inherited)).toBe(false);
		}
	});

	it.each(fields)("requires enumerable own data for peer field %s", (field) => {
		const original = peer();
		const nonenumerable = Object.defineProperty({ ...original }, field, {
			value: Reflect.get(original, field),
			enumerable: false,
		});
		expect(routeAllows("admin", original)).toBe(true);
		expect(routeAllows("admin", nonenumerable)).toBe(false);
	});

	it("refuses own or inherited accessors without invoking them", () => {
		let calls = 0;
		for (const field of fields) {
			const accessor = Object.defineProperty(peer(), field, {
				enumerable: true,
				get() {
					calls++;
					return Reflect.get(peer(), field);
				},
			});
			expect(routeAllows("admin", accessor)).toBe(false);
			expect(routeAllows("admin", Object.create(accessor))).toBe(false);
		}
		expect(calls).toBe(0);
	});

	it("refuses peer and capability proxies without invoking traps", () => {
		let calls = 0;
		const trapped = <T extends object>(value: T): T =>
			new Proxy(value, {
				get() {
					calls++;
					throw new Error("Unexpected peer get");
				},
				getPrototypeOf() {
					calls++;
					throw new Error("Unexpected peer prototype read");
				},
				ownKeys() {
					calls++;
					throw new Error("Unexpected peer keys read");
				},
			});
		expect(routeAllows("admin", trapped(peer()))).toBe(false);
		expect(routeAllows("admin", { ...peer(), capabilities: trapped(["admin"]) })).toBe(false);
		expect(routeAllows("admin", { ...peer(), role: trapped({}) })).toBe(false);
		expect(calls).toBe(0);
	});

	it("keeps nonenumerable own capability indices admitted", () => {
		const capabilities = Object.defineProperty(["admin"], "0", {
			value: "admin",
			enumerable: false,
		});
		expect(routeAllows("admin", { ...peer(), capabilities })).toBe(true);
	});

	it("ignores unused own array metadata without invoking it", () => {
		let calls = 0;
		const unused = () => {
			calls++;
			throw new Error("Unexpected capability metadata read");
		};
		const capabilities = Object.defineProperties(["admin"], {
			[Symbol.iterator]: { get: unused },
			constructor: { get: unused },
			metadata: { get: unused, enumerable: true },
		});
		expect(routeAllows("admin", { ...peer(), capabilities })).toBe(true);
		expect(calls).toBe(0);
	});

	it("keeps own capability data on custom array prototypes and subclasses admitted", () => {
		let calls = 0;
		const prototype = Object.defineProperty(Object.create(Array.prototype), Symbol.iterator, {
			get() {
				calls++;
				throw new Error("Unexpected capability prototype iterator read");
			},
		});
		class Capabilities extends Array<string> {}
		for (const capabilities of [
			Object.setPrototypeOf(["admin"], prototype),
			new Capabilities("admin"),
		])
			expect(routeAllows("admin", { ...peer(), capabilities })).toBe(true);
		expect(calls).toBe(0);
	});

	it("copies only own capability strings without consulting array hooks", () => {
		let calls = 0;
		const getter = () => {
			calls++;
			return "admin";
		};
		const accessor = Object.defineProperty([], "0", { enumerable: true, get: getter });
		const inherited = Object.setPrototypeOf(
			Array(1),
			Object.defineProperty(Object.create(Array.prototype), "0", { get: getter }),
		);
		for (const capabilities of [
			accessor,
			inherited,
			Array(1),
			["admin", "admin"],
			[{ admin: null }],
		])
			expect(routeAllows("admin", { ...peer(), capabilities })).toBe(false);
		expect(calls).toBe(0);
	});

	it("refuses oversized capability arrays before inspecting any entry descriptor", () => {
		const short = ["admin"];
		const oversized = Array<string>(DeviceCapability.options.length + 1).fill("admin");
		const nativeDescriptor = Object.getOwnPropertyDescriptor;
		let shortEntries = 0;
		let oversizedEntries = 0;
		let shortAllowed = false;
		let oversizedAllowed = false;
		try {
			Object.getOwnPropertyDescriptor = (target, key) => {
				const numeric = typeof key === "string" && /^(0|[1-9][0-9]*)$/u.test(key);
				if (numeric && target === short) shortEntries++;
				if (numeric && target === oversized) oversizedEntries++;
				return nativeDescriptor(target, key);
			};
			shortAllowed = routeAllows("admin", { ...peer(), capabilities: short });
			oversizedAllowed = routeAllows("admin", { ...peer(), capabilities: oversized });
		} finally {
			Object.getOwnPropertyDescriptor = nativeDescriptor;
		}
		expect(Object.getOwnPropertyDescriptor).toBe(nativeDescriptor);
		expect(shortAllowed).toBe(true);
		expect(shortEntries).toBeGreaterThan(0);
		expect(oversizedAllowed).toBe(false);
		expect(oversizedEntries).toBe(0);
	});

	it("keeps pending status, sidecar bootstrap and operation policies unchanged", () => {
		const pending = {
			...peer(),
			confirmedEpoch: null,
			capabilities: [],
			sidecarClaim: true,
			bootstrapDone: false,
		};
		expect(routeAllows("status", pending)).toBe(true);
		expect(routeAllows("bootstrap", pending)).toBe(true);
		expect(routeAllows("bootstrap", { ...pending, bootstrapDone: true })).toBe(false);
		expect(routeAllows("bootstrap", { ...pending, sidecarClaim: false })).toBe(false);
		expect(routeAllows("new-operation", peer(), { kind: "data.export" })).toBe(true);
		expect(routeAllows("challenge", peer(), { kind: "admin.v1" })).toBe(true);
		expect(routeAllows("pair-confirmation", peer(), { preset: "desktop" })).toBe(true);
		expect(routeAllows("new-operation", peer(), { kind: "unknown" })).toBe(false);
		expect(routeAllows("pair-confirmation", peer(), { preset: "unknown" })).toBe(false);
	});

	it("keeps required authority facts unchanged", () => {
		for (const changed of [
			{ known: false },
			{ revoked: true },
			{ role: "host:sms" },
			{ confirmedEpoch: null },
			{ confirmedEpoch: 2 },
			{ capabilities: ["approve"] },
			{ capabilities: ["unknown", "admin"] },
		])
			expect(routeAllows("admin", { ...peer(), ...changed })).toBe(false);
		expect(routeAllows("unknown", peer())).toBe(false);
	});
});
