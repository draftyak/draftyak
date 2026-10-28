import { Agent, request } from "node:http";
import { MCP_MAX_REQUEST_BYTES } from "@draftyak/protocol/mcp";
import { BridgeRefusal, localEndpoint } from "./credentials.ts";

/** A private direct agent has no environment-proxy configuration or redirect handling. */
export class LocalHttp {
	readonly #agent = new Agent({ keepAlive: true, maxSockets: 8, maxTotalSockets: 8 });
	readonly #endpoint: URL;
	readonly #shutdown = new AbortController();
	constructor(endpoint: string) {
		this.#endpoint = localEndpoint(endpoint);
	}
	async post(
		headers: Record<string, string>,
		body: Buffer,
		signal?: AbortSignal,
	): Promise<{
		status: number;
		body: Buffer;
	}> {
		if (body.length > MCP_MAX_REQUEST_BYTES || this.#shutdown.signal.aborted)
			throw new BridgeRefusal();
		const abort = AbortSignal.any([
			this.#shutdown.signal,
			AbortSignal.timeout(10_000),
			...(signal ? [signal] : []),
		]);
		return await new Promise((resolve, reject) => {
			const sent = request(
				this.#endpoint,
				{
					method: "POST",
					agent: this.#agent,
					signal: abort,
					maxHeaderSize: 16_384,
					headers: { ...headers, "content-length": String(body.length) },
				},
				(reply) => {
					reply.on("error", () => reject(new BridgeRefusal()));
					const contentType = reply.headers["content-type"]?.split(";", 1)[0]?.trim();
					if (reply.statusCode === 401 || reply.statusCode === 202) {
						reply.destroy();
						resolve({ status: reply.statusCode, body: Buffer.alloc(0) });
						return;
					}
					if (contentType !== "application/json") {
						reply.destroy();
						reject(new BridgeRefusal());
						return;
					}
					let size = 0;
					const chunks: Buffer[] = [];
					reply.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > MCP_MAX_REQUEST_BYTES) {
							reply.destroy(new BridgeRefusal());
							return;
						}
						chunks.push(chunk);
					});
					reply.on("end", () =>
						resolve({ status: reply.statusCode ?? 0, body: Buffer.concat(chunks) }),
					);
				},
			);
			sent.on("error", () => reject(new BridgeRefusal()));
			sent.end(body);
		});
	}
	close(): void {
		this.#shutdown.abort();
		this.#agent.destroy();
	}
}
