import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as kit from "@draftyak/spike-kit";
import { describe, expect, it, vi } from "vitest";
import { codeChanged, evidenceFile, missing, recordEvidence, recording, unmet } from "./record.ts";

// Multiple git-backed recordings need bounded headroom when the workspace runs tests in parallel.
const recordingTimeoutMs = 120_000;

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

	it.each(["directory", "content", "replacement"])(
		"records dirty after a prior generated output changes: %s",
		async (change) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "dy-s02-record-changed-output-"));
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			// This regression exercises production recording with synthetic provenance only.
			const print = vi.spyOn(kit, "fingerprint").mockResolvedValue({
				os: { platform: "synthetic", arch: "x64", osName: "synthetic", osVersion: "0" },
				node: { nodeVersion: "0", v8Version: "0" },
				commit: null,
				dirty: false,
				load: {
					cpuPercent: 0,
					cpuCount: 1,
					cpuModel: "synthetic",
					memoryUsedPercent: 0,
					concurrentBuilds: 0,
				},
			});
			vi.stubEnv("DRAFTYAK_RECORD_EVIDENCE", "1");
			try {
				const repo = path.join(root, "repo");
				fs.mkdirSync(repo);
				const initialized = spawnSync("git", ["init", "-q"], {
					cwd: repo,
					env: Object.fromEntries(
						Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
					),
				});
				expect(initialized.status).toBe(0);
				const first = path.join(repo, "evidence", "one.json");
				const second = path.join(repo, "evidence", "two.json");
				await recordEvidence(first, [], { held: true }, repo);
				expect(JSON.parse(fs.readFileSync(first, "utf8")).fingerprint.dirty).toBe(false);
				if (change === "directory") {
					fs.unlinkSync(first);
					fs.mkdirSync(first);
					fs.writeFileSync(path.join(first, "new-input.mjs"), "export {};\n");
				} else if (change === "content") {
					fs.appendFileSync(first, "\n");
				} else {
					const replacement = path.join(repo, "replacement.json");
					fs.writeFileSync(replacement, fs.readFileSync(first));
					fs.renameSync(replacement, first);
				}
				await recordEvidence(second, [], { held: true }, repo);
				expect(JSON.parse(fs.readFileSync(second, "utf8")).fingerprint.dirty).toBe(true);
			} finally {
				vi.unstubAllEnvs();
				print.mockRestore();
				log.mockRestore();
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
		recordingTimeoutMs,
	);

	it(
		"records exact generated outputs cleanly while retaining untracked input provenance",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "dy-s02-record-output-"));
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			vi.stubEnv("DRAFTYAK_RECORD_EVIDENCE", "1");
			try {
				const repo = path.join(root, "repo");
				fs.mkdirSync(repo);
				const initialized = spawnSync("git", ["init", "-q"], {
					cwd: repo,
					env: Object.fromEntries(
						Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
					),
				});
				expect(initialized.status).toBe(0);
				const record = async (name: string): Promise<boolean> => {
					const file = path.join(repo, "evidence", `${name}.json`);
					await recordEvidence(file, [], { held: true }, repo);
					return JSON.parse(fs.readFileSync(file, "utf8")).fingerprint.dirty;
				};
				expect(await record("one")).toBe(false);
				expect(await record("two")).toBe(false);
				fs.mkdirSync(path.join(repo, "test"));
				const input = path.join(repo, "test", "untracked.test.ts");
				fs.writeFileSync(input, "export {};\n");
				expect(await record("three")).toBe(true);
				fs.unlinkSync(input);
				fs.writeFileSync(path.join(repo, "evidence", "unknown.json"), "{}\n");
				expect(await record("four")).toBe(true);
			} finally {
				vi.unstubAllEnvs();
				log.mockRestore();
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
		recordingTimeoutMs,
	);

	it("counts tracked and untracked inputs, exempting only exact recording outputs", () => {
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
			const output = path.join(spike, "evidence", "ipc-x.json");
			expect(codeChanged(spike)).toBe(false);
			write("spike/evidence/ipc-x.json", '{ "recordedAt": "now" }\n');
			expect(codeChanged(spike)).toBe(true);
			expect(codeChanged(spike, [output])).toBe(false);
			for (const file of [
				"spike/test/untracked.test.ts",
				"spike/fixtures/untracked.mjs",
				"spike/fixtures/input.json",
				"spike/src/untracked.ts",
				"spike/evidence/untracked.test.ts",
				"spike/evidence/other.json",
				"kit/untracked.ts",
			]) {
				write(file, "{}\n");
				expect(codeChanged(spike, [output]), file).toBe(true);
				fs.unlinkSync(path.join(repo, file));
				expect(codeChanged(spike, [output])).toBe(false);
			}
			write("spike/evidence/literal[1].json", "{}\n");
			const literal = path.join(spike, "evidence", "literal[1].json");
			expect(codeChanged(spike, [output, literal])).toBe(false);
			write("spike/evidence/literal1.json", "{}\n");
			expect(codeChanged(spike, [output, literal])).toBe(true);
			fs.unlinkSync(path.join(spike, "evidence", "literal1.json"));
			write("kit/index.ts", "export {};\n");
			expect(codeChanged(spike, [output, literal])).toBe(true);
			git("checkout", "--", "kit/index.ts");
			write("spike/src/argv.ts", "export {};\n");
			expect(codeChanged(spike, [output, literal])).toBe(true);
			expect(codeChanged(root)).toBeNull();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
