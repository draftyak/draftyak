/** Select the build even on broken provisioning only in the dedicated spikes job. */
export function shouldRunAndroidBuild(
	env: NodeJS.ProcessEnv,
	toolchainPresent: () => boolean,
): boolean {
	const workflowRef = env.GITHUB_WORKFLOW_REF ?? "";
	const spikesWorkflow =
		/^draftyak\/draftyak\/\.github\/workflows\/spikes\.yml@refs\/(?:heads|tags)\/[^\s]+$/.exec(
			workflowRef,
		);
	const provisionedSpikesJob =
		env.GITHUB_ACTIONS === "true" &&
		env.DRAFTYAK_STRICT_SKIPS === "1" &&
		env.GITHUB_JOB === "run" &&
		spikesWorkflow?.[0] === workflowRef;
	return provisionedSpikesJob || toolchainPresent();
}
