import { isDeepStrictEqual } from "node:util";
import {
	nativeSupervisorWorkflowContract,
	nativeSupervisorWorkflowFile,
} from "./native-supervisor-workflow.ts";
import { parseYaml, type Yaml, type YamlDocument, type YamlPath } from "./yaml.ts";

// The single source of truth for action pins: [SHA, version comment], each SHA checked against its
// tag with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`. dtolnay/rust-toolchain has no
// release tags. Its comment has more than one word, because zizmor reads a one-word comment as a
// ref and would flag `# master` once master moves on.
export const actionPins: Readonly<Record<string, readonly [string, string]>> = {
	"actions/checkout": ["3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"],
	"actions/setup-node": ["949feb2413d6458794dcd2491c4babbbce0c15c1", "v7.1.0"],
	"pnpm/action-setup": ["ea17c68df8912ef543352723c149a84f56e3d413", "v6.1.0"],
	"actions/cache": ["55cc8345863c7cc4c66a329aec7e433d2d1c52a9", "v6.1.0"],
	"zizmorcore/zizmor-action": ["85b2b9fb8e3325e7a23d7d0a9d7ba5ae0f999e3e", "v0.7.1"],
	"dtolnay/rust-toolchain": ["683b588c487a69d01f6c6ddf40f036ff682cc2c8", "master on 2026-10-16"],
	"Swatinem/rust-cache": ["6323deb102c322ba6fcbdcafc7e3dddab59af2b6", "v2.9.2"],
	"actions/setup-java": ["b843ebf9b913146b38da2eaa7aeddf76074ae1ad", "v6.1.0"],
	"android-actions/setup-android": ["be39fa834029ff78f1a44aa3bb0819b8fc2bd8fd", "v4.0.4"],
	"actions/upload-artifact": ["cf430e030ddbb5b0abf93d22962f4752f3646cd9", "v7.0.2"],
	"actions/download-artifact": ["018cc2cf5baa6db3ef3c5f8a56943fffe632ef53", "v6"],
};

type YamlMap = { readonly [key: string]: Yaml };

const isMap = (value: Yaml | undefined): value is YamlMap =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const asMap = (value: Yaml | undefined): YamlMap => (isMap(value) ? value : {});
const asList = (value: Yaml | undefined): readonly Yaml[] => (Array.isArray(value) ? value : []);

const pushBranches = new Set(["main", "spikes-run/**"]);
const forbiddenEvents = ["pull_request_target", "workflow_run"];
const telemetryOff = ["DO_NOT_TRACK", "TURBO_TELEMETRY_DISABLED"];
const pinnedUses = /^([\w.-]+\/[\w.-]+)(?:\/[^@]*)?@([0-9a-f]{40})$/;
const expressions = /\$\{\{([\s\S]*?)\}\}/g;
// github.event, github.head_ref, github[...], the whole github context and inputs, in any case.
const untrusted = /(?<![\w.-])(?:github(?!\s*\.\s*(?!(?:event|head_ref)\b)[a-z_])|inputs\b)/i;
const evidence = /^!?spikes\/(?:\*|[a-z0-9][a-z0-9-]*)\/evidence(?:\/.*)?$/;
const requiredName = `\${{ github.event.pull_request.draft && 'required (draft)' || 'required' }}`;
const spikeJobName = `Spike heavy (\${{ matrix.id }})`;
// These are the only reviewed computed names. The spike name always has a literal separator,
// so even arbitrary matrix values cannot report exactly `required` or `pr-title`.
const computedNames = [
	[".github/workflows/ci.yml", "required", requiredName],
	[".github/workflows/ci.yml", "spike-run", spikeJobName],
	[".github/workflows/spikes.yml", "run", `\${{ matrix.spike }} on \${{ matrix.os }}`],
] as const;
const requiredPrTypes: Readonly<Record<string, readonly string[]>> = {
	".github/workflows/ci.yml": ["opened", "synchronize", "reopened", "ready_for_review"],
	".github/workflows/pr-title.yml": ["opened", "edited", "synchronize", "reopened"],
};
const nonDocs = "needs.changes.outputs.docs-only != 'true'";
const nativeSelected = "needs.changes.outputs.native-transport == 'true'";
const readyRun = "(github.event_name != 'pull_request' || !github.event.pull_request.draft)";
const ciControls: Readonly<Record<string, YamlMap>> = {
	changes: {},
	cheap: { needs: "changes" },
	full: {
		needs: "changes",
		if: `${nonDocs} && (github.event_name != 'pull_request' || !github.event.pull_request.draft)`,
	},
	"spike-run": {
		name: spikeJobName,
		needs: "changes",
		if: `${nonDocs} && ${readyRun} && needs.changes.outputs.spike-count != '0'`,
		strategy: {
			"fail-fast": false,
			"max-parallel": 4,
			matrix: `\${{ fromJSON(needs.changes.outputs.spike-matrix) }}`,
		},
		env: {
			DRAFTYAK_STRICT_SKIPS: "1",
			SHARD_ID: `\${{ matrix.id }}`,
			SPIKE: `\${{ matrix.spike }}`,
			SPIKES: `\${{ needs.changes.outputs.spikes }}`,
		},
	},
	spikes: {
		needs: ["changes", "spike-run"],
		if: `always() && needs.changes.result == 'success' && ${nonDocs} && ${readyRun} && needs.changes.outputs.spike-count != '0'`,
	},
	heavy: {
		needs: "changes",
		if: `${nonDocs} && ${readyRun} && needs.changes.outputs.ordinary-heavy != ''`,
		env: { DRAFTYAK_STRICT_SKIPS: "1" },
	},
	windows: {
		needs: "changes",
		if: `${nonDocs} && (github.ref == 'refs/heads/main' || (github.event_name == 'pull_request' && !github.event.pull_request.draft) || (github.event_name != 'pull_request' && ${nativeSelected}))`,
	},
	macos: { needs: "changes", if: `${nonDocs} && ${readyRun} && ${nativeSelected}` },
	required: {
		needs: ["changes", "cheap", "full", "spikes", "heavy", "windows", "macos"],
		if: "always()",
	},
};
const ciChangesOutputs: YamlMap = {
	areas: `\${{ steps.areas.outputs.areas }}`,
	"docs-only": `\${{ steps.areas.outputs.docs-only }}`,
	rust: `\${{ steps.areas.outputs.rust }}`,
	spikes: `\${{ steps.areas.outputs.spikes }}`,
	"spike-matrix": `\${{ steps.shards.outputs.matrix }}`,
	"spike-count": `\${{ steps.shards.outputs.count }}`,
	heavy: `\${{ steps.areas.outputs.heavy }}`,
	"native-transport": `\${{ steps.native.outputs.native-transport }}`,
	"ordinary-heavy": `\${{ steps.native.outputs.ordinary-heavy }}`,
	"template-smoke": `\${{ steps.areas.outputs.template-smoke || 'false' }}`,
	source: `\${{ steps.source.outputs.source }}`,
};
const browserRequired = "steps.browser-setup.outputs.required == 'true'";
const browserPath = `\${{ steps.browser-setup.outputs.path }}`;
const browserCache: YamlMap = {
	id: "browser-cache",
	if: browserRequired,
	uses: `actions/cache@${actionPins["actions/cache"]?.[0]}`,
	with: {
		path: browserPath,
		key: `playwright-\${{ runner.os }}-\${{ runner.arch }}-\${{ hashFiles('pnpm-lock.yaml') }}`,
	},
};
const offlineNodePreparation: YamlMap = {
	id: "offline-node",
	if: "needs.changes.outputs.spikes != '' || needs.changes.outputs.ordinary-heavy != ''",
	env: { DRAFTYAK_CACHE_DIR: `\${{ runner.temp }}/draftyak-node-input` },
	run: [
		"pnpm fetch-node --version bundled --platform linux --arch x64",
		"node --input-type=module <<'NODE'",
		"import { appendFileSync, readFileSync } from 'node:fs';",
		"import path from 'node:path';",
		"const { bundled } = JSON.parse(readFileSync('tools/fetch-node/versions.json', 'utf8'));",
		"const cache = path.join(process.env.DRAFTYAK_CACHE_DIR, 'node', bundled);",
		"appendFileSync(process.env.GITHUB_OUTPUT, `cache=${cache}\\n`);",
		"NODE",
		"",
	].join("\n"),
};

const ciCheckout: YamlMap = {
	uses: `actions/checkout@${actionPins["actions/checkout"]?.[0]}`,
	with: { "persist-credentials": false, ref: `\${{ github.sha }}` },
};
const ciNode: YamlMap = {
	uses: `actions/setup-node@${actionPins["actions/setup-node"]?.[0]}`,
	with: { "node-version-file": ".node-version" },
};
const ciPnpm: YamlMap = {
	uses: `pnpm/action-setup@${actionPins["pnpm/action-setup"]?.[0]}`,
	with: { cache: true },
};
const sourceCapture: YamlMap = {
	id: "source",
	run: "node tools/ci-checks/src/verification-receipt.ts capture",
};
const spikeUpload: YamlMap = {
	uses: `actions/upload-artifact@${actionPins["actions/upload-artifact"]?.[0]}`,
	with: {
		name: `ci-spike-\${{ github.run_id }}-\${{ github.run_attempt }}-\${{ matrix.id }}`,
		path: `\${{ steps.receipt.outputs.path }}`,
		"if-no-files-found": "error",
		"retention-days": 1,
	},
};

const ciCommands: Record<string, readonly YamlMap[]> = {
	changes: [
		{
			id: "areas",
			env: {
				BASE_SHA: `\${{ github.event.pull_request.base.sha || github.event.before }}`,
				HEAD_SHA: `\${{ github.event.pull_request.head.sha || github.sha }}`,
			},
			run: "node tools/ci-checks/src/changes.ts",
		},
		{
			id: "native",
			env: {
				HEAVY: `\${{ steps.areas.outputs.heavy }}`,
				RUST: `\${{ steps.areas.outputs.rust }}`,
			},
			run: "node tools/ci-checks/src/native-transport.ts select",
		},
		{
			id: "shards",
			env: { SPIKES: `\${{ steps.areas.outputs.spikes }}` },
			run: "node tools/ci-checks/src/heavy-shards.ts plan",
		},
	],
	cheap: [
		{
			if: "needs.changes.outputs.docs-only == 'true'",
			run: "node tools/verify/verify.ts --profile docs",
		},
		{ if: nonDocs, run: "pnpm install --frozen-lockfile" },
		{ if: nonDocs, run: "pnpm verify --profile cheap" },
	],
	full: [{ run: "pnpm install --frozen-lockfile" }, { run: "pnpm build" }],
	"spike-run": [
		ciCheckout,
		ciNode,
		{ run: "node tools/ci-checks/src/heavy-shards.ts validate" },
		ciPnpm,
		{
			uses: `actions/cache@${actionPins["actions/cache"]?.[0]}`,
			with: {
				path: ".turbo/cache",
				key: `turbo-\${{ runner.os }}-\${{ github.job }}-\${{ matrix.id }}-\${{ hashFiles('pnpm-lock.yaml', '.github/workflows/**', '**/*.ts', '**/*.json', '!**/node_modules/**') }}`,
				"restore-keys": `turbo-\${{ runner.os }}-\${{ github.job }}-\${{ matrix.id }}-`,
			},
		},
		{ run: "pnpm install --frozen-lockfile" },
		{ run: "pnpm build" },
		offlineNodePreparation,
		{
			id: "browser-setup",
			env: {
				SPIKES: `\${{ matrix.spike }}`,
				PLAYWRIGHT_BROWSERS_PATH: `\${{ runner.temp }}/draftyak-playwright`,
			},
			run: "node tools/ci-checks/src/browser-setup.ts plan",
		},
		browserCache,
		{
			if: browserRequired,
			env: {
				SPIKES: `\${{ matrix.spike }}`,
				PLAYWRIGHT_BROWSERS_PATH: browserPath,
			},
			run: "node tools/ci-checks/src/browser-setup.ts install",
		},
		{
			id: "heavy-test",
			env: {
				PLAYWRIGHT_BROWSERS_PATH: browserPath,
				DRAFTYAK_TEST_NODE_CACHE: `\${{ steps.offline-node.outputs.cache }}`,
				DRAFTYAK_CACHE_DIR: `\${{ runner.temp }}/draftyak-node-scratch`,
			},
			run: [
				'node tools/verify/turbo.ts run test:heavy --concurrency=1 --log-order=stream --log-prefix=task "--filter=./$SPIKE"',
				"",
			].join("\n"),
		},
		{
			id: "receipt",
			env: { SHARD_COMMAND_RESULT: `\${{ steps.heavy-test.outcome }}` },
			run: "node tools/ci-checks/src/heavy-shards.ts receipt",
		},
		spikeUpload,
	],
	spikes: [
		ciCheckout,
		ciNode,
		sourceCapture,
		{
			env: { SHARD_RESULT: `\${{ needs.spike-run.result }}` },
			run: `node --input-type=module -e 'if (process.env.SHARD_RESULT !== "success") process.exit(1)'`,
		},
		{
			uses: `actions/download-artifact@${actionPins["actions/download-artifact"]?.[0]}`,
			with: {
				pattern: `ci-spike-\${{ github.run_id }}-\${{ github.run_attempt }}-*`,
				path: `\${{ runner.temp }}/spike-receipts`,
				"merge-multiple": true,
			},
		},
		{
			id: "collect",
			env: {
				SPIKES: `\${{ needs.changes.outputs.spikes }}`,
				SHARD_RECEIPTS: `\${{ runner.temp }}/spike-receipts`,
			},
			run: "node tools/ci-checks/src/heavy-shards.ts collect",
		},
	],
	heavy: [
		ciCheckout,
		ciNode,
		sourceCapture,
		ciPnpm,
		{ run: "pnpm install --frozen-lockfile" },
		{ run: "pnpm build" },
		{
			id: "offline-node",
			env: { DRAFTYAK_CACHE_DIR: `\${{ runner.temp }}/draftyak-node-input` },
			run: offlineNodePreparation.run ?? "",
		},
		{
			id: "browser-setup",
			env: {
				SPIKES: `\${{ needs.changes.outputs.spikes }}`,
				PLAYWRIGHT_BROWSERS_PATH: `\${{ runner.temp }}/draftyak-playwright`,
			},
			run: "node tools/ci-checks/src/browser-setup.ts plan",
		},
		browserCache,
		{
			if: browserRequired,
			env: {
				SPIKES: `\${{ needs.changes.outputs.spikes }}`,
				PLAYWRIGHT_BROWSERS_PATH: browserPath,
			},
			run: "node tools/ci-checks/src/browser-setup.ts install",
		},
		{
			id: "heavy-test",
			env: {
				HEAVY: `\${{ needs.changes.outputs.ordinary-heavy }}`,
				SMOKE: `\${{ needs.changes.outputs.template-smoke == 'true' || github.ref == 'refs/heads/main' || github.base_ref == 'main' }}`,
				PLAYWRIGHT_BROWSERS_PATH: browserPath,
				DRAFTYAK_TEST_NODE_CACHE: `\${{ steps.offline-node.outputs.cache }}`,
				DRAFTYAK_CACHE_DIR: `\${{ runner.temp }}/draftyak-node-scratch`,
			},
			run: [
				"filters=()",
				'while IFS= read -r filter; do filters+=("--filter=$filter"); done <<< "$HEAVY"',
				'if [ "$SMOKE" != true ] && [ -f packages/create-plugin/package.json ]; then',
				'  filters+=("--filter=!./packages/create-plugin")',
				"fi",
				`node tools/verify/turbo.ts run test:heavy --concurrency=1 --log-order=stream --log-prefix=task "\${filters[@]}"`,
				"",
			].join("\n"),
		},
		{
			id: "complete",
			env: {
				HEAVY: `\${{ needs.changes.outputs.ordinary-heavy }}`,
				HEAVY_COMMAND_RESULT: `\${{ steps.heavy-test.outcome }}`,
			},
			run: [
				"node --input-type=module <<'NODE'",
				"import { appendFileSync } from 'node:fs';",
				"if (process.env.HEAVY_COMMAND_RESULT !== 'success') process.exit(1);",
				"appendFileSync(process.env.GITHUB_OUTPUT, `completed=${JSON.stringify(process.env.HEAVY.split('\\n'))}\\n`);",
				"NODE",
				"",
			].join("\n"),
		},
	],
	windows: [
		{ run: "pnpm install --frozen-lockfile" },
		{ run: "pnpm verify", env: { TURBO_CONCURRENCY: "1" } },
	],
};

const nativePlatforms = {
	full: { platform: "linux", architecture: "x64", runner: "ubuntu-24.04" },
	windows: { platform: "win32", architecture: "x64", runner: "windows-2025" },
	macos: { platform: "darwin", architecture: "arm64", runner: "macos-15" },
} as const;
for (const [job, platform] of Object.entries(nativePlatforms)) {
	const conditional: YamlMap = job === "macos" ? {} : { if: nativeSelected };
	const env = { NATIVE_PLATFORM: platform.platform, NATIVE_ARCHITECTURE: platform.architecture };
	const platformCheck: YamlMap = {
		...conditional,
		env,
		run: "node tools/ci-checks/src/native-transport.ts platform",
	};
	const execute: YamlMap = {
		id: "native",
		...conditional,
		env,
		run: "pnpm exec node tools/ci-checks/src/native-transport.ts run",
	};
	ciCommands[job] =
		job === "macos"
			? [platformCheck, { run: "pnpm install --frozen-lockfile" }, execute]
			: [platformCheck, ...(ciCommands[job] ?? []), execute];
}
const prTitleCommands: readonly YamlMap[] = [
	{
		env: {
			PR_TITLE: `\${{ github.event.pull_request.title }}`,
			PR_BODY: `\${{ github.event.pull_request.body }}`,
			PR_HEAD_REF: `\${{ github.event.pull_request.head.ref }}`,
			PR_BASE_REF: `\${{ github.event.pull_request.base.ref }}`,
		},
		run: "node tools/ci-checks/src/pr-meta.ts",
	},
	{
		env: {
			BASE_SHA: `\${{ github.event.pull_request.base.sha }}`,
			HEAD_SHA: `\${{ github.event.pull_request.head.sha }}`,
		},
		run: 'node tools/vendor-guard/src/cli.ts --commits "$BASE_SHA..$HEAD_SHA"',
	},
];

const readOnly = (permissions: Yaml | undefined): boolean => {
	const map = asMap(permissions);
	return Object.keys(map).join() === "contents" && map.contents === "read";
};

const nativeStoreFile = ".github/workflows/native-store.yml";
// The receipt-only upload exception requires the complete trusted execution contract.
const nativeStoreContract: Yaml = {
	name: "Native macOS store",
	on: {
		workflow_dispatch: {
			inputs: {
				pr: { description: "Open owner PR into m2", required: true, type: "string" },
				head: {
					description: "Exact current PR head (40 lowercase hex characters)",
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
		"native-store": {
			if: `\${{ github.event_name == 'workflow_dispatch' && github.repository == 'draftyak/draftyak' && github.actor == 'nicksavov' && github.triggering_actor == 'nicksavov' && github.ref == 'refs/heads/m0' }}`,
			"runs-on": "macos-15",
			"timeout-minutes": 15,
			steps: [
				{
					name: "Check out trusted controls",
					uses: `actions/checkout@${actionPins["actions/checkout"]?.[0]}`,
					with: { ref: `\${{ github.sha }}`, "persist-credentials": false },
				},
				{
					name: "Set up Node",
					uses: `actions/setup-node@${actionPins["actions/setup-node"]?.[0]}`,
					with: { "node-version-file": ".node-version" },
				},
				{
					name: "Admit the exact owner PR head",
					id: "source",
					env: { NATIVE_STORE_PR: `\${{ inputs.pr }}`, NATIVE_STORE_HEAD: `\${{ inputs.head }}` },
					run: "node tools/ci-checks/src/native-store.ts admit",
				},
				{
					name: "Check out admitted source",
					uses: `actions/checkout@${actionPins["actions/checkout"]?.[0]}`,
					with: {
						repository: "draftyak/draftyak",
						ref: `\${{ steps.source.outputs.head }}`,
						path: "source",
						"persist-credentials": false,
					},
				},
				{
					name: "Verify the source checkout",
					env: {
						NATIVE_STORE_PR: `\${{ steps.source.outputs.pr }}`,
						NATIVE_STORE_HEAD: `\${{ steps.source.outputs.head }}`,
					},
					run: "node tools/ci-checks/src/native-store.ts verify-source",
				},
				{
					name: "Set up pnpm",
					uses: `pnpm/action-setup@${actionPins["pnpm/action-setup"]?.[0]}`,
				},
				{
					name: "Install locked source dependencies",
					"working-directory": "source",
					run: "pnpm install --frozen-lockfile",
				},
				{
					name: "Run and verify the native store case",
					id: "native",
					env: {
						NATIVE_STORE_PR: `\${{ steps.source.outputs.pr }}`,
						NATIVE_STORE_HEAD: `\${{ steps.source.outputs.head }}`,
					},
					run: "node tools/ci-checks/src/native-store.ts run",
				},
				{
					name: "Upload the verified native receipt",
					if: `\${{ success() && steps.native.outputs.receipt == 'ready' }}`,
					uses: `actions/upload-artifact@${actionPins["actions/upload-artifact"]?.[0]}`,
					with: {
						name: `native-store-receipt-\${{ github.run_id }}-\${{ github.run_attempt }}`,
						path: `\${{ runner.temp }}/native-store-receipt.json`,
						"if-no-files-found": "error",
						"retention-days": 1,
					},
				},
			],
		},
	},
};

const labelsFile = ".github/workflows/labels.yml";
// The sole write-permission exception pins the whole execution context, including every step.
// A one-line condition retains the parser's refusal of folded and multiline scalars.
const labelsContract: Yaml = {
	name: "Sync approved labels",
	on: { workflow_dispatch: null },
	permissions: { contents: "read" },
	env: { DO_NOT_TRACK: "1", TURBO_TELEMETRY_DISABLED: "1" },
	jobs: {
		"sync-labels": {
			if: `\${{ github.event_name == 'workflow_dispatch' && github.repository == 'draftyak/draftyak' && github.actor == 'nicksavov' && github.triggering_actor == 'nicksavov' && github.ref == 'refs/heads/m11' }}`,
			permissions: { contents: "read", issues: "write" },
			"runs-on": "ubuntu-24.04",
			steps: [
				{
					name: "Check out source",
					uses: `actions/checkout@${actionPins["actions/checkout"]?.[0]}`,
					with: { ref: `\${{ github.sha }}`, "persist-credentials": false },
				},
				{
					name: "Set up pnpm",
					uses: `pnpm/action-setup@${actionPins["pnpm/action-setup"]?.[0]}`,
				},
				{
					name: "Set up Node",
					uses: `actions/setup-node@${actionPins["actions/setup-node"]?.[0]}`,
					with: { "node-version-file": ".node-version" },
				},
				{ name: "Install locked dependencies", run: "pnpm install --frozen-lockfile" },
				{
					name: "Validate metadata",
					run: "pnpm --filter @draftyak/launch-checks --fail-if-no-match metadata",
				},
				{
					name: "Validate issue drafts and labels",
					run: "pnpm --filter @draftyak/launch-checks --fail-if-no-match issues",
				},
				{
					name: "Synchronize approved labels",
					id: "sync-approved-labels",
					env: { GH_TOKEN: `\${{ github.token }}` },
					run: "node tools/launch-checks/src/issues-cli.ts --sync-labels",
				},
			],
		},
	},
};

// Problems in one workflow file, as `file:line: message`.
export function checkWorkflow(file: string, source: string, rustToolchain: string): string[] {
	let doc: YamlDocument;
	try {
		doc = parseYaml(source);
	} catch (error) {
		return [`${file}: ${error instanceof Error ? error.message : String(error)}`];
	}
	const problems: string[] = [];
	const report = (prefix: YamlPath, message: string): void => {
		const scalar = doc.scalars.find((s) => prefix.every((part, at) => s.path[at] === part));
		problems.push(`${file}${scalar ? `:${scalar.line}` : ""}: ${message}`);
	};
	const checkCommands = (job: string, definition: YamlMap, commands: readonly YamlMap[]): void => {
		const steps = asList(definition.steps).map(asMap);
		let previous = -1;
		for (const expected of commands) {
			const kind = typeof expected.run === "string" ? "run" : "uses";
			const matches = steps.flatMap((step, index) =>
				step[kind] === expected[kind] && (kind === "run" || step.id === expected.id) ? [index] : [],
			);
			const index = matches[0] ?? -1;
			const step = Object.fromEntries(
				Object.entries(steps[index] ?? {}).filter(([key]) => key !== "name"),
			);
			const duplicateId =
				typeof expected.id === "string" &&
				steps.filter((step) => step.id === expected.id).length !== 1;
			if (
				matches.length !== 1 ||
				index <= previous ||
				duplicateId ||
				!isDeepStrictEqual(step, expected)
			) {
				report(
					["jobs", job, "steps"],
					`must preserve ${job} command and its execution controls: ${expected[kind]}`,
				);
			}
			previous = index;
		}
	};
	const workflow = asMap(doc.value);
	const reviewedLabels = file === labelsFile && isDeepStrictEqual(doc.value, labelsContract);
	if (file === labelsFile && !reviewedLabels) {
		report([], "labels.yml must exactly match the reviewed owner-only labels contract");
	}
	const reviewedNativeStore =
		file === nativeStoreFile && isDeepStrictEqual(doc.value, nativeStoreContract);
	if (file === nativeStoreFile && !reviewedNativeStore) {
		report([], "native-store.yml must exactly match the trusted native receipt contract");
	}
	const reviewedNativeSupervisor =
		file === nativeSupervisorWorkflowFile &&
		isDeepStrictEqual(doc.value, nativeSupervisorWorkflowContract(actionPins));
	if (file === nativeSupervisorWorkflowFile && !reviewedNativeSupervisor) {
		report([], "native-supervisor.yml must exactly match the trusted native supervisor contract");
	}
	if (file === ".github/workflows/ci.yml") {
		const checkFailurePolicy = (value: Yaml, at: YamlPath): void => {
			if (Array.isArray(value)) {
				for (const [index, entry] of value.entries()) checkFailurePolicy(entry, [...at, index]);
			} else if (isMap(value)) {
				for (const [key, entry] of Object.entries(value)) {
					const child = [...at, key];
					if (key === "continue-on-error") {
						report(child, "ci.yml must not contain continue-on-error");
					}
					checkFailurePolicy(entry, child);
				}
			}
		};
		checkFailurePolicy(doc.value, []);
	}

	if (!readOnly(workflow.permissions)) {
		report(["permissions"], "top-level permissions must be exactly `contents: read`");
	}
	const env = asMap(workflow.env);
	if (telemetryOff.some((name) => String(env[name]) !== "1")) {
		report(["env"], "env must set DO_NOT_TRACK and TURBO_TELEMETRY_DISABLED to '1'");
	}

	const on = workflow.on;
	const events =
		typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : Object.keys(asMap(on));
	for (const event of forbiddenEvents.filter((name) => events.includes(name))) {
		report(["on", event], `${event} is not allowed`);
	}
	const requiredTypes = requiredPrTypes[file];
	if (requiredTypes) {
		const trigger = asMap(asMap(on).pull_request);
		const types = asList(trigger.types);
		if (
			Object.keys(trigger).join() !== "types" ||
			types.length !== requiredTypes.length ||
			!requiredTypes.every((type) => types.includes(type))
		) {
			report(
				["on", "pull_request"],
				"must preserve required PR events without path/branch filters",
			);
		}
	}
	if (events.includes("push")) {
		const push = asMap(asMap(on).push);
		const branches = asList(push.branches);
		const hasTags = Object.hasOwn(push, "tags");
		const m10Tags =
			hasTags &&
			(file === ".github/workflows/release.yml" || file === ".github/workflows/mobile.yml") &&
			Array.isArray(push.tags) &&
			push.tags.length === 1 &&
			push.tags[0] === "m10-rc-*";
		const filters = Object.keys(push).filter(
			(key) => !["branches", "paths", "paths-ignore", "tags"].includes(key),
		);
		if (
			filters.length > 0 ||
			(hasTags && !m10Tags) ||
			(branches.length === 0 && (Object.hasOwn(push, "branches") || !m10Tags)) ||
			branches.some((b) => !pushBranches.has(String(b)))
		) {
			report(
				["on", "push"],
				"push may only run on the branches main or spikes-run/**, or the single m10-rc-* tag pattern in release.yml or mobile.yml",
			);
		}
	}
	if (file === ".github/workflows/ci.yml") {
		if (!isDeepStrictEqual(workflow.defaults, { run: { shell: "bash" } })) {
			report(["defaults"], "must preserve the CI execution shell");
		}
		if (!isDeepStrictEqual(asMap(asMap(workflow.jobs).changes).outputs, ciChangesOutputs)) {
			report(["jobs", "changes", "outputs"], "must preserve classifier job output mappings");
		}
		for (const [job, controls] of Object.entries(ciControls)) {
			const definition = asMap(asMap(workflow.jobs)[job]);
			const actual = Object.fromEntries(
				Object.entries(definition).filter(
					([key]) =>
						["if", "needs", "strategy", "env"].includes(key) || Object.hasOwn(controls, key),
				),
			);
			const allowed = [
				"name",
				"runs-on",
				"timeout-minutes",
				"outputs",
				"steps",
				...Object.keys(controls),
			];
			if (
				!isMap(asMap(workflow.jobs)[job]) ||
				!isDeepStrictEqual(actual, controls) ||
				Object.keys(definition).some((key) => !allowed.includes(key))
			) {
				report(["jobs", job], `must preserve ${job} job execution controls`);
			}
			if (job === "spike-run" && definition.outputs !== undefined)
				report(
					["jobs", job, "outputs"],
					"spike-run completion must come from its validated receipt",
				);
			if (job !== "required" && job !== "changes" && job !== "spike-run") {
				const expectedOutputs: YamlMap = {
					source: `\${{ steps.source.outputs.source }}`,
					...(job === "spikes" ? { completed: `\${{ steps.collect.outputs.completed }}` } : {}),
					...(job === "heavy" ? { completed: `\${{ steps.complete.outputs.completed }}` } : {}),
					...(job in nativePlatforms
						? { "native-transport": `\${{ steps.native.outputs.native-transport }}` }
						: {}),
				};
				if (!isDeepStrictEqual(definition.outputs, expectedOutputs))
					report(["jobs", job, "outputs"], "must preserve source and native completion outputs");
			}
			checkCommands(job, definition, [
				...(["required", "spike-run", "spikes", "heavy"].includes(job) ? [] : [sourceCapture]),
				...(ciCommands[job] ?? []),
			]);
			if (["spike-run", "spikes", "heavy"].includes(job)) {
				const budget = job === "spikes" ? 5 : 30;
				if (definition["runs-on"] !== "ubuntu-24.04" || definition["timeout-minutes"] !== budget)
					report(["jobs", job], "must preserve the standard shard runner and time budget");
			}
			if (job === "spike-run" || job === "heavy") {
				const steps = asList(definition.steps).map(asMap);
				const rustAt = steps.findIndex((step) =>
					String(step.uses).startsWith("dtolnay/rust-toolchain@"),
				);
				const cacheAt = steps.findIndex((step) =>
					String(step.uses).startsWith("Swatinem/rust-cache@"),
				);
				const nodeAt = steps.findIndex((step) => step.uses === ciNode.uses);
				const installAt = steps.findIndex((step) => step.run === "pnpm install --frozen-lockfile");
				const withoutName = (step: YamlMap | undefined): YamlMap =>
					Object.fromEntries(Object.entries(step ?? {}).filter(([key]) => key !== "name"));
				if (
					steps.filter((step) => String(step.uses).startsWith("dtolnay/rust-toolchain@")).length !==
						1 ||
					steps.filter((step) => String(step.uses).startsWith("Swatinem/rust-cache@")).length !==
						1 ||
					rustAt <= nodeAt ||
					cacheAt <= rustAt ||
					cacheAt >= installAt ||
					!isDeepStrictEqual(withoutName(steps[rustAt]), {
						uses: `dtolnay/rust-toolchain@${actionPins["dtolnay/rust-toolchain"]?.[0]}`,
						if: "needs.changes.outputs.rust != ''",
						with: { toolchain: rustToolchain, components: "clippy, rustfmt" },
					}) ||
					!isDeepStrictEqual(withoutName(steps[cacheAt]), {
						uses: `Swatinem/rust-cache@${actionPins["Swatinem/rust-cache"]?.[0]}`,
						if: "needs.changes.outputs.rust != ''",
						with: { workspaces: `\${{ needs.changes.outputs.rust }}` },
					})
				)
					report(
						["jobs", job, "steps"],
						"must preserve selected Rust setup and cache before install",
					);
			}
			if (job in nativePlatforms) {
				const platform = nativePlatforms[job as keyof typeof nativePlatforms];
				if (definition["runs-on"] !== platform.runner || definition["timeout-minutes"] !== 30)
					report(["jobs", job], "must preserve the native runner and time budget");
				const rustSteps = asList(definition.steps)
					.map(asMap)
					.filter((step) => String(step.uses).startsWith("dtolnay/rust-toolchain@"));
				const expectedRust: YamlMap = {
					uses: `dtolnay/rust-toolchain@${actionPins["dtolnay/rust-toolchain"]?.[0]}`,
					...(job === "full"
						? { if: "needs.changes.outputs.rust != ''" }
						: job === "windows"
							? { if: nativeSelected }
							: {}),
					with: { toolchain: rustToolchain, components: "clippy, rustfmt" },
				};
				if (rustSteps.length !== 1 || !isDeepStrictEqual(rustSteps[0], expectedRust))
					report(["jobs", job, "steps"], "must preserve the pinned native Rust setup");
				for (const step of asList(definition.steps).map(asMap)) {
					const ordinaryCondition = Object.hasOwn(asMap(step.env), "SPIKES")
						? "needs.changes.outputs.spikes != '' || needs.changes.outputs.ordinary-heavy != ''"
						: "needs.changes.outputs.ordinary-heavy != ''";
					if (
						job === "full" &&
						String(step.run).includes("tools/verify/turbo.ts run test:heavy") &&
						Object.hasOwn(asMap(step.env), "HEAVY") &&
						(asMap(step.env).HEAVY !== `\${{ needs.changes.outputs.ordinary-heavy }}` ||
							step.if !== ordinaryCondition)
					)
						report(
							["jobs", job, "steps"],
							"ordinary heavy suites must exclude the dedicated native selector",
						);
				}
			}
		}
		for (const job of ["spike-run", "heavy"]) {
			const steps = asList(asMap(asMap(workflow.jobs)[job]).steps).map(asMap);
			const caches = steps.flatMap((step, index) => (step.id === "browser-cache" ? [index] : []));
			const cacheAt = caches[0] ?? -1;
			const cache = Object.fromEntries(
				Object.entries(steps[cacheAt] ?? {}).filter(([key]) => key !== "name"),
			);
			const planAt = steps.findIndex((step) => step.id === "browser-setup");
			const installAt = steps.findIndex(
				(step) => step.run === "node tools/ci-checks/src/browser-setup.ts install",
			);
			if (
				caches.length !== 1 ||
				!isDeepStrictEqual(cache, browserCache) ||
				cacheAt <= planAt ||
				cacheAt >= installAt
			) {
				report(
					["jobs", job, "steps"],
					"must preserve the selected browser cache between its plan and install",
				);
			}
		}
	}
	if (file === ".github/workflows/pr-title.yml") {
		if (workflow.defaults !== undefined) {
			report(["defaults"], "pr-title.yml must not define workflow execution defaults");
		}
		checkCommands("pr-title", asMap(asMap(workflow.jobs)["pr-title"]), prTitleCommands);
	}

	for (const scalar of doc.scalars) {
		if (scalar.path.at(-1) !== "uses") continue;
		const [, action = "", sha] = pinnedUses.exec(String(scalar.value)) ?? [];
		const pin = actionPins[action];
		const where = `${file}:${scalar.line}`;
		if (!sha) problems.push(`${where}: uses must be owner/repo@<40-hex SHA> # <version>`);
		else if (!pin) problems.push(`${where}: ${action} is not in the pinned actions table`);
		else if (sha !== pin[0] || scalar.comment !== pin[1]) {
			problems.push(`${where}: ${action} must be @${pin[0]} # ${pin[1]}`);
		}
	}

	for (const [job, definition] of Object.entries(asMap(workflow.jobs))) {
		const jobMap = asMap(definition);
		const name = jobMap.name ?? job;
		if (
			typeof name !== "string" ||
			(name.includes("${{") &&
				!computedNames.some(
					([owner, id, reviewed]) => file === owner && job === id && name === reviewed,
				))
		) {
			report(["jobs", job, "name"], "unreviewed computed job name");
		}
		for (const [protectedName, owner, id] of [
			["required", ".github/workflows/ci.yml", "required"],
			["pr-title", ".github/workflows/pr-title.yml", "pr-title"],
		] as const) {
			if (String(name).includes(protectedName) && (file !== owner || job !== id)) {
				report(["jobs", job, "name"], "protected check name belongs to its required workflow job");
			}
		}
		if (
			Object.hasOwn(jobMap, "permissions") &&
			!readOnly(jobMap.permissions) &&
			!(reviewedLabels && job === "sync-labels")
		) {
			report(["jobs", job, "permissions"], "job permissions may only be `contents: read`");
		}
		for (const [index, value] of asList(jobMap.steps).entries()) {
			const at = ["jobs", job, "steps", index];
			const step = asMap(value);
			if (file === ".github/workflows/ci.yml" && String(step.run).includes("test:heavy")) {
				const selected = (ciCommands[job] ?? []).find((command) =>
					String(command.run).includes("test:heavy"),
				);
				if (
					!["spike-run", "heavy"].includes(job) ||
					!isDeepStrictEqual(
						Object.fromEntries(Object.entries(step).filter(([key]) => key !== "name")),
						selected,
					)
				)
					report(at, "test:heavy must preserve the selected shard or ordinary-heavy command");
			}
			const action = String(step.uses).split("@")[0];
			const inputs = asMap(step.with);
			const persist = inputs["persist-credentials"];
			if (action === "actions/checkout" && persist !== false && persist !== "false") {
				report(at, "actions/checkout needs persist-credentials: false");
			}
			if (action === "dtolnay/rust-toolchain" && String(inputs.toolchain) !== rustToolchain) {
				report(at, `dtolnay/rust-toolchain needs toolchain: ${rustToolchain}`);
			}
			const uploads = String(inputs.path ?? "")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			const receipt =
				file === ".github/workflows/ci.yml" &&
				job === "required" &&
				uploads.length === 1 &&
				uploads[0] === `\${{ runner.temp }}/ci-verification.json` &&
				inputs["retention-days"] === 7 &&
				inputs["if-no-files-found"] === "error";
			const nativeReceipt =
				(reviewedNativeStore && job === "native-store") ||
				(reviewedNativeSupervisor && job === "native-supervisor");
			const shardReceipt =
				file === ".github/workflows/ci.yml" &&
				job === "spike-run" &&
				isDeepStrictEqual(
					Object.fromEntries(Object.entries(step).filter(([key]) => key !== "name")),
					spikeUpload,
				);
			if (
				action === "actions/upload-artifact" &&
				!receipt &&
				!nativeReceipt &&
				!shardReceipt &&
				(uploads.length === 0 || uploads.some((p) => !evidence.test(p) || p.includes("..")))
			) {
				report(
					at,
					"upload-artifact may only upload spikes/*/evidence/, the fixed CI receipt or the trusted native receipt, never an installable build",
				);
			}
			for (const [expression, body = ""] of String(step.run ?? "").matchAll(expressions)) {
				if (untrusted.test(body)) {
					report(at, `run must not expand ${expression}; pass it through env`);
				}
			}
		}
	}
	return problems;
}
