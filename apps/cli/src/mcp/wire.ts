import type { McpParams } from "@draftyak/protocol/mcp";
import { BridgeRefusal } from "./credentials.ts";

export interface Message {
	readonly jsonrpc: "2.0";
	readonly id?: string | number;
	readonly method?: string;
	readonly params?: McpParams;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}
export interface Transport {
	onclose?: (() => void) | undefined;
	onerror?: ((error: Error) => void) | undefined;
	onmessage?: ((message: Message) => void) | undefined;
	start(): Promise<void>;
	send(message: Message): Promise<void>;
	close(): Promise<void>;
	release(id: string | number): void;
}
export function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function requestId(value: unknown): value is string | number {
	return (
		(typeof value === "string" && value.length <= 256) ||
		(typeof value === "number" && Number.isSafeInteger(value))
	);
}
/** The byte parser already supplies strict JSON; preserve params rather than schema-normalizing them. */
export function parseMessage(value: unknown): Message {
	if (
		!object(value) ||
		value.jsonrpc !== "2.0" ||
		typeof value.method !== "string" ||
		value.method.length > 128 ||
		!/^[A-Za-z][A-Za-z0-9/_]*$/.test(value.method) ||
		(Object.hasOwn(value, "id") && !requestId(value.id)) ||
		(value.params !== undefined && !object(value.params)) ||
		Object.keys(value).some((key) => !["jsonrpc", "id", "method", "params"].includes(key))
	)
		throw new BridgeRefusal();
	return value as unknown as Message;
}
