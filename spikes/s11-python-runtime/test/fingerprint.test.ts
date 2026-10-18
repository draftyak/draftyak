import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeChanged } from "./fingerprint.ts";

describe("the recording fingerprint's dirty flag", () => {
	let root = "";
	const spike = (): string => path.join(root, "repo", "spikes", "s99");
	const write = (file: string, text: string): void => {
		const target = path.join(root, "repo", file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, text);
	};

	// A throwaway repository, isolated from the user's git config and without background maintenance.
	beforeAll(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dy-s11-print-")));
		const config = path.join(root, "gitconfig");
		fs.writeFileSync(config, "[maintenance]\n\tauto = false\n");
		fs.mkdirSync(path.join(root, "repo"));
		const env = {
			...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
			GIT_CONFIG_GLOBAL: config,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Ada Lovelace",
			GIT_AUTHOR_EMAIL: "ada@example.com",
			GIT_COMMITTER_NAME: "Ada Lovelace",
			GIT_COMMITTER_EMAIL: "ada@example.com",
		};
		const git = (...args: string[]): void => {
			const result = spawnSync("git", args, {
				cwd: path.join(root, "repo"),
				encoding: "utf8",
				env,
			});
			if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
		};
		git("init", "-q", "-b", "main");
		git("config", "maintenance.auto", "false");
		write("spikes/s99/evidence/budgets-x.json", "{}\n");
		write("spikes/s99/test/budgets.ts", "export {};\n");
		write("spikes/s98/evidence/other.json", "{}\n");
		git("add", "-A");
		git("commit", "-q", "-m", "test: seed");
	});
	afterAll(() => {
		if (root !== "") fs.rmSync(root, { recursive: true, force: true });
	});

	it("leaves out the spike's own evidence and counts every other tracked change", () => {
		expect(codeChanged(spike())).toBe(false);
		write("spikes/s99/evidence/budgets-x.json", '{ "changed": true }\n');
		write("spikes/s99/evidence/allowlist-x.json", "{}\n");
		expect(codeChanged(spike())).toBe(false);
		write("spikes/s98/evidence/other.json", '{ "changed": true }\n');
		expect(codeChanged(spike())).toBe(true);
		write("spikes/s98/evidence/other.json", "{}\n");
		expect(codeChanged(spike())).toBe(false);
		write("spikes/s99/test/budgets.ts", "export const changed = true;\n");
		expect(codeChanged(spike())).toBe(true);
	});

	it("is unknown where git can't run", () => {
		expect(codeChanged(path.join(root, "missing"))).toBe(null);
	});
});
