import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (request: Request) => Response | Promise<Response>;

export interface Served {
	readonly url: string;
	close(): Promise<void>;
}

// A fetch-style handler on 127.0.0.1:<random>. The Date header comes from `now`, so fakes control it.
export async function serve(handler: Handler, now: () => number = Date.now): Promise<Served> {
	const server = createServer(async (incoming, outgoing) => {
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(chunk as Buffer);
		const body = Buffer.concat(chunks);
		const headers = new Headers();
		for (const [name, value] of Object.entries(incoming.headers)) {
			for (const item of [value ?? []].flat()) headers.append(name, item);
		}
		const method = incoming.method ?? "GET";
		const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
			method,
			headers,
			...(method === "GET" || method === "HEAD" ? {} : { body }),
		});
		let response: Response;
		try {
			response = await handler(request);
		} catch (error) {
			response = new Response(String(error), { status: 500 });
		}
		outgoing.sendDate = false;
		outgoing.statusCode = response.status;
		outgoing.setHeader("date", new Date(now()).toUTCString());
		response.headers.forEach((value, name) => {
			outgoing.setHeader(name, value);
		});
		outgoing.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
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

export function json(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=UTF-8", ...headers },
	});
}
