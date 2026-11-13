import { types } from "node:util";
import {
	ChatDraftContent,
	type DraftContent,
	EmailDraftContent,
} from "@draftyak/protocol/entities/draft";
import { type Flag, Flag as FlagSchema, Flags, flagSeverity } from "@draftyak/protocol/flags";
import { describe, expect, it, vi } from "vitest";
import { classifySecretPatternFlags } from "../src/secret-pattern-flags.ts";

type Input = Pick<DraftContent, "channel" | "body">;
type Channel = Input["channel"];
type Expected = "none" | "warning" | "INVALID_INPUT" | "STRUCTURE_LIMIT";

// Assertions expose only fixed labels and booleans, even if a classifier returns candidate DATA.
function invoke(input: unknown): unknown {
	try {
		return classifySecretPatternFlags(input as Input);
	} catch {
		throw new Error("Classifier threw for synthetic DATA");
	}
}

function data(value: unknown): Record<string, PropertyDescriptor> | undefined {
	if (typeof value !== "object" || value === null || types.isProxy(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	return Object.values(descriptors).every((descriptor) => "value" in descriptor)
		? descriptors
		: undefined;
}

function exactResult(value: unknown, expected: Expected): boolean {
	const result = data(value);
	if (!result) return false;
	if (expected === "INVALID_INPUT" || expected === "STRUCTURE_LIMIT") {
		return (
			Object.keys(result).sort().join(",") === "code,status" &&
			result.status?.value === "refused" &&
			result.code?.value === expected
		);
	}
	if (Object.keys(result).sort().join(",") !== "flags,status") return false;
	const flags: unknown = result.flags?.value;
	if (result.status?.value !== "classified" || types.isProxy(flags) || !Array.isArray(flags)) {
		return false;
	}
	if (flags.length !== (expected === "warning" ? 1 : 0)) return false;
	if (Reflect.ownKeys(flags).length !== flags.length + 1) return false;
	if (flags.length === 0) return Flags.safeParse(flags).success;
	const element = Object.getOwnPropertyDescriptor(flags, "0");
	if (!element || !("value" in element)) return false;
	const flag = data(element.value);
	return (
		flag !== undefined &&
		Object.keys(flag).sort().join(",") === "code,severity" &&
		flag.code?.value === "SECRET_PATTERN" &&
		flag.severity?.value === "ack" &&
		FlagSchema.safeParse(element.value).success &&
		Flags.safeParse(flags).success
	);
}

function draft(body: string, channel: Channel = "email"): Input {
	try {
		return channel === "email"
			? EmailDraftContent.parse({
					channel,
					to: [],
					cc: [],
					bcc: [],
					subject: "Synthetic fixture",
					body,
					attachments: [],
				})
			: ChatDraftContent.parse({ channel, threadTs: null, broadcast: false, body });
	} catch {
		throw new Error("Synthetic canonical fixture was invalid");
	}
}

function check(body: string, expected: "none" | "warning", channel: Channel = "email"): void {
	expect(exactResult(invoke(draft(body, channel)), expected)).toBe(true);
}

function refused(input: unknown, expected: "INVALID_INPUT" | "STRUCTURE_LIMIT"): void {
	expect(exactResult(invoke(input), expected)).toBe(true);
}

const digits = (length: number): string => "7".repeat(length);
const otp = (): string => `${"o"}tp: ${digits(6)}`;

function luhn(length: number, seed = 3): string {
	const payload = Array.from({ length: length - 1 }, (_, index) => (index * 7 + seed) % 10);
	let sum = 0;
	for (let index = 0; index < payload.length; index += 1) {
		let digit = payload[index]!;
		if ((length - index) % 2 === 0) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
		sum += digit;
	}
	return payload.join("") + ((10 - (sum % 10)) % 10);
}

function mod97(text: string): number {
	let remainder = 0;
	for (const character of text.toUpperCase()) {
		const code = character.charCodeAt(0);
		remainder = code >= 65 ? (remainder * 100 + code - 55) % 97 : (remainder * 10 + code - 48) % 97;
	}
	return remainder;
}

function iban(length: number, mixed = false): string {
	const country = "Q" + "X";
	const body = Array.from({ length: length - 4 }, (_, index) =>
		mixed && index % 3 === 0 ? String(index % 10) : String.fromCharCode(65 + ((index * 7) % 26)),
	).join("");
	const checksum = String(98 - mod97(body + country + "00")).padStart(2, "0");
	return country + checksum + body;
}

function forbiddenIban(checksum: string): string {
	const country = "Q" + "X";
	for (let first = 0; first < 26; first += 1) {
		for (let second = 0; second < 26; second += 1) {
			const body = "A".repeat(9) + String.fromCharCode(65 + first, 65 + second);
			if (mod97(body + country + checksum) === 1) return country + checksum + body;
		}
	}
	throw new Error("Synthetic checksum fixture was unavailable");
}

const grouped = (value: string, separator = " "): string => value.match(/.{1,4}/g)!.join(separator);
const pem = (name: string): string => "-".repeat(5) + "BEGIN " + name + "-".repeat(5);

const keyCases: readonly [string, (length: number) => string, number][] = [
	["workspace", (length) => "xox" + "b-" + "1" + "a".repeat(length), 8],
	["paired workspace", (length) => "xox" + "p.xoxb-" + "1" + "a".repeat(length), 8],
	["application", (length) => "xapp" + "-1-" + "a".repeat(length), 8],
	[
		"service webhook",
		(length) => "hooks." + "slack.com/services/T" + "A/" + "a".repeat(length),
		16,
	],
	[
		"workflow webhook",
		(length) => "hooks." + "slack.com/workflows/T" + "A/" + "a".repeat(length),
		16,
	],
	[
		"trigger webhook",
		(length) => "hooks." + "slack.com/triggers/T" + "A/" + "a".repeat(length),
		16,
	],
	["named key", (length) => "sk-ant" + "-api-" + "a".repeat(length), 20],
	["versioned named key", (length) => "sk-ant" + "-api2-" + "a".repeat(length), 20],
	["project key", (length) => "sk-" + "proj-" + "a".repeat(length), 20],
	["service account key", (length) => "sk-" + "svcacct-" + "a".repeat(length), 20],
	["administrative key", (length) => "sk-" + "admin-" + "a".repeat(length), 20],
	["access key", (length) => "ya29" + "." + "a".repeat(length), 20],
	["refresh key", (length) => "1/" + "/0" + "a".repeat(length), 20],
];

const wordNeighbors = [
	["supplementary letter", String.fromCodePoint(0x10400)],
	["combining mark", String.fromCodePoint(0x1d165)],
	["supplementary number", String.fromCodePoint(0x1d7ce)],
	["underscore", "_"],
] as const;

describe("secret pattern flags", () => {
	it("uses the canonical acknowledgement with no candidate detail", () => {
		expect(flagSeverity("SECRET_PATTERN")).toBe("ack");
		check([otp(), luhn(16), iban(22), pem("PRIVATE KEY")].join("\n"), "warning");
		check("Ordinary prose with no selected warning pattern.", "none");
		check("", "none");
	});

	it.each([
		"otp",
		"one-time code",
		"one time code",
		"one-time password",
		"one time password",
		"verification code",
		"security code",
		"authentication code",
		"login code",
		"sign-in code",
		"sign in code",
		"2fa code",
	])("recognizes the supported contextual label %s", (label) => {
		check(`${label.toUpperCase().replaceAll(" ", " \t ")} is # ${digits(4)}`, "warning");
	});

	it.each(["IS", "Is", "iS"])(
		"recognizes the ASCII-insensitive connector variant %s",
		(connector) => {
			check(`otp ${connector} : ${digits(6)}`, "warning");
		},
	);

	it("honors both contextual digit limits and connector limits", () => {
		for (const length of [4, 10])
			check(`otp${" ".repeat(8)}is${"\t".repeat(8)}:${" ".repeat(8)}${digits(length)}`, "warning");
		for (const connector of [":", "=", "#", "-", " is ", "\t=\t"])
			check(`otp${connector}${digits(6)}`, "warning");
		for (const length of [3, 11, 12, 20]) check(`otp: ${digits(length)}`, "none");
		for (const connector of [
			" ".repeat(9),
			" is",
			" is ".replace("is", "is\n"),
			"::",
			" : ".repeat(2),
			"\n",
			"\u00a0",
		])
			check(`otp${connector}${digits(6)}`, "none");
	});

	it("does not broaden labels, word spacing or digit grammar", () => {
		for (const label of [
			"code",
			"passcode",
			"one    time code",
			"verification\ncode",
			"verification\u00a0code",
		])
			check(`${label}: ${digits(6)}`, "none");
		for (const body of [
			`otp: ${digits(3)} ${digits(3)}`,
			`otp: ${digits(3)}-${digits(3)}`,
			`otp: ${digits(6)}a`,
			digits(6),
			`o\u200btp: ${digits(6)}`,
			`otp: &#${"55;".repeat(6)}`,
		])
			check(body, "none");
	});

	it("does not join digit groups or lend a label to a later group", () => {
		for (const separator of [" ", "-"]) {
			check(`otp: ${digits(4)}${separator}${digits(4)}`, "warning");
			check(`otp: ${digits(2)}${separator}${digits(4)}`, "none");
		}
	});

	it.each(wordNeighbors)(
		"rejects contextual and checksum identifier substrings beside %s",
		(_label, neighbor) => {
			for (const body of [
				neighbor + otp(),
				`otp${neighbor}: ${digits(6)}`,
				`otp: ${digits(6)}${neighbor}`,
				neighbor + luhn(16),
				luhn(16) + neighbor,
			])
				check(body, "none");
			check(`${String.fromCodePoint(0x1f642)}${otp()}!`, "warning");
		},
	);

	it.each(keyCases)(
		"recognizes the exact %s minimum without clipping longer suffixes",
		(_label, build, minimum) => {
			check(build(minimum - 1), "none");
			check(build(minimum), "warning");
			check(build(minimum + 80), "warning");
			if (_label !== "paired workspace") check("z" + build(minimum), "none");
			check(String.fromCodePoint(0x10400) + build(minimum), "warning");
			check(build(minimum).toUpperCase(), _label === "refresh key" ? "warning" : "none");
		},
	);

	it("preserves legacy-key word boundaries and fixed middle marker", () => {
		const candidate = "sk-" + "a".repeat(20) + "T3BlbkFJ" + "b".repeat(20);
		check(candidate, "warning");
		for (const suffix of ["a", "_"]) check(candidate + suffix, "none");
		check(candidate + "-", "warning");
		check(String.fromCodePoint(0x10400) + candidate + String.fromCodePoint(0x10400), "warning");
		check("sk-" + "a".repeat(19) + "T3BlbkFJ" + "b".repeat(20), "none");
		check(candidate.replace("T3BlbkFJ", "T3BlbkFK"), "none");
	});

	it("preserves the fixed API-key suffix and its negative lookahead", () => {
		const build = (length: number): string => "AI" + "za" + "a".repeat(length);
		check(build(34), "none");
		check(build(35), "warning");
		for (const suffix of ["a", "-", "_"]) check(build(35) + suffix, "none");
		check(build(35) + String.fromCodePoint(0x10400), "warning");
		check("z" + build(35), "none");
		check(build(35).toLowerCase(), "none");
	});

	it("retains exact key subgrammars rather than guessing credentials", () => {
		check("zxox" + "p.xoxb-" + "1" + "a".repeat(8), "warning");
		check("xapp" + "-1-" + "_-".repeat(4), "warning");
		check("hooks." + "slack.com/services/T" + "A/" + "_/".repeat(8), "warning");
		check("sk-ant" + "-api2x-" + "a".repeat(20), "none");
		check("hooks." + "slack.com/services/t" + "A/" + "a".repeat(16), "none");
		check("hooks." + "slack.com/services/T" + "A/" + "a".repeat(15) + "-", "none");
		check("xox" + "B-1" + "a".repeat(8), "none");
		check("ey" + "J" + "a".repeat(30) + "." + "b".repeat(30) + "." + "c".repeat(30), "none");
	});

	it.each([
		"PRIVATE KEY",
		"ENCRYPTED PRIVATE KEY",
		"RSA PRIVATE KEY",
		"EC PRIVATE KEY",
		"DSA PRIVATE KEY",
		"OPENSSH PRIVATE KEY",
	])("recognizes only the complete %s header", (name) => {
		check(pem(name), "warning");
		check("word" + pem(name) + "word", "warning");
		check("-" + pem(name), "none");
		check(pem(name) + "-", "none");
		check(pem(name).toLowerCase(), "none");
		check(pem(name).slice(1), "none");
	});

	it("does not treat public material as a private header", () => {
		for (const name of ["PUBLIC KEY", "CERTIFICATE", "PRIVATE KEYS"]) check(pem(name), "none");
	});

	it.each([13, 14, 15, 16, 17, 18, 19])("checks both Luhn parities at length %i", (length) => {
		const candidate = luhn(length);
		check(candidate, "warning");
		check(candidate.slice(0, -1) + ((Number(candidate.at(-1)) + 1) % 10), "none");
		check("0".repeat(length), "warning");
	});

	it("preserves leading zeros and the exact maximal numeric token grammar", () => {
		check(luhn(16, 0), "warning");
		for (const separator of [" ", "-"]) check(grouped(luhn(16), separator), "warning");
		check(grouped(luhn(16)).replace(" ", "-"), "warning");
		for (const separator of ["  ", "--", "\t", "\n", "\u00a0", ","])
			check(grouped(luhn(16), separator), "none");
		check(luhn(12), "none");
		check(luhn(20), "none");
		check(luhn(13) + digits(7), "none");
		check(digits(7) + luhn(13), "none");
		check(luhn(13) + " " + luhn(13), "none");
		check(grouped(luhn(20)), "none");
	});

	it.each([15, 16, 22, 33, 34])(
		"checks generic IBAN rotation and streamed arithmetic at length %i",
		(length) => {
			const candidate = iban(length);
			check(candidate, "warning");
			check(candidate.toLowerCase(), "warning");
			check(grouped(candidate), "warning");
			check(candidate.slice(4) + candidate.slice(0, 4), "none");
			const changed = candidate.slice(0, -1) + (candidate.at(-1) === "A" ? "B" : "A");
			check(changed, "none");
		},
	);

	it("enforces IBAN checkdigit range independently of a valid remainder", () => {
		for (const checksum of ["00", "01", "99"]) {
			const candidate = forbiddenIban(checksum);
			expect(mod97(candidate.slice(4) + candidate.slice(0, 4)) === 1).toBe(true);
			check(candidate, "none");
		}
	});

	it.each(wordNeighbors)(
		"rejects compact IBAN identifier substrings beside %s",
		(_label, neighbor) => {
			const candidate = iban(22);
			check(neighbor + candidate, "none");
			check(candidate + neighbor, "none");
			check(`(${candidate})`, "warning");
		},
	);

	it("does not salvage compact overlong or misgrouped IBAN candidates", () => {
		for (const length of [14, 35]) check(iban(length), "none");
		const candidate = iban(34);
		check(candidate + "A", "none");
		check("A" + candidate, "none");
		for (const separator of ["\t", "\n", "\u00a0", "-", "  "])
			check(grouped(candidate, separator), "none");
		check(candidate.slice(0, 3) + " " + candidate.slice(3), "none");
		check(candidate.slice(0, 5) + " " + candidate.slice(5), "none");
		check(candidate.replace("Q", "\uff31"), "none");
	});

	it("admits the documented grouped-prefix warning without country lookup", () => {
		check(grouped(iban(16)) + " ABCD EFGH", "warning");
		check(`(${iban(15)}).`, "warning");
		check(iban(22, true), "warning");
		check(grouped(iban(22, true)), "warning");
	});

	it.each(["email", "chat"] as const)(
		"scans quoted history, fenced content and the full %s tail",
		(channel) => {
			check(`> Earlier message\n> ${otp()}\nSignature`, "warning", channel);
			check(`\u0060\u0060\u0060\n${pem("PRIVATE KEY")}\n\u0060\u0060\u0060`, "warning", channel);
			const limit = channel === "email" ? 100_000 : 40_000;
			const tail = `\n${otp()}`;
			const nearMiss = "otp: " + digits(3) + "; sk-ant" + "-api-" + "a".repeat(19) + "; ";
			const prefix = nearMiss.repeat(Math.floor((limit - tail.length) / nearMiss.length));
			check(prefix.padEnd(limit - tail.length, "o") + tail, "warning", channel);
			check(prefix, "none", channel);
			check("0".repeat(limit - tail.length) + tail, "warning", channel);
			check("o".repeat(limit), "none", channel);
			check("\ud83d\ude42".repeat(limit), "none", channel);
			refused({ channel, body: "o".repeat(limit + 1) }, "STRUCTURE_LIMIT");
			refused({ channel, body: "\ud83d\ude42".repeat(limit + 1) }, "STRUCTURE_LIMIT");
			refused({ channel, body: "o".repeat(limit * 2 + 1) }, "STRUCTURE_LIMIT");
		},
	);

	it("validates the entire canonical body before an early warning", () => {
		for (const suffix of ["e\u0301", "\r\n", "\ud800", "\udc00"])
			refused({ channel: "email", body: otp() + suffix }, "INVALID_INPUT");
		refused({ channel: "chat", body: otp() + "o".repeat(40_000) }, "STRUCTURE_LIMIT");
		check("\u00e9\nOrdinary text", "none");
		check("\uff4f\uff54\uff50: " + digits(6), "none");
	});

	it.each([
		["ordinary prototype", Object.prototype],
		["null prototype", null],
	] as const)("rejects reset-prototype arrays: %s", (_label, prototype) => {
		let reads = 0;
		const canonical = draft(otp(), "chat");
		const input = Object.assign([], { channel: canonical.channel, body: canonical.body });
		Object.setPrototypeOf(input, prototype);
		Object.defineProperty(input, "unused", {
			get() {
				reads += 1;
				throw new Error("Unexpected extra read");
			},
		});
		expect(Array.isArray(input) && Object.getPrototypeOf(input) === prototype).toBe(true);
		const result = invoke(input);
		expect(reads).toBe(0);
		expect(exactResult(result, "INVALID_INPUT")).toBe(true);
	});

	it("rejects malformed used DATA without calling accessors or proxy traps", () => {
		let reads = 0;
		const fail = (): never => {
			reads += 1;
			throw new Error("Unexpected fixture access");
		};
		for (const input of [
			undefined,
			null,
			true,
			1,
			"text",
			[],
			new Date(),
			Object.create({ channel: "email", body: "text" }),
			{ channel: "other", body: "text" },
			{ channel: {}, body: "text" },
			{ channel: "email", body: {} },
			{ channel: "email", body: 1 },
			{ channel: "email" },
		])
			refused(input, "INVALID_INPUT");
		for (const key of ["channel", "body"]) {
			const input = { channel: "email", body: "text" };
			Object.defineProperty(input, key, { get: fail });
			refused(input, "INVALID_INPUT");
		}
		const proxy = new Proxy(
			{ channel: "email", body: "text" },
			{ get: fail, getPrototypeOf: fail, getOwnPropertyDescriptor: fail, ownKeys: fail },
		);
		refused(proxy, "INVALID_INPUT");
		refused({ channel: "email", body: new Proxy({}, { get: fail }) }, "INVALID_INPUT");
		refused({ channel: { [Symbol.toPrimitive]: fail }, body: "text" }, "INVALID_INPUT");
		refused(
			{ channel: "email", body: { [Symbol.toPrimitive]: fail, toString: fail } },
			"INVALID_INPUT",
		);
		const revoked = Proxy.revocable({ channel: "email", body: "text" }, {});
		revoked.revoke();
		refused(revoked.proxy, "INVALID_INPUT");
		expect(reads).toBe(0);
	});

	it("ignores unused getters and preserves owned and null-prototype DATA", () => {
		let reads = 0;
		const input = Object.assign(Object.create(null), { channel: "email", body: otp() }) as Input;
		for (const name of ["to", "attachments", "metadata"])
			Object.defineProperty(input, name, {
				get() {
					reads += 1;
					throw new Error("Unexpected extra read");
				},
			});
		Object.freeze(input);
		expect(exactResult(invoke(input), "warning")).toBe(true);
		expect(reads).toBe(0);
		expect(input.body === otp() && input.channel === "email" && Object.isFrozen(input)).toBe(true);
	});

	it("returns isolated canonical results without logging candidate DATA", () => {
		const spies = ["log", "warn", "error", "info", "debug"] as const;
		const mocks = spies.map((method) =>
			vi.spyOn(console, method).mockImplementation(() => undefined),
		);
		try {
			const input = Object.freeze(draft(otp()));
			const before = JSON.stringify(input);
			const first = invoke(input);
			const second = invoke(input);
			expect(exactResult(first, "warning") && exactResult(second, "warning")).toBe(true);
			const a = first as { flags: Flag[] };
			const b = second as { flags: Flag[] };
			expect(first !== second && a.flags !== b.flags && a.flags[0] !== b.flags[0]).toBe(true);
			Reflect.set(a.flags[0]!, "detail", "changed");
			expect(exactResult(invoke(input), "warning")).toBe(true);
			const emptyFirst = invoke(draft(""));
			const emptySecond = invoke(draft(""));
			expect(exactResult(emptyFirst, "none") && exactResult(emptySecond, "none")).toBe(true);
			expect(
				emptyFirst !== emptySecond &&
					(emptyFirst as { flags: Flag[] }).flags !== (emptySecond as { flags: Flag[] }).flags,
			).toBe(true);
			expect(JSON.stringify(input) === before).toBe(true);
			expect(mocks.every((mock) => mock.mock.calls.length === 0)).toBe(true);
		} finally {
			for (const mock of mocks) mock.mockRestore();
		}
	});
});
