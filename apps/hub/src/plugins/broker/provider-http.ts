import type { ClientRequest } from "node:http";
import { request } from "node:https";
import {
	HOST_MAX_ACTIVE_REQUESTS,
	HOST_MAX_HEADER_BYTES,
	HOST_REQUEST_TIMEOUT_MS,
	HostFetchResult,
	HostHeaders,
} from "@draftyak/protocol/host-channel";
import type { AiProfile } from "@draftyak/protocol/manifest/ai-http";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { Ulid } from "@draftyak/protocol/scalars";
import { type CredentialBinding, CredentialVault } from "../../credentials/vault.ts";
import { fields } from "./ai/boundary.ts";
import {
	type AiProfileRegistry,
	type AiRequestSnapshot,
	aiRequestEndpoint,
	captureAiRequestInputs,
	snapshotVerifiedAiRequest,
	verifyCapturedAiRequest,
} from "./ai/index.ts";
import {
	captureEgressPolicy,
	createPinnedHttpsConnection,
	type EgressPolicy,
	type PinnedAddress,
	resolveEgressAnswers,
	validateEgressAnswers,
} from "./network/index.ts";

export class ProviderHttpError extends Error {
	readonly code = "PROVIDER_HTTP_REFUSED";
	constructor() {
		super("Provider request unavailable");
	}
}
const refused = (): ProviderHttpError => new ProviderHttpError();
const useCredential = CredentialVault.prototype.withCredential;

export interface ProviderHttpBroker {
	/** Native invocation data, never fields accepted from a plugin's host/fetch frame. */
	execute(
		profile: AiProfile,
		candidate: unknown,
		binding: unknown,
		reference: string,
		credential: CredentialBinding,
		signal: AbortSignal,
	): Promise<HostFetchResult>;
	close(): void;
}

function outboundHeaders(verified: AiRequestSnapshot, key: string): Record<string, string> {
	if (!key || key.length > 8192 || !/^[!-~]+$/.test(key)) throw refused();
	const headers: Record<string, string> = Object.create(null);
	for (const [name, value] of verified.headers) headers[name.toLowerCase()] = value;
	if (verified.profile === "messages-api-v1") {
		if (headers["x-api-key"] !== "brokered" || headers.authorization !== undefined) throw refused();
		headers["x-api-key"] = key;
	} else if (verified.profile === "responses-api-v1") {
		if (headers.authorization !== "Bearer brokered" || headers["x-api-key"] !== undefined)
			throw refused();
		headers.authorization = `Bearer ${key}`;
	} else {
		if (headers.authorization !== undefined || headers["x-api-key"] !== undefined) throw refused();
		headers.authorization = `Bearer ${key}`;
	}
	// The host protocol transports decoded bytes. Do not admit an unbounded decompression path.
	headers["accept-encoding"] = "identity";
	return headers;
}

function fetchPinned(
	verified: AiRequestSnapshot,
	host: string,
	pin: PinnedAddress,
	policy: EgressPolicy,
	key: string,
	signal: AbortSignal,
): Promise<HostFetchResult> {
	const url = new URL(verified.url);
	if (url.protocol !== "https:" || url.username || url.password || url.hash) throw refused();
	const headers = outboundHeaders(verified, key);
	const connection = createPinnedHttpsConnection(host, Number(url.port || 443), pin, policy);
	return new Promise((resolve, reject) => {
		let settled = false;
		let req: ClientRequest | undefined;
		let length = 0;
		const chunks: Buffer[] = [];
		const fail = (): void => finish();
		function finish(result?: HostFetchResult): void {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", fail);
			req?.destroy();
			connection.destroy();
			for (const chunk of chunks) chunk.fill(0);
			chunks.length = 0;
			if (result) resolve(result);
			else reject(refused());
		}
		try {
			signal.throwIfAborted();
			signal.addEventListener("abort", fail, { once: true });
			req = request({
				...connection.options,
				method: verified.method,
				path: `${url.pathname}${url.search}`,
				headers: { ...headers, ...connection.options.headers },
			});
			req.once("error", fail);
			connection.guard(
				req,
				() => signal.aborted || settled,
				() => {
					if (signal.aborted || settled) return fail();
					req?.end(verified.body);
				},
				fail,
			);
			req.once("response", (response) => {
				try {
					if (settled || signal.aborted) return response.destroy();
					const status = response.statusCode;
					if (
						status === undefined ||
						status < 200 ||
						status >= 600 ||
						(status >= 300 && status < 400)
					)
						throw refused();
					if (
						response.headers["content-encoding"] &&
						response.headers["content-encoding"] !== "identity"
					)
						throw refused();
					if (
						response.rawHeaders.length > 128 ||
						Buffer.byteLength(response.rawHeaders.join("")) > HOST_MAX_HEADER_BYTES
					)
						throw refused();
					const selected: [string, string][] = [];
					const names = new Set<string>();
					for (let i = 0; i < response.rawHeaders.length; i += 2) {
						const name = response.rawHeaders[i]?.toLowerCase();
						const value = response.rawHeaders[i + 1];
						if (!name || value === undefined || value.includes(key)) throw refused();
						if (name !== "content-type" && name !== "retry-after") continue;
						if (names.has(name)) throw refused();
						names.add(name);
						selected.push([name, value]);
					}
					const safeHeaders = HostHeaders.parse(selected);
					response.once("aborted", fail);
					response.once("error", fail);
					response.on("data", (raw: Buffer) => {
						if (settled) return;
						if (signal.aborted || !Buffer.isBuffer(raw) || raw.length > MAX_INLINE_BYTES - length)
							return fail();
						length += raw.length;
						chunks.push(Buffer.from(raw));
					});
					response.once("end", () => {
						if (settled) return;
						let body: Buffer | undefined;
						try {
							if (!response.complete || signal.aborted) throw refused();
							body = Buffer.concat(chunks, length);
							if (body.includes(key)) throw refused();
							finish({
								status,
								headers: safeHeaders,
								body: { base64: body.toString("base64url") },
							});
						} catch {
							fail();
						} finally {
							body?.fill(0);
						}
					});
				} catch {
					response.destroy();
					fail();
				}
			});
		} catch {
			fail();
		}
	});
}

/**
 * Internal native composition. Installed-generation, account and prompt authority must be
 * established by the native invocation owner before binding this to a host channel.
 */
export function createProviderHttpBroker(options: {
	readonly registry: AiProfileRegistry;
	readonly vault: CredentialVault;
	readonly networkPolicy: EgressPolicy;
}): ProviderHttpBroker {
	const policy = captureEgressPolicy(options.networkPolicy);
	const registry = options.registry;
	const vault = options.vault;
	const active = new Set<AbortController>();
	let closed = false;
	return Object.freeze<ProviderHttpBroker>({
		async execute(profile, candidate, binding, reference, credential, signal) {
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const abort = (): void => controller.abort();
			try {
				if (closed || active.size >= HOST_MAX_ACTIVE_REQUESTS) throw refused();
				signal.throwIfAborted();
				// Capture all request and pinned prompt bytes before the first DNS/vault await.
				const captured = captureAiRequestInputs(candidate, binding);
				const url = new URL(aiRequestEndpoint(captured));
				if (url.protocol !== "https:") throw refused();
				// URL keeps IPv6 authority brackets; DNS and TLS require the canonical bare IP.
				const host =
					url.hostname.startsWith("[") && url.hostname.endsWith("]")
						? url.hostname.slice(1, -1)
						: url.hostname;
				const selectedCredential = fields(credential, ["ownerKind", "ownerId", "kind"]);
				if (
					selectedCredential.kind !== "provider-key" ||
					selectedCredential.ownerKind !== "provider" ||
					!Ulid.safeParse(selectedCredential.ownerId).success
				)
					throw refused();
				const capturedCredential: CredentialBinding = Object.freeze({
					ownerKind: "provider",
					ownerId: selectedCredential.ownerId as string,
					kind: "provider-key",
				});
				active.add(controller);
				signal.addEventListener("abort", abort, { once: true });
				timer = setTimeout(abort, HOST_REQUEST_TIMEOUT_MS);
				const answers = await resolveEgressAnswers(
					host,
					Number(url.port || 443),
					policy,
					controller.signal,
				);
				controller.signal.throwIfAborted();
				const verified = verifyCapturedAiRequest(registry, profile, captured, { answers, policy });
				const snapshot = snapshotVerifiedAiRequest(verified);
				const pin = validateEgressAnswers(answers, policy);
				const result = await useCredential.call(
					vault,
					reference,
					capturedCredential,
					{ requestClass: "read", signal: controller.signal },
					async (value, use) => {
						if (value.kind !== "provider-key") throw refused();
						return fetchPinned(
							snapshot,
							host,
							pin,
							policy,
							value.key,
							AbortSignal.any([controller.signal, use.signal]),
						);
					},
				);
				return HostFetchResult.parse(result);
			} catch {
				throw refused();
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				active.delete(controller);
				controller.abort();
			}
		},
		close(): void {
			closed = true;
			for (const controller of active) controller.abort();
		},
	});
}
