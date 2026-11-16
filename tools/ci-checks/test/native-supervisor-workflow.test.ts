import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../src/workflow-policy.ts";
import { parseYaml, type Yaml } from "../src/yaml.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const file = ".github/workflows/native-supervisor.yml";
const workflow = readFileSync(path.join(root, file), "utf8");
const rust = /channel\s*=\s*"([^"]+)"/.exec(
	readFileSync(path.join(root, "rust-toolchain.toml"), "utf8"),
)?.[1];
if (!rust) throw new Error("Missing Rust toolchain pin");

function map(value: Yaml | undefined): Record<string, Yaml> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected a workflow mapping");
	return value;
}

function replaceOnce(from: string, to: string): string {
	expect(workflow.split(from)).toHaveLength(2);
	return workflow.replace(from, to);
}

type Mutation = readonly [name: string, from: string, to: string];
const uploadGate = "if: ${{ success() && steps.native.outputs.receipt == 'ready' }}";
const receiptPath = "path: ${{ runner.temp }}/native-supervisor-receipt.json";
const nodeVersionField = "node-version-file: .node-version";
const mutations: readonly Mutation[] = [
	["pull request execution", "workflow_dispatch:", "pull_request:"],
	["reusable execution", "workflow_dispatch:", "workflow_call:"],
	[
		"caller-selected command input",
		"inputs:\n",
		"inputs:\n      command:\n        required: true\n        type: string\n",
	],
	[
		"optional PR input",
		"description: Open owner PR into m2\n        required: true",
		"description: Open owner PR into m2\n        required: false",
	],
	["writable repository token", "contents: read", "contents: write"],
	["extra token scope", "contents: read", "contents: read\n  actions: write"],
	["inherited token", "DO_NOT_TRACK: '1'", "DO_NOT_TRACK: '1'\n  GH_TOKEN: '${{ github.token }}'"],
	["source working directory default", "shell: bash", "shell: bash\n    working-directory: source"],
	["missing dispatch predicate", "github.event_name == 'workflow_dispatch' && ", ""],
	[
		"wrong repo",
		"github.repository == 'draftyak/draftyak'",
		"github.repository == 'synthetic/other'",
	],
	["wrong actor", "github.actor == 'nicksavov'", "github.actor == 'synthetic-user'"],
	["missing triggering actor", "github.triggering_actor == 'nicksavov' && ", ""],
	["wrong control branch", "github.ref == 'refs/heads/m0'", "github.ref == 'refs/heads/m2'"],
	["non-native runner", "runs-on: macos-15", "runs-on: ubuntu-24.04"],
	["different macOS image", "runs-on: macos-15", "runs-on: macos-14"],
	["larger runner", "runs-on: macos-15", "runs-on: macos-15-large"],
	[
		"runner matrix",
		"timeout-minutes: 20",
		"timeout-minutes: 20\n    strategy:\n      matrix:\n        arch: [arm64, x64]",
	],
	["unbounded job", "timeout-minutes: 20", "timeout-minutes: 360"],
	["source controls checkout", "ref: ${{ github.sha }}", "ref: ${{ inputs.head }}"],
	[
		"trusted checkout credentials",
		"ref: ${{ github.sha }}\n          persist-credentials: false",
		"ref: ${{ github.sha }}\n          persist-credentials: true",
	],
	["unadmitted checkout", "ref: ${{ steps.source.outputs.head }}", "ref: ${{ inputs.head }}"],
	["different source repository", "repository: draftyak/draftyak", "repository: synthetic/other"],
	[
		"source checkout credentials",
		"path: source\n          persist-credentials: false",
		"path: source\n          persist-credentials: true",
	],
	["Node pin", nodeVersionField, "node-version-file: source/.node-version"],
	["dependency cache", nodeVersionField, "node-version-file: .node-version\n          cache: pnpm"],
	[
		"unpinned pnpm action",
		"pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413",
		"pnpm/action-setup@main",
	],
	[
		"untrusted controller",
		"run: node tools/ci-checks/src/native-supervisor.ts run",
		"run: node source/tools/ci-checks/src/native-supervisor.ts run",
	],
	[
		"raw head at execution",
		"NATIVE_SUPERVISOR_HEAD: ${{ steps.source.outputs.head }}",
		"NATIVE_SUPERVISOR_HEAD: ${{ inputs.head }}",
	],
	[
		"direct source install",
		"- name: Set up pinned pnpm",
		"- name: Install source without controller\n        working-directory: source\n        run: pnpm install --frozen-lockfile\n      - name: Set up pinned pnpm",
	],
	[
		"direct source build",
		"- name: Build and verify the native supervisor cases",
		"- name: Build source without controller\n        working-directory: source\n        run: pnpm --filter @draftyak/hub... build\n      - name: Build and verify the native supervisor cases",
	],
	["ignored command failure", "id: native", "id: native\n        continue-on-error: true"],
	["always upload", uploadGate, "if: ${{ always() }}"],
	["unverified upload", uploadGate, "if: ${{ success() }}"],
	["source artifact path", receiptPath, "path: source/native-supervisor-receipt.json"],
	["wildcard artifact path", receiptPath, "path: ${{ runner.temp }}/*"],
	[
		"attempt-ambiguous artifact",
		"name: native-supervisor-receipt-${{ github.run_id }}-${{ github.run_attempt }}",
		"name: native-supervisor-receipt-${{ github.run_id }}",
	],
	["missing receipt ignored", "if-no-files-found: error", "if-no-files-found: ignore"],
	["long artifact retention", "retention-days: 1", "retention-days: 30"],
];

describe("dedicated native supervisor workflow", () => {
	it("admits the fixed dispatch and receipt contract through the real workflow policy", () => {
		expect(checkWorkflow(file, workflow, rust)).toEqual([]);
		expect(checkWorkflow(file, workflow.replaceAll("\n", "\r\n"), rust)).toEqual([]);
	});

	it("does not grant the receipt upload exception to another workflow filename", () => {
		const problems = checkWorkflow(".github/workflows/other-native.yml", workflow, rust);
		expect(problems.some((problem) => problem.includes("upload-artifact may only upload"))).toBe(
			true,
		);
	});

	it("keeps source execution inside the trusted controller after admission", () => {
		const document = map(parseYaml(workflow).value);
		expect(Object.keys(map(document.on))).toEqual(["workflow_dispatch"]);
		expect(Object.keys(map(document.jobs))).toEqual(["native-supervisor"]);
		const job = map(map(document.jobs)["native-supervisor"]);
		if (!Array.isArray(job.steps)) throw new Error("Missing workflow steps");
		const steps = job.steps.map(map);
		expect(steps.flatMap((step) => (typeof step.run === "string" ? [step.run] : []))).toEqual([
			"node tools/ci-checks/src/native-supervisor.ts admit",
			"node tools/ci-checks/src/native-supervisor.ts run",
		]);
		const admission = steps.findIndex((step) => step.id === "source");
		const source = steps.findIndex((step) => map(step.with ?? {}).path === "source");
		const native = steps.findIndex((step) => step.id === "native");
		expect(admission).toBeGreaterThan(0);
		expect(source).toBeGreaterThan(admission);
		expect(native).toBeGreaterThan(source);
		expect(steps[native]?.["working-directory"]).toBeUndefined();
		expect(steps[native]?.env).toEqual({
			NATIVE_SUPERVISOR_PR: "${{ steps.source.outputs.pr }}",
			NATIVE_SUPERVISOR_HEAD: "${{ steps.source.outputs.head }}",
		});
	});

	it.each(mutations)("refuses %s through the production policy", (_name, from, to) => {
		const changed = replaceOnce(from, to);
		expect(changed).not.toBe(workflow);
		expect(checkWorkflow(file, changed, rust).length).toBeGreaterThan(0);
	});
});
