import { describe, expect, it } from "vitest";
import {
	captureNativeGmailSendReceiptData,
	MAX_GMAIL_RECEIPT_METADATA_BYTES,
} from "../../src/outbox/gmail-receipt.ts";

function receipt() {
	return {
		message: {
			kind: "email.message" as const,
			providerId: "DYTEST-provider-message",
			threadId: "DYTEST-provider-thread",
			internalDate: 1_800_000_000_000,
			labelIds: ["SENT"],
			sizeBytes: 321,
		},
		messageIdHeader: "different literal\r\n folded value",
		bytesRead: 512,
	};
}

describe("detached Gmail send receipt metadata", () => {
	it("preserves literal Message-ID DATA and owns every mutable metadata container", () => {
		const input = receipt(),
			captured = captureNativeGmailSendReceiptData(input);
		expect(captured).toEqual(input);
		expect(captured.messageIdHeader).toBe("different literal\r\n folded value");
		input.message.providerId = "changed";
		input.message.labelIds[0] = "changed";
		expect(captured.message.providerId).toBe("DYTEST-provider-message");
		expect(captured.message.labelIds).toEqual(["SENT"]);
		for (const value of [captured, captured.message, captured.message.labelIds])
			expect(Object.isFrozen(value)).toBe(true);
	});

	it("does not impose the old ticket payload limit on a complete bounded literal header", () => {
		const input = receipt();
		input.messageIdHeader = "x".repeat(MAX_GMAIL_RECEIPT_METADATA_BYTES);
		input.bytesRead = MAX_GMAIL_RECEIPT_METADATA_BYTES;
		expect(captureNativeGmailSendReceiptData(input).messageIdHeader).toBe(input.messageIdHeader);
	});

	it.each([
		[
			"empty header",
			(input: ReturnType<typeof receipt>) => {
				input.messageIdHeader = "";
			},
		],
		[
			"oversized header",
			(input: ReturnType<typeof receipt>) => {
				input.messageIdHeader = "x".repeat(MAX_GMAIL_RECEIPT_METADATA_BYTES + 1);
			},
		],
		[
			"ill-formed header",
			(input: ReturnType<typeof receipt>) => {
				input.messageIdHeader = "\ud800";
			},
		],
		[
			"empty provider id",
			(input: ReturnType<typeof receipt>) => {
				input.message.providerId = "";
			},
		],
		[
			"provider line feed",
			(input: ReturnType<typeof receipt>) => {
				input.message.providerId = "id\n";
			},
		],
		[
			"empty thread",
			(input: ReturnType<typeof receipt>) => {
				input.message.threadId = "";
			},
		],
		[
			"unbounded labels",
			(input: ReturnType<typeof receipt>) => {
				input.message.labelIds = Array(257).fill("SENT");
			},
		],
		[
			"duplicate labels",
			(input: ReturnType<typeof receipt>) => {
				input.message.labelIds = ["SENT", "SENT"];
			},
		],
		[
			"negative date",
			(input: ReturnType<typeof receipt>) => {
				input.message.internalDate = -1;
			},
		],
		[
			"empty observation",
			(input: ReturnType<typeof receipt>) => {
				input.bytesRead = 0;
			},
		],
		[
			"oversized observation",
			(input: ReturnType<typeof receipt>) => {
				input.bytesRead = MAX_GMAIL_RECEIPT_METADATA_BYTES + 1;
			},
		],
		[
			"fractional observation",
			(input: ReturnType<typeof receipt>) => {
				input.bytesRead = 1.5;
			},
		],
	] as const)("refuses %s", (_, mutate) => {
		const input = receipt();
		mutate(input);
		expect(() => captureNativeGmailSendReceiptData(input)).toThrow();
	});

	it("refuses extra fields, raw bytes, array records and proxy metadata", () => {
		for (const input of [
			{ ...receipt(), approved: true },
			{ ...receipt(), message: { ...receipt().message, raw: { base64: "eA" } } },
			{ ...receipt(), message: Object.assign([], receipt().message) },
			new Proxy(receipt(), {}),
			{ ...receipt(), message: new Proxy(receipt().message, {}) },
			{ ...receipt(), message: { ...receipt().message, labelIds: new Proxy(["SENT"], {}) } },
		])
			expect(() => captureNativeGmailSendReceiptData(input)).toThrow();
	});

	it("refuses accessors and sparse or decorated label arrays without invoking their code", () => {
		let calls = 0;
		const getter = {
			get: () => {
				calls++;
				throw new Error("untrusted accessor");
			},
			enumerable: true,
		};
		const top = receipt();
		Object.defineProperty(top, "messageIdHeader", getter);
		const message = receipt();
		Object.defineProperty(message.message, "threadId", getter);
		const labels = receipt();
		Object.defineProperty(labels.message.labelIds, "0", getter);
		const sparse = receipt();
		sparse.message.labelIds = new Array(1);
		const decorated = receipt();
		Object.defineProperty(decorated.message.labelIds, "approved", { value: true });
		for (const input of [top, message, labels, sparse, decorated])
			expect(() => captureNativeGmailSendReceiptData(input)).toThrow();
		expect(calls).toBe(0);
	});
});
