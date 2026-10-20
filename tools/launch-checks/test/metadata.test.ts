import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, expect, test } from "vitest";
import { checkMetadata, type MetadataInputs, requiredForms } from "../src/metadata.ts";
import { loadMetadata, parseMetadataYaml } from "../src/metadata-cli.ts";

let baseline: MetadataInputs;
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../src/metadata-cli.ts", import.meta.url));
const fixtures: string[] = [];
beforeAll(async () => {
	baseline = await loadMetadata(repository);
});

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await rm(fixture, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "draftyak-launch-metadata-"));
	fixtures.push(root);
	const files = [
		"CONTRIBUTING.md",
		".github/labels.yml",
		".github/CODEOWNERS",
		".github/pull_request_template.md",
		".github/ISSUE_TEMPLATE/config.yml",
		...requiredForms.map((name) => `.github/ISSUE_TEMPLATE/${name}.yml`),
	];
	for (const relative of files) {
		await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
		await copyFile(path.join(repository, relative), path.join(root, relative));
	}
	execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
	execFileSync("git", ["add", "--", ...files], { cwd: root, stdio: "ignore" });
	return root;
}

function runCli(args: string[]): SpawnSyncReturns<string> {
	return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

function copy(): MetadataInputs {
	return structuredClone(baseline);
}

test("the actual reviewed launch metadata satisfies the structural audit", () => {
	expect(checkMetadata(baseline)).toEqual([]);
});

test("a deleted label fails even when no form references it", () => {
	const input = copy();
	input.labels = (input.labels as { name: string }[]).filter(
		(label) => label.name !== "good first issue",
	);
	expect(checkMetadata(input)).toContainEqual({
		file: ".github/labels.yml",
		rule: "missing required label good first issue",
	});
});

test("duplicate names, invalid colors and blank descriptions fail independently", () => {
	const input = copy();
	(input.labels as unknown[]).push({ name: "good first issue", color: "red", description: " " });
	const rules = checkMetadata(input).map((problem) => problem.rule);
	expect(rules).toContain("label names must be nonempty and unique");
	expect(rules).toContain("label colors must contain six hexadecimal digits");
	expect(rules).toContain("every label needs a description");
});

test("a dangling form label is diagnosed on its form", () => {
	const input = copy();
	(input.forms.docs as { labels: string[] }).labels.push("type:undefined");
	expect(checkMetadata(input)).toContainEqual({
		file: ".github/ISSUE_TEMPLATE/docs.yml",
		rule: "form labels must name defined labels",
	});
});

test.each(["bug", "feature", "channel-plugin", "ai-provider", "tool-plugin", "docs"])(
	"a missing %s form fails",
	(name) => {
		const input = copy();
		delete (input.forms as Record<string, unknown>)[name];
		expect(checkMetadata(input).some((problem) => problem.file.endsWith(`/${name}.yml`))).toBe(
			true,
		);
	},
);

test("an optional privacy acknowledgement does not satisfy the bug form", () => {
	const input = copy();
	const body = (
		input.forms.bug as { body: { id: string; attributes: { options?: { required: boolean }[] } }[] }
	).body;
	const field = body.find((entry) => entry.id === "privacy");
	if (!field?.attributes.options?.[0]) throw new Error("baseline has no privacy option");
	field.attributes.options[0].required = false;
	expect(checkMetadata(input)).toContainEqual({
		file: ".github/ISSUE_TEMPLATE/bug.yml",
		rule: "bug form needs a required no-message-content acknowledgement",
	});
});

test("markdown cannot impersonate the bug privacy checkbox even with required options", () => {
	const input = copy();
	const bug = input.forms.bug as {
		body: { id: string; type: string; attributes: { value?: string } }[];
	};
	const field = bug.body.find((entry) => entry.id === "privacy");
	if (!field) throw new Error("baseline has no privacy option");
	field.type = "markdown";
	field.attributes.value = "Read these instructions";
	expect(checkMetadata(input)).toContainEqual({
		file: ".github/ISSUE_TEMPLATE/bug.yml",
		rule: "bug form needs a required no-message-content acknowledgement",
	});
});

test("required reproduction fields cannot silently become optional", () => {
	const input = copy();
	const bug = input.forms.bug as { body: { id: string; validations?: { required: boolean } }[] };
	const field = bug.body.find((entry) => entry.id === "reproduction");
	if (!field?.validations) throw new Error("baseline has no reproduction field");
	field.validations.required = false;
	expect(checkMetadata(input)).toContainEqual({
		file: ".github/ISSUE_TEMPLATE/bug.yml",
		rule: "missing required reproduction field",
	});
});

test.each([
	["bug", "reproduction"],
	["tool-plugin", "rfc"],
] as const)(
	"an array-valued field type cannot impersonate the required %s %s input",
	(name, id) => {
		const input = copy();
		const form = input.forms[name] as { body: { id?: string; type: unknown }[] };
		const field = form.body.find((entry) => entry.id === id);
		if (!field) throw new Error("baseline has no required field");
		field.type = [field.type];
		expect(checkMetadata(input)).toContainEqual({
			file: `.github/ISSUE_TEMPLATE/${name}.yml`,
			rule: "unsupported form field type",
		});
	},
);

test("the chooser refuses blank issues and a public security route", () => {
	const input = copy();
	const chooser = input.chooser as {
		blank_issues_enabled: boolean;
		contact_links: { url: string }[];
	};
	chooser.blank_issues_enabled = true;
	chooser.contact_links = chooser.contact_links.filter(
		(contact) => !contact.url.includes("advisories"),
	);
	expect(
		checkMetadata(input).filter((problem) => problem.file.endsWith("/config.yml")),
	).toHaveLength(2);
});

test.each([
	["bug", "reproduction"],
	["tool-plugin", "rfc"],
] as const)("markdown cannot impersonate the required %s %s input", (formName, id) => {
	const input = copy();
	const form = input.forms[formName] as { body: { id?: string }[] };
	form.body = form.body.map((field) =>
		field.id === id
			? {
					type: "markdown",
					id,
					attributes: { value: "Instructions only" },
					validations: { required: true },
				}
			: field,
	);
	expect(checkMetadata(input)).toContainEqual({
		file: `.github/ISSUE_TEMPLATE/${formName}.yml`,
		rule: `missing required ${id} field`,
	});
});

test("a later CODEOWNERS override cannot remove the protected path's owner", () => {
	const input = copy();
	input.codeowners += "\n/apps/hub/src/authz/ @someone-else\n";
	expect(checkMetadata(input)).toContainEqual({
		file: ".github/CODEOWNERS",
		rule: "owner review is missing for apps/hub/src/authz/ownership-check.ts",
	});
});

test("actual protected files are checked beyond representative probes", () => {
	const input = copy();
	input.codeowners += "\n/apps/hub/src/listeners/proxy.ts @someone-else\n";
	input.trackedPaths = [...input.trackedPaths, "apps/hub/src/listeners/proxy.ts"];
	expect(checkMetadata(input)).toContainEqual({
		file: ".github/CODEOWNERS",
		rule: "owner review is missing for apps/hub/src/listeners/proxy.ts",
	});
});

test.each(["packages/bounded-files/", "packages/lookup-core/", "apps/hub/src/listeners/"])(
	"conditional security root %s requires effective recursive ownership when present",
	(root) => {
		const input = copy();
		input.codeowners += `\n/${root} @someone-else\n/${root}* @nicksavov\n`;
		input.trackedPaths = [...input.trackedPaths, `${root}nested/guard.ts`];
		expect(checkMetadata(input)).toContainEqual({
			file: ".github/CODEOWNERS",
			rule: `owner review is missing for ${root}nested/guard.ts`,
		});
		input.codeowners += `/${root} @nicksavov\n`;
		expect(checkMetadata(input)).toEqual([]);
	},
);

test("conditional roots are not hypothetical implementation prerequisites", () => {
	const input = copy();
	input.codeowners = input.codeowners
		.split("\n")
		.filter((line) => !/bounded-files|lookup-core|listeners/.test(line))
		.join("\n");
	input.trackedPaths = input.trackedPaths.filter(
		(file) =>
			!/^(packages\/(?:bounded-files|lookup-core)\/|apps\/hub\/src\/listeners[/.])/.test(file),
	);
	expect(checkMetadata(input)).toEqual([]);
});

test("root defaults and double-star patterns retain real CODEOWNERS ordering", () => {
	const input = copy();
	input.codeowners =
		"* @nicksavov\n/apps/**/unprotected.ts @someone-else\n/apps/**/unprotected.ts @nicksavov\n";
	input.trackedPaths = [...input.trackedPaths, "apps/hub/src/authz/unprotected.ts"];
	expect(checkMetadata(input)).toEqual([]);
});

test("a trailing single star covers direct files but cannot cover a nested security module", () => {
	const input = copy();
	input.codeowners =
		"* @nicksavov\n/apps/hub/src/authz/ @someone-else\n/apps/hub/src/authz/* @nicksavov\n";
	input.trackedPaths = [
		...input.trackedPaths,
		"apps/hub/src/authz/direct.ts",
		"apps/hub/src/authz/nested/private.ts",
	];
	const result = checkMetadata(input);
	expect(result).toContainEqual({
		file: ".github/CODEOWNERS",
		rule: "owner review is missing for apps/hub/src/authz/nested/private.ts",
	});
	expect(result.some((problem) => problem.rule.endsWith("authz/direct.ts"))).toBe(false);
	input.codeowners += "/apps/hub/src/authz/ @nicksavov\n";
	expect(checkMetadata(input)).toEqual([]);
});

test("unsupported CODEOWNERS negation cannot turn into a passing audit", () => {
	const input = copy();
	input.codeowners += "\n!/security/ @nicksavov\n";
	expect(checkMetadata(input)).toContainEqual({
		file: ".github/CODEOWNERS",
		rule: "unsupported ownership pattern",
	});
});

test("ordinary module stars are shallow and embedded double stars are refused", () => {
	const input = copy();
	input.codeowners +=
		"\n/apps/hub/src/authz/ @someone-else\n/apps/hub/src/authz.ts @someone-else\n/apps/hub/src/auth* @nicksavov\n";
	input.trackedPaths = [
		...input.trackedPaths,
		"apps/hub/src/authz.ts",
		"apps/hub/src/authz/nested/private.ts",
	];
	const report = checkMetadata(input);
	expect(report.some((problem) => problem.rule.endsWith("for apps/hub/src/authz.ts"))).toBe(false);
	expect(report).toContainEqual({
		file: ".github/CODEOWNERS",
		rule: "owner review is missing for apps/hub/src/authz/nested/private.ts",
	});
	input.codeowners += "/apps/hub/src/auth** @nicksavov\n";
	expect(checkMetadata(input)).toContainEqual({
		file: ".github/CODEOWNERS",
		rule: "unsupported ownership pattern",
	});
});

test("a directory-only CODEOWNERS pattern cannot restore ownership of a same-named file", () => {
	const input = copy();
	input.codeowners =
		"* @nicksavov\n/package.json @someone-else\n/package.json/ @nicksavov\n/security/ @nicksavov\n";
	const result = checkMetadata(input);
	expect(result).toContainEqual({
		file: ".github/CODEOWNERS",
		rule: "owner review is missing for package.json",
	});
	expect(result.some((problem) => problem.rule.includes("for security/"))).toBe(false);
});

const lineEndings = [
	["LF", "\n"],
	["CRLF", "\r\n"],
	["CR", "\r"],
] as const;
const prControls = [
	["tests", "tests"],
	["changeset", "changeset"],
	["docs", "documentation"],
	["DCO", "DCO sign-off"],
	["security paths", "security-sensitive paths"],
	["approval and data boundaries", "approval credentials consent outbound"],
] as const;
const prControlLines = prControls.map(([, text]) => `- [ ] ${text}`);

function expectMissingPrControls(input: MetadataInputs): void {
	const result = checkMetadata(input);
	expect(result).toHaveLength(prControls.length);
	for (const [name] of prControls)
		expect(result).toContainEqual({
			file: ".github/pull_request_template.md",
			rule: `missing ${name} checkbox`,
		});
}

test.each(lineEndings)(
	"PR checklist line endings %s preserve visible controls",
	(_name, ending) => {
		const input = copy();
		input.pullRequest = ["plain", ...prControlLines].join(ending);
		expect(checkMetadata(input)).toEqual([]);
	},
);

test.each(lineEndings)(
	"PR checklist line endings %s hide controls after a mixed-ending fence opener",
	(_name, ending) => {
		for (const fence of ["```", "~~~"]) {
			const input = copy();
			input.pullRequest = `plain${ending}${fence}\n${prControlLines.join("\n")}\n${fence}\n`;
			expectMissingPrControls(input);
		}
	},
);

test.each(lineEndings)(
	"PR checklist line endings %s close a fence before visible controls",
	(_name, ending) => {
		for (const fence of ["```", "~~~"]) {
			const input = copy();
			input.pullRequest = `${fence}\nexample\n${fence}${ending}${prControlLines.join("\n")}\n`;
			expect(checkMetadata(input)).toEqual([]);
		}
	},
);

test.each(lineEndings)(
	"PR checklist line endings %s keep a consistently ended fenced checklist hidden",
	(_name, ending) => {
		for (const fence of ["```", "~~~"]) {
			const input = copy();
			input.pullRequest = ["plain", fence, ...prControlLines, fence].join(ending);
			expectMissingPrControls(input);
		}
	},
);

test.each(["visible", "hidden"])(
	"PR checklist line endings survive the real CLI for %s lone-CR controls",
	async (kind) => {
		const root = await fixture();
		const source =
			kind === "visible"
				? ["plain", ...prControlLines].join("\r")
				: `plain\r~~~\n${prControlLines.join("\n")}\n~~~\n`;
		await writeFile(path.join(root, ".github/pull_request_template.md"), source);
		const result = runCli([root]);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(kind === "visible" ? 0 : 1);
		expect(result.stdout).toBe(`launch metadata: ${kind === "visible" ? 0 : 6} problems\n`);
		if (kind === "visible") expect(result.stderr).toBe("");
		else
			for (const [name] of prControls)
				expect(result.stderr).toContain(
					`.github/pull_request_template.md: missing ${name} checkbox\n`,
				);
	},
);

test.each([" ", "x", "X"])(
	"a task-marker %j without a separator cannot satisfy required PR controls",
	(marker) => {
		const input = copy();
		input.pullRequest = input.pullRequest.replace(/^- \[[ x]\][ \t]+/gim, `- [${marker}]`);
		expect(
			checkMetadata(input).filter((problem) => problem.file === ".github/pull_request_template.md"),
		).toHaveLength(6);
	},
);

test.each([" ", "x", "X"])(
	"a task-marker %j with an ASCII space or tab preserves visible PR controls",
	(marker) => {
		for (const separator of [" ", "\t"]) {
			const input = copy();
			input.pullRequest = input.pullRequest.replace(
				/^- \[[ x]\][ \t]+/gim,
				`- [${marker}]${separator}`,
			);
			expect(checkMetadata(input)).toEqual([]);
		}
	},
);

test("PR review and contributor sign-off guidance cannot disappear", () => {
	const input = copy();
	input.pullRequest = "## Validation\n- [ ] Tests pass\n";
	input.contributing = "## Setup\nRun the tests.\n";
	const result = checkMetadata(input);
	expect(
		result.some(
			(problem) =>
				problem.file === ".github/pull_request_template.md" &&
				problem.rule === "missing DCO checkbox",
		),
	).toBe(true);
	expect(
		result.some(
			(problem) =>
				problem.file === "CONTRIBUTING.md" && problem.rule === "missing human sign-off guidance",
		),
	).toBe(true);
});

test.each(["backticks", "tildes", "comment", "unclosed-comment", "indented-code"])(
	"PR checklist examples inside %s cannot impersonate interactive task boxes",
	(kind) => {
		const input = copy();
		input.pullRequest =
			kind === "backticks"
				? `\`\`\`\`markdown\n${input.pullRequest}\n\`\`\`\`\n`
				: kind === "tildes"
					? `~~~markdown\n${input.pullRequest}\n~~~\n`
					: kind === "comment"
						? `<!--\n${input.pullRequest}\n-->`
						: kind === "unclosed-comment"
							? `<!--\n${input.pullRequest}`
							: input.pullRequest
									.split("\n")
									.map((line) => `    ${line}`)
									.join("\n");
		expect(checkMetadata(input)).toContainEqual({
			file: ".github/pull_request_template.md",
			rule: "missing DCO checkbox",
		});
	},
);

test("a fenced DCO decoy cannot replace one missing real checkbox among real controls", () => {
	const input = copy();
	const lines = input.pullRequest.split("\n");
	const dco = lines.find((line) => /^- \[ \].*DCO.*sign-off/.test(line));
	if (!dco) throw new Error("baseline has no DCO checkbox");
	input.pullRequest = `~~~markdown\n${dco}\n~~~\n${lines.filter((line) => line !== dco).join("\n")}`;
	expect(checkMetadata(input)).toContainEqual({
		file: ".github/pull_request_template.md",
		rule: "missing DCO checkbox",
	});
	input.pullRequest += `\n${dco}\n`;
	expect(checkMetadata(input)).toEqual([]);
});

test("fence-comment context cannot expose a second fenced checklist", () => {
	const input = copy();
	input.pullRequest = `\`\`\`text\n<!--\n\`\`\`\n-->\n\`\`\`\n${input.pullRequest}\n\`\`\``;
	const result = checkMetadata(input);
	expect(result).toHaveLength(6);
	for (const name of [
		"tests",
		"changeset",
		"docs",
		"DCO",
		"security paths",
		"approval and data boundaries",
	])
		expect(result).toContainEqual({
			file: ".github/pull_request_template.md",
			rule: `missing ${name} checkbox`,
		});
});

test("fence-comment literal markers in a closed fence preserve the visible real checklist", () => {
	const input = copy();
	input.pullRequest = `\`\`\`text\n<!--\n\`\`\`\n\n${input.pullRequest}`;
	expect(checkMetadata(input)).toEqual([]);
});

test("raw-HTML pre block cannot expose a literal checklist", () => {
	const input = copy();
	input.pullRequest = `<pre>\n${input.pullRequest}\n</pre>`;
	expect(checkMetadata(input)).toContainEqual({
		file: ".github/pull_request_template.md",
		rule: "missing DCO checkbox",
	});
});

test("raw-HTML partial opener at EOL cannot expose an unclosed literal checklist", () => {
	const input = copy();
	input.pullRequest = `<pre\n${input.pullRequest}`;
	expect(checkMetadata(input)).toContainEqual({
		file: ".github/pull_request_template.md",
		rule: "missing DCO checkbox",
	});
});

test("raw-HTML partial opener inside a closed fence preserves visible controls", () => {
	const input = copy();
	input.pullRequest = `~~~html\n<pre\n~~~\n${input.pullRequest}`;
	expect(checkMetadata(input)).toEqual([]);
});

const rawPrefixes = [
	["CDATA", "<![CDATA[\n", "\n]]>"],
	["processing", "<?xml\n", ""],
	["declaration", "<!DOCTYPE\n", "\n>"],
] as const;

test("backtick-info control refuses an invalid fence opener before a hidden checklist", () => {
	const input = copy();
	input.pullRequest = `\`\`\`bad\`\n\`\`\`\n${input.pullRequest}\n\`\`\``;
	expect(checkMetadata(input)).toContainEqual({
		file: ".github/pull_request_template.md",
		rule: "missing DCO checkbox",
	});
});

test("backtick-info literal in a tilde fence preserves visible controls", () => {
	const input = copy();
	input.pullRequest = `~~~bad\`\nexample\n~~~\n${input.pullRequest}`;
	expect(checkMetadata(input)).toEqual([]);
});

test("fence-whitespace NBSP cannot close a fence before a hidden checklist", () => {
	const input = copy();
	input.pullRequest = `\`\`\`text\nliteral\n\`\`\`\u00a0\n${input.pullRequest}`;
	expect(checkMetadata(input)).toContainEqual({
		file: ".github/pull_request_template.md",
		rule: "missing DCO checkbox",
	});
});

test("fence-whitespace ASCII space preserves a real closing fence and visible controls", () => {
	const input = copy();
	input.pullRequest = `\`\`\`text\nliteral\n\`\`\` \n${input.pullRequest}`;
	expect(checkMetadata(input)).toEqual([]);
});

test.each(["<!-->", "<!--->"])(
	"comment-opener %s closes on its opening line before a hidden checklist",
	(opener) => {
		const input = copy();
		input.pullRequest = `${opener}\n\`\`\`\n-->\n${input.pullRequest}\n\`\`\``;
		expect(checkMetadata(input)).toContainEqual({
			file: ".github/pull_request_template.md",
			rule: "missing DCO checkbox",
		});
	},
);

test.each(["<!-->", "<!--->"])(
	"comment-opener %s preserves the next visible real checklist",
	(opener) => {
		const input = copy();
		input.pullRequest = `${opener}\n${input.pullRequest}`;
		expect(checkMetadata(input)).toEqual([]);
	},
);

test.each(["inline-code", "indented-code"])(
	"comment-opener inside %s cannot hide a real fence boundary",
	(kind) => {
		const input = copy();
		const literal = kind === "inline-code" ? "`<!--`" : "    <!--\n";
		input.pullRequest = `${literal}\n\`\`\`\n-->\n${input.pullRequest}\n\`\`\``;
		expect(checkMetadata(input)).toContainEqual({
			file: ".github/pull_request_template.md",
			rule: "missing DCO checkbox",
		});
	},
);

test.each(rawPrefixes)(
	"raw-HTML declaration-prefix %s cannot expose a literal checklist",
	(_kind, start, end) => {
		const input = copy();
		input.pullRequest = start + input.pullRequest + end;
		expect(checkMetadata(input)).toContainEqual({
			file: ".github/pull_request_template.md",
			rule: "missing DCO checkbox",
		});
	},
);

test.each(rawPrefixes)(
	"raw-HTML declaration-prefix %s inside a fence preserves visible controls",
	(_kind, start, end) => {
		const input = copy();
		input.pullRequest = `~~~html\n${start}example${end}\n~~~\n${input.pullRequest}`;
		expect(checkMetadata(input)).toEqual([]);
	},
);

test.each(["fence", "comment"])(
	"raw-HTML examples inside a %s preserve visible controls",
	(kind) => {
		const input = copy();
		const example = "<pre>\nexample\n</pre>";
		input.pullRequest =
			(kind === "fence" ? `~~~html\n${example}\n~~~\n` : `<!--\n${example}\n-->\n`) +
			input.pullRequest;
		expect(checkMetadata(input)).toEqual([]);
	},
);

test.each([
	"name: one\nname: two\n",
	"name: [unterminated",
	"---\nname: one\n---\nname: two\n",
	"name: !unknown value",
	"source: &x [one]\ncopy: *x",
	"? [synthetic-collection-key]\n: ignored\n",
	"1: first\n'1': duplicate after coercion\n",
])("ambiguous, malformed or alias-expanding YAML fails: %s", (source) => {
	expect(() => parseMetadataYaml(source)).toThrow();
});

test("the real CLI succeeds for a synthetic worktree, including the shell separator", async () => {
	const root = await fixture();
	for (const args of [[root], ["--", root]]) {
		const result = runCli(args);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("launch metadata: 0 problems\n");
		expect(result.stderr).toBe("");
	}
});

test.runIf(process.platform === "win32")(
	"Windows repository-root casing aliases preserve the real CLI result",
	async () => {
		const root = await fixture();
		const result = runCli([root.toUpperCase()]);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("launch metadata: 0 problems\n");
		expect(result.stderr).toBe("");
	},
);

test("the real CLI returns a structural failure when a required label disappears", async () => {
	const root = await fixture();
	const labels = path.join(root, ".github/labels.yml");
	await writeFile(
		labels,
		(await readFile(labels, "utf8")).replace("good first issue", "other issue"),
	);
	const result = runCli([root]);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain(".github/labels.yml: missing required label good first issue");
	expect(result.stdout).toBe("launch metadata: 1 problems\n");
});

test("the real CLI rejects an array-valued required field type as a structural problem", async () => {
	const root = await fixture();
	const filename = path.join(root, ".github/ISSUE_TEMPLATE/bug.yml");
	const source = await readFile(filename, "utf8");
	const changed = source.replace(/type: textarea(\r?\n\s+id: reproduction)/, "type: [textarea]$1");
	expect(changed).not.toBe(source);
	await writeFile(filename, changed);
	const result = runCli([root]);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain(".github/ISSUE_TEMPLATE/bug.yml: unsupported form field type");
	expect(result.stdout).toBe("launch metadata: 1 problems\n");
});

test.each([{ args: [] }, { args: ["--help"] }, { args: ["one", "two"] }])(
	"invalid CLI arguments exit 2: %j",
	({ args }) => {
		const result = runCli(args);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("usage: launch-metadata <repository-root>");
		expect(result.stdout).toBe("");
	},
);

test.each(["missing", "directory", "oversized", "invalid-yaml", "collection-key"])(
	"the real CLI refuses a %s metadata input without echoing its contents",
	async (kind) => {
		const root = await fixture();
		const filename = path.join(root, ".github/labels.yml");
		if (kind === "missing" || kind === "directory") await unlink(filename);
		if (kind === "directory") await mkdir(filename);
		if (kind === "oversized") await writeFile(filename, "x".repeat(3 * 1024 * 1024));
		if (kind === "invalid-yaml") await writeFile(filename, "synthetic-marker: [unterminated");
		if (kind === "collection-key")
			await writeFile(
				path.join(root, ".github/ISSUE_TEMPLATE/bug.yml"),
				`${await readFile(path.join(root, ".github/ISSUE_TEMPLATE/bug.yml"), "utf8")}\n? [synthetic-collection-key]\n: ignored\n`,
			);
		const result = runCli([root]);
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("launch metadata: missing, unreadable, unsafe or invalid input\n");
	},
);

test("linked metadata files are refused", async () => {
	const root = await fixture();
	const original = path.join(root, ".github/labels.yml");
	const target = path.join(root, "synthetic-labels.yml");
	await copyFile(original, target);
	await unlink(original);
	await symlink(target, original, "file");
	await expect(loadMetadata(root)).rejects.toThrow("linked metadata input");
	expect(runCli([root]).status).toBe(2);
});

test.each(["root", "ancestor", "metadata-parent"])(
	"a linked %s directory is refused before metadata parsing",
	async (kind) => {
		const root = await fixture();
		const container = await mkdtemp(path.join(tmpdir(), "draftyak-launch-metadata-"));
		fixtures.push(container);
		const linked = path.join(container, "linked");
		let selected = root;
		if (kind === "metadata-parent") {
			const github = path.join(root, ".github");
			const moved = path.join(root, "original-github");
			await rename(github, moved);
			await symlink(moved, github, process.platform === "win32" ? "junction" : "dir");
		} else {
			await symlink(root, linked, process.platform === "win32" ? "junction" : "dir");
			selected = kind === "root" ? linked : path.join(linked, "child");
			if (kind === "ancestor") await mkdir(path.join(root, "child"));
		}
		const parse = (): never => {
			throw new Error("parser must not run");
		};
		await expect(loadMetadata(selected, parse)).rejects.toThrow(/linked/);
		expect(runCli([selected]).status).toBe(2);
	},
);

test("an ordinary subdirectory and a directory outside Git are not repository roots", async () => {
	const root = await fixture();
	const child = path.join(root, "child");
	await mkdir(child);
	await expect(loadMetadata(child)).rejects.toThrow("expected the repository root");
	const outside = await mkdtemp(path.join(tmpdir(), "draftyak-launch-metadata-"));
	fixtures.push(outside);
	expect(runCli([outside]).status).toBe(2);
});
