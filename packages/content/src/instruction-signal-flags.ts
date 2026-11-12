import { types } from "node:util";
import { type Flag, Flags } from "@draftyak/protocol/flags";
import type { HygieneResult } from "./hygiene.ts";

export type InstructionSignalFlags =
	| { status: "classified"; flags: readonly Flag[] }
	| { status: "refused"; code: "INVALID_INPUT" };

/** Project supplied signal DATA only; this does not detect instructions or verify their source. */
export function classifyInstructionSignalFlags(
	signal: Pick<HygieneResult, "suspectedInstructions">,
): InstructionSignalFlags {
	try {
		if (!signal || typeof signal !== "object" || types.isProxy(signal) || Array.isArray(signal))
			return { status: "refused", code: "INVALID_INPUT" };
		const prototype = Object.getPrototypeOf(signal);
		if (prototype !== null && prototype !== Object.prototype)
			return { status: "refused", code: "INVALID_INPUT" };
		const descriptor = Object.getOwnPropertyDescriptor(signal, "suspectedInstructions");
		if (!descriptor || !("value" in descriptor))
			return { status: "refused", code: "INVALID_INPUT" };
		const value: unknown = descriptor.value;
		if (typeof value !== "boolean") return { status: "refused", code: "INVALID_INPUT" };
		const flags: Flag[] = value ? [{ code: "SUSPECTED_INSTRUCTIONS", severity: "advisory" }] : [];
		return { status: "classified", flags: Flags.parse(flags) };
	} catch {
		return { status: "refused", code: "INVALID_INPUT" };
	}
}
