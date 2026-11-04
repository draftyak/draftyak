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
const unnamed = (step: YamlMap): YamlMap =>
	Object.fromEntries(Object.entries(step).filter(([key]) => key !== "name"));
const only = (step: YamlMap, keys: readonly string[]): boolean =>
	Object.keys(step).every((key) => keys.includes(key));
// The owner/repo of a `uses:` step, sub-path actions included; "" for a `run:` step.
const actionOf = (step: YamlMap | undefined): string =>
	/^[\w.-]+\/[\w.-]+/.exec(String(step?.uses ?? ""))?.[0] ?? "";
const isAction = (step: YamlMap | undefined): boolean =>
	step?.uses !== undefined && step.run === undefined;

const pushBranches = new Set(["main", "spikes-run/**"]);
const forbiddenEvents = ["pull_request_target", "workflow_run"];
const telemetryOff = ["DO_NOT_TRACK", "TURBO_TELEMETRY_DISABLED"];
// Names that make Node or bash load a file before a step's own command, in any case.
const preloadEnv = ["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV"];
// The only env names a job that runs the reserved gate may set, since its gate step inherits
// them; every other such job sets none.
const reviewedJobEnv: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
	".github/workflows/ci.yml": {
		"spike-run": ["DRAFTYAK_STRICT_SKIPS", "SHARD_ID", "SPIKE", "SPIKES"],
		heavy: ["DRAFTYAK_STRICT_SKIPS"],
	},
	".github/workflows/spikes.yml": {
		run: ["DRAFTYAK_STRICT_SKIPS", "DRAFTYAK_NODES", "DRAFTYAK_CACHE_DIR"],
	},
};
// The env names, besides the telemetry switches, that a workflow whose jobs run the reserved gate
// may set, since each of its gate steps inherits them: the approval binding workflows' run
// settings, none of which makes Node or bash load a file.
const bindingEnv = ["CI", "DRAFTYAK_STRICT_SKIPS", "DRAFTYAK_APPROVAL_BINDING_RUNS"];
const reviewedWorkflowEnv: Readonly<Record<string, readonly string[]>> = {
	".github/workflows/nightly.yml": bindingEnv,
	".github/workflows/security.yml": bindingEnv,
};
// Names in a sentence: a, b and c.
const inWords = (names: readonly string[]): string =>
	names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
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
const windowsIf = `${nonDocs} && (github.ref == 'refs/heads/main' || (github.event_name == 'pull_request' && !github.event.pull_request.draft) || (github.event_name != 'pull_request' && ${nativeSelected}))`;
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
	windows: { needs: "changes", if: windowsIf },
	macos: { needs: "changes", if: `${nonDocs} && ${readyRun} && ${nativeSelected}` },
	// The reserved suites' opted-in proofs, each in a log of its own; reserved-windows wherever
	// windows runs.
	reserved: { needs: "changes", if: nonDocs },
	"reserved-windows": { needs: "changes", if: windowsIf },
	required: {
		needs: [
			"changes",
			"cheap",
			"full",
			"spikes",
			"heavy",
			"windows",
			"macos",
			"reserved",
			"reserved-windows",
		],
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

// In every workflow, each job that runs a command runs the reserved gate on its own checkout
// before any repository code or other action, since another job's gate proves nothing about this
// checkout, and the pre-install check is the last command before each install.
const gate = "node tools/verify/gate.ts";
const preinstall = "node tools/verify/preinstall.ts";
const install = "pnpm install --frozen-lockfile";
// The second checkout of native-store.yml and native-supervisor.yml, at source/, which the trusted
// checkout's gate and pre-install check read with --root before pnpm starts there.
const sourceGate = `${gate} --root source`;
const sourcePreinstall = `${preinstall} --root source`;
const beforeGate = new Set(["actions/checkout", "actions/setup-node"]);
// Before the gate, setup-node reads only the pinned Node version (a cache input starts a package
// manager in the unchecked checkout), and neither action sets an env, which its Node would read.
const pinnedNode = { "node-version-file": ".node-version" };
const plainBeforeGate = (step: YamlMap): boolean =>
	only(step, ["name", "uses", "with"]) &&
	(actionOf(step) === "actions/checkout" || isDeepStrictEqual(step.with, pinnedNode));
// A step that runs a command or may start a package manager in the checkout.
const startsCommand = (step: YamlMap): boolean =>
	step.run !== undefined ||
	actionOf(step) === "pnpm/action-setup" ||
	(actionOf(step) === "actions/setup-node" && !plainBeforeGate(step));
const packageManager = /(?<![\w.-])(?:pnpm|pnpx|npm|npx|yarn|corepack)(?![\w.-])/i;
// A git command, after git's own options, that rewrites the working tree or adds files to it: after
// the gate, it would leave a tree the gate never saw.
const treeCommands = [
	"checkout",
	"switch",
	"reset",
	"restore",
	"stash",
	"pull",
	"merge",
	"rebase",
	"cherry-pick",
	"revert",
	"am",
	"apply",
	"read-tree",
	"checkout-index",
	"worktree",
	"sparse-checkout",
	"submodule",
	"bisect",
	"clone",
];
const treeChange = new RegExp(
	String.raw`(?<![\w./-])git(?:\s+(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace|exec-path|config-env)\s+\S+|-{1,2}[\w-]+(?:=\S+)?))*\s+(?:${treeCommands.join("|")})(?![\w.-])`,
	"i",
);
// What a step that may start a package manager in the checkout is, for the rules that must come
// first: pnpm/action-setup, setup-node with more than the pinned version (a cache input runs one),
// or a command that names one; null for any other step.
const packageManagerStart = (step: YamlMap): string | null => {
	if (actionOf(step) === "pnpm/action-setup") return "pnpm/action-setup";
	if (actionOf(step) === "actions/setup-node" && !isDeepStrictEqual(step.with, pinnedNode)) {
		return "setup-node with more than the pinned Node version";
	}
	if (typeof step.run === "string" && packageManager.test(step.run)) {
		return "a command that names a package manager";
	}
	return null;
};
// The status functions: a condition that calls one, success() included, no longer gets the success()
// GitHub otherwise puts first, so it may run after an earlier step failed or was cancelled.
const statusFunction = /(?<![\w.])(?:always|failure|cancelled|success)\s*\(/i;
// Whether `expression` has an || outside parentheses, brackets and string literals ('' escapes a
// quote), or unbalanced ones.
const topLevelOr = (expression: string): boolean => {
	let depth = 0;
	for (let at = 0; at < expression.length; at++) {
		const char = expression[at];
		if (char === "'") {
			at++;
			while (at < expression.length && (expression[at] !== "'" || expression[at + 1] === "'")) {
				at += expression[at] === "'" ? 2 : 1;
			}
			if (at >= expression.length) return true;
		} else if (char === "(" || char === "[") depth++;
		else if (char === ")" || char === "]") depth--;
		else if (char === "|" && expression[at + 1] === "|" && depth === 0) return true;
		if (depth < 0) return true;
	}
	return depth !== 0;
};
// A condition that runs only after every earlier step passed: one that calls no status function, or
// success() alone or as the leading conjunct of the whole condition, with no status call after it.
const onSuccessOnly = (condition: Yaml | undefined): boolean => {
	const text = String(condition ?? "").trim();
	if (!statusFunction.test(text)) return true;
	const inner = /^\$\{\{([\s\S]*)\}\}$/.exec(text)?.[1];
	const expression = inner !== undefined && !/\$\{\{|\}\}/.test(inner) ? inner.trim() : text;
	const rest = /^success\s*\(\s*\)\s*(?:&&([\s\S]*))?$/i.exec(expression);
	if (rest === null) return false;
	return !statusFunction.test(rest[1] ?? "") && !topLevelOr(rest[1] ?? "");
};
const uploadPin = `actions/upload-artifact@${actionPins["actions/upload-artifact"]?.[0]}`;
// After the gate, the only steps that may run when an earlier one failed: the CI receipt's upload,
// which reports refused trees too, and spikes.yml's evidence check and upload, which need its heavy
// step to have run, and its shell-only elapsed-time line.
const afterFailure: Readonly<Record<string, Readonly<Record<string, readonly YamlMap[]>>>> = {
	".github/workflows/ci.yml": {
		required: [
			{
				if: "always()",
				uses: uploadPin,
				with: {
					name: `ci-verification-\${{ github.run_id }}-\${{ github.run_attempt }}`,
					path: `\${{ runner.temp }}/ci-verification.json`,
					"if-no-files-found": "error",
					"retention-days": 7,
				},
			},
		],
	},
	".github/workflows/spikes.yml": {
		run: [
			{
				id: "evidence",
				if: "always() && (steps.heavy.outcome == 'success' || steps.heavy.outcome == 'failure')",
				run: "node tools/ci-checks/src/spikes-run.ts --check-evidence",
			},
			{
				uses: uploadPin,
				if: "always() && steps.evidence.outcome == 'success'",
				with: {
					name: `evidence_\${{ matrix.spike }}_\${{ matrix.os }}`,
					path: "spikes/*/evidence/",
					"if-no-files-found": "warn",
					overwrite: true,
					"retention-days": 7,
				},
			},
			{
				if: "always()",
				env: { STARTED: `\${{ steps.start.outputs.at }}`, RUNNER: `\${{ matrix.os }}` },
				run: [
					"minutes=$(( ($(date +%s) - STARTED + 59) / 60 ))",
					'line="about $minutes min of elapsed runner time on $RUNNER, counted from the first step"',
					'echo "$line"',
					`printf '### Elapsed runner time\\n\\n%s\\n' "$line" >> "$GITHUB_STEP_SUMMARY"`,
					"",
				].join("\n"),
			},
		],
	},
};
// The gate step inherits these, so nothing may set another shell or a working folder.
const bashDefaults = { run: { shell: "bash" } };
// An install by any package manager, also after options (pnpm --dir x i); line continuations are
// joined first.
const installCommand =
	/\b(?:pnpm|npm|yarn|corepack)(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+(?:i|install|ci|add)\b/;
// The one step of each reserved job that carries the flag, and nothing else in it.
const flag = { DRAFTYAK_RESERVED_TESTS: "1" };
const unitProof = { env: flag, run: "node tools/verify/reserved-proof.ts --tier unit" };
// Whether a value names the opt-in flag, in any case, as a key or in any string inside it.
const flagName = /DRAFTYAK_RESERVED_TESTS/i;
const namesFlag = (value: Yaml | undefined): boolean =>
	typeof value === "string"
		? flagName.test(value)
		: Array.isArray(value)
			? value.some(namesFlag)
			: isMap(value) &&
				Object.entries(value).some(([key, inner]) => flagName.test(key) || namesFlag(inner));
// Each ci.yml job's own commands, after the gate and, in every job but required, the source
// capture, which the check puts first; the shard, collector and ordinary-heavy jobs list their
// own checkout and setup-node, and the gate right after them.
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
		{ if: nonDocs, run: preinstall },
		{ if: nonDocs, run: install },
		{ if: nonDocs, run: "pnpm verify --profile cheap" },
	],
	full: [{ run: preinstall }, { run: install }, { run: "pnpm build" }],
	"spike-run": [
		ciCheckout,
		ciNode,
		{ run: gate },
		{ run: "node tools/ci-checks/src/heavy-shards.ts validate" },
		{ run: preinstall },
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
			env: flag,
			run: ['node tools/verify/reserved-proof.ts --tier heavy "--filter=./$SPIKE"', ""].join("\n"),
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
		{ run: gate },
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
		{ run: gate },
		sourceCapture,
		{ run: preinstall },
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
		{ run: preinstall },
		{ run: install },
		{ run: "pnpm verify", env: { TURBO_CONCURRENCY: "1" } },
	],
	reserved: [
		{
			if: "github.event_name == 'pull_request'",
			env: {
				BASE_SHA: `\${{ github.event.pull_request.base.sha || github.event.before }}`,
				BASE_REPO: `\${{ github.repository }}`,
				HEAD_REPO: `\${{ github.event.pull_request.head.repo.full_name }}`,
				HEAD_REF: `\${{ github.event.pull_request.head.ref }}`,
			},
			run: "node tools/ci-checks/src/reserved-inventory.ts",
		},
		{ run: preinstall },
		{ run: install },
		unitProof,
	],
	"reserved-windows": [{ run: preinstall }, { run: install }, unitProof],
	required: [
		{
			env: {
				CI_NEEDS: `\${{ toJSON(needs) }}`,
				CI_HEAD_SHA: `\${{ github.event.pull_request.head.sha || github.sha }}`,
				CI_BASE_SHA: `\${{ github.event.pull_request.base.sha || github.event.before }}`,
				CI_PR_DRAFT: `\${{ github.event.pull_request.draft == true }}`,
			},
			run: "node tools/ci-checks/src/verification-receipt.ts report",
		},
	],
};
// spikes.yml's run job may start its clock, test the item's commit, clear its evidence and turn
// off Spotlight before the gate, with exactly these steps; the gate then checks the tested tree.
const spikesStart: readonly YamlMap[] = [
	{ id: "start", run: 'echo "at=$(date +%s)" >> "$GITHUB_OUTPUT"' },
	{
		if: "github.event_name == 'push'",
		run: [
			'if [ "$(git diff --name-only HEAD^ HEAD)" != spikes/run.json ]; then',
			'  echo "::error::a spikes-run branch holds HEAD plus spikes/run.json: start runs with pnpm spikes:run"',
			"  exit 1",
			"fi",
			"git checkout --quiet --detach HEAD^",
			"",
		].join("\n"),
	},
	{
		run: [
			"git ls-files -z -- 'spikes/*/evidence/*' | git update-index -z --skip-worktree --stdin",
			"rm -rf spikes/*/evidence",
			"",
		].join("\n"),
	},
	{
		if: "runner.os == 'macOS'",
		run: `sudo mdutil -a -i off || echo "::warning::mdutil couldn't turn off Spotlight indexing"`,
	},
];
// The one install that isn't pnpm's own: the JavaScript pnpm for Intel macOS, without its scripts.
const intelMacPnpm = [
	'dest="$RUNNER_TEMP/pnpm-js"',
	'mkdir -p "$dest"',
	'cp .github/pnpm-js/package.json .github/pnpm-js/package-lock.json "$dest/"',
	'npm ci --prefix "$dest" --ignore-scripts --no-audit --no-fund',
	`want="$(node -p "require('./package.json').packageManager.replace(/^pnpm@/, '').split('+')[0]")"`,
	'got="$("$dest/node_modules/.bin/pnpm" --version)"',
	'if [ "$got" != "$want" ]; then',
	'  echo "::error::.github/pnpm-js installs pnpm $got, but packageManager pins $want"',
	"  exit 1",
	"fi",
	'echo "$dest/node_modules/.bin" >> "$GITHUB_PATH"',
	"",
].join("\n");
const spikesCommands: Readonly<Record<string, readonly YamlMap[]>> = {
	plan: [
		{ run: gate },
		{
			id: "plan",
			env: {
				RUN_SPIKES: `\${{ inputs.spikes }}`,
				RUN_OS: `\${{ inputs.os }}`,
				RUN_NODE: `\${{ inputs.node }}`,
				RUN_TESTS: `\${{ inputs.tests }}`,
			},
			run: "node tools/ci-checks/src/spikes-run.ts --plan",
		},
	],
	run: [
		{ run: gate },
		// Before pnpm/action-setup starts pnpm, and again as the last command before the install.
		{ run: preinstall },
		{ if: "runner.os == 'macOS' && runner.arch == 'X64'", run: intelMacPnpm },
		{ run: preinstall },
		{ run: install },
		{
			id: "heavy",
			env: {
				SPIKE: `\${{ matrix.spike }}`,
				XVFB: `\${{ matrix.tauriLinux }}`,
				TESTS: `\${{ matrix.tests }}`,
			},
			// Only a spike whose own folder is reserved runs its heavy command opted in.
			run: [
				'heavy=(pnpm --filter "./spikes/$SPIKE" --fail-if-no-match run test:heavy)',
				'read -r -a tests <<< "$TESTS"',
				`if [ "\${#tests[@]}" -gt 0 ]; then heavy+=(-- "\${tests[@]}"); fi`,
				`if [ "$XVFB" = true ]; then heavy=(xvfb-run --auto-servernum "\${heavy[@]}"); fi`,
				"reserved=0",
				'node reserved-tests.ts --reserved "spikes/$SPIKE" || reserved=$?',
				'if [ "$reserved" = 0 ]; then',
				`  heavy=(env DRAFTYAK_RESERVED_TESTS=1 "\${heavy[@]}")`,
				'elif [ "$reserved" != 1 ]; then',
				'  exit "$reserved"',
				"fi",
				`"\${heavy[@]}"`,
				"",
			].join("\n"),
		},
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
			? [platformCheck, { run: preinstall }, { run: install }, execute]
			: [platformCheck, ...(ciCommands[job] ?? []), execute];
}
const prTitleCommands: readonly YamlMap[] = [
	{ run: gate },
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
				{ name: "Reserved paths and execution inputs", run: gate },
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
				// The trusted gate and pre-install check on the admitted source, from this checkout.
				{ name: "Reserved paths and execution inputs of the source", run: sourceGate },
				{ name: "Pre-install script check of the source", run: sourcePreinstall },
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
					name: "Set up Node",
					uses: `actions/setup-node@${actionPins["actions/setup-node"]?.[0]}`,
					with: { "node-version-file": ".node-version" },
				},
				{ name: "Reserved paths and execution inputs", run: gate },
				{ name: "Pre-install script check", run: preinstall },
				{
					name: "Set up pnpm",
					uses: `pnpm/action-setup@${actionPins["pnpm/action-setup"]?.[0]}`,
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
		// A command listed more than once must appear exactly that often, its nth listing matching its
		// nth step; an action is listed by its uses and its id.
		const listed: YamlMap[] = [];
		for (const expected of commands) {
			const kind = typeof expected.run === "string" ? "run" : "uses";
			const same = (other: YamlMap): boolean =>
				other[kind] === expected[kind] && (kind === "run" || other.id === expected.id);
			const nth = listed.filter(same).length;
			listed.push(expected);
			const wanted = commands.filter(same).length;
			const matches = steps.flatMap((step, index) => (same(step) ? [index] : []));
			const index = matches[nth] ?? -1;
			const step = unnamed(steps[index] ?? {});
			const duplicateId =
				typeof expected.id === "string" &&
				steps.filter((step) => step.id === expected.id).length !== 1;
			if (
				matches.length !== wanted ||
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
	// Before the gate, only checkout, setup-node and the given reviewed steps; the gate step itself
	// bare, and no checkout after it, except the one source checkout of an exact native contract,
	// which its own gate and pre-install check read with --root, and no git command that changes the
	// working tree.
	const gateFirst = (
		job: string,
		definition: YamlMap,
		start: readonly YamlMap[],
		sourceCheckout = false,
	): void => {
		const steps = asList(definition.steps).map(asMap);
		const at = steps.findIndex((step) =>
			isAction(step)
				? !beforeGate.has(actionOf(step))
				: !start.some((reviewed) => isDeepStrictEqual(unnamed(step), reviewed)),
		);
		const first = steps[at];
		if (first?.run !== gate) {
			const allowed =
				start.length === 0
					? "checkout and setup-node"
					: "checkout, setup-node and its reviewed start steps";
			report(
				["jobs", job, "steps"],
				`${job} must run the reserved gate (${gate}) first; only ${allowed} may come before it`,
			);
			return;
		}
		if (!only(first, ["name", "run"])) {
			report(
				["jobs", job, "steps", at],
				`${job}'s reserved gate step may set only its name and run, with no if, env or continue-on-error`,
			);
		}
		for (const [index, step] of steps.slice(0, at).entries()) {
			if (isAction(step) && !plainBeforeGate(step)) {
				report(
					["jobs", job, "steps", index],
					`${job}'s checkout and setup-node before the reserved gate may set only their name, uses and with, and setup-node only node-version-file: .node-version`,
				);
			}
		}
		// The gate lists the one checkout at the root: another, say into an ignored folder, it never sees.
		const early = steps.slice(0, at).filter((step) => actionOf(step) === "actions/checkout");
		const elsewhere = (step: YamlMap): boolean =>
			Object.keys(asMap(step.with)).some((key) =>
				["path", "repository"].includes(key.toLowerCase()),
			);
		if (early.length > 1 || early.some(elsewhere)) {
			report(
				["jobs", job, "steps"],
				`${job} may check out only once before the reserved gate, at the root and with no path or repository`,
			);
		}
		const later = steps.slice(at + 1).filter((step) => actionOf(step) === "actions/checkout");
		const reviewed =
			sourceCheckout && later.length === 1 && asMap(later[0]?.with).path === "source";
		if (later.length > 0 && !reviewed) {
			report(["jobs", job, "steps"], `${job} must not check out again after the reserved gate`);
		}
		for (const [offset, step] of steps.slice(at + 1).entries()) {
			if (typeof step.run === "string" && treeChange.test(step.run)) {
				report(
					["jobs", job, "steps", at + 1 + offset],
					`${job} must not change its working tree with git after the reserved gate`,
				);
			}
		}
		// A later step that runs after a failure would run after a refused gate or check too.
		const late = afterFailure[file]?.[job] ?? [];
		for (const [offset, step] of steps.slice(at + 1).entries()) {
			if (
				!onSuccessOnly(step.if) &&
				!late.some((allowed) => isDeepStrictEqual(unnamed(step), allowed))
			) {
				report(
					["jobs", job, "steps", at + 1 + offset],
					`${job}'s steps after the reserved gate may not use always(), failure() or cancelled(), or success() other than first before &&, except its reviewed ones`,
				);
			}
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
	// The one job of each exact native contract, which checks out the admitted source at source/
	// after its gate and checks it there with --root before pnpm starts.
	const admittedSource = (job: string): boolean =>
		(reviewedNativeStore && job === "native-store") ||
		(reviewedNativeSupervisor && job === "native-supervisor");
	const ci = file === ".github/workflows/ci.yml";
	const spikes = file === ".github/workflows/spikes.yml";
	if (ci) {
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
	if (ci) {
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
			// Every job starts with the gate, required too, since it runs after every other job even
			// when another job's gate refused the tree; every other job then captures its source. The
			// shard, collector and ordinary-heavy jobs list the gate after their checkout and setup-node.
			checkCommands(job, definition, [
				...(["spike-run", "spikes", "heavy"].includes(job) ? [] : [{ run: gate }]),
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
	if (spikes) {
		// A shell that isn't bash would skip the gate as surely as removing it.
		if (!isDeepStrictEqual(workflow.defaults, bashDefaults)) {
			report(["defaults"], "must preserve the spikes execution shell");
		}
		for (const [job, commands] of Object.entries(spikesCommands)) {
			checkCommands(job, asMap(asMap(workflow.jobs)[job]), commands);
		}
	}
	if (file === ".github/workflows/pr-title.yml") {
		if (workflow.defaults !== undefined) {
			report(["defaults"], "pr-title.yml must not define workflow execution defaults");
		}
		checkCommands("pr-title", asMap(asMap(workflow.jobs)["pr-title"]), prTitleCommands);
	}
	// Every job that runs a command or may start a package manager starts with the gate, in any
	// workflow; a job of other actions alone, such as zizmor's, runs no repository code.
	const gated = Object.entries(asMap(workflow.jobs))
		.map(([job, definition]) => [job, asMap(definition)] as const)
		.filter(([, definition]) =>
			asList(definition.steps).some((step) => startsCommand(asMap(step))),
		);
	if (
		gated.length > 0 &&
		Object.hasOwn(workflow, "defaults") &&
		!isDeepStrictEqual(workflow.defaults, bashDefaults)
	) {
		report(
			["defaults"],
			"workflow defaults may set only the bash shell, since each reserved gate step inherits them",
		);
	}
	for (const [job, definition] of gated) {
		if (Object.hasOwn(definition, "defaults")) {
			report(
				["jobs", job, "defaults"],
				`${job} must not set defaults, since its reserved gate step inherits them`,
			);
		}
		gateFirst(job, definition, spikes && job === "run" ? spikesStart : [], admittedSource(job));
	}
	// Each gate step inherits its workflow's env, its job's env and its job container's. Where a job
	// runs the gate, the workflow env holds only the telemetry switches and the workflow's reviewed
	// names, and that job's env only its reviewed names, with no container; elsewhere neither env may
	// make Node or bash load a file.
	const preloads = (value: Yaml | undefined): boolean =>
		Object.keys(asMap(value)).some((name) => preloadEnv.includes(name.toUpperCase()));
	const workflowEnv = [...telemetryOff, ...(reviewedWorkflowEnv[file] ?? [])];
	const noPreload =
		"may not set NODE_OPTIONS, NODE_PATH, BASH_ENV or ENV, which make Node or bash load a file before a step's command";
	if (gated.length === 0) {
		if (preloads(workflow.env)) report(["env"], `env ${noPreload}`);
	} else if (
		Object.hasOwn(workflow, "env") &&
		(!isMap(workflow.env) ||
			Object.keys(asMap(workflow.env)).some((name) => !workflowEnv.includes(name)))
	) {
		report(
			["env"],
			`env may hold only ${inWords(workflowEnv)}, since each reserved gate step inherits it`,
		);
	}
	const gatedIds = new Set(gated.map(([job]) => job));
	for (const [job, definition] of Object.entries(asMap(workflow.jobs))) {
		const jobMap = asMap(definition);
		if (!gatedIds.has(job)) {
			if (preloads(jobMap.env)) report(["jobs", job, "env"], `${job}'s env ${noPreload}`);
			continue;
		}
		const reviewed = reviewedJobEnv[file]?.[job] ?? [];
		if (
			Object.hasOwn(jobMap, "env") &&
			(!isMap(jobMap.env) ||
				Object.keys(asMap(jobMap.env)).some((name) => !reviewed.includes(name)))
		) {
			report(
				["jobs", job, "env"],
				reviewed.length === 0
					? `${job} must not set env, since its reserved gate step inherits it`
					: `${job}'s env may hold only ${inWords(reviewed)}, since its reserved gate step inherits it`,
			);
		}
		if (Object.hasOwn(jobMap, "container")) {
			report(
				["jobs", job, "container"],
				`${job} must not run in a container, whose env and options its reserved gate step would inherit`,
			);
		}
	}
	// The opt-in flag only on the reviewed proof steps, each unchanged in its own job: in no other
	// step, job setting or workflow setting, as a name or in any text.
	const flagOnly =
		"DRAFTYAK_RESERVED_TESTS may appear only on the reviewed reserved proof steps, unchanged";
	const without = (map: YamlMap, key: string): YamlMap =>
		Object.fromEntries(Object.entries(map).filter(([name]) => name !== key));
	if (namesFlag(without(workflow, "jobs"))) report([], flagOnly);
	const reviewedCommands: Readonly<Record<string, readonly YamlMap[]>> = ci
		? ciCommands
		: spikes
			? spikesCommands
			: {};
	for (const [job, definition] of Object.entries(asMap(workflow.jobs))) {
		const jobMap = asMap(definition);
		if (namesFlag(without(jobMap, "steps"))) report(["jobs", job], flagOnly);
		const flagged = (reviewedCommands[job] ?? []).filter(namesFlag);
		for (const [index, step] of asList(jobMap.steps).map(asMap).entries()) {
			const own = unnamed(step);
			if (namesFlag(own) && !flagged.some((reviewed) => isDeepStrictEqual(own, reviewed))) {
				report(["jobs", job, "steps", index], flagOnly);
			}
		}
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
		const steps = asList(jobMap.steps).map(asMap);
		const gateAt = steps.findIndex((step) => step.run === gate);
		for (const [index, step] of steps.entries()) {
			const at = ["jobs", job, "steps", index];
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
				ci &&
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
			// The pre-install check is the last command before each install and runs whenever it does;
			// in every workflow the gate and the check, with no condition or the step's own, also come
			// before each step that may start a package manager in the checkout. Only the exact native
			// contracts set up pnpm for their source checkout, checked there with --root, and only
			// native-store's installs in it.
			const nativeSource = admittedSource(job);
			if (step.run === install) {
				let before = index - 1;
				while (before >= 0 && isAction(steps[before])) before--;
				const check = steps[before];
				const wanted = nativeSource ? sourcePreinstall : preinstall;
				if (check?.run !== wanted) {
					report(at, `${job} must run ${wanted} as the last command before ${install}`);
				} else if (
					!only(check, ["name", "if", "run"]) ||
					(check.if !== undefined && !isDeepStrictEqual(check.if, step.if))
				) {
					report(
						["jobs", job, "steps", before],
						`${job}'s pre-install check may set only its name, run and its install's if`,
					);
				}
				const source = nativeSource && step["working-directory"] === "source";
				if (
					!only(step, source ? ["name", "if", "run", "working-directory"] : ["name", "if", "run"])
				) {
					report(at, `${job}'s ${install} step may set only its name, if and run`);
				}
			}
			// A command before the gate is a reviewed start step, or refused as any other would be.
			const starts = step.run !== undefined && index < gateAt ? null : packageManagerStart(step);
			if (starts !== null) {
				const earlier = steps.slice(0, index);
				const wanted = nativeSource ? [preinstall, sourcePreinstall] : [preinstall];
				const checks = earlier.filter((other) => wanted.includes(String(other.run)));
				// As before an install, only a check that sets nothing but its name, if and run counts:
				// one marked continue-on-error, say, can't stop what follows it.
				const plain = checks.filter((check) => only(check, ["name", "if", "run"]));
				if (checks.length === 0) {
					report(at, `${job} must run ${preinstall} before ${starts}`);
				} else if (plain.length === 0) {
					report(
						at,
						`${job}'s pre-install check before ${starts} may set only its name, if and run`,
					);
				} else if (
					!plain.some((check) => check.if === undefined || isDeepStrictEqual(check.if, step.if))
				) {
					report(
						at,
						`${job}'s pre-install check before ${starts} must run whenever it does, with no if or the same if`,
					);
				}
				if (!earlier.some((other) => other.run === gate)) {
					report(at, `${job} must run ${gate} before ${starts}`);
				}
			}
			// Input names are case-insensitive.
			if (
				actionOf(step) === "pnpm/action-setup" &&
				Object.keys(inputs).some((key) => key.toUpperCase() === "RUN_INSTALL")
			) {
				report([...at, "with"], "pnpm/action-setup must not set run_install");
			}
			// Every install is exactly the checked one, or Intel macOS's scriptless pnpm.
			const command = typeof step.run === "string" ? step.run.replace(/\\\r?\n/g, " ") : "";
			if (installCommand.test(command) && step.run !== install && step.run !== intelMacPnpm) {
				report(
					at,
					`install commands must be exactly ${install}, or the reviewed Intel macOS pnpm step`,
				);
			}
		}
	}
	return problems;
}
