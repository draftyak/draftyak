import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { createFake, type Fake, RESERVED_PORTS } from "../server.ts";
import { ConnectorClientError, data, refused, syntheticUrl, text } from "./data.ts";

export interface NodeConnectorTransportOptions {
	readonly issuer: string;
	/** An already running test server, addressed by an exact numeric loopback literal and port. */
	readonly origin: string;
}

/** Adapts a Node-bound test server without DNS, external fetch, or redirect following. */
export function createNodeConnectorTransport(raw: NodeConnectorTransportOptions): Fake {
	const options = data(raw, ["issuer", "origin"]);
	const issuer = syntheticUrl(text(options.issuer) + "/").slice(0, -1);
	if (issuer !== options.issuer || new URL(issuer).origin !== issuer) refused();
	const rawOrigin = text(options.origin);
	if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(rawOrigin)) refused();
	const origin = new URL(rawOrigin);
	const port = Number(origin.port);
	if (origin.origin !== rawOrigin || port > 65535 || RESERVED_PORTS.has(port)) refused();
	const hostname = origin.hostname === "[::1]" ? "::1" : "127.0.0.1";
	const host = new URL(issuer).host;
	return createFake(
		{
			async fetch(request) {
				try {
					const target = new URL(request.url);
					if (
						target.origin !== issuer ||
						target.hash !== "" ||
						target.username !== "" ||
						target.password !== ""
					)
						refused();
					const body = Buffer.from(await request.arrayBuffer());
					if (body.byteLength > 65536) refused();
					request.signal.throwIfAborted();
					const headers: Record<string, string> = {
						host,
						"x-forwarded-host": host,
						"x-forwarded-proto": "https",
						"content-length": String(body.byteLength),
					};
					for (const name of ["accept", "authorization", "content-type"] as const) {
						const value = request.headers.get(name);
						if (value !== null) headers[name] = value;
					}
					return await new Promise<Response>((resolve, reject) => {
						const outgoing = httpRequest(
							{
								hostname,
								family: hostname === "::1" ? 6 : 4,
								port,
								method: request.method,
								path: target.pathname + target.search,
								headers,
								agent: false,
								signal: request.signal,
							},
							(incoming) => {
								try {
									const responseHeaders = new Headers();
									for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
										const name = incoming.rawHeaders[index];
										const value = incoming.rawHeaders[index + 1];
										if (name !== undefined && value !== undefined)
											responseHeaders.append(name, value);
									}
									const status = incoming.statusCode ?? 500;
									const noBody = request.method === "HEAD" || [204, 205, 304].includes(status);
									if (noBody) incoming.resume();
									resolve(
										new Response(
											noBody ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
											{ status, headers: responseHeaders },
										),
									);
								} catch (error) {
									incoming.destroy();
									reject(error);
								}
							},
						);
						outgoing.once("error", reject);
						outgoing.end(body);
					});
				} catch {
					throw new ConnectorClientError();
				}
			},
		},
		{ host, maxRequestBodyBytes: 65536 },
	);
}
