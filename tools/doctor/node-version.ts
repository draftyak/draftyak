import { readFileSync } from "node:fs";

const refused = () => new Error("Runtime policy unavailable");
function parts(value: unknown): readonly [number, number, number] | undefined {
	if (typeof value !== "string" || value.length > 64) return undefined;
	const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
	if (!match || match[0].length !== value.length) return undefined;
	const result = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
	return result.every(Number.isSafeInteger) ? result : undefined;
}

/** Builtins only: the CLI checks this policy before loading diagnostics. */
export interface NodePolicy {
	readonly minimum: string;
	readonly classify: (version: unknown) => "full" | "unsupported";
}

export function loadNodePolicy(): NodePolicy {
	let value: { minimum?: string } | null;
	try {
		value = JSON.parse(
			readFileSync(new URL("../fetch-node/versions.json", import.meta.url), "utf8"),
		);
	} catch {
		throw refused();
	}
	const minimum = value?.minimum as string;
	const floor = parts(minimum);
	if (!floor || minimum.startsWith("v")) throw refused();
	return Object.freeze({
		minimum,
		classify(version: unknown): "full" | "unsupported" {
			const candidate = parts(version);
			if (!candidate) return "unsupported";
			for (const index of [0, 1, 2] as const) {
				if (candidate[index] > floor[index]) return "full";
				if (candidate[index] < floor[index]) return "unsupported";
			}
			return "full";
		},
	});
}

export function classifyNode(version: unknown): "full" | "unsupported" {
	return loadNodePolicy().classify(version);
}
