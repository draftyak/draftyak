import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { EVIDENCE_DIR, receive } from "../src/receive-report.ts";
import { failures, sessionLines } from "./device-session.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), "draftyak-s12-private-evidence-"));
const relative = "spikes/s12-sms/evidence";
const fixture = "spikes/s12-sms/test/fixtures/report-full.json";
const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) {
	delete env[key];
}

function git(args: readonly string[], cwd = temp) {
	const result = spawnSync("git", ["-c", "core.excludesFile=", ...args], {
		cwd,
		env,
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.error) throw result.error;
	expect(result.signal).toBeNull();
	return result;
}

expect(git(["init", "--quiet"]).status).toBe(0);
copyFileSync(path.join(root, ".gitignore"), path.join(temp, ".gitignore"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("private S12 evidence", () => {
	it("ignores only this spike's raw destination, including future session and soak names", () => {
		expect(path.relative(root, EVIDENCE_DIR).split(path.sep).join("/")).toBe(relative);
		for (const name of [
			"session1.json",
			"session1-tls.json",
			"soak-doze-forced.json",
			"later/natural.json",
		]) {
			const file = `${relative}/${name}`;
			const ignored = git(["check-ignore", "--no-index", "--verbose", file]);
			expect(ignored.status, file).toBe(0);
			expect(ignored.stdout, file).toContain(`:/spikes/s12-sms/evidence/\t${file}`);
		}
		expect(
			git(["check-ignore", "--no-index", "spikes/s11-python-runtime/evidence/run.json"]).status,
		).toBe(1);
	});

	it("retains the tracked synthetic report fixtures outside the ignored destination", () => {
		for (const name of ["full", "bare", "failing", "refused", "truncated"]) {
			const file = `spikes/s12-sms/test/fixtures/report-${name}.json`;
			expect(git(["check-ignore", "--no-index", file]).status, file).toBe(1);
			expect(git(["ls-files", "--error-unmatch", "--", file], root).status, file).toBe(0);
		}
	});

	it("keeps synthetic receiver output ignored and readable by the device-session reader", async () => {
		const evidenceDir = path.join(temp, path.relative(root, EVIDENCE_DIR));
		const bytes = readFileSync(path.join(root, fixture));
		for (const name of ["session1", "session1-tls"]) {
			const received = await receive(bytes, { name, evidenceDir });
			expect(received).toEqual({ ok: true, written: path.join(evidenceDir, `${name}.json`) });
			expect(git(["check-ignore", "--no-index", `${relative}/${name}.json`]).status).toBe(0);
		}
		const lines = sessionLines(evidenceDir);
		expect(lines).toContain("inventory: ok");
		expect(lines).toContain("ekm equal: yes");
		expect(failures(lines)).toEqual([]);
		expect(git(["status", "--porcelain", "--untracked-files=all"]).stdout).toBe("?? .gitignore\n");
	});
});
