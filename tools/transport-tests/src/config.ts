import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import type { Reporter, Vitest, VitestPluginContext } from "vitest/node";
import { heavyVitestConfig, vitestConfig } from "../../../vitest.shared.ts";
import type { Admission } from "./admission.ts";
import type { NativeStore } from "./capabilities.ts";
import { requireCompleteNativeRun } from "./native.ts";

export async function nativeConfig(
	env: ConfigEnv,
	admit: () => Promise<Admission>,
	names: (store: NativeStore) => readonly string[] | Promise<readonly string[]>,
): Promise<ViteUserConfig> {
	if (env.mode !== "heavy") return vitestConfig(env);
	// Admission is unconditional in this tier and precedes Vitest's file/name/tag filtering.
	const { selection } = await admit();
	const expected = await names(selection.store);
	const base = heavyVitestConfig(env, {
		docker: {
			description: "Required local Linux Docker daemon",
			detect: () => selection.store === "secret-service",
		},
		"secret-service": {
			description: "Isolated Linux Secret Service acceptance",
			detect: () => selection.store === "secret-service",
		},
	});
	return {
		...base,
		plugins: [
			...(base.plugins ?? []),
			{
				name: "draftyak:required-native-store",
				configureVitest({ vitest }: VitestPluginContext) {
					vitest.config.reporters.push(completionReporter(vitest, expected));
				},
			},
		],
		test: {
			...base.test,
			passWithNoTests: false,
			maxWorkers: 1,
			sequence: { concurrent: false, shuffle: false },
		},
	};
}

function completionReporter(_vitest: Vitest, expected: readonly string[]): Reporter {
	return {
		onTestRunEnd(modules) {
			const passed = modules.flatMap((module) =>
				[...module.children.allTests("passed")].map((test) => test.fullName),
			);
			try {
				requireCompleteNativeRun(expected, passed);
			} catch {
				process.exitCode = 1;
				process.stderr.write("Required native-store acceptance did not complete\n");
			}
		},
	};
}
