import { describe, expect, it } from "vitest";
import { verifyMailAuth } from "../src/auth-results.ts";

const sender = "Sender@example.test";
const lowerPass = "mx.google.com; dmarc=pass header.from=example.test";
const verify = (top: string) =>
	verifyMailAuth(
		[top, lowerPass].map((value) => ({ key: "authentication-results", value })),
		"gmail",
		sender,
	);

describe("parsed topmost authentication service", () => {
	const providers = [
		"(provider note) mx.google.com",
		'"mx.google.com"',
		'(outer (nested; note))\t"MX.GOOGLE.COM"',
		'"mx.google\\.com"',
		"(escaped \\) note) mx.google.com (service note) 1 (version note)",
	];
	it.each(providers)("retains a failing top service %s over a lower pass", (provider) => {
		expect(verify(`${provider}; dmarc=fail header.from=example.test`)).toEqual({
			dmarc: "fail",
			reason: "dmarc-fail",
		});
	});
	it.each(providers)("accepts the same parsed service's valid result: %s", (provider) => {
		expect(verify(`${provider}; dmarc=pass header.from=example.test`)).toEqual({
			dmarc: "pass",
			verifiedSender: sender,
			reason: "verified",
		});
	});
	it.each([
		"(provider note) mx.google.com; dmarc=pass (unterminated",
		'"mx.google.com"; dmarc=pass reason="unterminated',
		"(provider note) mx.google.com (unterminated; dmarc=pass header.from=example.test",
		'(provider note) "mx.google.com" version; dmarc=pass header.from=example.test',
		'(provider note) "mx.google.com"1; dmarc=pass header.from=example.test',
		'(provider note) "mx.google.com" 1; dmarc=pass header.from=example.test; dmarc=fail',
	])("does not fall through a selected malformed field: %s", (top) => {
		expect(verify(top)).toEqual({ dmarc: "none", reason: "invalid-results" });
	});
	it.each([
		"(mx.google.com) other.example.test; dmarc=fail header.from=example.test",
		'"mx.google.com; other.example.test"; dmarc=fail header.from=example.test',
		"mx.google.com.attacker.test; dmarc=fail header.from=example.test",
	])("ignores a different parsed authserv-id: %s", (top) => {
		expect(verify(top)).toMatchObject({ dmarc: "pass", verifiedSender: sender });
	});
	it.each(["pass", "fail"])("parses the comment-depth boundary with a %s result", (result) => {
		const prefix = `${"(".repeat(8)}provider note${")".repeat(8)} mx.google.com`;
		expect(verify(`${prefix}; dmarc=${result} header.from=example.test`)).toEqual(
			result === "pass"
				? { dmarc: "pass", verifiedSender: sender, reason: "verified" }
				: { dmarc: "fail", reason: "dmarc-fail" },
		);
	});
	it.each([
		`${"(".repeat(9)}provider note${")".repeat(9)} mx.google.com; dmarc=fail header.from=example.test`,
		"(unterminated mx.google.com; dmarc=fail header.from=example.test",
		'"mx.google.com; dmarc=fail header.from=example.test',
		'"mx.google.com\\',
		"(provider note) ; dmarc=fail header.from=example.test",
	])("fails closed instead of searching below an unreadable prefix: %s", (top) => {
		expect(verify(top)).toEqual({ dmarc: "none", reason: "invalid-results" });
	});
});
