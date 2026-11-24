import { describe, expect, it, vi } from "vitest";
import { shouldRunAndroidBuild } from "../probe-build-context.ts";

const spikesJob: NodeJS.ProcessEnv = {
	GITHUB_ACTIONS: "true",
	DRAFTYAK_STRICT_SKIPS: "1",
	GITHUB_JOB: "run",
	GITHUB_WORKFLOW_REF: "draftyak/draftyak/.github/workflows/spikes.yml@refs/heads/spikes-run/test",
};

describe("Android build context selection", () => {
	it("does not claim a missing toolchain in ordinary strict full CI", () => {
		const present = vi.fn(() => false);
		expect(
			shouldRunAndroidBuild(
				{
					...spikesJob,
					GITHUB_JOB: "full",
					GITHUB_WORKFLOW_REF: "draftyak/draftyak/.github/workflows/ci.yml@refs/pull/81/merge",
				},
				present,
			),
		).toBe(false);
		expect(present).toHaveBeenCalledOnce();
	});
	it.each([
		"draftyak/draftyak/.github/workflows/spikes.yml@refs/heads/spikes-run/test",
		"draftyak/draftyak/.github/workflows/spikes.yml@refs/heads/m0",
		"draftyak/draftyak/.github/workflows/spikes.yml@refs/tags/test",
	])(
		"keeps the provisioned spikes build selected so missing prerequisites fail: %s",
		(workflow) => {
			const present = vi.fn(() => false);
			expect(shouldRunAndroidBuild({ ...spikesJob, GITHUB_WORKFLOW_REF: workflow }, present)).toBe(
				true,
			);
			expect(present).not.toHaveBeenCalled();
		},
	);
	it.each<NodeJS.ProcessEnv>([
		{},
		{ GITHUB_ACTIONS: "false" },
		{ DRAFTYAK_STRICT_SKIPS: "0" },
		{ GITHUB_JOB: "plan" },
		{ GITHUB_JOB: "full" },
		{ GITHUB_WORKFLOW_REF: undefined },
		{ GITHUB_WORKFLOW_REF: "draftyak/draftyak/.github/workflows/ci.yml@refs/heads/m0" },
		{ GITHUB_WORKFLOW_REF: "other/repository/.github/workflows/spikes.yml@refs/heads/m0" },
		{ GITHUB_WORKFLOW_REF: "draftyak/draftyak/.github/workflows/spikes.yml@" },
		{ GITHUB_WORKFLOW_REF: "draftyak/draftyak/.github/workflows/spikes.yml@refs/heads/" },
		{ GITHUB_WORKFLOW_REF: "draftyak/draftyak/.github/workflows/spikes.yml@refs/pull/81/merge" },
		{ GITHUB_WORKFLOW_REF: "draftyak/draftyak/.github/workflows/spikes.yml@refs/heads/m0\nextra" },
		{ GITHUB_WORKFLOW_REF: "draftyak/draftyak/.github/workflows/spikes.yml@refs/heads/m0\n" },
		{ GITHUB_WORKFLOW_REF: "draftyak/draftyak/.github/workflows/spikes.yml.extra@refs/heads/m0" },
	])("uses the real capability outside the exact provisioned job: %j", (overrides) => {
		const env = Object.keys(overrides).length === 0 ? {} : { ...spikesJob, ...overrides };
		const missing = vi.fn(() => false);
		const present = vi.fn(() => true);
		expect(shouldRunAndroidBuild(env, missing)).toBe(false);
		expect(shouldRunAndroidBuild(env, present)).toBe(true);
		expect(missing).toHaveBeenCalledOnce();
		expect(present).toHaveBeenCalledOnce();
	});
});
