import { EmailAddress } from "@draftyak/protocol/entities/common";
import { Contact } from "@draftyak/protocol/entities/contact";
import type { Draft, EmailDraftContent } from "@draftyak/protocol/entities/draft";
import { type Flag, Flags, flagSeverity } from "@draftyak/protocol/flags";
import { Ulid } from "@draftyak/protocol/scalars";
import { describe, expect, it } from "vitest";
import { classifyEmailNewRecipientFlags, MAX_CONTACT_FLAG_ROWS } from "../src/recipient-flags.ts";

type Recipients = Pick<EmailDraftContent, "channel" | "to" | "cc" | "bcc">;
type ContactData = Pick<Contact, "accountId" | "addressNorm" | "known">;
const accountId: Draft["accountId"] = Ulid.parse("0".repeat(26));
const otherAccountId: Draft["accountId"] = Ulid.parse(`${"0".repeat(25)}1`);
const address = "Owner@example.invalid";
const contactSchema = Contact.pick({ accountId: true, addressNorm: true, known: true });
const flag = (detail: string): Flag => ({ code: "NEW_RECIPIENT", severity: "ack", detail });

function draft(fields: Partial<Omit<Recipients, "channel">> = {}): Recipients {
	return { channel: "email", to: [], cc: [], bcc: [], ...fields };
}

function contact(text = address, known = true, rowAccount = accountId): ContactData {
	return contactSchema.parse({
		accountId: rowAccount,
		addressNorm: { untrusted: true, text },
		known,
	});
}

function classified(
	recipients: Recipients,
	contacts: readonly ContactData[] = [],
	account = accountId,
): readonly Flag[] {
	const result = classifyEmailNewRecipientFlags(account, recipients, contacts);
	expect(result.status).toBe("classified");
	if (result.status !== "classified") throw new Error("Expected classified recipient data");
	expect(Flags.safeParse(result.flags).success).toBe(true);
	expect(new Set(result.flags.map((item) => JSON.stringify([item.code, item.detail]))).size).toBe(
		result.flags.length,
	);
	return result.flags;
}

function expectFlags(
	recipients: Recipients,
	contacts: readonly ContactData[],
	expected: readonly Flag[],
): void {
	const actual = classified(recipients, contacts);
	expect(actual).toHaveLength(expected.length);
	expect(actual).toEqual(expect.arrayContaining([...expected]));
}

function refused(
	recipients: unknown,
	...optional: [contacts?: unknown, account?: unknown, code?: "INVALID_INPUT" | "STRUCTURE_LIMIT"]
): void {
	const actualContacts = optional.length < 1 ? [] : optional[0];
	const actualAccount = optional.length < 2 ? accountId : optional[1];
	const code = optional[2] ?? "INVALID_INPUT";
	expect(
		classifyEmailNewRecipientFlags(
			actualAccount as string,
			recipients as Recipients,
			actualContacts as ContactData[],
		),
	).toEqual({ status: "refused", code });
}

describe("new recipient flags from supplied account contact data", () => {
	it("classifies explicit empty data and emits the catalogue's exact acknowledgement flag", () => {
		expectFlags(draft(), [], []);
		expect(flagSeverity("NEW_RECIPIENT")).toBe("ack");
		expectFlags(draft({ to: [address] }), [], [flag(address)]);
	});

	it.each(["to", "cc", "bcc"] as const)("includes actual draft %s recipients", (field) => {
		expectFlags(draft({ [field]: [address] }), [], [flag(address)]);
		expectFlags(draft({ [field]: [address] }), [contact()], []);
	});

	it("only lets a same-account known contact suppress a flag", () => {
		const recipients = draft({ to: [address] });
		expectFlags(recipients, [contact(address, false)], [flag(address)]);
		expectFlags(recipients, [contact(address, true, otherAccountId)], [flag(address)]);
		expectFlags(recipients, [contact(address, false, otherAccountId), contact()], []);
		expect(classified(recipients, [contact()], otherAccountId)).toEqual([flag(address)]);
	});

	it("deduplicates canonical recipients across all three fields and repeated contacts", () => {
		const second = "Second@example.invalid";
		expectFlags(
			draft({ to: [address, second, address], cc: [second, address], bcc: [address, second] }),
			[],
			[flag(address), flag(second)],
		);
		expectFlags(
			draft({ to: [address, address], cc: [address], bcc: [address] }),
			[contact(), contact(), contact("Owner@EXAMPLE.INVALID")],
			[],
		);
	});

	it("normalizes IDNA/domain case consistently in recipients and known contacts", () => {
		const unicode = "User@B\u00dcCHER.invalid";
		const canonical = "User@xn--bcher-kva.invalid";
		expect(EmailAddress.safeParse(canonical).success).toBe(true);
		expectFlags(draft({ to: [unicode], cc: [canonical] }), [], [flag(canonical)]);
		expectFlags(draft({ to: [unicode] }), [contact("User@XN--BCHER-KVA.INVALID")], []);
		expectFlags(draft({ bcc: [canonical] }), [contact(unicode)], []);
	});

	it("preserves local-part case, dots and plus tags instead of applying provider aliases", () => {
		const base = "Owner@example.invalid";
		const recipients = [
			"owner@example.invalid",
			"Own.er@example.invalid",
			"Owner+tag@example.invalid",
		];
		expectFlags(draft({ to: recipients }), [contact(base)], recipients.map(flag));
		expectFlags(
			draft({ to: recipients }),
			recipients.map((item) => contact(item)),
			[],
		);
	});

	it("accepts generic contact addresses without treating them as known email recipients", () => {
		const generic = ["U_SYNTHETIC", "user@singlelabel", "a".repeat(320)];
		for (const text of generic) expect(contactSchema.safeParse(contact(text)).success).toBe(true);
		expectFlags(
			draft({ to: [address] }),
			generic.map((text) => contact(text)),
			[flag(address)],
		);
	});

	it("uses the canonical 254-character email address bound", () => {
		const exact = `${"x".repeat(200)}@${"d".repeat(45)}.invalid`;
		expect(exact).toHaveLength(254);
		expect(EmailAddress.safeParse(exact).success).toBe(true);
		expectFlags(draft({ to: [exact] }), [], [flag(exact)]);
		expectFlags(draft({ to: [exact] }), [contact(exact)], []);
		const overflow = `x${exact}`;
		expect(EmailAddress.safeParse(overflow).success).toBe(false);
		refused(draft({ to: [overflow] }));
	});

	it("uses all 100 recipients in each list without imposing an aggregate 100-address cap", () => {
		const to = Array.from({ length: 100 }, (_, index) => `To${index}@example.invalid`);
		const cc = Array.from({ length: 100 }, (_, index) => `Cc${index}@example.invalid`);
		const bcc = Array.from({ length: 100 }, (_, index) => `Bcc${index}@example.invalid`);
		const recipients = draft({ to, cc, bcc });
		const all = [...to, ...cc, ...bcc];
		expectFlags(recipients, [], all.map(flag));
		expectFlags(
			recipients,
			all.map((item) => contact(item)),
			[],
		);
	});

	it.each(["to", "cc", "bcc"] as const)(
		"refuses an overlong %s list before deduplication",
		(field) => {
			refused(draft({ [field]: Array.from({ length: 101 }, () => address) }));
		},
	);

	it("allows exactly 10,000 valid rows including duplicates", () => {
		expect(MAX_CONTACT_FLAG_ROWS).toBe(10_000);
		const rows = Array.from({ length: 10_000 }, () => contact());
		expectFlags(draft({ to: [address] }), rows, []);
	});

	it("refuses a 10,001-row list before traversing even its first row", () => {
		let reads = 0;
		const rows: ContactData[] = [];
		rows.length = 10_001;
		Object.defineProperty(rows, "0", {
			get() {
				reads++;
				throw new Error("Oversized contact data must not be traversed");
			},
		});
		refused(draft({ to: [address] }), rows, accountId, "STRUCTURE_LIMIT");
		expect(reads).toBe(0);
	});

	it("validates every row after a match and with no draft recipients", () => {
		const invalidTail = { ...contact(), known: "true" };
		for (const recipients of [draft(), draft({ to: [address] })]) {
			refused(recipients, [contact(), invalidTail]);
			refused(recipients, [contact(), { ...invalidTail, accountId: otherAccountId }]);
		}
	});

	it("refuses contradictory known values for one account and normalized email key", () => {
		for (const rows of [
			[contact(), contact(address, false)],
			[contact(address, false), contact("Owner@EXAMPLE.INVALID")],
			[contact("User@B\u00dcCHER.invalid"), contact("User@xn--bcher-kva.invalid", false)],
		]) {
			refused(draft({ to: [address] }), rows);
			refused(draft(), rows);
		}
	});

	it("detects conflicts in foreign-account and generic-address rows too", () => {
		refused(draft(), [
			contact(address, true, otherAccountId),
			contact(address, false, otherAccountId),
		]);
		refused(draft(), [contact("U_SYNTHETIC"), contact("U_SYNTHETIC", false)]);
		expectFlags(draft({ to: [address] }), [contact(), contact(address, false, otherAccountId)], []);
		expectFlags(draft(), [contact("U_SYNTHETIC"), contact("U_SYNTHETIC")], []);
	});

	it.each([
		"",
		"x",
		"8".repeat(26),
		"a".repeat(26),
		`${"0".repeat(26)}\n`,
		null,
		undefined,
		Object(accountId),
	])("refuses an invalid account id without coercion: %j", (account) =>
		refused(draft(), [], account),
	);

	it.each([null, undefined, true, 1, "draft", [], new Date(0), Object("draft")])(
		"refuses non-record draft data: %s",
		(value) => refused(value),
	);

	it.each([
		{},
		{ to: [], cc: [], bcc: [] },
		{ ...draft(), channel: "chat" },
		{ ...draft(), channel: "sms" },
		{ ...draft(), channel: "EMAIL" },
		{ ...draft(), to: null },
		{ ...draft(), cc: "Owner@example.invalid" },
		{ ...draft(), bcc: [null] },
		{ ...draft(), to: [Object(address)] },
	])("refuses malformed draft projections: %j", (value) => refused(value));

	it.each([
		" Owner@example.invalid",
		"Owner@example.invalid ",
		"Owner@example.invalid\r\n",
		"Ow\u200bner@example.invalid",
		"Owner@example.invalid/path",
		"Owner@example.invalid%2Fpath",
		"Owner@singlelabel",
		".Owner@example.invalid",
		"Owner..Name@example.invalid",
		"\ud800@example.invalid",
	])("refuses malformed recipient addresses instead of silently trimming: %j", (value) => {
		refused(draft({ to: [address], bcc: [value] }), [contact()]);
	});

	it.each([null, undefined, {}, "contacts", true, Object(address)])(
		"refuses a non-array contacts input: %s",
		(value) => refused(draft(), value),
	);

	it.each([
		null,
		undefined,
		[],
		new Date(0),
		{},
		{ ...contact(), accountId: "invalid" },
		{ ...contact(), known: undefined },
		{ ...contact(), known: 1 },
		{ ...contact(), known: Object(true) },
		{ ...contact(), addressNorm: address },
		{ ...contact(), addressNorm: { untrusted: false, text: address } },
		{ ...contact(), addressNorm: { text: address } },
		{ ...contact(), addressNorm: { untrusted: true } },
		{ ...contact(), addressNorm: { untrusted: true, text: "" } },
		{ ...contact(), addressNorm: { untrusted: true, text: "Invalid address" } },
		{ ...contact(), addressNorm: { untrusted: true, text: "x".repeat(321) } },
		{ ...contact(), addressNorm: { untrusted: true, text: "x\u200by" } },
		{ ...contact(), addressNorm: { untrusted: true, text: "\ud800" } },
		{ ...contact(), addressNorm: { untrusted: true, text: Object(address) } },
	])("refuses a malformed contact projection anywhere in the list: %#", (row) => {
		refused(draft({ to: [address] }), [contact(), row]);
		refused(draft(), [row]);
	});

	it("rejects sparse arrays, exotic prototypes and inherited fields", () => {
		const sparse: ContactData[] = [];
		sparse.length = 1;
		refused(draft(), sparse);
		const sparseRecipients: string[] = [];
		sparseRecipients.length = 1;
		refused(draft({ to: sparseRecipients }));
		refused(Object.create(draft()));
		refused(draft(), [Object.create(contact())]);
		refused(draft(), [{ ...contact(), addressNorm: Object.create(contact().addressNorm) }]);
		class ContactRows extends Array<ContactData> {}
		refused(draft(), new ContactRows(contact()));
	});

	it("accepts null-prototype records and arrays using only own data fields", () => {
		const input = Object.assign(Object.create(null), draft({ to: [address] }));
		const row = Object.assign(Object.create(null), contact());
		row.addressNorm = Object.assign(Object.create(null), row.addressNorm);
		const rows = [row];
		Object.setPrototypeOf(rows, null);
		Object.setPrototypeOf(input.to, null);
		expectFlags(input, rows, []);
	});

	it("refuses accessors in every inspected field without invoking them", () => {
		let reads = 0;
		const getter = {
			get() {
				reads++;
				throw new Error("Contact data must not execute getters");
			},
		};
		for (const field of ["channel", "to", "cc", "bcc"]) {
			refused(Object.defineProperty(draft(), field, getter));
		}
		for (const field of ["accountId", "addressNorm", "known"]) {
			refused(draft(), [Object.defineProperty(contact(), field, getter)]);
		}
		for (const field of ["untrusted", "text"]) {
			const row = contact();
			Object.defineProperty(row.addressNorm, field, getter);
			refused(draft(), [row]);
		}
		refused(draft(), Object.defineProperty([contact()], "0", getter));
		refused(draft({ to: Object.defineProperty([address], "0", getter) }));
		expect(reads).toBe(0);
	});

	it("refuses proxies at every inspected boundary without invoking traps", () => {
		let traps = 0;
		const trap = (): never => {
			traps++;
			throw new Error("Contact data must not inspect proxies");
		};
		const handler = {
			get: trap,
			getPrototypeOf: trap,
			getOwnPropertyDescriptor: trap,
			ownKeys: trap,
		};
		refused(new Proxy(draft(), handler));
		refused(draft({ to: new Proxy([address], handler) }));
		refused(draft(), new Proxy([contact()], handler));
		refused(draft(), [new Proxy(contact(), handler)]);
		refused(draft(), [{ ...contact(), addressNorm: new Proxy(contact().addressNorm, handler) }]);
		const revoked = Proxy.revocable(contact(), handler);
		revoked.revoke();
		refused(draft(), [revoked.proxy]);
		expect(traps).toBe(0);
	});

	it("ignores extra wrapper fields without enumerating or reading them", () => {
		let reads = 0;
		const row = contact();
		const getter = {
			get() {
				reads++;
				throw new Error("Unused wrapper data must not be evaluated");
			},
		};
		Object.defineProperty(row.addressNorm, "unexpected", getter);
		Object.defineProperty(row.addressNorm, Symbol("unused"), getter);
		expectFlags(draft({ to: [address] }), [row], []);
		expect(reads).toBe(0);
	});

	it("does not read unused fields, array methods or iterators", () => {
		let reads = 0;
		const getter = {
			get() {
				reads++;
				throw new Error("Unused contact data must not be read");
			},
		};
		const input = draft({ to: [address] });
		for (const field of ["body", "subject", "attachments"])
			Object.defineProperty(input, field, getter);
		const row = contact();
		for (const field of ["name", "lastActivityAt"]) Object.defineProperty(row, field, getter);
		const rows = [row];
		for (const array of [rows, input.to, input.cc, input.bcc]) {
			for (const key of ["map", "filter", Symbol.iterator])
				Object.defineProperty(array, key, getter);
		}
		expectFlags(input, rows, []);
		expect(reads).toBe(0);
	});

	it("does not coerce invalid inspected data", () => {
		let coercions = 0;
		const value = {
			toString() {
				coercions++;
				throw new Error("Canonical data must not be coerced");
			},
		};
		refused(draft(), [], value);
		refused(draft({ to: [value as unknown as string] }));
		refused(draft(), [{ ...contact(), addressNorm: { untrusted: true, text: value } }]);
		expect(coercions).toBe(0);
	});

	it("refuses proxy objects in primitive fields without inspection or coercion", () => {
		for (const boundary of [
			"account argument",
			"draft channel",
			"contact account",
			"contact known",
			"address untrusted",
			"address text",
			"recipient value",
		] as const) {
			let traps = 0;
			let coercions = 0;
			const trap = (): never => {
				traps++;
				throw new Error("Primitive data must not inspect proxy objects");
			};
			const value = new Proxy(
				{},
				{
					get(_target, key) {
						traps++;
						if (key === Symbol.toPrimitive || key === "toString" || key === "valueOf") {
							return () => {
								coercions++;
								return "synthetic";
							};
						}
						if (key === Symbol.toStringTag) return "Synthetic";
						throw new Error("Primitive data must not read proxy properties");
					},
					getPrototypeOf: trap,
					getOwnPropertyDescriptor: trap,
					ownKeys: trap,
					has: trap,
				},
			);
			switch (boundary) {
				case "account argument":
					refused(draft(), [], value);
					break;
				case "draft channel":
					refused({ ...draft(), channel: value });
					break;
				case "contact account":
					refused(draft(), [{ ...contact(), accountId: value }]);
					break;
				case "contact known":
					refused(draft(), [{ ...contact(), known: value }]);
					break;
				case "address untrusted":
					refused(draft(), [{ ...contact(), addressNorm: { untrusted: value, text: address } }]);
					break;
				case "address text":
					refused(draft(), [{ ...contact(), addressNorm: { untrusted: true, text: value } }]);
					break;
				case "recipient value":
					refused({ ...draft(), to: [value] });
					break;
			}
			expect(traps, boundary).toBe(0);
			expect(coercions, boundary).toBe(0);
		}
	});

	it("does not mutate frozen recipient or contact data", () => {
		const input = draft({ to: [address], bcc: ["New@example.invalid"] });
		const row = contact();
		Object.freeze(row.addressNorm);
		Object.freeze(row);
		for (const array of [input.to, input.cc, input.bcc]) Object.freeze(array);
		Object.freeze(input);
		const rows = Object.freeze([row]);
		const before = structuredClone({ input, rows });
		expectFlags(input, rows, [flag("New@example.invalid")]);
		expect({ input, rows }).toEqual(before);
	});
});
