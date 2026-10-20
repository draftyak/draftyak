export const requiredForms: readonly string[] = [
	"bug",
	"feature",
	"channel-plugin",
	"ai-provider",
	"tool-plugin",
	"docs",
];

export interface MetadataInputs {
	labels: unknown;
	chooser: unknown;
	forms: Readonly<Record<string, unknown>>;
	codeowners: string;
	pullRequest: string;
	contributing: string;
	trackedPaths: readonly string[];
}

export interface MetadataProblem {
	file: string;
	rule: string;
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

const requiredLabels: readonly string[] = [
	"good first issue",
	"help wanted",
	"needs-changeset",
	"security-sensitive",
	"breaking-change",
	..."hub desktop mobile sms-host sdk python mcp api ai channel docs ci"
		.split(" ")
		.map((area) => `area:${area}`),
	..."bug feature proposal docs maintenance test".split(" ").map((type) => `type:${type}`),
	..."channel ai tool".split(" ").map((plugin) => `plugin:${plugin}`),
	..."triage needs-info accepted in-progress blocked"
		.split(" ")
		.map((status) => `status:${status}`),
];

// These required fields describe the reviewed forms; the checker permits extra fields.
const formFields: Readonly<Record<string, readonly string[]>> = {
	bug: ["version", "environment", "reproduction", "expected", "observed"],
	feature: ["problem", "proposal", "alternatives"],
	"channel-plugin": ["channel", "use_case", "api", "boundaries", "testing"],
	"ai-provider": ["provider", "interface", "policy", "routing", "tests"],
	"tool-plugin": ["proposal_type", "kind", "rfc", "inputs", "data_flow", "tests"],
	docs: ["location", "problem", "correction"],
};

const protectedRoots: readonly string[] = [
	".github/",
	"tools/ci-checks/",
	"tools/verify/",
	"tools/launch-checks/",
	"tools/vendor-guard/",
	"tools/fetch-node/",
	"tools/release-guard/",
	"tools/android-manifest-guard/",
	"tools/egress-recorder/",
	"tools/sign-sms-host/",
	"packages/protocol/",
	"packages/mime/",
	"packages/extensions/",
	"packages/runtime-python/",
	"packages/bounded-files/",
	"packages/lookup-core/",
	"apps/mcp-apps/",
	"apps/sms-host/",
	"crates/",
	"security/",
	..."key-manager kernel store audit credentials recovery extensions identity auth authz policy accounts plugins devicehost tools outbox mcp oauth-as api listeners"
		.split(" ")
		.map((module) => `apps/hub/src/${module}`),
	"spikes/kit/env-live.ts",
	"spikes/kit/evidence.ts",
	"spikes/s12-sms/schema/",
	"spikes/s12-sms/src/receive-report.ts",
	"spikes/s12-sms/probe-android/",
	"package.json",
	"pnpm-workspace.yaml",
];

const conditionalRoots: readonly string[] = [
	"packages/bounded-files/",
	"packages/lookup-core/",
	"apps/hub/src/listeners",
];

// GitHub uses the last matching CODEOWNERS rule. This repository's policy uses
// ordinary rooted paths and glob stars; unsupported syntax fails explicitly.
function ownerPattern(pattern: string): RegExp {
	if (!pattern || /[![\]\\]/.test(pattern)) throw new Error("unsupported CODEOWNERS pattern");
	const anchored = pattern.startsWith("/") || pattern.replace(/\/$/, "").includes("/");
	const value = pattern.replace(/^\//, "").replace(/\/$/, "");
	let regex = anchored ? "^" : "(?:^|/)";
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (character === "*" && value[index + 1] === "*") {
			if (
				(index > 0 && value[index - 1] !== "/") ||
				(index + 2 < value.length && value[index + 2] !== "/")
			) {
				throw new Error("unsupported embedded double star");
			}
			if (value[index + 2] === "/") {
				regex += "(?:.*/)?";
				index += 2;
			} else {
				regex += ".*";
				index++;
			}
		} else if (character === "*") regex += "[^/]*";
		else if (character === "?") regex += "[^/]";
		else regex += character?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "";
	}
	const finalSegment = value.slice(value.lastIndexOf("/") + 1);
	const suffix = pattern.endsWith("/") ? "/.*" : !/[?*]/.test(finalSegment) ? "(?:/.*)?" : "";
	return new RegExp(`${regex}${suffix}$`);
}

function withinRoot(file: string, root: string): boolean {
	return root.endsWith("/")
		? file.startsWith(root)
		: root.startsWith("apps/hub/src/")
			? file === `${root}.ts` || file.startsWith(`${root}/`)
			: file === root;
}

function isProtected(file: string): boolean {
	return protectedRoots.some((root) => withinRoot(file, root));
}

function taskCheckboxes(source: string): string[] {
	const checkboxes: string[] = [];
	let fence: string | undefined;
	let inComment = false;
	for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
		if (fence) {
			if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \t]*$`).exec(line)?.[0] === line)
				fence = undefined;
			continue;
		}
		if (!inComment) {
			const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
			if (opening) {
				if (opening[1]?.startsWith("`") && line.slice(opening[0].length).includes("`")) return [];
				fence = opening[1];
				continue;
			}
		}
		// Fenced contents are literal. Outside fences, keep comment state in order;
		// never delete a span that might contain a meaningful fence boundary.
		let hasComment = inComment;
		let cursor = 0;
		while (cursor < line.length) {
			if (inComment) {
				const end = line.indexOf("-->", cursor);
				if (end < 0) break;
				inComment = false;
				cursor = end + 3;
			} else {
				const start = line.indexOf("<!--", cursor);
				const outsideComment = line.slice(cursor, start < 0 ? undefined : start);
				if (/<\/?[a-z][a-z0-9-]*(?=[\s/>]|$)/i.test(outsideComment)) return [];
				if (/<[!?]/.test(outsideComment)) return [];
				if (start < 0) break;
				if (!/^ {0,3}$/.test(line.slice(0, start))) return [];
				hasComment = true;
				inComment = true;
				cursor = start + 2;
			}
		}
		if (!hasComment && /^- \[[ x]\][ \t]/i.test(line)) checkboxes.push(line);
	}
	return checkboxes;
}

export function checkMetadata(input: MetadataInputs): MetadataProblem[] {
	const problems: MetadataProblem[] = [];
	const report = (file: string, rule: string): void => {
		problems.push({ file, rule });
	};
	const labels = new Set<string>();
	if (!Array.isArray(input.labels)) report(".github/labels.yml", "labels must be a sequence");
	for (const row of Array.isArray(input.labels) ? input.labels : []) {
		const label = object(row);
		if (!nonempty(label.name) || labels.has(label.name))
			report(".github/labels.yml", "label names must be nonempty and unique");
		else labels.add(label.name);
		if (typeof label.color !== "string" || !/^[a-f0-9]{6}$/i.test(label.color))
			report(".github/labels.yml", "label colors must contain six hexadecimal digits");
		if (!nonempty(label.description))
			report(".github/labels.yml", "every label needs a description");
	}
	for (const label of requiredLabels)
		if (!labels.has(label)) report(".github/labels.yml", `missing required label ${label}`);
	const chooser = object(input.chooser);
	if (chooser.blank_issues_enabled !== false)
		report(".github/ISSUE_TEMPLATE/config.yml", "blank issues must be disabled");
	const contacts = Array.isArray(chooser.contact_links) ? chooser.contact_links.map(object) : [];
	for (const url of [
		"https://github.com/draftyak/draftyak/discussions",
		"https://github.com/draftyak/draftyak/security/advisories/new",
	]) {
		if (
			!contacts.some(
				(contact) => contact.url === url && nonempty(contact.name) && nonempty(contact.about),
			)
		)
			report(".github/ISSUE_TEMPLATE/config.yml", "missing discussion or private-security route");
	}
	for (const name of requiredForms) {
		const file = `.github/ISSUE_TEMPLATE/${name}.yml`;
		const form = object(input.forms[name]);
		if (!nonempty(form.name) || !nonempty(form.description))
			report(file, "form needs a name and description");
		if (
			!Array.isArray(form.labels) ||
			!form.labels.length ||
			form.labels.some((label: unknown) => typeof label !== "string" || !labels.has(label))
		)
			report(file, "form labels must name defined labels");
		if (!Array.isArray(form.body) || !form.body.length) {
			report(file, "form needs a nonempty body");
			continue;
		}
		const ids = new Set<string>();
		const fields = form.body.map(object);
		for (const field of fields) {
			const attrs = object(field.attributes);
			if (field.type === "markdown") {
				if (!nonempty(attrs.value)) report(file, "markdown fields need text");
				continue;
			}
			if (
				typeof field.type !== "string" ||
				!["input", "textarea", "dropdown", "checkboxes", "upload"].includes(field.type)
			)
				report(file, "unsupported form field type");
			if (!nonempty(field.id) || !/^[a-zA-Z0-9_-]+$/.test(field.id) || ids.has(field.id))
				report(file, "interactive field ids must be valid and unique");
			else ids.add(field.id);
			if (!nonempty(attrs.label)) report(file, "interactive fields need labels");
			const required = object(field.validations).required;
			if (required !== undefined && typeof required !== "boolean")
				report(file, "required validation must be boolean");
			if (
				field.type === "dropdown" &&
				(!Array.isArray(attrs.options) ||
					!attrs.options.length ||
					attrs.options.some((option) => !nonempty(option)))
			)
				report(file, "dropdown needs nonempty text options");
			if (
				field.type === "checkboxes" &&
				(!Array.isArray(attrs.options) ||
					!attrs.options.length ||
					attrs.options.some((option) => !nonempty(object(option).label)))
			)
				report(file, "checkboxes need labeled options");
		}
		for (const id of formFields[name] ?? []) {
			if (
				!fields.some(
					(field) =>
						field.type !== "markdown" &&
						field.id === id &&
						object(field.validations).required === true,
				)
			)
				report(file, `missing required ${id} field`);
		}
		if (
			name === "bug" &&
			!fields.some(
				(field) =>
					field.type === "checkboxes" &&
					Array.isArray(object(field.attributes).options) &&
					(object(field.attributes).options as unknown[]).some((option) => {
						const value = object(option);
						return (
							value.required === true &&
							typeof value.label === "string" &&
							/no (?:real )?message content/i.test(value.label)
						);
					}),
			)
		)
			report(file, "bug form needs a required no-message-content acknowledgement");
		if (
			name === "tool-plugin" &&
			!fields.some(
				(field) =>
					field.type !== "markdown" &&
					field.id === "rfc" &&
					object(field.validations).required === true,
			)
		)
			report(file, "tool proposal must require the RFC or existing-kind explanation");
	}
	if (Buffer.byteLength(input.codeowners) >= 3 * 1024 * 1024)
		report(".github/CODEOWNERS", "CODEOWNERS exceeds GitHub's size limit");
	const rules: { matches: RegExp; owners: string[] }[] = [];
	for (const line of input.codeowners.split(/\r?\n/)) {
		const text = line.split("#", 1)[0]?.trim();
		if (!text) continue;
		const [pattern, ...owners] = text.split(/\s+/);
		try {
			rules.push({ matches: ownerPattern(pattern ?? ""), owners });
		} catch {
			report(".github/CODEOWNERS", "unsupported ownership pattern");
		}
	}
	const probes = protectedRoots
		.filter(
			(root) =>
				!conditionalRoots.includes(root) ||
				input.trackedPaths.some((file) => withinRoot(file, root)),
		)
		.flatMap((root) =>
			root.endsWith("/")
				? [`${root}ownership-check.ts`, `${root}nested/ownership-check.ts`]
				: root.startsWith("apps/hub/src/")
					? [`${root}/ownership-check.ts`, `${root}/nested/ownership-check.ts`]
					: [root],
		);
	for (const file of new Set([...probes, ...input.trackedPaths.filter(isProtected)])) {
		let owners: string[] = [];
		for (const rule of rules) if (rule.matches.test(file)) owners = rule.owners;
		if (!owners.includes("@nicksavov"))
			report(".github/CODEOWNERS", `owner review is missing for ${file}`);
	}
	const checkboxes = taskCheckboxes(input.pullRequest);
	for (const [name, pattern] of [
		["tests", /tests?/i],
		["changeset", /changeset/i],
		["docs", /documentation/i],
		["DCO", /DCO.*sign-off/i],
		["security paths", /security-sensitive.*paths/i],
		["approval and data boundaries", /approval.*credentials.*consent.*outbound/i],
	] as const)
		if (!checkboxes.some((line) => pattern.test(line)))
			report(".github/pull_request_template.md", `missing ${name} checkbox`);
	for (const [name, pattern] of [
		["DCO 1.1", /DCO.*1\.1|Origin 1\.1/i],
		["no CLA", /no contributor licence agreement|no CLA/i],
		["human sign-off", /human contributor.*sign off/i],
		["Windows setup", /setting up on Windows/i],
		["changesets", /changeset/i],
		["security paths", /security-sensitive paths/i],
		["channel guide", /adding a channel/i],
	] as const)
		if (!pattern.test(input.contributing)) report("CONTRIBUTING.md", `missing ${name} guidance`);
	return problems.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
}
