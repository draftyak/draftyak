import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (request: Request) => Response | Promise<Response>;

export interface Served {
	readonly url: string;
	close(): Promise<void>;
}

// A fetch-style handler on 127.0.0.1:<random>. Response bodies stream as they are produced, and a
// body that errors drops the connection mid-response, as a failing upstream would. Every response
// closes its connection: on a loaded machine a client could otherwise reuse a kept-alive socket just
// as the server's 5 s keep-alive timeout closes it, and the request would fail.
export async function serve(handler: Handler): Promise<Served> {
	const server = createServer(async (incoming, outgoing) => {
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(chunk as Buffer);
		const headers = new Headers();
		for (const [name, value] of Object.entries(incoming.headers)) {
			for (const item of [value ?? []].flat()) headers.append(name, item);
		}
		const method = incoming.method ?? "GET";
		const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
			method,
			headers,
			...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
		});
		let response: Response;
		try {
			response = await handler(request);
		} catch (error) {
			response = new Response(String(error), { status: 500 });
		}
		outgoing.statusCode = response.status;
		response.headers.forEach((value, name) => {
			outgoing.setHeader(name, value);
		});
		outgoing.setHeader("connection", "close");
		try {
			for await (const chunk of response.body ?? []) {
				await new Promise((resolve) => outgoing.write(chunk, resolve));
			}
			outgoing.end();
		} catch {
			outgoing.destroy();
		}
	});
	// A failed listen (no ports left, ENOBUFS) fails the test at once instead of at its timeout.
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject).listen({ host: "127.0.0.1", port: 0 }, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

export const json = (
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

export async function form(request: Request): Promise<URLSearchParams> {
	return new URLSearchParams(await request.text());
}
