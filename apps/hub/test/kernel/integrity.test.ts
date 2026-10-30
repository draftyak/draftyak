import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ArtifactError } from "../../src/artifacts/archive.ts";
import { preparePinnedPackage, snapshotPackageLock } from "../../src/artifacts/pin.ts";
import { pinDigest } from "../../src/extensions/config.ts";
import { ExtensionError } from "../../src/extensions/errors.ts";
import * as integrity from "../../src/kernel/integrity.ts";
import { makePinnedPackage } from "../artifacts/fixtures.ts";

const digest = createHash("sha512").update("pin").digest();
const encoded = digest.toString("base64");
const body = encoded.slice(0, 86);
const pin = `sha512-${encoded}`;
const sri = (label: string, bytes: Uint8Array): string =>
	`${label}-${Buffer.from(bytes).toString("base64")}`;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const lastIndex = alphabet.indexOf(body.charAt(85));
const padBitAliases: [string, string][] = Array.from({ length: 15 }, (_, index) => [
	`pad-bit alias ${index + 1}`,
	`sha512-${body.slice(0, 85)}${alphabet.charAt(lastIndex | (index + 1))}==`,
]);
const urlSafe = pin.replaceAll("+", "-").replaceAll("/", "_");
const wrongLengths: [string, string, number][] = [
	["a canonical 61-byte digest", sri("sha512", digest.subarray(0, 61)), 61],
	["a canonical 67-byte digest", sri("sha512", Buffer.concat([digest, digest.subarray(0, 3)])), 67],
];

const accepted: [string, string, Buffer][] = [
	["a sha512 digest", pin, digest],
	["an all-zero digest", sri("sha512", Buffer.alloc(64)), Buffer.alloc(64)],
	["an all-ones digest", sri("sha512", Buffer.alloc(64, 0xff)), Buffer.alloc(64, 0xff)],
];

const refused: [string, unknown][] = [
	["syntax: bare base64", encoded],
	["syntax: an upper-case label", `SHA512-${encoded}`],
	["syntax: a label without its dash", `sha512${encoded}`],
	["syntax: a colon after the label", `sha512:${encoded}`],
	["syntax: a doubled label", `sha512-${pin}`],
	["syntax: a sha256 label", `sha256-${encoded}`],
	["syntax: a sha384 label", `sha384-${encoded}`],
	["syntax: a sha256 digest", sri("sha256", createHash("sha256").update("pin").digest())],
	["syntax: a sha384 digest", sri("sha384", createHash("sha384").update("pin").digest())],
	["syntax: 85 characters", `sha512-${body.slice(0, 85)}==`],
	["syntax: 87 characters", `sha512-${body}A==`],
	...wrongLengths.map(([name, value]): [string, unknown] => [`length: ${name}`, value]),
	["syntax: missing padding", `sha512-${body}`],
	["syntax: half the padding", `sha512-${body}=`],
	["syntax: extra padding", `${pin}=`],
	...padBitAliases.map(([name, value]): [string, unknown] => [`canonical: ${name}`, value]),
	["syntax: the URL-safe alphabet", urlSafe],
	["syntax: a leading space", ` ${pin}`],
	["syntax: a trailing space", `${pin} `],
	["syntax: a leading LF", `\n${pin}`],
	["syntax: a trailing LF", `${pin}\n`],
	["syntax: a trailing CR", `${pin}\r`],
	["syntax: a trailing CRLF", `${pin}\r\n`],
	["syntax: a trailing line separator", `${pin}\u2028`],
	["syntax: a trailing paragraph separator", `${pin}\u2029`],
	["syntax: a line break inside", `sha512-${body.slice(0, 43)}\n${body.slice(43)}==`],
	["syntax: a tab after the label", `sha512-\t${encoded}`],
	["syntax: a leading BOM", `\ufeff${pin}`],
	["syntax: a non-ASCII label digit", `sha５12-${encoded}`],
	["syntax: a trailing non-breaking space", `${pin}\u00a0`],
	["syntax: a trailing zero-width space", `${pin}\u200b`],
	["syntax: a trailing NUL", `${pin}\0`],
	["syntax: a trailing lone high surrogate", `${pin}\ud800`],
	["syntax: a trailing lone low surrogate", `${pin}\udc00`],
	["syntax: an empty string", ""],
	["type: undefined", undefined],
	["type: null", null],
	["type: a number", 64],
	["type: a boolean", true],
	["type: a bigint", 64n],
	["type: a symbol", Symbol("DYTEST")],
	["type: the digest bytes", digest],
	["type: UTF-8 bytes of a valid pin", Buffer.from(pin, "utf8")],
	["type: a Uint8Array of a valid pin", new Uint8Array(Buffer.from(pin, "utf8"))],
	["type: a String object", new String(pin)],
	["type: an array", [pin]],
];

const lock = (value: unknown) => ({
	name: "fixture-artifact",
	version: "1.2.3",
	integrity: value,
	entry: "index.mjs",
});

const targets = [
	{
		target: "the shared parser",
		accepts: (value: unknown, expected: Buffer) =>
			expect(integrity.integrityDigest(value)).toEqual(expected),
		refuses: (value: unknown) => expect(integrity.integrityDigest(value)).toBeUndefined(),
	},
	{
		target: "extension config pins",
		accepts: (value: unknown, expected: Buffer) => expect(pinDigest(value)).toEqual(expected),
		refuses: (value: unknown) =>
			expect(() => pinDigest(value)).toThrowError(
				expect.objectContaining({
					constructor: ExtensionError,
					name: "ExtensionError",
					code: "config",
					message: "Extension operation refused.",
				}),
			),
	},
	{
		target: "package-lock integrity",
		accepts: (value: unknown) => {
			const snapshot = snapshotPackageLock(lock(value));
			expect(snapshot).toEqual(lock(value));
			expect(Object.isFrozen(snapshot)).toBe(true);
		},
		refuses: (value: unknown) =>
			expect(() => snapshotPackageLock(lock(value))).toThrowError(
				expect.objectContaining({
					constructor: ArtifactError,
					name: "ArtifactError",
					message: "Artifact verification refused.",
				}),
			),
	},
];

describe.each(targets)("$target", ({ accepts, refuses }) => {
	it.each(accepted)("accepts %s", (_, value, expected) => accepts(value, expected));
	it.each(refused)("refuses %s", (_, value) => refuses(value));

	it("never converts a value that is not a string", () => {
		let calls = 0;
		const hook = (): string => {
			calls++;
			return pin;
		};
		refuses({ toString: hook, valueOf: hook, [Symbol.toPrimitive]: hook });
		expect(calls).toBe(0);
	});

	it("never observes proxy conversion hooks", () => {
		let calls = 0;
		refuses(
			new Proxy(
				{},
				{
					get() {
						calls++;
						throw new Error("DYTEST unexpected conversion");
					},
				},
			),
		);
		expect(calls).toBe(0);
		const revoked = Proxy.revocable(new String(pin), {});
		revoked.revoke();
		refuses(revoked.proxy);
	});
});

it.each(accepted)(
	"%s is exactly 64 bytes encoded as 95 ASCII UTF-8 bytes",
	(_, value, expected) => {
		expect(expected.length).toBe(64);
		expect(value.length).toBe(95);
		expect(Buffer.byteLength(value, "utf8")).toBe(95);
		expect(value).toBe(`sha512-${expected.toString("base64")}`);
	},
);

it.each(wrongLengths)("%s fails only the digest-length grammar", (_, value, bytes) => {
	const text = value.slice(7);
	const decoded = Buffer.from(text, "base64");
	expect(decoded.length).toBe(bytes);
	expect(decoded.length).not.toBe(64);
	expect(decoded.toString("base64")).toBe(text);
	expect(text.endsWith("==")).toBe(true);
	expect(text.length - 2).not.toBe(86);
});

it.each(padBitAliases)("%s has the right shape and bytes but fails the round trip", (_, value) => {
	const text = value.slice(7);
	expect(text.length).toBe(88);
	expect(text.endsWith("==")).toBe(true);
	expect([...text.slice(0, -2)].every((character) => alphabet.includes(character))).toBe(true);
	expect(Buffer.from(text, "base64")).toEqual(digest);
	expect(Buffer.from(text, "base64").toString("base64")).not.toBe(text);
});

it("builds noncanonical padding and URL-safe aliases of the accepted digest", () => {
	expect(urlSafe).not.toBe(pin);
	for (const alias of [urlSafe, `sha512-${body}`, `sha512-${body}=`])
		expect(Buffer.from(alias.slice(7), "base64")).toEqual(digest);
});

it("routes extension pins, lock snapshots and archive verification through the same parser", () => {
	const parser = vi.spyOn(integrity, "integrityDigest");
	try {
		const fixture = makePinnedPackage();
		expect(pinDigest(fixture.lock.integrity)).toEqual(
			createHash("sha512").update(fixture.archive).digest(),
		);
		expect(snapshotPackageLock(fixture.lock)).toEqual(fixture.lock);
		expect(preparePinnedPackage(fixture.archive, fixture.lock).inventory.integrity).toBe(
			fixture.lock.integrity,
		);
		expect(parser).toHaveBeenCalledTimes(4);
		for (const call of parser.mock.calls) expect(call).toEqual([fixture.lock.integrity]);
	} finally {
		parser.mockRestore();
	}
});
