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
