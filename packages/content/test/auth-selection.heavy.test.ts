import { describe, expect, it } from "vitest";
import { cleanInWorker, parseMailInWorker } from "../src/worker.ts";

describe("isolated provider selection and IPv6 link regressions", () => {
	it.each([
		["(provider note) mx.google.com; dmarc=fail header.from=example.test", "fail", "dmarc-fail"],
		['"mx.google.com"; dmarc=fail header.from=example.test', "fail", "dmarc-fail"],
		["(provider note) mx.google.com; dmarc=pass (unterminated", "none", "invalid-results"],
		['"mx.google.com" 1; dmarc=pass reason="unterminated', "none", "invalid-results"],
		[
			`${"(".repeat(9)}provider note${")".repeat(9)} mx.google.com; dmarc=fail header.from=example.test`,
			"none",
			"invalid-results",
		],
		["(unterminated mx.google.com; dmarc=fail header.from=example.test", "none", "invalid-results"],
		['"mx.google.com; dmarc=fail header.from=example.test', "none", "invalid-results"],
	])("never upgrades the selected provider through the worker: %s", async (top, dmarc, reason) => {
		const result = await parseMailInWorker(
			Buffer.from(
				[
					"From: Sender@example.test",
					"Subject: Synthetic provider boundary",
					`Authentication-Results: ${top}`,
					"Authentication-Results: mx.google.com; dmarc=pass header.from=example.test",
					"",
					"Visible synthetic body.",
				].join("\r\n"),
			),
			{ provider: "gmail", ownerAddresses: ["Owner@example.test"] },
		);
		expect(result.auth).toEqual({ dmarc, reason });
		expect(result.direction).toBe("inbound");
		expect(result.body.text).toBe("Visible synthetic body.");
	});
	it.each([
		"(provider note) mx.google.com",
		'"mx.google.com" 1',
		`${"(".repeat(8)}provider note${")".repeat(8)} mx.google.com`,
	])("retains valid parsed provider results through the worker: %s", async (provider) => {
		const result = await parseMailInWorker(
			Buffer.from(
				`From: Sender@example.test\r\nAuthentication-Results: ${provider}; dmarc=pass header.from=example.test\r\n\r\nVisible.`,
			),
			{ provider: "gmail", ownerAddresses: [] },
		);
		expect(result.auth).toEqual({
			dmarc: "pass",
			verifiedSender: "Sender@example.test",
			reason: "verified",
		});
	});
	it.each(["http://[::1]", "https://[2001:db8::1]."])(
		"retains bare IPv6 authorities in the worker: %s",
		async (uri) => {
			const result = await cleanInWorker("text", `Before ${uri} After`);
			const host = uri.startsWith("http:") ? "[::1]" : "[2001:db8::1]";
			expect(result.text).toBe(`Before [link 1: ${host}]${uri.endsWith(".") ? "." : ""} After`);
			expect(result.links).toEqual([{ index: 1, host }]);
		},
	);
});
