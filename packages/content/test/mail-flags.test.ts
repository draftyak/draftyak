import { EmailDraftContent } from "@draftyak/protocol/entities/draft";
import { type Flag, Flag as FlagSchema, Flags, flagSeverity } from "@draftyak/protocol/flags";
import { describe, expect, it } from "vitest";
import { type ParsedMail, parseMail } from "../src/mail.ts";
import { classifyEmailReplyRedirectFlags } from "../src/mail-flags.ts";

type Recipients = Pick<EmailDraftContent, "channel" | "to" | "cc" | "bcc">;
const sender = "Sender@example.test";
const redirect = "Redirect@elsewhere.test";

async function parsed(extra: readonly string[] = [], from = sender): Promise<ParsedMail> {
	return parseMail(Buffer.from([`From: ${from}`, ...extra, "", "Synthetic body."].join("\r\n")), {
		provider: "gmail",
		ownerAddresses: ["Owner@example.test"],
	});
}

function draft(recipients: Partial<Omit<Recipients, "channel">> = {}): EmailDraftContent {
	return EmailDraftContent.parse({
		channel: "email",
		to: [],
		cc: [],
		bcc: [],
		subject: "Synthetic redirect review",
		body: "Synthetic body.",
		attachments: [],
		...recipients,
	});
}

function expectedFlag(address: string): Flag {
	return { code: "REPLY_TO_REDIRECT", severity: "ack", detail: address };
}

function classified(mail: ParsedMail, recipients: Recipients): readonly Flag[] {
	const result = classifyEmailReplyRedirectFlags(mail, recipients);
	expect(result.status).toBe("classified");
	if (result.status !== "classified") throw new Error("Expected classified recipient data");
	expect(Flags.safeParse(result.flags).success).toBe(true);
	return result.flags;
}

describe("Reply-To redirect flags for actual draft recipient data", () => {
	it("emits the exact canonical acknowledgement flag for a selected parsed Reply-To", async () => {
		const mail = await parsed([`Reply-To: ${redirect}`]);
		expect(mail.replyToHeaderCount).toBe(1);
		const flags = classified(mail, draft({ to: [redirect] }));
		expect(flags).toEqual([expectedFlag(redirect)]);
		expect(FlagSchema.safeParse(flags[0]).success).toBe(true);
		expect(flagSeverity("REPLY_TO_REDIRECT")).toBe("ack");
	});

	it("flags a different local part even when Reply-To and From share a domain", async () => {
		const mail = await parsed(["Reply-To: Redirect@example.test"]);
		expect(classified(mail, draft({ to: ["Redirect@example.test"] }))).toEqual([
			expectedFlag("Redirect@example.test"),
		]);
	});

	it.each(["to", "cc", "bcc"] as const)(
		"uses the actual draft %s recipients when deciding whether a redirect is selected",
		async (field) => {
			const mail = await parsed([`Reply-To: ${redirect}`]);
			expect(classified(mail, draft({ [field]: [redirect] }))).toEqual([expectedFlag(redirect)]);
		},
	);

	it("does not flag an absent, unchanged or unselected Reply-To", async () => {
		const absent = await parsed();
		expect(absent.replyToHeaderCount).toBe(0);
		expect(classified(absent, draft({ to: [sender] }))).toEqual([]);
		const same = await parsed([`Reply-To: ${sender}`]);
		expect(classified(same, draft({ to: [sender] }))).toEqual([]);
		const redirected = await parsed([`Reply-To: ${redirect}`]);
		expect(classified(redirected, draft({ to: [sender] }))).toEqual([]);
		expect(classified(redirected, draft())).toEqual([]);
	});

	it("emits one flag per selected address in first Reply-To order across duplicate draft fields", async () => {
		const first = "First@elsewhere.test";
		const second = "Second@elsewhere.test";
		const mail = await parsed([
			`Reply-To: Unselected@elsewhere.test, ${second}, ${first}, ${second}`,
		]);
		expect(classified(mail, draft({ to: [first], cc: [second, first], bcc: [second] }))).toEqual([
			expectedFlag(second),
			expectedFlag(first),
		]);
	});

	it("normalizes source and draft IDNA domains while preserving local-part case", async () => {
		const same = await parsed(["Reply-To: User@XN--BCHER-KVA.EXAMPLE"], "User@BÜCHER.example");
		const recipients = draft({ to: ["User@xn--bcher-kva.example"] });
		expect(classified(same, { ...recipients, to: ["User@BÜCHER.example"] })).toEqual([]);
		const changed = await parsed(["Reply-To: user@BÜCHER.example"], "User@BÜCHER.example");
		expect(classified(changed, { ...recipients, to: ["user@BÜCHER.example"] })).toEqual([
			expectedFlag("user@xn--bcher-kva.example"),
		]);
	});

	it("never reads unused incoming lists or draft body and attachments", async () => {
		const mail = await parsed([`Reply-To: ${redirect}`, "Bcc: Hidden@example.test"]);
		const recipients = draft({ to: [redirect] });
		let reads = 0;
		const unread = {
			get() {
				reads++;
				throw new Error("Unused reply flag data must not be read");
			},
		};
		for (const key of ["to", "cc", "bcc"]) Object.defineProperty(mail, key, unread);
		for (const key of ["body", "attachments"]) Object.defineProperty(recipients, key, unread);
		expect(classified(mail, recipients)).toEqual([expectedFlag(redirect)]);
		expect(reads).toBe(0);
	});

	it.each(["", "Invalid@example.test/attacker"])(
		"refuses a present unusable Reply-To instead of classifying no redirect: %s",
		async (replyTo) => {
			const mail = await parsed([`Reply-To: ${replyTo}`]);
			expect(mail.replyToHeaderCount).toBe(1);
			expect(mail.replyTo).toEqual([]);
			expect(classifyEmailReplyRedirectFlags(mail, draft({ to: [sender] }))).toEqual({
				status: "refused",
				code: "AMBIGUOUS_REPLY_TO",
			});
		},
	);

	it("refuses duplicate, missing and inconsistent original Reply-To count data", async () => {
		const duplicate = await parsed(["Reply-To:", `rEpLy-To: ${redirect}`]);
		expect(duplicate.replyToHeaderCount).toBe(2);
		expect(classifyEmailReplyRedirectFlags(duplicate, draft({ to: [redirect] }))).toEqual({
			status: "refused",
			code: "AMBIGUOUS_REPLY_TO",
		});
		const mail = await parsed([`Reply-To: ${redirect}`]);
		for (const replyToHeaderCount of [undefined, 0, -1, 0.5]) {
			expect(
				classifyEmailReplyRedirectFlags(
					{ ...mail, replyToHeaderCount } as unknown as ParsedMail,
					draft({ to: [redirect] }),
				),
			).toEqual({ status: "refused", code: "AMBIGUOUS_REPLY_TO" });
		}
	});

	it("requires a sole From and independently refuses its original ambiguous marker", async () => {
		const mail = await parsed([`Reply-To: ${redirect}`]);
		for (const from of [[], [{ address: sender }, { address: "Other@example.test" }]]) {
			expect(classifyEmailReplyRedirectFlags({ ...mail, from }, draft())).toEqual({
				status: "refused",
				code: "AMBIGUOUS_FROM",
			});
		}
		const ambiguous = await parsed(["From:", `Reply-To: ${redirect}`]);
		expect(ambiguous.from).toEqual([{ address: sender }]);
		expect(ambiguous.auth.reason).toBe("ambiguous-from");
		expect(classifyEmailReplyRedirectFlags(ambiguous, draft({ to: [redirect] }))).toEqual({
			status: "refused",
			code: "AMBIGUOUS_FROM",
		});
	});

	it("refuses malformed actual recipient data without returning a partial flag", async () => {
		const mail = await parsed([`Reply-To: ${redirect}`]);
		const valid = draft({ to: [redirect] });
		for (const recipients of [
			null,
			{ ...valid, channel: "chat" },
			{ ...valid, cc: ["Invalid address"] },
			{ ...valid, bcc: null },
		]) {
			expect(classifyEmailReplyRedirectFlags(mail, recipients as unknown as Recipients)).toEqual({
				status: "refused",
				code: "INVALID_INPUT",
			});
		}
	});

	it("refuses accessors in inspected data without invoking them", async () => {
		const mail = await parsed([`Reply-To: ${redirect}`]);
		const recipients = draft({ to: [redirect] });
		let reads = 0;
		const getter = {
			get() {
				reads++;
				return redirect;
			},
		};
		Object.defineProperty(recipients, "to", getter);
		expect(classifyEmailReplyRedirectFlags(mail, recipients)).toEqual({
			status: "refused",
			code: "INVALID_INPUT",
		});
		const mailbox = Object.defineProperty({}, "address", getter);
		expect(
			classifyEmailReplyRedirectFlags(
				{ ...mail, replyTo: [mailbox] } as unknown as ParsedMail,
				draft({ to: [redirect] }),
			),
		).toEqual({ status: "refused", code: "INVALID_INPUT" });
		expect(reads).toBe(0);
	});

	it("refuses proxies and sparse inspected arrays without reading traps or holes", async () => {
		const mail = await parsed([`Reply-To: ${redirect}`]);
		const recipients = draft({ to: [redirect] });
		let traps = 0;
		const handler = {
			get() {
				traps++;
				throw new Error("Proxy data must not be inspected");
			},
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("Proxy data must not be inspected");
			},
			getPrototypeOf() {
				traps++;
				throw new Error("Proxy data must not be inspected");
			},
		};
		for (const [source, actual] of [
			[new Proxy(mail, handler), recipients],
			[mail, new Proxy(recipients, handler)],
			[mail, { ...recipients, to: new Proxy([redirect], handler) }],
		] as const) {
			expect(classifyEmailReplyRedirectFlags(source, actual)).toEqual({
				status: "refused",
				code: "INVALID_INPUT",
			});
		}
		expect(traps).toBe(0);
		const sparse: string[] = [];
		sparse.length = 1;
		expect(classifyEmailReplyRedirectFlags(mail, { ...recipients, cc: sparse })).toEqual({
			status: "refused",
			code: "INVALID_INPUT",
		});
	});

	it("bounds source Reply-To data before deduplicating matching addresses", async () => {
		const mail = await parsed([`Reply-To: ${redirect}`]);
		const many = Array.from({ length: 500 }, () => ({ address: redirect }));
		expect(classified({ ...mail, replyTo: many }, draft({ to: [redirect] }))).toEqual([
			expectedFlag(redirect),
		]);
		expect(
			classifyEmailReplyRedirectFlags(
				{ ...mail, replyTo: [...many, { address: redirect }] },
				draft({ to: [redirect] }),
			),
		).toEqual({ status: "refused", code: "INVALID_INPUT" });
	});

	it.each(["to", "cc", "bcc"] as const)(
		"validates the merged 100-address draft %s bound before deduplication",
		async (field) => {
			const mail = await parsed([`Reply-To: ${redirect}`]);
			const addresses = Array.from({ length: 100 }, () => redirect);
			const valid = draft({ [field]: addresses });
			expect(classified(mail, valid)).toEqual([expectedFlag(redirect)]);
			const overflow = { ...valid, [field]: [...addresses, redirect] };
			expect(EmailDraftContent.safeParse(overflow).success).toBe(false);
			expect(classifyEmailReplyRedirectFlags(mail, overflow)).toEqual({
				status: "refused",
				code: "INVALID_INPUT",
			});
		},
	);

	it("does not change parsed mail or the validated draft", async () => {
		const mail = await parsed([`Reply-To: ${redirect}, ${redirect}`]);
		const recipients = draft({ to: [redirect], cc: [sender] });
		const beforeMail = structuredClone(mail);
		const beforeDraft = structuredClone(recipients);
		expect(classified(mail, recipients)).toEqual([expectedFlag(redirect)]);
		expect(mail).toEqual(beforeMail);
		expect(recipients).toEqual(beforeDraft);
	});
});
