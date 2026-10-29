import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as artifacts from "../../src/artifacts/index.ts";
import { type PackageLock, preparePinnedPackage } from "../../src/artifacts/index.ts";
import { makePinnedPackage, packageEntries } from "./fixtures.ts";

function preparedIdentity(name: string, version: string) {
	const input = makePinnedPackage(packageEntries({ name, version, type: "module" }), {
		name,
		version,
	});
	return preparePinnedPackage(input.archive, input.lock);
}

function refused(action: () => unknown): void {
	expect(action).toThrowError(
		expect.objectContaining({ name: "ArtifactError", message: "Artifact verification refused." }),
	);
}

describe("pinned artifact public input contract", () => {
	it("exports exactly the preparation and verification functions at runtime", () => {
		expect(Object.keys(artifacts).sort()).toEqual([
			"canonicalDirectory",
			"preparePinnedPackage",
			"verifyBundle",
			"verifyBundleFile",
		]);
		expect(Object.values(artifacts).every((value) => typeof value === "function")).toBe(true);
	});

	it("accepts a native-tool USTAR package independently of the test encoder", () => {
		const archive = readFileSync(new URL("./fixtures/native-ustar-package.tgz", import.meta.url));
		const prepared = preparePinnedPackage(archive, {
			name: "fixture-artifact",
			version: "1.2.3",
			entry: "index.mjs",
			integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
		});
		expect(prepared.inventory.files.map((row) => row.path)).toEqual([
			"empty",
			"index.mjs",
			"package.json",
		]);
		expect(prepared.files.get("index.mjs")?.toString()).toBe(
			"export const fixture = 'DYTEST native USTAR';\n",
		);
		expect(prepared.files.get("empty")).toEqual(Buffer.alloc(0));
	});

	it("accepts a null-prototype primitive lock and owns the returned file bytes", () => {
		const { archive, lock } = makePinnedPackage(
			packageEntries(undefined, [{ name: "package/empty", body: "" }]),
		);
		const prepared = preparePinnedPackage(archive, Object.assign(Object.create(null), lock));
		const entry = Buffer.from(prepared.files.get("index.mjs") ?? []);
		archive.fill(0);
		expect(prepared.files.get("index.mjs")).toEqual(entry);
		expect(prepared.files.get("empty")).toEqual(Buffer.alloc(0));
		expect(prepared.inventory.files.find((row) => row.path === "empty")).toEqual({
			path: "empty",
			bytes: 0,
			sha256: createHash("sha256").update("").digest("hex"),
		});
		prepared.files.get("index.mjs")?.fill(0);
		expect(prepared.inventory.files.find((row) => row.path === "index.mjs")?.sha256).toBe(
			createHash("sha256").update(entry).digest("hex"),
		);
	});

	it("rejects lock accessors without evaluating them", () => {
		for (const key of ["name", "version", "integrity", "entry"] as const) {
			const { archive, lock } = makePinnedPackage();
			let calls = 0;
			Object.defineProperty(lock, key, {
				enumerable: true,
				get() {
					calls++;
					return "DYTEST";
				},
			});
			refused(() => preparePinnedPackage(archive, lock));
			expect(calls).toBe(0);
		}
	});

	it("rejects lock proxies before any reflection trap", () => {
		const { archive, lock } = makePinnedPackage();
		let traps = 0;
		const proxied = new Proxy(lock, {
			ownKeys() {
				traps++;
				return Reflect.ownKeys(lock);
			},
			getPrototypeOf() {
				traps++;
				return Object.prototype;
			},
			getOwnPropertyDescriptor(target, key) {
				traps++;
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
			get(target, key, receiver) {
				traps++;
				return Reflect.get(target, key, receiver);
			},
		});
		refused(() => preparePinnedPackage(archive, proxied));
		expect(traps).toBe(0);
	});

	it("rejects revoked proxies, inherited fields, hidden fields, symbols and extra own fields", () => {
		const { archive, lock } = makePinnedPackage();
		const revoked = Proxy.revocable(lock, {});
		revoked.revoke();
		const hidden = { ...lock };
		Object.defineProperty(hidden, "entry", { value: lock.entry, enumerable: false });
		for (const invalid of [
			revoked.proxy,
			Object.create(lock),
			hidden,
			{ ...lock, [Symbol("DYTEST")]: true },
			{ ...lock, extra: true },
		]) {
			refused(() => preparePinnedPackage(archive, invalid));
		}
	});

	it("rejects a class-instance lock and extra string fields beside an accepted plain lock", () => {
		const { archive, lock } = makePinnedPackage();
		class Lock {
			name = lock.name;
			version = lock.version;
			integrity = lock.integrity;
			entry = lock.entry;
		}
		for (const invalid of [
			new Lock(),
			{ ...lock, extra: "DYTEST" },
			{ ...lock, [Symbol("DYTEST")]: "DYTEST" },
		]) {
			refused(() => preparePinnedPackage(archive, invalid));
		}
		expect(preparePinnedPackage(archive, { ...lock }).inventory.name).toBe(lock.name);
	});

	it("returns every file in its own backing store", () => {
		const { archive, lock } = makePinnedPackage(
			packageEntries(undefined, [
				{ name: "package/empty", body: "" },
				{ name: "package/small", body: "DYTEST" },
				{ name: "package/large", body: Buffer.alloc(70_000, 0x41) },
			]),
		);
		const prepared = preparePinnedPackage(archive, lock);
		expect(prepared.files.size).toBe(5);
		for (const bytes of prepared.files.values()) {
			expect(bytes.byteOffset).toBe(0);
			expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
		}
	});

	it("refuses coercible lock values without conversion hooks", () => {
		const { archive, lock } = makePinnedPackage();
		let calls = 0;
		const value = {
			toString() {
				calls++;
				return lock.name;
			},
			valueOf() {
				calls++;
				return lock.name;
			},
			[Symbol.toPrimitive]() {
				calls++;
				return lock.name;
			},
		};
		refused(() =>
			preparePinnedPackage(archive, { ...lock, name: value } as unknown as PackageLock),
		);
		expect(calls).toBe(0);
	});

	it("uses the selected Uint8Array offset and ignores caller byte metadata and iteration", () => {
		const { archive, lock } = makePinnedPackage();
		const parent = Buffer.alloc(archive.length + 19, 0xa5);
		parent.set(archive, 7);
		const selected = new Uint8Array(parent.buffer, parent.byteOffset + 7, archive.length);
		let calls = 0;
		for (const key of ["buffer", "byteOffset", "byteLength", "length"]) {
			Object.defineProperty(selected, key, {
				get() {
					calls++;
					throw new Error("DYTEST byte hook");
				},
			});
		}
		Object.defineProperty(selected, Symbol.iterator, {
			value() {
				calls++;
				throw new Error("DYTEST iterator");
			},
		});
		const result: { prepared?: ReturnType<typeof preparePinnedPackage> } = {};
		expect(() => {
			result.prepared = preparePinnedPackage(selected, lock);
		}).not.toThrow();
		expect(result.prepared?.inventory.name).toBe(lock.name);
		expect(calls).toBe(0);
	});

	it("refuses byte proxies without property or reflection hooks", () => {
		const { archive, lock } = makePinnedPackage();
		let calls = 0;
		const bytes = new Proxy(archive, {
			get() {
				calls++;
				throw new Error("DYTEST proxy");
			},
			getPrototypeOf() {
				calls++;
				return Uint8Array.prototype;
			},
		});
		refused(() => preparePinnedPackage(bytes, lock));
		expect(calls).toBe(0);
	});

	it("refuses shared, resizable and detached backing stores", () => {
		const { archive, lock } = makePinnedPackage();
		const shared = new Uint8Array(new SharedArrayBuffer(archive.length));
		shared.set(archive);
		refused(() => preparePinnedPackage(shared, lock));
		const resizable = new Uint8Array(
			new ArrayBuffer(archive.length, { maxByteLength: archive.length + 1 }),
		);
		resizable.set(archive);
		refused(() => preparePinnedPackage(resizable, lock));
		const detached = Uint8Array.from(archive);
		structuredClone(detached.buffer, { transfer: [detached.buffer] });
		refused(() => preparePinnedPackage(detached, lock));
	});

	it("keeps separate preparation results independent", () => {
		const { archive, lock } = makePinnedPackage();
		const first = preparePinnedPackage(archive, lock);
		const second = preparePinnedPackage(archive, lock);
		const expected = Buffer.from(second.files.get("index.mjs") ?? []);
		first.files.get("index.mjs")?.fill(0);
		expect(second.files.get("index.mjs")).toEqual(expected);
		expect(archive[0]).toBe(0x1f);
	});

	it("rejects duplicate JSON keys, trailing documents and non-JSON numbers after a valid pin", () => {
		const jsons = [
			'{"name":"fixture-artifact","name":"fixture-artifact","version":"1.2.3","type":"module"}',
			'{"name":"fixture-artifact","version":"1.2.3","type":"module","nested":{"x":1,"x":1}}',
			'{"name":"fixture-artifact","version":"1.2.3","type":"module"}{}',
			'{"name":"fixture-artifact","version":"1.2.3","type":"module","x":NaN}',
		];
		for (const body of jsons) {
			const input = makePinnedPackage([
				{ name: "package/package.json", body },
				{ name: "package/index.mjs", body: "DYTEST" },
			]);
			refused(() => preparePinnedPackage(input.archive, input.lock));
		}
	});

	it("rejects ill-formed UTF-8 JSON rather than accepting replacement characters", () => {
		const prefix = Buffer.from(
			'{"name":"fixture-artifact","version":"1.2.3","type":"module","x":"',
		);
		const body = Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
		const input = makePinnedPackage([
			{ name: "package/package.json", body },
			{ name: "package/index.mjs", body: "DYTEST" },
		]);
		refused(() => preparePinnedPackage(input.archive, input.lock));
	});

	it("requires canonical base64 padding bits even when decoded pin bytes are unchanged", () => {
		const { archive, lock } = makePinnedPackage();
		const encoded = lock.integrity.slice(7);
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		const at = alphabet.indexOf(encoded.charAt(85));
		const alias = `${encoded.slice(0, 85)}${alphabet[at + 1]}==`;
		expect(Buffer.from(alias, "base64")).toEqual(Buffer.from(encoded, "base64"));
		refused(() => preparePinnedPackage(archive, { ...lock, integrity: `sha512-${alias}` }));
	});

	it("requires the exact sha512 label on a pin whose digest matches", () => {
		const { archive, lock } = makePinnedPackage();
		const encoded = lock.integrity.slice(7);
		for (const label of ["sha384-", "sha256-", "SHA512-"])
			refused(() => preparePinnedPackage(archive, { ...lock, integrity: `${label}${encoded}` }));
		expect(preparePinnedPackage(archive, lock).inventory.integrity).toBe(lock.integrity);
	});

	it("accepts SemVer prerelease/build distinctions and rejects numeric prerelease leading zeros", () => {
		for (const version of [
			"0.0.0",
			"1.2.3-0",
			"1.2.3-01a",
			"1.2.3-alpha.0",
			"1.2.3+001",
			"1.2.3-alpha+001",
		]) {
			expect(preparedIdentity("fixture-artifact", version).inventory.version).toBe(version);
		}
		for (const version of [
			"01.2.3",
			"1.02.3",
			"1.2.03",
			"1.2.3-01",
			"1.2.3-a.01",
			"1.2.3-",
			"1.2.3+",
			"1.2.3-a..b",
			"1.2.3\n",
		]) {
			refused(() => preparedIdentity("fixture-artifact", version));
		}
	});

	it("enforces exact primitive name/version length boundaries without truncation", () => {
		const name = "a".repeat(214);
		const version = `1.2.${"3".repeat(124)}`;
		expect(preparedIdentity(name, version).inventory).toMatchObject({ name, version });
		refused(() => preparedIdentity(`${name}a`, "1.2.3"));
		refused(() => preparedIdentity("fixture-artifact", `${version}3`));
		refused(() => preparedIdentity("fixture-artifact\n", "1.2.3"));
	});
});
