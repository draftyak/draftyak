import type { Draft, DraftContent } from "@draftyak/protocol/entities/draft";
import { describe, expect, it, vi } from "vitest";
import {
	CrossThreadFlagsError,
	classifySuppliedCrossThreadEmailAndNumberFlags,
} from "../src/cross-thread-flags.ts";
import { finishHygiene, linkMarker } from "../src/hygiene.ts";
import type { ThreadMessage } from "../src/prompt.ts";

const WARNING = [{ code: "CROSS_THREAD_DATA", severity: "ack" }];
const id = (value: number): string => String(value).padStart(26, "0");

function makeDraft(overrides: Partial<Draft> = {}): Draft {
	return {
		id: id(1),
		accountId: id(2),
		conversationId: id(3),
		rev: 1,
		state: "open",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function email(body: string): DraftContent {
	return { channel: "email", to: [], cc: [], bcc: [], subject: "", body, attachments: [] };
}

function chat(body: string): DraftContent {
	return { channel: "chat", threadTs: null, broadcast: false, body };
}

function message(text: string, overrides: Partial<ThreadMessage> = {}): ThreadMessage {
	return {
		id: id(10),
		conversationId: id(4),
		direction: "inbound",
		dmarc: "none",
		body: {
			text,
			removals: { hidden: 0, invisible: 0, quoted: 0, truncated: 0, uris: 0 },
			links: [],
			suspectedInstructions: false,
		},
		...overrides,
	};
}

function classify(content: DraftContent, messages: readonly ThreadMessage[], draft = makeDraft()) {
	return classifySuppliedCrossThreadEmailAndNumberFlags(draft, content, messages);
}

function refuse(draft: unknown, content: unknown, messages: unknown): CrossThreadFlagsError {
	let caught: unknown;
	let returned = false;
	try {
		classifySuppliedCrossThreadEmailAndNumberFlags(
			draft as Draft,
			content as DraftContent,
			messages as readonly ThreadMessage[],
		);
		returned = true;
	} catch (error) {
		caught = error;
	}
	expect(returned).toBe(false);
	expect(caught).toBeInstanceOf(CrossThreadFlagsError);
	if (!(caught instanceof CrossThreadFlagsError)) throw new Error("Expected a fixed refusal");
	expect(caught.code).toBe("CROSS_THREAD_FLAGS_REFUSED");
	expect(caught.message).toBe("Cross-thread flags refused");
	for (const name of ["detail", "cause"]) {
		const descriptor = Object.getOwnPropertyDescriptor(caught, name);
		if (descriptor !== undefined) {
			expect(Object.hasOwn(descriptor, "value")).toBe(true);
			expect(descriptor.value).toBeUndefined();
		}
	}
	return caught;
}

function freezeData<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) freezeData(item);
		Object.freeze(value);
	}
	return value;
}

function nullRecord<T extends object>(value: T): T {
	return Object.assign(Object.create(null) as object, value);
}

function stringBytes(value: unknown): number {
	if (typeof value === "string") return new TextEncoder().encode(value).length;
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + stringBytes(item), 0);
	if (value !== null && typeof value === "object") {
		return Object.values(value).reduce<number>((sum, item) => sum + stringBytes(item), 0);
	}
	return 0;
}

function aggregateFixture(extra: number) {
	const draft = makeDraft();
	const content = email("123456");
	const messages = Array.from({ length: 27 }, (_, index) =>
		message(index === 0 ? `123456 ${"x".repeat(39_993)}` : index === 26 ? "" : "x".repeat(40_000), {
			id: id(100 + index),
			conversationId: index === 0 ? id(4) : id(3),
			subject: "metadata",
			sender: "sender",
		}),
	);
	const last = messages[messages.length - 1];
	if (!last) throw new Error("Missing aggregate fixture row");
	const fill = 1_048_576 - stringBytes([draft, content, messages]) + extra;
	if (fill < 0 || fill > 40_000) throw new Error("Invalid aggregate fixture budget");
	last.body.text = "x".repeat(fill);
	return { draft, content, messages };
}

function linkedMessage(count: number): ThreadMessage {
	const links: { index: number; host: string }[] = [];
	const text = Array.from({ length: count }, (_, index) =>
		linkMarker(`https://h${index + 1}.example.invalid/path`, links),
	).join(" ");
	return {
		...message(""),
		body: finishHygiene(
			text,
			{ maxChars: 40_000 },
			{
				hidden: 0,
				suspectedInstructions: false,
				links,
			},
		),
	};
}

const CHANNELS = [
	["email", email],
	["chat", chat],
] as const;
const DELIMITERS = [
	["angles", "<", ">"],
	["parentheses", "(", ")"],
	["brackets", "[", "]"],
	["double quotes", '"', '"'],
	["comma", ",", ","],
	["semicolon", ";", ";"],
	["colon", ":", ":"],
	["space", " ", " "],
	["line feed", "\n", "\n"],
] as const;
const EMAILS = [
	["local case differs", "Owner@example.invalid", "owner@example.invalid", false],
	["domain case differs", "owner@EXAMPLE.INVALID", "owner@example.invalid", false],
	["identical upper domain", "owner@EXAMPLE.INVALID", "owner@EXAMPLE.INVALID", true],
	["identical Unicode domain", "owner@bücher.example", "owner@bücher.example", true],
	["IDNA aliases differ", "owner@bücher.example", "owner@xn--bcher-kva.example", false],
	["scripts differ", "a@example.invalid", "а@example.invalid", false],
	["longer local part", "xowner@example.invalid", "owner@example.invalid", false],
	["longer domain", "owner@example.invalid.evil", "owner@example.invalid", false],
	["extra at sign", "x@owner@example.invalid", "owner@example.invalid", false],
	["local slash prefix", "prefix/owner@example.invalid", "owner@example.invalid", false],
	["path suffix", "owner@example.invalid/path", "owner@example.invalid", false],
	[
		"URL prefix",
		"https://example.invalid/path/owner@example.invalid",
		"owner@example.invalid",
		false,
	],
] as const;
const NUMBERS = [
	["six digits", "123456", "123456", true],
	["five digits", "12345", "12345", false],
	["surrounding letters", "a123456z", "123456", true],
	["shorter draft run", "123456", "1234567", false],
	["shorter source run", "1234567", "123456", false],
	["same leading zeros", "001234", "001234", true],
	["different leading zeros", "123456", "000123456", false],
	["hyphen groups", "123-456", "123456", false],
	["space groups", "123 456", "123456", false],
	["Arabic-Indic digits", "١٢٣٤٥٦", "١٢٣٤٥٦", true],
	["Arabic-Indic and ASCII differ", "١٢٣٤٥٦", "123456", false],
	["fullwidth and ASCII differ", "１２３４５６", "123456", false],
	[
		"five astral code points",
		"\u{1D7CE}\u{1D7CF}\u{1D7D0}\u{1D7D1}\u{1D7D2}",
		"\u{1D7CE}\u{1D7CF}\u{1D7D0}\u{1D7D1}\u{1D7D2}",
		false,
	],
	[
		"six astral code points",
		"\u{1D7CE}\u{1D7CF}\u{1D7D0}\u{1D7D1}\u{1D7D2}\u{1D7D3}",
		"\u{1D7CE}\u{1D7CF}\u{1D7D0}\u{1D7D1}\u{1D7D2}\u{1D7D3}",
		true,
	],
	[
		"astral and ASCII differ",
		"\u{1D7CE}\u{1D7CF}\u{1D7D0}\u{1D7D1}\u{1D7D2}\u{1D7D3}",
		"012345",
		false,
	],
	["mixed scripts", "123٤٥٦", "123٤٥٦", true],
	["mixed-script maximal run", "123٤٥٦", "123٤٥٦7", false],
] as const;
const PERIODS = [
	["sentence end", "Use owner@example.invalid.", "copy owner@example.invalid", true],
	["both sides", "owner@example.invalid.", "owner@example.invalid.", true],
	["before a comma", "owner@example.invalid., next", "owner@example.invalid", true],
	["before whitespace", "owner@example.invalid. next", "owner@example.invalid", true],
	["original upper spelling", "owner@EXAMPLE.INVALID.", "owner@EXAMPLE.INVALID", true],
	["original Unicode spelling", "owner@bücher.example.", "owner@bücher.example", true],
	["case stays unequal", "owner@EXAMPLE.INVALID.", "owner@example.invalid", false],
	["double dots", "owner@example.invalid..", "owner@example.invalid", false],
	["longer host", "owner@example.invalid.evil.", "owner@example.invalid", false],
	["extra at sign", "x@owner@example.invalid.", "owner@example.invalid", false],
	["slash suffix", "owner@example.invalid/path.", "owner@example.invalid", false],
	["larger local span", "prefix/owner@example.invalid.", "owner@example.invalid", false],
	["IDNA stays unequal", "owner@bücher.example.", "owner@xn--bcher-kva.example", false],
] as const;
const ENUMS = [
	["inbound", "pass"],
	["inbound", "fail"],
	["inbound", "none"],
	["outbound", "pass"],
	["outbound", "fail"],
	["outbound", "none"],
] as const;

describe("supplied cross-thread email and number flags", () => {
	it.each(CHANNELS)("flags exact other-conversation DATA in %s", (_name, makeContent) => {
		expect(
			classify(makeContent("owner@example.invalid 123456"), [
				message("owner@example.invalid 123456"),
			]),
		).toStrictEqual(WARNING);
		expect(
			classify(makeContent("owner@example.invalid"), [message("owner@example.invalid")]),
		).toStrictEqual(WARNING);
		expect(classify(makeContent("123456"), [message("123456")])).toStrictEqual(WARNING);
		expect(
			classify(makeContent("Use owner@example.invalid."), [message("copy owner@example.invalid")]),
		).toStrictEqual(WARNING);
	});
	it.each(CHANNELS)("excludes the current conversation in %s", (_name, makeContent) => {
		expect(
			classify(makeContent("owner@example.invalid 123456"), [
				message("owner@example.invalid 123456", { conversationId: id(3) }),
			]),
		).toStrictEqual([]);
	});
	it("still examines a different conversation after a current-conversation row", () => {
		expect(
			classify(email("123456"), [
				message("123456", { conversationId: id(3) }),
				message("123456", { id: id(11) }),
			]),
		).toStrictEqual(WARNING);
	});
	it("allows a new email conversation and refuses an unassociated chat draft", () => {
		const draft = makeDraft({ conversationId: null });
		expect(classify(email("123456"), [message("123456")], draft)).toStrictEqual(WARNING);
		refuse(draft, chat("123456"), [message("123456")]);
	});
	it("returns one detail-free flag for repeated tokens and multiple matching sources", () => {
		expect(
			classify(email("123456 123456 owner@example.invalid"), [
				message("123456 owner@example.invalid"),
				message("123456", { id: id(11) }),
			]),
		).toStrictEqual(WARNING);
	});
	it("searches only the draft body, not recipient roles, subject or attachment names", () => {
		const content = email("");
		if (content.channel !== "email") throw new Error("Expected email fixture");
		content.to = ["owner@example.invalid"];
		content.cc = ["owner@example.invalid"];
		content.bcc = ["owner@example.invalid"];
		content.subject = "owner@example.invalid 123456";
		content.attachments = [
			{
				blobId: id(90),
				filename: "owner@example.invalid-123456",
				contentType: "application/octet-stream",
				size: 0,
				sha256: "0".repeat(64),
			},
		];
		expect(classify(content, [message("owner@example.invalid 123456")])).toStrictEqual([]);
	});
	it("searches only source text, not optional subject or sender metadata", () => {
		expect(
			classify(email("owner@example.invalid 123456"), [
				message("", {
					subject: "owner@example.invalid 123456",
					sender: "owner@example.invalid 123456",
				}),
			]),
		).toStrictEqual([]);
	});
	it("does not treat message or conversation identifiers as copied body data", () => {
		expect(classify(email(`${id(10)} ${id(4)}`), [message("")])).toStrictEqual([]);
	});
	it("accepts empty unfinished bodies and an empty supplied corpus", () => {
		expect(classify(email(""), [])).toStrictEqual([]);
		expect(classify(chat(""), [message("123456")])).toStrictEqual([]);
	});
	it.each(["sent", "discarded"] as const)(
		"does not invent an open-state requirement for %s DATA",
		(state) => {
			expect(classify(email("123456"), [message("123456")], makeDraft({ state }))).toStrictEqual(
				WARNING,
			);
		},
	);
	it.each(ENUMS)("accepts canonical source direction %s and DMARC %s", (direction, dmarc) => {
		expect(classify(email("123456"), [message("123456", { direction, dmarc })])).toStrictEqual(
			WARNING,
		);
	});
	it.each(DELIMITERS)("recognizes a complete email between %s", (_name, before, after) => {
		expect(
			classify(email(`${before}owner@example.invalid${after}`), [message("owner@example.invalid")]),
		).toStrictEqual(WARNING);
		expect(
			classify(email("owner@example.invalid"), [message(`${before}owner@example.invalid${after}`)]),
		).toStrictEqual(WARNING);
	});
	it.each(EMAILS)("preserves literal email keys: %s", (_name, current, source, matched) => {
		expect(classify(email(current), [message(source)])).toStrictEqual(matched ? WARNING : []);
		expect(classify(email(source), [message(current)])).toStrictEqual(matched ? WARNING : []);
	});
	it.each(NUMBERS)(
		"preserves maximal Unicode digit runs: %s",
		(_name, current, source, matched) => {
			expect(classify(email(current), [message(source)])).toStrictEqual(matched ? WARNING : []);
			expect(classify(email(source), [message(current)])).toStrictEqual(matched ? WARNING : []);
		},
	);
	it.each(PERIODS)(
		"handles one terminal sentence period without partial matching: %s",
		(_name, current, source, matched) => {
			expect(classify(email(current), [message(source)])).toStrictEqual(matched ? WARNING : []);
			expect(classify(email(source), [message(current)])).toStrictEqual(matched ? WARNING : []);
		},
	);
	it("does not promote host-only link metadata into a full URL match", () => {
		const source = linkedMessage(1);
		expect(classify(email("https://h1.example.invalid/path"), [source])).toStrictEqual([]);
	});
	it("accepts recursively frozen valid DATA without modifying it", () => {
		const draft = freezeData(makeDraft());
		const content = freezeData(email("123456"));
		const sources = freezeData([message("123456")]);
		const before = JSON.stringify([draft, content, sources]);
		expect(classify(content, sources, draft)).toStrictEqual(WARNING);
		expect(JSON.stringify([draft, content, sources])).toBe(before);
	});
	it("accepts null-prototype DATA records with ordinary dense arrays", () => {
		const source = message("123456");
		source.body.removals = nullRecord(source.body.removals);
		const body = nullRecord(source.body);
		expect(
			classify(
				nullRecord(email("123456")),
				[nullRecord({ ...source, body })],
				nullRecord(makeDraft()),
			),
		).toStrictEqual(WARNING);
	});
});

const LATE_DEFECTS: ReadonlyArray<readonly [string, (row: ThreadMessage) => unknown]> = [
	["duplicate message ID", (row) => ({ ...row, id: id(10) })],
	["noncanonical conversation ID", (row) => ({ ...row, conversationId: "not-a-conversation-id" })],
	["invalid direction", (row) => ({ ...row, direction: "incoming" })],
	["invalid DMARC", (row) => ({ ...row, dmarc: "unknown" })],
	[
		"truncated source",
		(row) => ({ ...row, body: { ...row.body, removals: { ...row.body.removals, truncated: 1 } } }),
	],
	["CR source text", (row) => ({ ...row, body: { ...row.body, text: "source\rtext" } })],
	["non-NFC source text", (row) => ({ ...row, body: { ...row.body, text: "e\u0301" } })],
	["unpaired source surrogate", (row) => ({ ...row, body: { ...row.body, text: "\uD800" } })],
	[
		"source text over its UTF16 limit",
		(row) => ({ ...row, body: { ...row.body, text: "x".repeat(40_001) } }),
	],
	["subject over its UTF8 limit", (row) => ({ ...row, subject: "é".repeat(2_049) })],
	["sender over its UTF8 limit", (row) => ({ ...row, sender: "é".repeat(2_049) })],
	["unpaired metadata surrogate", (row) => ({ ...row, sender: "\uD800" })],
	[
		"fractional removal counter",
		(row) => ({ ...row, body: { ...row.body, removals: { ...row.body.removals, quoted: 0.5 } } }),
	],
	[
		"negative removal counter",
		(row) => ({ ...row, body: { ...row.body, removals: { ...row.body.removals, quoted: -1 } } }),
	],
	[
		"oversized removal counter",
		(row) => ({
			...row,
			body: { ...row.body, removals: { ...row.body.removals, quoted: 1_048_577 } },
		}),
	],
	[
		"nonfinite removal counter",
		(row) => ({ ...row, body: { ...row.body, removals: { ...row.body.removals, quoted: NaN } } }),
	],
	["unknown nested member", (row) => ({ ...row, body: { ...row.body, extra: true } })],
	[
		"inconsistent link table",
		(row) => ({ ...row, body: { ...row.body, links: [{ index: 1, host: "example.invalid" }] } }),
	],
];

describe("whole supplied DATA refusal", () => {
	it.each(LATE_DEFECTS)(
		"refuses %s even after a hit and in an excluded conversation",
		(_name, corrupt) => {
			const late = message("unrelated", { id: id(11), conversationId: id(3) });
			refuse(makeDraft(), email("123456"), [message("123456"), corrupt(late)]);
		},
	);
	it("validates all arguments before accepting an empty corpus", () => {
		refuse(null, email(""), []);
		refuse(makeDraft(), { ...email(""), body: "\uDC00" }, []);
		refuse(makeDraft(), { ...email(""), body: "e\u0301" }, []);
		refuse(makeDraft(), { ...email(""), body: "line\rbreak" }, []);
	});
	it("refuses unknown canonical draft and content members", () => {
		refuse({ ...makeDraft(), extra: true }, email("123456"), []);
		refuse(makeDraft(), { ...email("123456"), extra: true }, []);
	});
	it("refuses nonarray, sparse, decorated and subclassed corpus arrays", () => {
		refuse(makeDraft(), email("123456"), { 0: message("123456"), length: 1 });
		refuse(makeDraft(), email("123456"), new Array(1));
		refuse(makeDraft(), email("123456"), Object.assign([message("123456")], { extra: 1 }));
		refuse(
			makeDraft(),
			email("123456"),
			Object.assign([message("123456")], { "01": message("123456", { id: id(11) }) }),
		);
		class Corpus extends Array<ThreadMessage> {}
		refuse(makeDraft(), email("123456"), new Corpus(message("123456")));
		refuse(makeDraft(), email("123456"), Object.setPrototypeOf([message("123456")], null));
	});
	it("refuses a function as a supplied message without calling it", () => {
		const callback = vi.fn(() => message("123456"));
		refuse(makeDraft(), email("123456"), [callback]);
		expect(callback).not.toHaveBeenCalled();
	});
	it.each(["draft", "content", "corpus", "row", "body", "links"] as const)(
		"refuses normal and revoked Proxy at %s without traps",
		(position) => {
			for (const revoked of [false, true]) {
				const trap = vi.fn(() => {
					throw new Error("Caller Proxy trap invoked");
				});
				let draft: unknown = makeDraft();
				let content: unknown = email("123456");
				let row: unknown = message("123456");
				let sources: unknown = [row];
				const target =
					position === "draft"
						? makeDraft()
						: position === "content"
							? email("123456")
							: position === "corpus"
								? [message("123456")]
								: position === "row"
									? message("123456")
									: position === "body"
										? message("123456").body
										: [];
				const pair = Proxy.revocable(target, {
					get: trap,
					ownKeys: trap,
					getOwnPropertyDescriptor: trap,
					getPrototypeOf: trap,
				});
				if (revoked) pair.revoke();
				if (position === "draft") draft = pair.proxy;
				else if (position === "content") content = pair.proxy;
				else if (position === "corpus") sources = pair.proxy;
				else if (position === "row") {
					row = pair.proxy;
					sources = [row];
				} else if (position === "body") sources = [{ ...message("123456"), body: pair.proxy }];
				else
					sources = [
						{ ...message("123456"), body: { ...message("123456").body, links: pair.proxy } },
					];
				refuse(draft, content, sources);
				expect(trap).not.toHaveBeenCalled();
			}
		},
	);
	it.each([true, false])(
		"refuses accessors without invoking them (enumerable=%s)",
		(enumerable) => {
			const getter = vi.fn(() => "123456");
			const setter = vi.fn();
			const row = message("123456", { id: id(11), conversationId: id(3) });
			Object.defineProperty(row.body, "text", { get: getter, set: setter, enumerable });
			refuse(makeDraft(), email("123456"), [message("123456"), row]);
			expect(getter).not.toHaveBeenCalled();
			expect(setter).not.toHaveBeenCalled();
		},
	);
	it("refuses an accessor array index without reading it", () => {
		const getter = vi.fn(() => message("123456"));
		const sources = new Array(1);
		Object.defineProperty(sources, "0", { get: getter, enumerable: true });
		refuse(makeDraft(), email("123456"), sources);
		expect(getter).not.toHaveBeenCalled();
	});
	it("refuses non-enumerable extras and symbol fields without invoking callbacks", () => {
		const callback = vi.fn();
		const extra = message("123456");
		Object.defineProperty(extra, "extra", { value: 1, enumerable: false });
		refuse(makeDraft(), email("123456"), [extra]);
		const symbolic = message("123456");
		Object.defineProperty(symbolic, Symbol.toPrimitive, { value: callback, enumerable: false });
		refuse(makeDraft(), email("123456"), [symbolic]);
		expect(callback).not.toHaveBeenCalled();
	});
	it("rejects boxed and coercible scalars without coercion", () => {
		const callback = vi.fn(() => "123456");
		const scalar = { toString: callback, valueOf: callback, [Symbol.toPrimitive]: callback };
		refuse(makeDraft(), email("123456"), [
			{ ...message("123456"), body: { ...message("123456").body, text: scalar } },
		]);
		refuse(makeDraft(), email("123456"), [{ ...message("123456"), subject: Object("metadata") }]);
		expect(callback).not.toHaveBeenCalled();
	});
	it.each([new Date(0), new Map(), new Set(), new Uint8Array(1)])(
		"rejects exotic row records: %s",
		(exotic) => {
			refuse(makeDraft(), email("123456"), [Object.assign(exotic, message("123456"))]);
		},
	);
	it("refuses custom record prototypes without reading inherited fields", () => {
		const inherited = vi.fn(() => "123456");
		const prototype = Object.defineProperty({}, "text", { get: inherited });
		const body = Object.defineProperties(
			Object.create(prototype) as object,
			Object.getOwnPropertyDescriptors(message("123456").body),
		);
		refuse(makeDraft(), email("123456"), [{ ...message("123456"), body }]);
		expect(inherited).not.toHaveBeenCalled();
	});
});

describe("declared resource units and content-free results", () => {
	it("accepts 100 unique canonical messages and refuses a late 101st", () => {
		const rows = Array.from({ length: 100 }, (_, index) =>
			message(index === 0 ? "123456" : "unrelated", {
				id: id(100 + index),
				conversationId: index === 0 ? id(4) : id(3),
			}),
		);
		expect(classify(email("123456"), rows)).toStrictEqual(WARNING);
		refuse(makeDraft(), email("123456"), [
			...rows,
			message("unrelated", { id: id(200), conversationId: id(3) }),
		]);
	});
	it("measures source text in UTF16 units rather than code points", () => {
		expect(classify(email("123456"), [message("😀".repeat(20_000))])).toStrictEqual([]);
		refuse(makeDraft(), email("123456"), [message("😀".repeat(20_001))]);
	});
	it("does not apply the source-text UTF16 cap to canonical draft body scalars", () => {
		expect(classify(email(`${"x".repeat(99_993)} 123456`), [message("123456")])).toStrictEqual(
			WARNING,
		);
		expect(classify(chat(`${"😀".repeat(20_001)} 123456`), [message("123456")])).toStrictEqual(
			WARNING,
		);
		refuse(makeDraft(), { ...email(""), body: "x".repeat(100_001) }, []);
		refuse(makeDraft(), { ...chat(""), body: "x".repeat(40_001) }, []);
	});
	it("allows one full-size maximal number without truncating it to a shorter match", () => {
		const number = "1".repeat(40_000);
		expect(classify(email(number), [message(number)])).toStrictEqual(WARNING);
		expect(classify(email(number), [message(number.slice(1))])).toStrictEqual([]);
	});
	it("measures optional source metadata in UTF8 bytes", () => {
		expect(
			classify(email("123456"), [
				message("123456", { subject: "é".repeat(2_048), sender: "é".repeat(2_048) }),
			]),
		).toStrictEqual(WARNING);
		refuse(makeDraft(), email("123456"), [message("123456", { subject: "é".repeat(2_049) })]);
		refuse(makeDraft(), email("123456"), [message("123456", { sender: "é".repeat(2_049) })]);
	});
	it("validates and counts known non-enumerable DATA fields", () => {
		const valid = message("123456");
		Object.defineProperty(valid, "subject", { value: "é".repeat(2_048), enumerable: false });
		expect(classify(email("123456"), [valid])).toStrictEqual(WARNING);
		const late = message("unrelated", { id: id(11), conversationId: id(3) });
		Object.defineProperty(late, "sender", { value: "é".repeat(2_049), enumerable: false });
		refuse(makeDraft(), email("123456"), [message("123456"), late]);
	});
	it("accepts 512 final link annotations and refuses a matching 513th entry", () => {
		const source = linkedMessage(512);
		expect(source.body.links).toHaveLength(512);
		expect(classify(email("unrelated"), [source])).toStrictEqual([]);
		const tooMany = {
			...source,
			body: {
				...source.body,
				text: `${source.body.text} [link 513: h513.example.invalid]`,
				links: [...source.body.links, { index: 513, host: "h513.example.invalid" }],
			},
		};
		refuse(makeDraft(), email("unrelated"), [tooMany]);
	});
	it("counts all snapshotted strings at the exact aggregate byte boundary", () => {
		const exact = aggregateFixture(0);
		expect(stringBytes([exact.draft, exact.content, exact.messages])).toBe(1_048_576);
		expect(classify(exact.content, exact.messages, exact.draft)).toStrictEqual(WARNING);
		const over = aggregateFixture(1);
		expect(stringBytes([over.draft, over.content, over.messages])).toBe(1_048_577);
		const excluded = over.messages[1];
		if (!excluded) throw new Error("Missing excluded fixture row");
		Object.defineProperty(excluded, "sender", { value: excluded.sender, enumerable: false });
		refuse(over.draft, over.content, over.messages);
	});
	it("keeps matched values out of output, fixed errors and logging", () => {
		const token = "private.copy@example.invalid";
		const log = vi.spyOn(console, "log");
		const warn = vi.spyOn(console, "warn");
		const error = vi.spyOn(console, "error");
		const info = vi.spyOn(console, "info");
		const debug = vi.spyOn(console, "debug");
		try {
			const output = classify(email(token), [message(token)]);
			expect(output).toStrictEqual(WARNING);
			expect(JSON.stringify(output)).not.toContain(token);
			const rejected = refuse(makeDraft(), email(token), [
				message(token),
				{ ...message(token, { id: id(11) }), extra: token },
			]);
			expect(rejected.message).not.toContain(token);
			expect(rejected.stack).not.toContain(token);
			expect(JSON.stringify(Object.getOwnPropertyDescriptors(rejected))).not.toContain(token);
			expect(log).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
			expect(info).not.toHaveBeenCalled();
			expect(debug).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
			warn.mockRestore();
			error.mockRestore();
			info.mockRestore();
			debug.mockRestore();
		}
	});
});
