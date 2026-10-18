import { spikeVitestConfig } from "@draftyak/spike-kit/vitest";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// Runs the bench-locked file (measure.heavy, whose benchmark does the idle check) before the other
// heavy files, so the idle check samples a quiet machine instead of following escape's and ipc's
// process churn. It does not change the threshold, window or budget.
class BenchLockedFirst extends BaseSequencer {
	override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
		const sorted = await super.sort(files);
		const rank = (spec: TestSpecification): number =>
			spec.moduleId.includes("measure.heavy") ? 0 : 1;
		return [...sorted].sort((a, b) => rank(a) - rank(b));
	}
}

export default function config(env: ConfigEnv): ViteUserConfig {
	const base = spikeVitestConfig(env);
	if (env.mode !== "heavy") return base;
	// The benchmarks and the inspector's fixed port hold the machine lock, so heavy files run one at
	// a time; the bench-locked file runs first so its idle check never follows another file's load.
	return {
		...base,
		test: {
			...base.test,
			fileParallelism: false,
			sequence: { ...base.test?.sequence, sequencer: BenchLockedFirst },
		},
	};
}
