import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { communityFiles, communityLinks } from "../src/community.ts";
import { loadCommunity } from "../src/community-cli.ts";
import { requiredForms } from "../src/metadata.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../src/community-cli.ts", import.meta.url));
const fixtures: string[] = [];
const cleanEnv = (): NodeJS.ProcessEnv =>
	Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
	);
afterEach(async () => {
	for (const root of fixtures.splice(0)) {
		const resolved = path.resolve(root);
		if (
			path.dirname(resolved) !== path.resolve(tmpdir()) ||
			!path.basename(resolved).startsWith("draftyak-community-")
		)
			throw new Error("Refusing fixture cleanup outside the owned temporary paths");
		await rm(resolved, { recursive: true, force: true });
	}
});

async function fixture(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "draftyak-community-"));
	fixtures.push(root);
	const files = [
		"CONTRIBUTING.md",
		".github/labels.yml",
		".github/CODEOWNERS",
		".github/pull_request_template.md",
		".github/ISSUE_TEMPLATE/config.yml",
		...requiredForms.map((name) => `.github/ISSUE_TEMPLATE/${name}.yml`),
		...communityFiles.filter((file) => file !== "README.md"),
	];
	const documents: Record<string, string> = {};
	for (const file of files) {
		await mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await copyFile(path.join(repository, file), path.join(root, file));
		if ((communityFiles as readonly string[]).includes(file))
			documents[file] = await readFile(path.join(root, file), "utf8");
	}
	documents["README.md"] =
		"# DraftYak\n## Install and first run\nWindows NSIS, Apple-silicon macOS DMG and Ubuntu 24.04 deb are planned targets. Keychain may prompt after updates. Ubuntu needs Secret Service. Tray, reopen and autostart need actual platform checks. Signing limitations remain.\n## Security\nPIN approval covers exact content and the send window. The same-OS-user limit applies. Desktop must be awake and running; a missed window requires fresh approval. See [security](SECURITY.md#security-model).";
	await writeFile(path.join(root, "README.md"), documents["README.md"]);
	for (const link of communityLinks(documents).links) {
		if (Object.hasOwn(documents, link.target)) continue;
		await mkdir(path.dirname(path.join(root, link.target)), { recursive: true });
		if ((await lstat(path.join(repository, link.target))).isDirectory()) {
			await mkdir(path.join(root, link.target), { recursive: true });
			await writeFile(path.join(root, link.target, "fixture.md"), "Synthetic directory target.");
		} else await copyFile(path.join(repository, link.target), path.join(root, link.target));
	}
	execFileSync("git", ["-c", "init.templateDir=", "init", "-q", root], {
		env: cleanEnv(),
		stdio: "ignore",
	});
	execFileSync("git", ["-c", "core.autocrlf=false", "add", "--", "."], {
		cwd: root,
		env: cleanEnv(),
		stdio: "ignore",
	});
	return root;
}
const run = (args: string[]) =>
	spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: cleanEnv() });

test("the CLI checks a synthetic root and supports the separator", async () => {
	const root = await fixture();
	const result = run(["--", root]);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).toContain("launch community: 0 problems");
});

test("a missing README remains a negative without a placeholder", async () => {
	const root = await fixture();
	await rm(path.join(root, "README.md"));
	const input = await loadCommunity(root);
	expect(input.documents["README.md"]).toBeUndefined();
	const result = run([root]);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("README.md: required community document is missing or empty");
});

test("missing documents and existing files with missing anchors exit one", async () => {
	const root = await fixture();
	await rm(path.join(root, "SUPPORT.md"));
	await writeFile(
		path.join(root, "README.md"),
		`${await readFile(path.join(root, "README.md"), "utf8")}\n[planned](SECURITY.md#missing)`,
	);
	const result = run([root]);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("internal link fragment is missing");
	expect(result.stderr).toContain("SUPPORT.md: required community document is missing or empty");
});

test("a directory in place of a required document fails safely without content or local paths", async () => {
	const root = await fixture();
	await rm(path.join(root, "NOTICE"));
	await mkdir(path.join(root, "NOTICE"));
	const result = run([root]);
	expect(result.status).toBe(2);
	expect(result.stderr).toContain("unsafe or invalid input");
	expect(result.stderr).not.toContain(root);
});

test("linked parent components are refused rather than followed", async () => {
	const root = await fixture();
	const outside = await mkdtemp(path.join(tmpdir(), "draftyak-community-outside-"));
	fixtures.push(outside);
	await writeFile(path.join(outside, "target.md"), "PRIVATE_SENTINEL");
	await symlink(outside, path.join(root, "linked"), "junction");
	await writeFile(
		path.join(root, "README.md"),
		`${await readFile(path.join(root, "README.md"), "utf8")}\n[link](linked/target.md)`,
	);
	const blob = execFileSync("git", ["rev-parse", ":README.md"], {
		cwd: root,
		env: cleanEnv(),
		encoding: "utf8",
	}).trim();
	execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},linked/target.md`], {
		cwd: root,
		env: cleanEnv(),
		stdio: "ignore",
	});
	const result = run([root]);
	expect(result.status).toBe(2);
	expect(result.stderr).not.toContain("PRIVATE_SENTINEL");
});

test.each([{ args: [] }, { args: ["--unknown"] }, { args: [".", "extra"] }])(
	"invalid invocation exits two",
	({ args }) => {
		expect(run(args).status).toBe(2);
	},
);

test("non-root invocation and oversized inputs refuse", async () => {
	const root = await fixture();
	expect(run([path.join(root, ".github")]).status).toBe(2);
	await writeFile(path.join(root, "README.md"), "x".repeat(3 * 1024 * 1024));
	expect(run([root]).status).toBe(2);
});
