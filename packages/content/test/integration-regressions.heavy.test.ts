import { describe, expect, it } from "vitest";
import { parseMailInWorker } from "../src/worker.ts";

describe("consolidated hub security regressions", () => {
	it("selects the topmost provider-matching result after an unrelated relay header", async () => {
		const raw = Buffer.from(
			"From: Sender <sender@example.net>\r\nSubject: First subject\r\nSubject: Lower subject\r\nAuthentication-Results: relay.example; dmarc=pass\r\nAuthentication-Results: mx.google.com; dmarc=fail header.from=example.net\r\nAuthentication-Results: mx.google.com; dmarc=pass header.from=example.net\r\n\r\nVisible",
		);
		const result = await parseMailInWorker(raw, { provider: "gmail", ownerAddresses: [] });
		expect(result.subject).toBe("First subject");
		expect(result.auth.dmarc).toBe("fail");
		expect(result.body.text).toBe("Visible");
	});
});
