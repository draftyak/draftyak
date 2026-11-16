import { describe, expect, it } from "vitest";
import { type ParsedMail, parseMail } from "../src/mail.ts";
import { selectEmailReplyTargets } from "../src/reply-targets.ts";

const own = ["Owner@example.test"];
const sender = "Sender@example.test";

async function parsed(extra: readonly string[] = [], from = sender): Promise<ParsedMail> {
	return parseMail(
		Buffer.from(
			[
				`From: ${from}`,
				...extra,
				"Subject: Synthetic reply selection",
				"Message-ID: <reply-selection@example.test>",
				"",
				"Synthetic body.",
			].join("\r\n"),
		),
		{ provider: "generic", ownerAddresses: own },
	);
}

describe("email reply target selection from parsed data", () => {
	it("uses From only when the original message has no Reply-To header", async () => {
		const mail = await parsed(["To: Owner@example.test", "Cc: Copy@example.test"]);
		expect(mail.replyToHeaderCount).toBe(0);
		expect(selectEmailReplyTargets(mail, "reply", own)).toEqual({
			status: "selected",
			to: [sender],
			cc: [],
			provenance: [{ address: sender, kind: "from", field: "to" }],
		});
	});

	it("uses every address in one nonempty Reply-To header as the primary recipients", async () => {
		const mail = await parsed([
			"Reply-To: First <First@example.test>, Second@example.test",
			"To: Owner@example.test, Other@example.test",
			"Cc: Copy@example.test",
		]);
		expect(mail.replyToHeaderCount).toBe(1);
		expect(selectEmailReplyTargets(mail, "reply", own)).toEqual({
			status: "selected",
			to: ["First@example.test", "Second@example.test"],
			cc: [],
			provenance: [
				{ address: "First@example.test", kind: "reply-to", field: "to" },
				{ address: "Second@example.test", kind: "reply-to", field: "to" },
			],
		});
	});

	it("removes own addresses and deduplicates globally with To priority and first-origin provenance", async () => {
		const mail = await parsed([
			"Reply-To: Primary@example.test, Shared@example.test",
			"To: Owner@example.test, Sender@example.test, Shared@example.test, Target@example.test",
			"Cc: Target@example.test, Copy@example.test, Primary@example.test, Owner@example.test",
			"Bcc: Hidden@example.test",
		]);
		expect(selectEmailReplyTargets(mail, "reply-all", own)).toEqual({
			status: "selected",
			to: ["Primary@example.test", "Shared@example.test", sender, "Target@example.test"],
			cc: ["Copy@example.test"],
			provenance: [
				{ address: "Primary@example.test", kind: "reply-to", field: "to" },
				{ address: "Shared@example.test", kind: "reply-to", field: "to" },
				{ address: sender, kind: "to", field: "to" },
				{ address: "Target@example.test", kind: "to", field: "to" },
				{ address: "Copy@example.test", kind: "cc", field: "cc" },
			],
		});
	});

	it("normalizes IDNA and domain case while preserving local-part case for own-address matching", async () => {
		const mail = await parsed(
			[
				"To: Owner@BÜCHER.example, owner@BÜCHER.example, User@XN--BCHER-KVA.EXAMPLE",
				"Cc: owner@xn--bcher-kva.example",
			],
			"User@BÜCHER.example",
		);
		expect(selectEmailReplyTargets(mail, "reply-all", ["Owner@XN--BCHER-KVA.EXAMPLE"])).toEqual({
			status: "selected",
			to: ["User@xn--bcher-kva.example", "owner@xn--bcher-kva.example"],
			cc: [],
			provenance: [
				{ address: "User@xn--bcher-kva.example", kind: "from", field: "to" },
				{ address: "owner@xn--bcher-kva.example", kind: "to", field: "to" },
			],
		});
	});

	it("refuses a self-sent reply but selects the original To and Cc for reply-all", async () => {
		const mail = await parsed(
			["To: Recipient@example.test", "Cc: Copy@example.test"],
			"Owner@example.test",
		);
		expect(selectEmailReplyTargets(mail, "reply", own)).toEqual({
			status: "refused",
			code: "NO_RECIPIENTS",
		});
		expect(selectEmailReplyTargets(mail, "reply-all", own)).toEqual({
			status: "selected",
			to: ["Recipient@example.test"],
			cc: ["Copy@example.test"],
			provenance: [
				{ address: "Recipient@example.test", kind: "to", field: "to" },
				{ address: "Copy@example.test", kind: "cc", field: "cc" },
			],
		});
	});

	it.each(["", "Invalid@example.test/attacker"])(
		"refuses a present unusable Reply-To without falling back to From: %s",
		async (replyTo) => {
			const mail = await parsed([`Reply-To: ${replyTo}`]);
			expect(mail.replyToHeaderCount).toBe(1);
			expect(mail.replyTo).toEqual([]);
			expect(selectEmailReplyTargets(mail, "reply", own)).toEqual({
				status: "refused",
				code: "AMBIGUOUS_REPLY_TO",
			});
		},
	);

	it("refuses duplicate Reply-To headers even when only one has an address", async () => {
		const mail = await parsed(["Reply-To:", "rEpLy-To: Redirect@example.test"]);
		expect(mail.replyToHeaderCount).toBe(2);
		expect(selectEmailReplyTargets(mail, "reply-all", own)).toEqual({
			status: "refused",
			code: "AMBIGUOUS_REPLY_TO",
		});
	});

	it.each([undefined, 0, 0.5])(
		"refuses missing or contradictory Reply-To count DATA: %s",
		async (replyToHeaderCount) => {
			const mail = await parsed(["Reply-To: Redirect@example.test"]);
			expect(
				selectEmailReplyTargets(
					{ ...mail, replyToHeaderCount } as unknown as ParsedMail,
					"reply",
					own,
				),
			).toEqual({ status: "refused", code: "AMBIGUOUS_REPLY_TO" });
		},
	);

	it("refuses a wire-ambiguous From instead of trusting the parser's retained address", async () => {
		const mail = await parseMail(Buffer.from(`From: ${sender}\r\nFrom:\r\n\r\nSynthetic body.`), {
			provider: "gmail",
			ownerAddresses: own,
		});
		expect(mail.from).toEqual([{ address: sender }]);
		expect(mail.auth.reason).toBe("ambiguous-from");
		expect(selectEmailReplyTargets(mail, "reply", own)).toEqual({
			status: "refused",
			code: "AMBIGUOUS_FROM",
		});
	});

	it("requires exactly one From address even without an ambiguous-auth marker", async () => {
		const mail = await parsed();
		for (const from of [[], [{ address: sender }, { address: "Other@example.test" }]]) {
			expect(selectEmailReplyTargets({ ...mail, from }, "reply", own)).toEqual({
				status: "refused",
				code: "AMBIGUOUS_FROM",
			});
		}
	});

	it("does not read Bcc while selecting recipients", async () => {
		const mail = await parsed(["Bcc: Hidden@example.test"]);
		expect(mail.bcc).toEqual([{ address: "Hidden@example.test" }]);
		let reads = 0;
		Object.defineProperty(mail, "bcc", {
			get() {
				reads++;
				throw new Error("Bcc must not be read by reply selection");
			},
		});
		expect(selectEmailReplyTargets(mail, "reply-all", own)).toEqual({
			status: "selected",
			to: [sender],
			cc: [],
			provenance: [{ address: sender, kind: "from", field: "to" }],
		});
		expect(reads).toBe(0);
	});

	it.each(["to", "cc"] as const)(
		"accepts exactly 100 output %s recipients and refuses the next instead of truncating",
		async (field) => {
			const count = field === "to" ? 99 : 100;
			const addresses = Array.from({ length: count }, (_, i) => `Recipient${i}@example.test`);
			const mail = await parsed([`${field}: ${addresses.join(", ")}`]);
			const selected = selectEmailReplyTargets(mail, "reply-all", own);
			expect(selected).toMatchObject({
				status: "selected",
				to: field === "to" ? [sender, ...addresses] : [sender],
				cc: field === "cc" ? addresses : [],
			});
			const overflow = await parsed([
				`${field}: ${[...addresses, "Overflow@example.test"].join(", ")}`,
			]);
			expect(selectEmailReplyTargets(overflow, "reply-all", own)).toEqual({
				status: "refused",
				code: "RECIPIENT_LIMIT",
			});
		},
	);

	it.each(["to", "cc"] as const)(
		"bounds source %s before own-address removal and deduplication",
		async (field) => {
			const mail = await parsed();
			const addresses = Array.from({ length: 500 }, () => ({ address: "Owner@example.test" }));
			expect(selectEmailReplyTargets({ ...mail, [field]: addresses }, "reply-all", own)).toEqual({
				status: "selected",
				to: [sender],
				cc: [],
				provenance: [{ address: sender, kind: "from", field: "to" }],
			});
			const duplicate = addresses[0];
			if (duplicate === undefined) throw new Error("Missing boundary mailbox");
			expect(
				selectEmailReplyTargets({ ...mail, [field]: [...addresses, duplicate] }, "reply-all", own),
			).toEqual({ status: "refused", code: "INVALID_INPUT" });
		},
	);

	it("requires one through 500 valid own addresses", async () => {
		const mail = await parsed();
		const many = Array.from({ length: 500 }, (_, i) => `Own${i}@example.test`);
		expect(selectEmailReplyTargets(mail, "reply", own).status).toBe("selected");
		expect(selectEmailReplyTargets(mail, "reply", many).status).toBe("selected");
		for (const addresses of [[], [...many, "Own500@example.test"], ["not an address"]]) {
			expect(selectEmailReplyTargets(mail, "reply", addresses)).toEqual({
				status: "refused",
				code: "INVALID_INPUT",
			});
		}
	});

	it("refuses invalid runtime mode and source shapes without selecting a partial result", async () => {
		const mail = await parsed();
		expect(selectEmailReplyTargets(mail, "forward" as "reply", own)).toEqual({
			status: "refused",
			code: "INVALID_INPUT",
		});
		for (const value of [
			null,
			{ ...mail, to: null },
			{ ...mail, cc: [{ address: "Invalid address" }] },
			{ ...mail, from: [{ address: 7 }] },
		]) {
			expect(selectEmailReplyTargets(value as unknown as ParsedMail, "reply", own)).toEqual({
				status: "refused",
				code: "INVALID_INPUT",
			});
		}
	});

	it("leaves the parsed source and supplied own-address DATA unchanged", async () => {
		const mail = await parsed([
			"Reply-To: Redirect@example.test",
			"To: Owner@example.test, Target@example.test",
			"Cc: Copy@example.test",
		]);
		const before = structuredClone(mail);
		const addresses = ["Owner@EXAMPLE.TEST"];
		expect(selectEmailReplyTargets(mail, "reply-all", addresses).status).toBe("selected");
		expect(mail).toEqual(before);
		expect(addresses).toEqual(["Owner@EXAMPLE.TEST"]);
	});
});
