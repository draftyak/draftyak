import type { Readable, Writable } from "node:stream";
import { parseStrict } from "@draftyak/protocol/jcs";
import { MCP_MAX_REQUEST_BYTES } from "@draftyak/protocol/mcp";
import { BridgeRefusal } from "./credentials.ts";
import { type Message, parseMessage, type Transport } from "./wire.ts";

/** Newline JSON with finite frame, output queue and outstanding request bounds. */
export class BoundedStdio implements Transport {
	onclose: Transport["onclose"];
	onerror: Transport["onerror"];
	onmessage: Transport["onmessage"];
	readonly #input: Readable;
	readonly #output: Writable;
	readonly #requests = new Set<string | number>();
	#pending = Buffer.alloc(0);
	#closed = false;
	#started = false;
	#queuedBytes = 0;
	readonly #writes = new Set<(error?: Error) => void>();
	readonly #completion = Promise.withResolvers<number>();
	#exit = 0;
	get completion(): Promise<number> {
		return this.#completion.promise;
	}
	constructor(input: Readable = process.stdin, output: Writable = process.stdout) {
		this.#input = input;
		this.#output = output;
	}
	readonly #fail = (): void => {
		if (this.#closed) return;
		this.#exit = 1;
		this.onerror?.(new BridgeRefusal());
		void this.close();
	};
	readonly #end = (): void => {
		if (this.#pending.length) {
			this.#exit = 1;
			this.onerror?.(new BridgeRefusal());
		}
		void this.close();
	};
	readonly #data = (chunk: Buffer): void => {
		try {
			if (this.#closed || !Buffer.isBuffer(chunk)) throw new BridgeRefusal();
			let start = 0;
			for (let index = 0; index < chunk.length; index++) {
				if (chunk[index] !== 10) continue;
				const part = chunk.subarray(start, index);
				if (this.#pending.length + part.length > MCP_MAX_REQUEST_BYTES) throw new BridgeRefusal();
				const message = parseMessage(parseStrict(Buffer.concat([this.#pending, part])));
				this.#pending = Buffer.alloc(0);
				if ("method" in message && message.id !== undefined) {
					if (this.#requests.size >= 32 || this.#requests.has(message.id))
						throw new BridgeRefusal();
					this.#requests.add(message.id);
				}
				this.onmessage?.(message);
				start = index + 1;
			}
			const rest = chunk.subarray(start);
			if (this.#pending.length + rest.length > MCP_MAX_REQUEST_BYTES) throw new BridgeRefusal();
			this.#pending = Buffer.concat([this.#pending, rest]);
		} catch {
			this.#fail();
		}
	};
	release(id: string | number): void {
		this.#requests.delete(id);
	}
	async start(): Promise<void> {
		if (this.#started || this.#closed) throw new BridgeRefusal();
		this.#started = true;
		this.#input.on("data", this.#data);
		this.#input.on("end", this.#end);
		this.#input.on("error", this.#fail);
		this.#output.on("error", this.#fail);
	}
	async send(message: Message): Promise<void> {
		const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
		if (
			this.#closed ||
			bytes.length > MCP_MAX_REQUEST_BYTES ||
			this.#queuedBytes + bytes.length > 2 * MCP_MAX_REQUEST_BYTES
		) {
			this.#fail();
			throw new BridgeRefusal();
		}
		this.#queuedBytes += bytes.length;
		try {
			await new Promise<void>((resolve, reject) => {
				const deadline = performance.now() + 10_000;
				let settled = false;
				const finish = (error?: Error): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					this.#writes.delete(finish);
					if (error || performance.now() > deadline) reject(new BridgeRefusal());
					else resolve();
				};
				const timer = setTimeout(() => finish(new BridgeRefusal()), 10_000);
				this.#writes.add(finish);
				try {
					this.#output.write(bytes, (error) => finish(error ?? undefined));
				} catch {
					finish(new BridgeRefusal());
				}
			});
			if (!("method" in message) && message.id !== undefined) this.#requests.delete(message.id);
		} catch {
			this.#fail();
			throw new BridgeRefusal();
		} finally {
			this.#queuedBytes -= bytes.length;
		}
	}
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#pending = Buffer.alloc(0);
		this.#requests.clear();
		const writing = this.#queuedBytes > 0;
		for (const finish of this.#writes) finish(new BridgeRefusal());
		if (writing) this.#output.destroy(new BridgeRefusal());
		this.#input.off("data", this.#data);
		this.#input.off("end", this.#end);
		this.#input.off("error", this.#fail);
		this.#input.pause();
		this.onclose?.();
		this.#completion.resolve(this.#exit);
	}
}
