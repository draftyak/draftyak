export const nativeSupervisorWorkflowFile = ".github/workflows/native-supervisor.yml";

/** Only this fixed dispatch contract may publish the supervisor execution receipt. */
export function nativeSupervisorWorkflowContract(
	pins: Readonly<Record<string, readonly [string, string]>>,
) {
	const use = (name: string): string => `${name}@${pins[name]?.[0] ?? ""}`;
	return {
		name: "Native macOS supervisor",
		on: {
			workflow_dispatch: {
				inputs: {
					pr: { description: "Open owner PR into m2", required: true, type: "string" },
					head: {
						description: "Exact current PR head (40 lowercase hex characters)",
						required: true,
						type: "string",
					},
					controlSha: {
						description: "Exact immutable approved control commit (40 lowercase hex characters)",
						required: true,
						type: "string",
					},
				},
			},
		},
		permissions: { contents: "read" },
		env: { DO_NOT_TRACK: "1", TURBO_TELEMETRY_DISABLED: "1" },
		defaults: { run: { shell: "bash" } },
		jobs: {
			"native-supervisor": {
				if: "${{ github.event_name == 'workflow_dispatch' && github.repository == 'draftyak/draftyak' && github.actor == 'nicksavov' && github.triggering_actor == 'nicksavov' && github.ref == 'refs/heads/m0' && inputs.controlSha == github.sha && inputs.controlSha == github.workflow_sha }}",
				"runs-on": "macos-15",
				"timeout-minutes": 20,
				steps: [
					{
						name: "Check out trusted controls",
						uses: use("actions/checkout"),
						with: { ref: "${{ github.sha }}", "persist-credentials": false },
					},
					{
						name: "Set up pinned Node",
						uses: use("actions/setup-node"),
						with: { "node-version-file": ".node-version" },
					},
					// The gate on the trusted controls, before any of their code runs.
					{ name: "Reserved paths and execution inputs", run: "node tools/verify/gate.ts" },
					{
						name: "Admit the exact owner PR head",
						id: "source",
						env: {
							NATIVE_SUPERVISOR_PR: "${{ inputs.pr }}",
							NATIVE_SUPERVISOR_HEAD: "${{ inputs.head }}",
							NATIVE_SUPERVISOR_CONTROL_SHA: "${{ inputs.controlSha }}",
						},
						run: "node tools/ci-checks/src/native-supervisor.ts admit",
					},
					{
						name: "Check out admitted source",
						uses: use("actions/checkout"),
						with: {
							repository: "draftyak/draftyak",
							ref: "${{ steps.source.outputs.head }}",
							path: "source",
							"persist-credentials": false,
						},
					},
					// The admitted source, verified, then the trusted gate and pre-install check on it
					// with --root, before pnpm starts there.
					{
						name: "Verify the source checkout",
						env: {
							NATIVE_SUPERVISOR_PR: "${{ steps.source.outputs.pr }}",
							NATIVE_SUPERVISOR_HEAD: "${{ steps.source.outputs.head }}",
							NATIVE_SUPERVISOR_CONTROL_SHA: "${{ inputs.controlSha }}",
						},
						run: "node tools/ci-checks/src/native-supervisor.ts verify-source",
					},
					{
						name: "Reserved paths and execution inputs of the source",
						run: "node tools/verify/gate.ts --root source",
					},
					{
						name: "Pre-install script check of the source",
						run: "node tools/verify/preinstall.ts --root source",
					},
					{ name: "Set up pinned pnpm", uses: use("pnpm/action-setup") },
					{
						name: "Build and verify the native supervisor cases",
						id: "native",
						env: {
							NATIVE_SUPERVISOR_PR: "${{ steps.source.outputs.pr }}",
							NATIVE_SUPERVISOR_HEAD: "${{ steps.source.outputs.head }}",
							NATIVE_SUPERVISOR_CONTROL_SHA: "${{ inputs.controlSha }}",
						},
						run: "node tools/ci-checks/src/native-supervisor.ts run",
					},
					{
						name: "Upload the verified native supervisor receipt",
						if: "${{ success() && steps.native.outputs.receipt == 'ready' }}",
						uses: use("actions/upload-artifact"),
						with: {
							name: "native-supervisor-receipt-${{ github.run_id }}-${{ github.run_attempt }}",
							path: "${{ runner.temp }}/native-supervisor-receipt.json",
							"if-no-files-found": "error",
							"retention-days": 1,
						},
					},
				],
			},
		},
	};
}
