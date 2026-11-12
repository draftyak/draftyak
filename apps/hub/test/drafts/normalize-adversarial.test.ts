import type {
	ChatDraftContent,
	DraftAttachment,
	EmailDraftContent,
} from "@draftyak/protocol/entities/draft";
import { expect, it } from "vitest";
import { normalizeDraftBody, normalizeDraftContent } from "../../src/drafts/normalize.ts";

const OTTER = "\u{1f9a6}";
const LIMITS = [
	{ channel: "email", limit: 100_000 },
	{ channel: "chat", limit: 40_000 },
] as const;

function attachment(): DraftAttachment {
	return {
		blobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		filename: "DYTEST.txt",
		contentType: "text/plain",
		size: 0,
		sha256: "a".repeat(64),
	};
}

function email(body = "DYTEST body"): EmailDraftContent {
	return {
		channel: "email",
		to: ["dytest@example.test"],
		cc: [],
		bcc: [],
		subject: "DYTEST subject",
		body,
		attachments: [attachment()],
	};
}

function chat(body: string): ChatDraftContent {
	return { channel: "chat", threadTs: "DYTEST-thread", broadcast: true, body };
}

function content(channel: "email" | "chat", body: string) {
	return channel === "email" ? email(body) : chat(body);
}

function refuse(work: () => unknown): void {
	expect(work).toThrowError(/^Draft content refused\.$/);
}

function watchedProxy<T extends object>(value: T, called: () => void): T {
	const trap = (): never => {
		called();
		throw new Error("DYTEST proxy trap");
	};
	return new Proxy(value, {
		get: trap,
		getPrototypeOf: trap,
		ownKeys: trap,
		getOwnPropertyDescriptor: trap,
	});
}

it.each(LIMITS)("checks $channel limits after NFC expands U+0344", ({ channel, limit }) => {
	const accepted = "\u0344".repeat(limit / 2);
	const normalized = "\u0308\u0301".repeat(limit / 2);
	expect(normalizeDraftContent(content(channel, accepted)).body).toBe(normalized);
	refuse(() => normalizeDraftContent(content(channel, `${accepted}\u0344`)));
});

it.each(LIMITS)("counts astral $channel body scalars once", ({ channel, limit }) => {
	const accepted = OTTER.repeat(limit);
	expect(accepted.length).toBe(limit * 2);
	expect(normalizeDraftContent(content(channel, accepted)).body).toBe(accepted);
	refuse(() => normalizeDraftContent(content(channel, `${accepted}${OTTER}`)));
});

it.each(LIMITS)("checks $channel limits after CRLF shrinks", ({ channel, limit }) => {
	const accepted = "\r\n".repeat(limit);
	expect(normalizeDraftContent(content(channel, accepted)).body).toBe("\n".repeat(limit));
	refuse(() => normalizeDraftContent(content(channel, `${accepted}\r\n`)));
});

it("preserves decomposed one-line fields and other bytes in frozen null-prototype input", () => {
	const input = email("DYTEST \u200e e\u0301\r\n");
	const file = attachment();
	input.subject = "  e\u0301\tDYTEST ";
	file.filename = " e\u0301  .txt";
	input.attachments = [file];
	Object.setPrototypeOf(input, null);
	Object.freeze(file);
	for (const list of [input.to, input.cc, input.bcc, input.attachments]) Object.freeze(list);
	Object.freeze(input);
	expect(normalizeDraftContent(input)).toEqual({
		...input,
		body: "DYTEST \u200e \u00e9\n",
	});
	expect(input.body).toBe("DYTEST \u200e e\u0301\r\n");
	expect(input.subject).toBe("  e\u0301\tDYTEST ");
	expect(file.filename).toBe(" e\u0301  .txt");
});

it("counts subject code points without normalizing or trimming", () => {
	const input = email();
	input.subject = OTTER.repeat(2000);
	const output = normalizeDraftContent(input);
	expect(output.channel).toBe("email");
	if (output.channel !== "email") throw new Error("DYTEST email expected");
	expect(output.subject).toBe(input.subject);
	refuse(() => normalizeDraftContent({ ...input, subject: `${input.subject}${OTTER}` }));
});

it("counts filename code points without normalizing or truncating", () => {
	const input = email();
	const file = attachment();
	file.filename = OTTER.repeat(256);
	input.attachments = [file];
	const output = normalizeDraftContent(input);
	expect(output.channel).toBe("email");
	if (output.channel !== "email") throw new Error("DYTEST email expected");
	expect(output.attachments).toEqual([file]);
	refuse(() =>
		normalizeDraftContent({
			...input,
			attachments: [{ ...file, filename: `${file.filename}${OTTER}` }],
		}),
	);
});

it.each(["to", "cc", "bcc"] as const)("preserves 100 %s recipients and refuses 101", (field) => {
	const input = email();
	const values = Array.from({ length: 100 }, (_, index) => `dytest-${index}@example.test`);
	input[field] = values;
	const output = normalizeDraftContent(input);
	expect(output.channel).toBe("email");
	if (output.channel !== "email") throw new Error("DYTEST email expected");
	expect(output[field]).toEqual(values);
	refuse(() =>
		normalizeDraftContent({ ...input, [field]: [...values, "dytest-100@example.test"] }),
	);
});

it("preserves 100 attachment values and refuses 101", () => {
	const input = email();
	input.attachments = Array.from({ length: 100 }, (_, index) => ({
		...attachment(),
		filename: `DYTEST-${index}.txt`,
	}));
	const output = normalizeDraftContent(input);
	expect(output.channel).toBe("email");
	if (output.channel !== "email") throw new Error("DYTEST email expected");
	expect(output.attachments).toEqual(input.attachments);
	refuse(() =>
		normalizeDraftContent({ ...input, attachments: [...input.attachments, attachment()] }),
	);
});

it("detaches nested records and aliased arrays from both directions of caller mutation", () => {
	const input = email("DYTEST e\u0301\r");
	const shared = ["dytest-before@example.test"];
	const file = attachment();
	input.to = shared;
	input.cc = shared;
	input.attachments = [file];
	const output = normalizeDraftContent(input);
	expect(output.channel).toBe("email");
	if (output.channel !== "email") throw new Error("DYTEST email expected");
	expect(output).not.toBe(input);
	expect(output.to).not.toBe(shared);
	expect(output.cc).not.toBe(shared);
	expect(output.attachments).not.toBe(input.attachments);
	expect(output.attachments[0]).not.toBe(file);
	shared[0] = "dytest-input@example.test";
	file.filename = "DYTEST-input.txt";
	input.subject = "DYTEST input changed";
	expect(output.to).toEqual(["dytest-before@example.test"]);
	expect(output.cc).toEqual(["dytest-before@example.test"]);
	expect(output.attachments).toEqual([attachment()]);
	expect(output.subject).toBe("DYTEST subject");
	expect(output.body).toBe("DYTEST \u00e9\n");
	output.to.push("dytest-output@example.test");
	output.attachments[0] = { ...attachment(), filename: "DYTEST-output.txt" };
	expect(shared).toEqual(["dytest-input@example.test"]);
	expect(input.attachments).toEqual([{ ...attachment(), filename: "DYTEST-input.txt" }]);
});

it("refuses accessors at record, attachment and array positions without invoking them", () => {
	for (const position of ["body", "filename", "recipient"] as const) {
		let calls = 0;
		const input = email();
		const file = attachment();
		input.attachments = [file];
		const owner = position === "body" ? input : position === "filename" ? file : input.to;
		const key = position === "recipient" ? "0" : position;
		Object.defineProperty(owner, key, {
			enumerable: true,
			configurable: true,
			get() {
				calls++;
				return "DYTEST getter";
			},
		});
		refuse(() => normalizeDraftContent(input));
		expect(calls).toBe(0);
	}
});

it("refuses structural proxies before any introspection trap", () => {
	for (const position of ["record", "recipients", "attachment"] as const) {
		let calls = 0;
		const called = () => calls++;
		const input = email();
		let raw: unknown = input;
		if (position === "record") raw = watchedProxy(input, called);
		if (position === "recipients") input.to = watchedProxy(input.to, called);
		if (position === "attachment") input.attachments = [watchedProxy(attachment(), called)];
		refuse(() => normalizeDraftContent(raw));
		expect(calls).toBe(0);
	}
});

it("refuses unknown discriminators and extra string or symbol fields without hooks", () => {
	let calls = 0;
	const discriminator = {
		[Symbol.toPrimitive]() {
			calls++;
			return "email";
		},
	};
	refuse(() => normalizeDraftContent({ ...email(), channel: discriminator }));
	refuse(() => normalizeDraftContent({ ...chat("DYTEST"), channel: "sms" }));
	for (const key of ["DYTEST-extra", Symbol("DYTEST-extra")]) {
		const input = email();
		Object.defineProperty(input, key, {
			enumerable: true,
			get() {
				calls++;
				return "DYTEST extra";
			},
		});
		refuse(() => normalizeDraftContent(input));
	}
	expect(calls).toBe(0);
});

it("refuses holes and extra array properties without invoking their getters", () => {
	const sparse = email();
	delete sparse.to[0];
	refuse(() => normalizeDraftContent(sparse));
	let calls = 0;
	const extra = email();
	Object.defineProperty(extra.to, "DYTEST-extra", {
		enumerable: true,
		get() {
			calls++;
			return "dytest@example.test";
		},
	});
	refuse(() => normalizeDraftContent(extra));
	expect(calls).toBe(0);
});

it("refuses nonprimitive bodies without coercing them", () => {
	let calls = 0;
	const body = {
		toString() {
			calls++;
			return "DYTEST body";
		},
		[Symbol.toPrimitive]() {
			calls++;
			return "DYTEST body";
		},
	};
	refuse(() => normalizeDraftBody(body as unknown as string));
	refuse(() => normalizeDraftContent({ ...email(), body }));
	expect(calls).toBe(0);
});

it("falls back for object media types without coercing or changing other attachment fields", () => {
	let calls = 0;
	const media = {
		toString() {
			calls++;
			return "text/plain";
		},
		[Symbol.toPrimitive]() {
			calls++;
			return "text/plain";
		},
	};
	const file = attachment();
	const output = normalizeDraftContent({
		...email(),
		attachments: [{ ...file, contentType: media }],
	});
	expect(output.channel).toBe("email");
	if (output.channel !== "email") throw new Error("DYTEST email expected");
	expect(output.attachments).toEqual([{ ...file, contentType: "application/octet-stream" }]);
	expect(calls).toBe(0);
});
