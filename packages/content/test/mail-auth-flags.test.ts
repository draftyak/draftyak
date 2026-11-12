import { Flags } from "@draftyak/protocol/flags";
import { describe, expect, it } from "vitest";
import { type MailAuth, verifyMailAuth } from "../src/auth-results.ts";
import { classifyMailAuthenticationFlags } from "../src/mail-auth-flags.ts";

const failureFlags = Object.freeze([
	Object.freeze({ code: "DMARC_FAIL" as const, severity: "ack" as const }),
]);
const refused = { status: "refused", code: "INVALID_INPUT" };
const classify = (auth: unknown) =>
	classifyMailAuthenticationFlags(auth as Pick<MailAuth, "dmarc">);

function expectClassified(auth: unknown, failed: boolean): void {
	const result = classify(auth);
	expect(result).toEqual({ status: "classified", flags: failed ? failureFlags : [] });
	if (result.status !== "classified") throw new Error("DYTEST expected classified auth DATA");
	expect(Flags.safeParse(result.flags).success).toBe(true);
}

describe("mail authentication warning DATA", () => {
	it.each(["fail", "pass", "none"] as const)("maps only canonical dmarc=%s", (dmarc) => {
		expectClassified({ dmarc }, dmarc === "fail");
	});

	it("accepts a null-prototype record and a nonenumerable own data field", () => {
		const auth = Object.create(null);
		Object.defineProperty(auth, "dmarc", { value: "fail" });
		expectClassified(auth, true);
	});

	it("leaves frozen input unchanged and emits no provider or reason detail", () => {
		const auth = Object.freeze({
			dmarc: "fail" as const,
			reason: "dmarc-fail" as const,
			verifiedSender: "DYTEST-Sender@example.test",
		});
		expectClassified(auth, true);
		expect(auth).toEqual({
			dmarc: "fail",
			reason: "dmarc-fail",
			verifiedSender: "DYTEST-Sender@example.test",
		});
	});

	it.each(["fail", "pass"] as const)(
		"never reads unused reason, sender or extra fields with dmarc=%s",
		(dmarc) => {
			let reads = 0;
			const unused = () => {
				reads++;
				throw new Error("DYTEST unused auth field");
			};
			const auth = { dmarc };
			for (const key of ["reason", "verifiedSender", "other", "toJSON", Symbol("DYTEST-extra")])
				Object.defineProperty(auth, key, { get: unused });
			expectClassified(auth, dmarc === "fail");
			expect(reads).toBe(0);
		},
	);

	it("does not infer failure from an unused reason or sender claim", () => {
		expectClassified({ dmarc: "pass", reason: "dmarc-fail", verifiedSender: false }, false);
		expectClassified({ dmarc: "none", reason: "verified", verifiedSender: {} }, false);
	});

	it.each(["fail", "pass"] as const)(
		"isolates later results from caller changes after %s",
		(dmarc) => {
			const first = classify({ dmarc });
			if (first.status !== "classified") throw new Error("DYTEST expected first auth DATA");
			const flag = first.flags[0];
			if (flag) Reflect.set(flag, "code", "NEW_RECIPIENT");
			Reflect.set(first.flags, "0", { code: "NEW_RECIPIENT", severity: "ack" });
			Reflect.set(first.flags, "length", 1);
			expectClassified({ dmarc }, dmarc === "fail");
			expectClassified({ dmarc: "none" }, false);
		},
	);
});

describe("bounded own-field authentication intake", () => {
	it.each([
		undefined,
		null,
		false,
		0,
		"fail",
		Symbol("DYTEST-auth"),
		{},
		Object.create(null),
		Object.create({ dmarc: "fail" }),
		Object.assign([], { dmarc: "fail" }),
		Object.assign(new Date(0), { dmarc: "fail" }),
		Object.assign(new Map(), { dmarc: "fail" }),
		Object.assign(() => {}, { dmarc: "fail" }),
	])("refuses primitive, missing, inherited or exotic input %#", (auth) => {
		expect(classify(auth)).toEqual(refused);
	});

	it.each([
		undefined,
		null,
		false,
		0,
		{},
		[],
		Object("fail"),
		"",
		"FAIL",
		"Fail",
		" fail",
		"fail ",
		"fail\n",
		"none\0",
		"pass\u200b",
		"fail".repeat(1000),
	])("refuses noncanonical dmarc DATA %#", (dmarc) => {
		expect(classify({ dmarc })).toEqual(refused);
	});

	it("refuses an own accessor without invoking it", () => {
		let reads = 0;
		const auth = Object.defineProperty({}, "dmarc", {
			get: () => {
				reads++;
				throw new Error("DYTEST auth accessor");
			},
		});
		expect(classify(auth)).toEqual(refused);
		expect(reads).toBe(0);
		expect(classify(Object.defineProperty({}, "dmarc", { set: () => reads++ }))).toEqual(refused);
		expect(reads).toBe(0);
	});

	it("refuses proxy records and proxy primitive values without invoking any trap", () => {
		let traps = 0;
		const trap = () => {
			traps++;
			throw new Error("DYTEST auth proxy trap");
		};
		const handler = {
			get: trap,
			getPrototypeOf: trap,
			getOwnPropertyDescriptor: trap,
			ownKeys: trap,
			has: trap,
		};
		expect(classify(new Proxy({ dmarc: "fail" }, handler))).toEqual(refused);
		expect(classify({ dmarc: new Proxy({}, handler) })).toEqual(refused);
		const revoked = Proxy.revocable({ dmarc: "fail" }, handler);
		revoked.revoke();
		expect(classify(revoked.proxy)).toEqual(refused);
		expect(traps).toBe(0);
	});

	it("refuses coercible dmarc objects without calling coercion hooks", () => {
		let calls = 0;
		const coercion = () => {
			calls++;
			return "fail";
		};
		expect(
			classify({
				dmarc: { [Symbol.toPrimitive]: coercion, toString: coercion, valueOf: coercion },
			}),
		).toEqual(refused);
		expect(calls).toBe(0);
	});
});

describe("existing provider-result DATA composition", () => {
	const sender = "DYTEST-Sender@example.test";
	const pass = "mx.google.com; dmarc=pass header.from=example.test";
	const fail = "mx.google.com; dmarc=fail header.from=example.test";
	it.each([
		{ name: "topmost provider failure over a lower pass", headers: [fail, pass], dmarc: "fail" },
		{
			name: "topmost provider pass over a lower forged failure",
			headers: [pass, fail],
			dmarc: "pass",
		},
		{
			name: "foreign failing service above the real provider pass",
			headers: ["other.example.test; dmarc=fail header.from=example.test", pass],
			dmarc: "pass",
		},
		{
			name: "only an unrelated failing service",
			headers: ["other.example.test; dmarc=fail header.from=example.test"],
			dmarc: "none",
		},
		{ name: "no Authentication-Results", headers: [], dmarc: "none" },
		{
			name: "malformed selected provider over a lower pass",
			headers: ['mx.google.com; dmarc=pass reason="unterminated', pass],
			dmarc: "none",
		},
	])("classifies the actual verifier's $name", ({ headers, dmarc }) => {
		const auth = verifyMailAuth(
			headers.map((value) => ({ key: "authentication-results", value })),
			"gmail",
			sender,
		);
		expect(auth.dmarc).toBe(dmarc);
		expectClassified(auth, dmarc === "fail");
	});
});
