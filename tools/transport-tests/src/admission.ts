import path from "node:path";
import { findExecutable, preflight, type Selection, selectStore } from "./capabilities.ts";
import type { NativeContext } from "./native.ts";
import { requireSuccess } from "./outcome.ts";
import { type Runner, run } from "./run.ts";
import { cargoEnvironment } from "./suite.ts";

export interface Admission {
	readonly selection: Selection;
	readonly context: NativeContext;
}

/** Checks executable/daemon resources before Vitest can filter a selected native case away. */
export async function admitNative(
	root: string,
	platform: NodeJS.Platform = process.platform,
	environment: NodeJS.ProcessEnv = process.env,
	node: string = process.execPath,
	runner: Runner = run,
	find: typeof findExecutable = findExecutable,
): Promise<Admission> {
	if (!path.isAbsolute(root) || !path.isAbsolute(node))
		throw new Error("Absolute native test paths required");
	const selection = selectStore(platform, environment);
	const cargo = find("cargo", platform, environment);
	const docker =
		selection.store === "secret-service" ? find("docker", platform, environment) : undefined;
	const captured = cargoEnvironment(environment, undefined, node, platform);
	const probe = async (
		executable: string | undefined,
		args: readonly string[],
	): Promise<boolean> => {
		if (executable === undefined) return false;
		const result = await runner({ executable, args, cwd: root, env: captured, timeoutMs: 15_000 });
		try {
			requireSuccess(result);
			return true;
		} catch {
			return false;
		}
	};
	await preflight(selection, {
		cargo: () => probe(cargo, ["--version"]),
		node: () => probe(node, ["--version"]),
		docker: () =>
			probe(docker, [
				"--host",
				"unix:///var/run/docker.sock",
				"info",
				"--format",
				"{{.ServerVersion}}",
			]),
	});
	if (cargo === undefined)
		throw new Error("Required native-store test capability unavailable: cargo");
	return {
		selection,
		context: { root, cargo, node, docker, platform, environment: captured, runner },
	};
}
