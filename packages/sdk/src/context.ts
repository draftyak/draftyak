import type { LookupPermit } from "@draftyak/protocol/host-channel";
import { type HostFetch, hostFetch } from "./fetch.ts";
import type { HostChannel } from "./host.ts";

export interface PluginInstance {
	readonly id: string;
	readonly config: Readonly<Record<string, unknown>>;
}

export interface HostSocket {
	readonly id: string;
	sendAck(envelopeId: string): Promise<void>;
	subscribe(listener: (data: string) => void): () => void;
	close(): Promise<void>;
}
export interface PluginContext {
	readonly plugin: string;
	readonly account?: string;
	readonly instance?: PluginInstance;
	readonly signal: AbortSignal;
	readonly fetch: HostFetch;
	readonly ws: { open(url: string): Promise<HostSocket> };
	readonly kv: {
		get(key: string): Promise<unknown>;
		set(key: string, value: unknown): Promise<void>;
		delete(key: string): Promise<void>;
	};
	changed(cursor?: string): Promise<void>;
	log(level: "debug" | "info" | "warn" | "error", message: string): Promise<void>;
	progress(token: string | number, progress: number, total?: number): Promise<void>;
}
export interface ContextIdentity {
	readonly plugin: string;
	readonly account?: string;
	readonly instance?: PluginInstance;
}

export function createPluginContext(
	identity: ContextIdentity,
	host: HostChannel,
	signal: AbortSignal = new AbortController().signal,
	// Internal serving plumbing; only the parent can authorize a presented grant.
	lookupScope?: Readonly<{ lookupPermit?: LookupPermit }>,
): PluginContext {
	return Object.freeze({
		plugin: identity.plugin,
		...(identity.account ? { account: identity.account } : {}),
		...(identity.instance ? { instance: identity.instance } : {}),
		signal,
		fetch: hostFetch(host, signal, lookupScope),
		ws: Object.freeze({
			async open(url: string): Promise<HostSocket> {
				const { socketId: id } = await host.request("host/ws.open", { url }, { signal });
				return Object.freeze({
					id,
					async sendAck(envelopeId: string): Promise<void> {
						await host.request("host/ws.send", { socketId: id, envelopeId }, { signal });
					},
					subscribe(listener: (data: string) => void): () => void {
						return host.subscribe((event) => {
							if (event.method === "host/ws.message" && event.params.socketId === id)
								listener(event.params.data);
						});
					},
					async close(): Promise<void> {
						await host.request("host/ws.close", { socketId: id }, { signal });
					},
				});
			},
		}),
		kv: Object.freeze({
			async get(key: string): Promise<unknown> {
				return (await host.request("host/kv.get", { key }, { signal })).value;
			},
			async set(key: string, value: unknown): Promise<void> {
				await host.request("host/kv.set", { key, value }, { signal });
			},
			async delete(key: string): Promise<void> {
				await host.request("host/kv.delete", { key }, { signal });
			},
		}),
		async changed(cursor?: string): Promise<void> {
			await host.request("host/changed", cursor === undefined ? {} : { cursor }, { signal });
		},
		async log(level: "debug" | "info" | "warn" | "error", message: string): Promise<void> {
			await host.request("host/log", { level, message }, { signal });
		},
		async progress(token: string | number, progress: number, total?: number): Promise<void> {
			await host.request(
				"host/progress",
				{ token, progress, ...(total === undefined ? {} : { total }) },
				{ signal },
			);
		},
	});
}
