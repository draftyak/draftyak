import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	attachHostChannel,
	createChannelDecoder,
	encodeChannelMessage,
	type HostViolation,
	MAX_MESSAGE_BYTES,
} from "../src/host-channel.ts";

function decode(framed: boolean, chunks: readonly Uint8Array[]) {
	const messages: Record<string, unknown>[] = [];
	const violations: HostViolation[] = [];
	const decoder = createChannelDecoder({
		framed,
		onMessage: (message) => messages.push(message),
		onViolation: (violation) => violations.push(violation),
	});
	for (const chunk of chunks) decoder.push(chunk);
	return { messages, violations };
}

function header(flags: number, length: number, reserved = 0): Buffer {
	const head = Buffer.alloc(16);
	head.writeUInt32LE(flags, 0);
	head.writeUInt32LE(length, 8);
	head.writeUInt32LE(reserved, 12);
	return head;
}

const one = { jsonrpc: "2.0", method: "host/log", params: { text: "é€👍" } };
const two = { jsonrpc: "2.0", id: 7, result: null };
const bytes = (text: string): Buffer => Buffer.from(text, "utf8");
const byteByByte = (buffer: Buffer): Buffer[] => [...buffer].map((b) => Buffer.from([b]));

describe("createChannelDecoder", () => {
	for (const framed of [false, true]) {
		it(`decodes messages however the pipe splits them (${framed ? "framed" : "lines"})`, () => {
			const stream = Buffer.concat([
				encodeChannelMessage(one, framed),
				encodeChannelMessage(two, framed),
			]);
			expect(decode(framed, [stream]).messages).toEqual([one, two]);
			expect(decode(framed, byteByByte(stream))).toEqual({ messages: [one, two], violations: [] });
		});
	}

	it.for([
		["not json\n", "parse-error"],
		["\n", "parse-error"],
		["[1,2]\n", "not-jsonrpc"],
		['{"id":1,"result":2}\n', "not-jsonrpc"],
		['{"cmd":"NODE_HANDLE","type":"net.Socket"}\n', "handle"],
		['{"cmd":"NODE_HANDLE_ACK"}\n', "internal-message"],
		['{"cmd":"NODE_x-y","jsonrpc":"2.0"}\n', "internal-message"],
	] as const)("ends on %j as %s", ([line, kind]) => {
		const { messages, violations } = decode(false, [bytes(line), encodeChannelMessage(one, false)]);
		expect(violations.map((v) => v.kind)).toEqual([kind]);
		expect(messages).toEqual([]);
	});

	it("names Node's internal commands only by their protocol token", () => {
		const { violations } = decode(false, [bytes('{"cmd":"NODE_secret value"}\n')]);
		expect(violations).toEqual([{ kind: "internal-message", detail: "NODE_*" }]);
	});

	it("refuses invalid UTF-8", () => {
		const bad = Buffer.concat([
			bytes('{"jsonrpc":"2.0","method":"'),
			Buffer.from([0xc3, 0x28]),
			bytes('"}\n'),
		]);
		expect(decode(false, [bad]).violations.map((v) => v.kind)).toEqual(["parse-error"]);
	});

	it("caps a message, framed or not, and an unterminated line", () => {
		const big = bytes(`${"x".repeat(MAX_MESSAGE_BYTES + 1)}`);
		expect(decode(false, [big]).violations.map((v) => v.kind)).toEqual(["oversize"]);
		expect(decode(true, [header(1, MAX_MESSAGE_BYTES + 1)]).violations).toEqual([
			{ kind: "oversize", detail: "frame" },
		]);
		const piece = Buffer.concat([header(1, 65536), Buffer.alloc(65536, 0x78)]);
		const frames = Array.from({ length: 17 }, () => piece);
		expect(decode(true, frames).violations).toEqual([{ kind: "oversize", detail: "message" }]);
	});

	it.for([
		[0x10, 0, "bad-frame"],
		[0x0, 0, "bad-frame"],
		[0x1, 1, "bad-frame"],
		[0x3, 0, "handle"],
		[0x7, 0, "handle"],
		[0x4, 0, "handle"],
	] as const)("refuses frame flags %i (reserved %i) as %s", ([flags, reserved, kind]) => {
		const frame = Buffer.concat([header(flags, 0, reserved), encodeChannelMessage(one, true)]);
		expect(decode(true, [frame]).violations.map((v) => v.kind)).toEqual([kind]);
	});

	it("reads unframed bytes as a bad header on Windows", () => {
		expect(decode(true, [bytes("this is not json\n")]).violations).toEqual([
			{ kind: "bad-frame", detail: "header" },
		]);
	});
});

class FakeChild extends EventEmitter {
	readonly kills: string[] = [];
	readonly written: Buffer[] = [];
	exitCode: number | null = null;
	signalCode: string | null = null;
	readonly pipe: Duplex;
	readonly stdio: unknown[];
	constructor() {
		super();
		this.pipe = new Duplex({
			read() {},
			write: (chunk: Buffer, _encoding, done) => {
				this.written.push(chunk);
				done();
			},
		});
		this.stdio = [null, null, null, this.pipe];
	}
	kill(signal: string): boolean {
		this.kills.push(signal);
		return true;
	}
	feed(message: unknown): void {
		this.pipe.push(encodeChannelMessage(message, false));
	}
	replies(): Record<string, unknown>[] {
		return decode(false, this.written).messages;
	}
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

function attached(options: Parameters<typeof attachHostChannel>[1] = {}) {
	const child = new FakeChild();
	const channel = attachHostChannel(child as never, { framed: false, ...options });
	return { child, channel };
}

describe("attachHostChannel", () => {
	it("answers host/fetch with the broker's verdict and audits it", async () => {
		const { child, channel } = attached();
		child.feed({
			jsonrpc: "2.0",
			id: 1,
			method: "host/fetch",
			params: { url: "http://[::1]:9229/" },
		});
		await tick();
		expect(channel.audit).toEqual([{ allow: false, reason: "inspector-port", port: 9229 }]);
		expect(child.replies()).toEqual([
			{
				jsonrpc: "2.0",
				id: 1,
				error: {
					code: -32001,
					message: "egress denied",
					data: { reason: "inspector-port", port: 9229 },
				},
			},
		]);
	});

	it("SIGKILLs on the first violation and dispatches nothing after it", async () => {
		const { child, channel } = attached();
		child.feed({ cmd: "NODE_HANDLE_ACK" });
		child.feed({
			jsonrpc: "2.0",
			id: 2,
			method: "host/fetch",
			params: { url: "https://example.com/" },
		});
		await tick();
		expect(child.kills).toEqual(["SIGKILL"]);
		expect(channel.violations).toEqual([{ kind: "internal-message", detail: "NODE_HANDLE_ACK" }]);
		expect(channel.closed).toBe(true);
		expect(channel.audit).toEqual([]);
		expect(child.pipe.destroyed).toBe(true);
	});

	it("drops a reply to a plugin that has exited instead of throwing", async () => {
		let release: () => void = () => {};
		const { child, channel } = attached({
			onRequest: () => new Promise((resolve) => (release = () => resolve("late"))),
		});
		child.feed({ jsonrpc: "2.0", id: 3, method: "host/kv.get" });
		await tick();
		child.emit("exit", 0, null);
		release();
		await tick();
		expect(channel.droppedWrites).toBe(1);
		expect(child.replies()).toEqual([]);
	});

	it("refuses to write once the pipe is gone, and survives its errors", async () => {
		const { child, channel } = attached();
		child.pipe.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
		child.pipe.destroy();
		await tick();
		expect(channel.notify("host/changed", {})).toBe(false);
		await expect(channel.request("plugin/ping")).rejects.toThrow();
	});

	it("matches the plugin's reply to a hub request", async () => {
		const { child, channel } = attached();
		const reply = channel.request("plugin/echo", { ping: 1 }, 1_000);
		await tick();
		const [sent] = child.replies();
		child.feed({ jsonrpc: "2.0", id: sent?.id, result: { echoed: { ping: 1 } } });
		await expect(reply).resolves.toMatchObject({ result: { echoed: { ping: 1 } } });
	});
});
