import { statSync } from "node:fs";
import path from "node:path";

export type NativeStore = "windows" | "secret-service" | "macos";
export interface Selection {
	readonly store: NativeStore;
	readonly strict: boolean;
	readonly required: readonly ("cargo" | "node" | "docker")[];
}

/** Required native coverage is selected before Vitest applies any file, name or tag filter. */
export function selectStore(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Selection {
	const raw = env.DRAFTYAK_STRICT_SKIPS ?? "";
	if (!["", "0", "1"].includes(raw)) throw new Error("Invalid strict-skip setting");
	const store =
		platform === "win32"
			? "windows"
			: platform === "linux"
				? "secret-service"
				: platform === "darwin"
					? "macos"
					: undefined;
	if (store === undefined) throw new Error("Unsupported native-store test platform");
	const ci = env.CI !== undefined && !["", "0", "false"].includes(env.CI);
	return Object.freeze({
		store,
		strict: ci || raw === "1",
		required: Object.freeze(
			store === "secret-service"
				? (["cargo", "node", "docker"] as const)
				: (["cargo", "node"] as const),
		),
	});
}

export function findExecutable(
	name: "cargo" | "docker",
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
	isFile: (file: string) => boolean = (file) => {
		try {
			return statSync(file).isFile();
		} catch {
			return false;
		}
	},
): string | undefined {
	const delimiter = platform === "win32" ? ";" : ":";
	const api = platform === "win32" ? path.win32 : path.posix;
	return (env.PATH ?? env.Path ?? "")
		.split(delimiter)
		.filter((directory) => api.isAbsolute(directory))
		.map((directory) => api.join(directory, name + (platform === "win32" ? ".exe" : "")))
		.find(isFile);
}

export type CapabilityProbes = Readonly<
	Record<"cargo" | "node" | "docker", () => boolean | Promise<boolean>>
>;

export async function preflight(selection: Selection, probes: CapabilityProbes): Promise<void> {
	for (const name of selection.required) {
		if (!(await probes[name]()))
			throw new Error(`Required native-store test capability unavailable: ${name}`);
	}
}
