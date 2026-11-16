import { EmailAddress } from "@draftyak/protocol/entities/common";
import { describe, expect, it } from "vitest";
import { canonicalAddress, normalizeAddresses } from "../src/index.ts";

describe("shared normalized address contract", () => {
	it.each(["0x7f.1", "127.1", "0127.0.0.1", "2130706433", "127.0.0.1", "localhost"])(
		"refuses numeric and single-label domains: %s",
		(domain) => {
			expect(() => canonicalAddress(`Owner@${domain}`)).toThrowError(
				expect.objectContaining({ code: "BAD_ADDRESS" }),
			);
			expect(() => normalizeAddresses([`Owner@${domain}`])).toThrowError(
				expect.objectContaining({ code: "BAD_ADDRESS" }),
			);
		},
	);

	it.each(["\u{10400}ser", "Owner\u034f", "Owner\u115f", "Üser", '"Owner"'])(
		"retains the MIME ASCII local-part policy: %s",
		(local) => {
			expect(() => canonicalAddress(`${local}@example.test`)).toThrowError(
				expect.objectContaining({ code: "BAD_ADDRESS" }),
			);
		},
	);

	it.each([
		["Owner@EXAMPLE.test", "Owner@example.test"],
		["Owner@BÜCHER.test", "Owner@xn--bcher-kva.test"],
		["Owner/label?value@BÜCHER.test", "Owner/label?value@xn--bcher-kva.test"],
	])("preserves supported local parts and IDNA: %s", (input, expected) => {
		const actual = canonicalAddress(input);
		expect(actual).toBe(expected);
		expect(EmailAddress.safeParse(actual).success).toBe(true);
	});

	it.each(["x".repeat(65), `${"x".repeat(63)}.x`])(
		"retains the MIME local-part byte bound",
		(local) => {
			expect(() => canonicalAddress(`${local}@example.test`)).toThrowError(
				expect.objectContaining({ code: "BAD_ADDRESS" }),
			);
		},
	);
});
