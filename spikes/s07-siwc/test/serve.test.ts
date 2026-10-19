import { Agent, request } from "node:http";
import { describe, expect, it } from "vitest";
import { serve } from "./serve.ts";

describe("the fakes' server", () => {
	it("closes each connection after its response, so a keep-alive client never reuses one", async () => {
		const served = await serve(() => new Response("ok"));
		const agent = new Agent({ keepAlive: true, maxSockets: 1 });
		try {
			const sockets = new Set<unknown>();
			for (let i = 0; i < 2; i += 1) {
				const answer = await new Promise<{ connection?: string; body: string }>(
					(resolve, reject) => {
						const outgoing = request(`${served.url}/x`, { agent }, (incoming) => {
							sockets.add(incoming.socket);
							let body = "";
							incoming.setEncoding("utf8").on("data", (chunk: string) => {
								body += chunk;
							});
							incoming.on("end", () => resolve({ connection: incoming.headers.connection, body }));
						});
						outgoing.on("error", reject).end();
					},
				);
				expect(answer).toEqual({ connection: "close", body: "ok" });
			}
			// A kept-alive socket would have carried both requests.
			expect(sockets.size).toBe(2);
		} finally {
			agent.destroy();
			await served.close();
		}
	});
});
