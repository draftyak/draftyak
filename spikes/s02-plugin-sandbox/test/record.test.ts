import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codeChanged, evidenceFile, missing, recording, unmet } from "./record.ts";

describe("S2b evidence recording", () => {
	it("records only when asked or in CI", () => {
		expect(recording({})).toBe(false);
		expect(recording({ DRAFTYAK_RECORD_EVIDENCE: "1" })).toBe(true);
		expect(recording({ CI: "true" })).toBe(true);
		expect(recording({ CI: "true", DRAFTYAK_RECORD_EVIDENCE: "0" })).toBe(false);
		expect(() => recording({ DRAFTYAK_RECORD_EVIDENCE: "yes" })).toThrow(/1 or 0/);
	});

	it("names a Node-subset run apart from the file that covers both Nodes", () => {
		const name = (env: NodeJS.ProcessEnv): string => path.basename(evidenceFile("ipc", "x", env));
		expect(name({})).toBe("ipc-x.json");
		expect(name({ DRAFTYAK_NODES: "both" })).toBe("ipc-x.json");
		expect(name({ DRAFTYAK_NODES: "minimum" })).toBe("ipc-x-minimum.json");
		expect(name({ DRAFTYAK_NODES: "bundled" })).toBe("ipc-x-bundled.json");
		expect(path.basename(path.dirname(evidenceFile("ipc", "x", {})))).toBe("evidence");
	});

	it("turns every missing run and every false finding into a reason not to record", () => {
		const ran = new Map([["26.12.0", {}]]);
		expect(missing("node", ["26.5.1", "26.12.0"], ran)).toEqual(["node 26.5.1 did not run"]);
		expect(unmet({ held: true, broken: false })).toEqual(["broken is false"]);
	});

	it("counts any tracked change but the spike's own evidence/ as a code change", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dy-s02-record-"));
		try {
			// No user or system git config (hooks, signing), no repository variables from a hook, and no
			// background maintenance writing into .git while the test reads it.
			const config = path.join(root, "gitconfig");
			fs.writeFileSync(config, "[maintenance]\n\tauto = false\n[commit]\n\tgpgsign = false\n");
			const env = {
				...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
				GIT_CONFIG_GLOBAL: config,
				GIT_CONFIG_NOSYSTEM: "1",
			};
			const repo = path.join(root, "repo");
			const git = (...args: string[]): void => {
				const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env });
				if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
			};
			const write = (file: string, text: string): void => {
				fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
				fs.writeFileSync(path.join(repo, file), text);
			};
			for (const file of ["spike/evidence/ipc-x.json", "spike/src/argv.ts", "kit/index.ts"]) {
				write(file, "{}\n");
			}
			git("init", "-q");
			git("add", ".");
			git("-c", "user.name=s02", "-c", "user.email=s02@example.invalid", "commit", "-qm", "base");
			const spike = path.join(repo, "spike");
			expect(codeChanged(spike)).toBe(false);
			write("spike/evidence/ipc-x.json", '{ "recordedAt": "now" }\n');
			expect(codeChanged(spike)).toBe(false);
			write("kit/index.ts", "export {};\n");
			expect(codeChanged(spike)).toBe(true);
			git("checkout", "--", "kit/index.ts");
			write("spike/src/argv.ts", "export {};\n");
			expect(codeChanged(spike)).toBe(true);
			expect(codeChanged(root)).toBeNull();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
