import { types } from "node:util";
import { CliRefusal } from "./refusal.ts";

export interface ArgvLimits {
	readonly count: 256;
	readonly argumentBytes: 65536;
	readonly totalBytes: 262144;
}
export const ARGV_LIMITS: ArgvLimits = Object.freeze({
	count: 256,
	argumentBytes: 65536,
	totalBytes: 262144,
});

export function snapshotArgv(raw: unknown): readonly string[] {
	if (types.isProxy(raw) || !Array.isArray(raw)) throw new CliRefusal();
	const length: unknown = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (typeof length !== "number" || length > ARGV_LIMITS.count) throw new CliRefusal();
	const result: string[] = [];
	let total = 0;
	for (let index = 0; index < length; index++) {
		const member = Object.getOwnPropertyDescriptor(raw, String(index));
		if (!member || !("value" in member) || typeof member.value !== "string") throw new CliRefusal();
		const value: string = member.value;
		if (!value.isWellFormed() || value.includes("\0")) throw new CliRefusal();
		const bytes = Buffer.byteLength(value, "utf8");
		total += bytes;
		if (bytes > ARGV_LIMITS.argumentBytes || total > ARGV_LIMITS.totalBytes) throw new CliRefusal();
		result.push(value);
	}
	return Object.freeze(result);
}
