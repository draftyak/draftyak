import { isProxy } from "node:util/types";
import type { Fake } from "@draftyak/fakes";
import type { HeaderList } from "@draftyak/protocol/hash";
import { HOST_MAX_ACTIVE_REQUESTS, type HostMethod } from "@draftyak/protocol/host-channel";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import type { ResponsesHttpBindingInput } from "@draftyak/protocol/manifest/responses-http";
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
	/** Trusted constructor inputs for the Responses fixture comparison; never call metadata. */
	readonly responsesHttp?: readonly ResponsesHttpBindingInput[];
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
		options?: MockCallOptions,
	): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}
export interface MockProgressNotification {
	readonly jsonrpc: "2.0";
	readonly method: "notifications/progress";
	readonly params: {
		readonly progressToken: string | number;
		readonly progress: number;
		readonly total?: number;
	};
}
export interface MockCallOptions {
	/** Observes validated process-wire receipt, independently of private client handling. */
	readonly onProgress?: (notification: MockProgressNotification) => void;
}

export function copyMockCallOptions(
	options: MockCallOptions | undefined,
): MockCallOptions | undefined {
	if (options === undefined) return undefined;
	if (options === null || typeof options !== "object" || isProxy(options))
		throw new MockHubError("PROCESS_PROGRESS_INVALID");
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null)
		throw new MockHubError("PROCESS_PROGRESS_INVALID");
	const keys = Reflect.ownKeys(options);
	if (keys.some((key) => key !== "onProgress")) throw new MockHubError("PROCESS_PROGRESS_INVALID");
	const slot = Object.getOwnPropertyDescriptor(options, "onProgress");
	if (slot && !Object.hasOwn(slot, "value")) throw new MockHubError("PROCESS_PROGRESS_INVALID");
	const callback: unknown = slot?.value;
	if (callback !== undefined && typeof callback !== "function")
		throw new MockHubError("PROCESS_PROGRESS_INVALID");
	return callback === undefined
		? undefined
		: Object.freeze({ onProgress: callback as NonNullable<MockCallOptions["onProgress"]> });
}

/** Copies trusted binding inputs from own data properties without invoking caller hooks. */
export function copyResponsesHttpInputs(value: unknown): readonly ResponsesHttpBindingInput[] {
	const invalid: () => never = () => {
		throw new MockHubError("INVALID_RESPONSES_BINDINGS");
	};
	if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
		invalid();
	const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0 ||
		length > HOST_MAX_ACTIVE_REQUESTS ||
		Reflect.ownKeys(value).length !== length + 1
	)
		invalid();
	const inputs: ResponsesHttpBindingInput[] = [];
	for (let index = 0; index < length; index++) {
		const slot = Object.getOwnPropertyDescriptor(value, String(index));
		if (!slot?.enumerable || !Object.hasOwn(slot, "value")) invalid();
		inputs.push(slot.value);
	}
	return Object.freeze(inputs);
}
export class MockHubError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`Mock hub: ${code}`);
		this.code = code;
	}
}
