import { createHash } from "node:crypto";
import { MessageDirection } from "@draftyak/protocol/entities/common";
import { describe, expect, it } from "vitest";
import { parseMailInWorker } from "../src/index.ts";

const evidence = { provider: "gmail" as const, ownerAddresses: ["Owner@example.test"] };
const raw = (from: string | undefined, body = "Synthetic message.") =>
	Buffer.from(
		`${from === undefined ? "" : `From: ${from}\r\n`}To: Owner@example.test\r\nSubject: Synthetic\r\n\r\n${body}`,
	);

describe("reviewed direction handoff", () => {
	it("keeps worker direction and absent authentication in the merged scalar vocabularies", async () => {
		const bytes = raw("Owner@example.test");
		const incoming = await parseMailInWorker(bytes, evidence);
		expect(MessageDirection.parse(incoming.direction)).toBe("inbound");
		expect(incoming.auth.dmarc).toBe("none");
		const outgoing = await parseMailInWorker(bytes, {
			...evidence,
			sentEvidence: {
				kind: "verified-send",
				messageSha256: createHash("sha256").update(bytes).digest("hex"),
			},
		});
		expect(MessageDirection.parse(outgoing.direction)).toBe("outbound");
	});
	it.each(["sender@127.0.0.1", "sender\u034f@example.test", "\u{10400}sender@example.test"])(
		"filters mailboxes through the shared scalar after isolated parsing: %s",
		async (address) => {
			const domain = address.slice(address.lastIndexOf("@") + 1);
			const incoming = await parseMailInWorker(
				Buffer.from(
					[
						`From: ${address}`,
						`To: ${address}, Valid@example.test`,
						`Cc: ${address}`,
						`Bcc: ${address}`,
						`Reply-To: ${address}`,
						`Authentication-Results: mx.google.com; dmarc=pass header.from=${domain}`,
						"",
						"Synthetic message.",
					].join("\r\n"),
				),
				evidence,
			);
			expect(incoming.from).toEqual([]);
			expect(incoming.to).toEqual([{ address: "Valid@example.test" }]);
			expect(incoming.cc).toEqual([]);
			expect(incoming.bcc).toEqual([]);
			expect(incoming.replyTo).toEqual([]);
			expect(incoming.auth).toEqual({ dmarc: "none", reason: "ambiguous-from" });
			expect(incoming.direction).toBe("inbound");
		},
	);
});
