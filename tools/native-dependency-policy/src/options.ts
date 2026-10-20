import { isAbsolute } from "node:path";

export type Phase = "item" | "m4-gate";
export interface Options {
	readonly phase: Phase;
	readonly evidenceDirectory?: string;
}

export class UsageError extends Error {
	readonly code = "INVALID_ARGUMENTS";
	constructor() {
		super("native dependency policy arguments refused");
		this.name = "UsageError";
	}
}

/** The production command has no caller-selected authority or evidence inputs. */
export function parseArguments(values: readonly string[]): Options {
	const fail = (): never => {
		throw new UsageError();
	};
	if (values.length > 8 || values.some((value) => value.length > 4096 || value.includes("\0")))
		return fail();
	const args = values[0] === "--" ? values.slice(1) : values;
	if (args[0] !== "check") return fail();
	const seen = new Set<string>();
	let phase: Phase | undefined;
	let evidenceDirectory: string | undefined;
	for (let index = 1; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key || value === undefined || seen.has(key)) return fail();
		seen.add(key);
		switch (key) {
			case "--phase":
				if (value !== "item" && value !== "m4-gate") return fail();
				phase = value;
				break;
			case "--format":
				if (value !== "json") return fail();
				break;
			case "--evidence-dir":
				if (!isAbsolute(value)) return fail();
				evidenceDirectory = value;
				break;
			default:
				return fail();
		}
	}
	if (!phase) return fail();
	return { phase, ...(evidenceDirectory === undefined ? {} : { evidenceDirectory }) };
}
