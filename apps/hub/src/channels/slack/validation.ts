import { isProxy } from "node:util/types";

export type SlackCoreErrorCode = "INVALID_INPUT" | "TEXT_TOO_LONG" | "REQUEST_TOO_LARGE";

export class SlackCoreError extends Error {
	readonly code: SlackCoreErrorCode;
	constructor(code: SlackCoreErrorCode) {
		super(code);
		this.name = "SlackCoreError";
		this.code = code;
	}
}

export function invalid(code: SlackCoreErrorCode = "INVALID_INPUT"): never {
	throw new SlackCoreError(code);
}

export function data(value: unknown): Record<string, unknown> {
	try {
		if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) invalid();
		const prototype: unknown = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) invalid();
		const result: Record<string, unknown> = Object.create(null);
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") invalid();
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor)) invalid();
			result[key] = descriptor.value;
		}
		return result;
	} catch {
		return invalid();
	}
}

export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

export function text(value: unknown, maxUnits: number): string {
	if (typeof value !== "string" || value.length > maxUnits || !value.isWellFormed()) invalid();
	return value;
}

export function hasControls(value: string, allowLayout = false): boolean {
	for (let i = 0; i < value.length; i++) {
		const unit = value.charCodeAt(i);
		if ((unit < 32 && !(allowLayout && (unit === 9 || unit === 10))) || unit === 127) return true;
	}
	return false;
}

export function channelId(value: unknown): string {
	if (typeof value !== "string" || !/^[CDG][A-Z0-9]{2,31}$/.test(value)) invalid();
	return value;
}

export function slackTimestamp(value: unknown): string {
	if (typeof value !== "string" || !/^(0|[1-9]\d{0,11})\.\d{1,9}$/.test(value)) invalid();
	return value;
}

export function tsKey(value: string): bigint {
	const [seconds = "", fraction = ""] = slackTimestamp(value).split(".");
	return BigInt(seconds) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
}

export function integer(value: unknown, max: number = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
		invalid();
	return value;
}

export function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") invalid();
	return value;
}
