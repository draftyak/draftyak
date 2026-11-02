/** Shared Actions jobs do not provide the dedicated timing measurement context. */
export function timingContextAvailable(env: NodeJS.ProcessEnv): boolean {
	return (
		env.GITHUB_ACTIONS !== "true" || (env.GITHUB_WORKFLOW === "spikes" && env.GITHUB_JOB === "run")
	);
}
