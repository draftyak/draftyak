import { isDeepStrictEqual } from "node:util";
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
// These are the only reviewed computed names. The spike name always has a literal separator,
// so even arbitrary matrix values cannot report exactly `required` or `pr-title`.
const computedNames = [
	[".github/workflows/ci.yml", "required", requiredName],
	[".github/workflows/spikes.yml", "run", `\${{ matrix.spike }} on \${{ matrix.os }}`],
] as const;
const requiredPrTypes: Readonly<Record<string, readonly string[]>> = {
	".github/workflows/ci.yml": ["opened", "synchronize", "reopened", "ready_for_review"],
	".github/workflows/pr-title.yml": ["opened", "edited", "synchronize", "reopened"],
};
const nonDocs = "needs.changes.outputs.docs-only != 'true'";
const ciControls: Readonly<Record<string, YamlMap>> = {
	changes: {},
	cheap: { needs: "changes" },
	full: {
		needs: "changes",
		if: `${nonDocs} && (github.event_name != 'pull_request' || !github.event.pull_request.draft)`,
	},
	windows: {
		needs: "changes",
		if: `${nonDocs} && (github.ref == 'refs/heads/main' || (github.event_name == 'pull_request' && !github.event.pull_request.draft))`,
	},
	required: { needs: ["changes", "cheap", "full", "windows"], if: "always()" },
};
const ciCommands: Readonly<Record<string, readonly YamlMap[]>> = {
	cheap: [
		{
			if: "needs.changes.outputs.docs-only == 'true'",
			run: "node tools/verify/verify.ts --profile docs",
		},
		{ if: nonDocs, run: "pnpm install --frozen-lockfile" },
		{ if: nonDocs, run: "pnpm verify --profile cheap" },
	],
	full: [
		{ run: "pnpm install --frozen-lockfile" },
		{ run: "pnpm build" },
		{
			if: "needs.changes.outputs.spikes != '' || needs.changes.outputs.heavy != ''",
			env: {
				SPIKES: `\${{ needs.changes.outputs.spikes }}`,
				HEAVY: `\${{ needs.changes.outputs.heavy }}`,
				SMOKE: `\${{ needs.changes.outputs.template-smoke == 'true' || github.ref == 'refs/heads/main' || github.base_ref == 'main' }}`,
			},
			run: [
				"filters=()",
				'for dir in $SPIKES; do filters+=("--filter=./$dir"); done',
				"while IFS= read -r filter; do",
				'  if [ -n "$filter" ]; then filters+=("--filter=$filter"); fi',
				'done <<< "$HEAVY"',
				"# The template smoke packs and installs, so it runs only for its own packages and global",
				"# changes, on main and on PRs into main.",
				'if [ "$SMOKE" != true ] && [ -f packages/create-plugin/package.json ]; then',
				'  filters+=("--filter=!./packages/create-plugin")',
				"fi",
				`node tools/verify/turbo.ts run test:heavy "\${filters[@]}"`,
				"",
			].join("\n"),
		},
	],
	windows: [
		{ run: "pnpm install --frozen-lockfile" },
		{ run: "pnpm verify", env: { TURBO_CONCURRENCY: "1" } },
	],
};
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
			const matches = steps.flatMap((step, index) => (step.run === expected.run ? [index] : []));
			const index = matches[0] ?? -1;
			const step = Object.fromEntries(
				Object.entries(steps[index] ?? {}).filter(([key]) => key !== "name"),
			);
			if (matches.length !== 1 || index <= previous || !isDeepStrictEqual(step, expected)) {
				report(
					["jobs", job, "steps"],
					`must preserve ${job} command and its execution controls: ${expected.run}`,
				);
			}
			previous = index;
		}
	};
	const workflow = asMap(doc.value);
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
		const filters = Object.keys(push).filter(
			(key) => !["branches", "paths", "paths-ignore"].includes(key),
		);
		if (
			filters.length > 0 ||
			branches.length === 0 ||
			branches.some((b) => !pushBranches.has(String(b)))
		) {
			report(["on", "push"], "push may only run on the branches main or spikes-run/**");
		}
	}
	if (file === ".github/workflows/ci.yml") {
		if (!isDeepStrictEqual(workflow.defaults, { run: { shell: "bash" } })) {
			report(["defaults"], "must preserve the CI execution shell");
		}
		for (const [job, controls] of Object.entries(ciControls)) {
			const definition = asMap(asMap(workflow.jobs)[job]);
			const actual = Object.fromEntries(
				Object.entries(definition).filter(([key]) => ["if", "needs"].includes(key)),
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
			checkCommands(job, definition, ciCommands[job] ?? []);
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
		if (Object.hasOwn(jobMap, "permissions") && !readOnly(jobMap.permissions)) {
			report(["jobs", job, "permissions"], "job permissions may only be `contents: read`");
		}
		for (const [index, value] of asList(jobMap.steps).entries()) {
			const at = ["jobs", job, "steps", index];
			const step = asMap(value);
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
			if (
				action === "actions/upload-artifact" &&
				!receipt &&
				(uploads.length === 0 || uploads.some((p) => !evidence.test(p) || p.includes("..")))
			) {
				report(
					at,
					"upload-artifact may only upload spikes/*/evidence/ or the fixed CI receipt, never an installable build",
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
