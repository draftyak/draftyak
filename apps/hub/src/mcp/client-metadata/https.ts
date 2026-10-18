import { Agent, type RequestOptions, request } from "node:https";
import { isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import { canonicalAddress, type PinnedAddress, publicAddress } from "./addresses.ts";
import { metadataCacheTtl } from "./cache.ts";
import { CIMD_TIMEOUT_MS, metadataMaxBytes } from "./limits.ts";
import { type MetadataDestination, metadataUrl, refused } from "./policy.ts";

const RESPONSE_BLOCK_BYTES = 65_536;

export interface MetadataBytes {
	readonly body: Uint8Array;
	readonly contentType: string;
}
interface PinnedMetadataBytes extends MetadataBytes {
	readonly cacheExpiresAt: number;
}
export interface PinnedMetadataRequest {
	readonly destination: MetadataDestination;
	readonly address: PinnedAddress;
	readonly maxBytes: number;
	readonly signal: AbortSignal;
}
/** GET only, no supplied headers or credentials, no redirects, pooled sockets or environment proxy. */
export async function getPinnedMetadata(
	input: PinnedMetadataRequest,
): Promise<PinnedMetadataBytes> {
	const started = performance.now();
	const destination = metadataUrl(input.destination.url, input.destination.kind);
	const maxBytes = metadataMaxBytes(destination.kind, input.maxBytes);
	if (
		destination.host !== input.destination.host ||
		destination.path !== input.destination.path ||
		!publicAddress(input.address.address) ||
		isIP(input.address.address) !== input.address.family ||
		!Number.isFinite(started) ||
		started < 0
	)
		throw refused();
	const timeout = new AbortController(),
		signal = AbortSignal.any([input.signal, timeout.signal]),
		deadline = destination.kind === "cimd" ? started + CIMD_TIMEOUT_MS : Infinity;
	const expired = () => signal.aborted || performance.now() >= deadline;
	const timer =
		destination.kind === "cimd"
			? setTimeout(() => timeout.abort(), Math.max(0, deadline - performance.now()))
			: undefined;
	const agent = new Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0, proxyEnv: {} });
	try {
		return await new Promise<PinnedMetadataBytes>((resolve, reject) => {
			const blocks: Buffer[] = [];
			let bytes = 0,
				offset = 0,
				allocated = 0;
			const clear = () => {
				blocks.length = 0;
				bytes = 0;
				offset = 0;
				allocated = 0;
			};
			let settled = false;
			const fail = () => {
				if (!settled) {
					settled = true;
					clear();
					reject(refused());
				}
			};
			const options: RequestOptions & { autoSelectFamily: false } = {
				protocol: "https:",
				hostname: input.destination.host,
				port: 443,
				path: input.destination.path,
				method: "GET",
				agent,
				family: input.address.family,
				autoSelectFamily: false,
				servername: input.destination.host,
				rejectUnauthorized: true,
				minVersion: "TLSv1.2",
				maxHeaderSize: 16384,
				headers: {
					Host: input.destination.host,
					Accept: "application/json, application/jwk-set+json",
					"Accept-Encoding": "identity",
					Connection: "close",
				},
				lookup: (_host, lookupOptions, callback) =>
					lookupOptions.all
						? callback(null, [{ address: input.address.address, family: input.address.family }])
						: callback(null, input.address.address, input.address.family),
			};
			const req = request(options, (response) => {
				const one = (name: string): string | undefined => {
					const values: string[] = [];
					for (let i = 0; i < response.rawHeaders.length; i += 2)
						if (response.rawHeaders[i]?.toLowerCase() === name)
							values.push(response.rawHeaders[i + 1] ?? "");
					if (values.length > 1) throw refused();
					return values[0];
				};
				let length: number | undefined, contentType: string;
				const stop = () => {
					fail();
					response.destroy();
					req.destroy();
				};
				try {
					contentType = one("content-type") ?? "";
					const type = contentType.split(";")[0]?.toLowerCase();
					const encoding = one("content-encoding"),
						rawLength = one("content-length");
					if (
						response.statusCode !== 200 ||
						(type !== "application/json" &&
							!(input.destination.kind === "jwks" && type === "application/jwk-set+json")) ||
						!/^application\/(?:json|jwk-set\+json)(?:;[ \t]*charset=(?:utf-8|"utf-8"))?$/i.test(
							contentType,
						) ||
						(encoding !== undefined && encoding.toLowerCase() !== "identity")
					)
						throw refused();
					if (rawLength !== undefined) {
						if (!/^(0|[1-9][0-9]{0,9})$/.test(rawLength)) throw refused();
						length = Number(rawLength);
						if (length > maxBytes) throw refused();
					}
				} catch {
					stop();
					return;
				}
				response.on("data", (chunk: Buffer) => {
					if (settled) return;
					if (chunk.byteLength > maxBytes - bytes || expired()) {
						stop();
						return;
					}
					bytes += chunk.byteLength;
					let at = 0;
					while (at < chunk.byteLength) {
						if (blocks.length === 0 || offset === blocks[blocks.length - 1]?.byteLength) {
							const capacity = Math.min(RESPONSE_BLOCK_BYTES, maxBytes - allocated);
							blocks.push(Buffer.allocUnsafe(capacity));
							allocated += capacity;
							offset = 0;
						}
						const block = blocks[blocks.length - 1] as Buffer;
						const take = Math.min(chunk.byteLength - at, block.byteLength - offset);
						chunk.copy(block, offset, at, at + take);
						at += take;
						offset += take;
					}
				});
				response.once("error", fail);
				response.once("aborted", fail);
				response.once("end", () => {
					if (settled) return;
					const finished = performance.now();
					if (
						!response.complete ||
						signal.aborted ||
						!Number.isFinite(finished) ||
						finished < started ||
						finished >= deadline ||
						(length !== undefined && length !== bytes)
					) {
						stop();
						return;
					}
					try {
						const result = Object.freeze({
							body: Buffer.concat(blocks, bytes),
							contentType,
							cacheExpiresAt:
								finished + metadataCacheTtl(response.rawHeaders, Date.now(), finished - started),
						});
						settled = true;
						resolve(result);
					} catch {
						stop();
					} finally {
						clear();
					}
				});
			});
			const abort = () => {
				fail();
				req.destroy();
			};
			signal.addEventListener("abort", abort, { once: true });
			req.once("error", fail);
			req.once("close", () => {
				signal.removeEventListener("abort", abort);
				// A successful response ends before request close; every earlier close must settle too.
				fail();
			});
			req.once("socket", (socket) => {
				const tls = socket as TLSSocket;
				tls.once("secureConnect", () => {
					try {
						if (
							expired() ||
							!tls.authorized ||
							tls.remoteAddress === undefined ||
							canonicalAddress(tls.remoteAddress) !== canonicalAddress(input.address.address)
						)
							throw refused();
						req.end();
					} catch {
						abort();
					}
				});
			});
			if (expired()) abort();
		});
	} catch {
		throw refused();
	} finally {
		clearTimeout(timer);
		agent.destroy();
	}
}
