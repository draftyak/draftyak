import { createSecretKey, generateKeyPairSync, KeyObject } from "node:crypto";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { NativeAppReleaseError } from "../src/paths.ts";
import { buildNativeAppTrustSource } from "../src/trust-source.ts";

const declared = () => ({
	version: "1.2.3-beta.1+build.4",
	executable: "node",
	entry: "hub/hub.mjs",
	module: "hub/installed-main.mjs",
});
const publicFixture = () => generateKeyPairSync("ed25519").publicKey;
function emitted(source: string): Readonly<Record<string, string>> {
	const javascript = source
		.replace(/export interface NativeAppReleaseTrust \{[^}]+\}\n/, "")
		.replace(
			"export const nativeAppReleaseTrust: Readonly<NativeAppReleaseTrust>",
			"const nativeAppReleaseTrust",
		);
	return vm.runInNewContext(`${javascript}\nnativeAppReleaseTrust;`, Object.create(null));
}
function refused(key: unknown, layout: unknown): void {
	expect(() => buildNativeAppTrustSource(key as KeyObject, layout)).toThrow(NativeAppReleaseError);
}

describe("fixed native application trust Source", () => {
	it("emits only the declared frozen trust and exact genuine public SPKI", () => {
		const key = publicFixture(),
			row = declared(),
			source = buildNativeAppTrustSource(key, row);
		expect(emitted(source)).toEqual({
			...row,
			publicKeyDer: key.export({ format: "der", type: "spki" }).toString("base64"),
		});
		expect(Object.isFrozen(emitted(source))).toBe(true);
		expect(source).toContain("export interface NativeAppReleaseTrust");
		expect(source).not.toMatch(/\bimport\b|process\.|require\(|privateKey|BEGIN PRIVATE/);
	});
	it("accepts Windows node and null-prototype data without retaining caller state", () => {
		const key = publicFixture(),
			row = Object.assign(Object.create(null), declared(), { executable: "node.exe" });
		const source = buildNativeAppTrustSource(key, row);
		row.module = "hub/changed.mjs";
		row.version = "9.9.9";
		expect(emitted(source)).toMatchObject({
			executable: "node.exe",
			module: "hub/installed-main.mjs",
			version: "1.2.3-beta.1+build.4",
		});
	});
	it("rejects private keys before touching their export method", () => {
		const { privateKey } = generateKeyPairSync("ed25519"),
			touched = vi.fn(() => {
				throw new Error("unused");
			});
		Object.defineProperty(privateKey, "export", { get: touched });
		refused(privateKey, declared());
		expect(touched).not.toHaveBeenCalled();
	});
	it("rejects other algorithms, secret keys, spoofs, proxies and revoked proxies", () => {
		refused(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey, declared());
		refused(createSecretKey(new Uint8Array(32)), declared());
		refused(Object.create(KeyObject.prototype), declared());
		refused(null, declared());
		refused(new Proxy(publicFixture(), {}), declared());
		const revoked = Proxy.revocable(publicFixture(), {});
		revoked.revoke();
		refused(revoked.proxy, declared());
	});
	it("rejects a shadowed key accessor without invoking it", () => {
		const key = publicFixture(),
			getter = vi.fn(() => {
				throw new Error("unused");
			});
		Object.defineProperty(key, "export", { get: getter });
		refused(key, declared());
		expect(getter).not.toHaveBeenCalled();
	});
	it("rejects a substituted public DER that does not match the supplied key", () => {
		const key = publicFixture(),
			other = publicFixture(),
			prototype = Object.create(Object.getPrototypeOf(key));
		Object.defineProperty(prototype, "export", {
			value: () => other.export({ format: "der", type: "spki" }),
		});
		Object.setPrototypeOf(key, prototype);
		refused(key, declared());
	});
	it.each([
		null,
		[],
		{},
		{ ...declared(), extra: true },
		Object.assign(declared(), { [Symbol("extra")]: 1 }),
	])("rejects non-closed layout data %#", (row) => refused(publicFixture(), row));
	it.each(["version", "executable", "entry", "module"])(
		"rejects missing/accessor/nonenumerable %s",
		(field) => {
			const key = publicFixture(),
				missing = declared() as Record<string, unknown>;
			delete missing[field];
			refused(key, missing);
			const row = declared(),
				getter = vi.fn(() => {
					throw new Error("unused");
				});
			Object.defineProperty(row, field, { get: getter });
			refused(key, row);
			expect(getter).not.toHaveBeenCalled();
			Object.defineProperty(row, field, { value: "unused", enumerable: false });
			refused(key, row);
		},
	);
	it("rejects proxy layouts before all reflection traps", () => {
		const trap = vi.fn(() => {
				throw new Error("unused");
			}),
			row = new Proxy(declared(), { getPrototypeOf: trap, ownKeys: trap });
		refused(publicFixture(), row);
		expect(trap).not.toHaveBeenCalled();
		const revoked = Proxy.revocable(declared(), {});
		revoked.revoke();
		refused(publicFixture(), revoked.proxy);
	});
	it.each([
		"01.2.3",
		"1.2",
		"1.2.3-01",
		"1.2.3\n",
		'1.2.3";throw 1;//',
		"1.2.3-" + "a".repeat(128),
	])("rejects invalid versions %s", (version) =>
		refused(publicFixture(), { ...declared(), version }),
	);
	it.each(["1.0.0", "0.0.0", "1.2.3-0", "1.2.3-a.01b+meta.01"])(
		"retains release version grammar %s",
		(version) =>
			expect(
				emitted(buildNativeAppTrustSource(publicFixture(), { ...declared(), version })).version,
			).toBe(version),
	);
	it.each([
		"../main.mjs",
		"hub/../main.mjs",
		"hub/main.js",
		"other/main.mjs",
		"hub/.env.mjs",
		"hub/CON.mjs",
		"hub/a\\b.mjs",
		'hub/a".mjs',
		"hub/a\n.mjs",
		"hub/" + "a".repeat(200) + ".mjs",
	])("rejects unsafe module %s", (module) => refused(publicFixture(), { ...declared(), module }));
	it.each([
		{ executable: "bin/node" },
		{ executable: "node --eval x" },
		{ entry: "hub/main.mjs" },
		{ entry: "hub/hub.mjs\n" },
	])("rejects undeclared launcher layout %#", (change) =>
		refused(publicFixture(), { ...declared(), ...change }),
	);
});
