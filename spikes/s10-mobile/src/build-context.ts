import { strictSkips } from "@draftyak/spike-kit";

/** Only the dedicated workflow provisions the required mobile build toolchains. */
export function isDedicatedSpikeBuild(env: NodeJS.ProcessEnv): boolean {
	return (
		env.GITHUB_ACTIONS === "true" &&
		strictSkips(env) &&
		env.GITHUB_WORKFLOW === "spikes" &&
		env.GITHUB_JOB === "run"
	);
}
