import type { Fake } from "@draftyak/fakes";
import type { HeaderList } from "@draftyak/protocol/hash";
import type { HostMethod } from "@draftyak/protocol/host-channel";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import type { SendTicket, TicketMismatch } from "@draftyak/protocol/send-ticket";
import type { HostChannel, PluginEntry } from "@draftyak/sdk";

export interface MockPlugin {
	readonly manifest: unknown;
	readonly entry: PluginEntry;
}
export interface MockAccount {
	readonly id: string;
	readonly mode: "read_only" | "full";
}
export interface MockHubOptions {
	readonly mode: "in-memory" | "process";
	readonly plugin: MockPlugin;
	readonly account?: MockAccount;
	readonly instance?:
		| string
		| { readonly id: string; readonly config?: Readonly<Record<string, unknown>> };
	readonly upstreams: readonly Fake[];
	readonly secrets?: Readonly<Record<string, string>>;
}
export interface RenderedRequest {
	readonly outboxId: string;
	readonly method: "POST" | "PUT" | "PATCH";
	readonly url: string;
	readonly headers: HeaderList;
	readonly body: Uint8Array;
	readonly mintedAt: number;
	readonly deliverBy: number;
}
export interface Denial {
	readonly sequence: number;
	readonly method: HostMethod | "unknown";
	readonly reason: string;
	readonly lookup: number | null;
}
export interface MockHost extends HostChannel {
	readonly denials: readonly Denial[];
	readonly logs: readonly { readonly level: string; readonly message: string }[];
	readonly progress: readonly {
		readonly token: string | number;
		readonly progress: number;
		readonly total?: number;
	}[];
	readonly disabled: boolean;
	readonly alerts: readonly { readonly reason: TicketMismatch }[];
	readonly auditComplete: boolean;
	/** Trusted test state only; never supplied to a plugin's context or metadata. */
	mintTicket(rendered: RenderedRequest): SendTicket;
	/** Seeds normative negative vectors, including deliberately invalid stored ticket metadata. */
	seedTicket(ticket: unknown, renderedHeaders: HeaderList): void;
	hasTicket(ticketId: string): boolean;
	/** Trusted test blob state, for the existing Bytes/ref interface; no disk storage. */
	putBlob(bytes: Uint8Array): { readonly ref: string };
	readBlob(ref: string): Uint8Array | undefined;
}
export interface MockHub {
	readonly host: MockHost;
	readonly manifest: PluginManifestV1;
	discover(): Promise<Record<string, unknown>>;
	listTools(): Promise<Record<string, unknown>>;
	call(
		name: string,
		args: Record<string, unknown>,
		meta?: Record<string, unknown>,
	): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}
export class MockHubError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`Mock hub: ${code}`);
		this.code = code;
	}
}
