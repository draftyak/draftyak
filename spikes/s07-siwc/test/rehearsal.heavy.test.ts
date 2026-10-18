import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { acquireBenchLock, skipOrFail } from "@draftyak/spike-kit";
import { expect, it } from "vitest";
import { CALLBACK_PORT } from "../src/auth.ts";
import { SessionStopped } from "./live-session.ts";
import { rehearsal } from "./rehearse.ts";

// The live procedure as the session runs it, on 127.0.0.1:1455 under the kit's machine-wide lock
// (port only, no idle check) and with a real fingerprint, against M0.26's fakes; then vendor-guard,
// as `pnpm guard` runs it, checks the evidence in a throwaway repository shaped like the spike's.

const run = promisify(execFile);
const GUARD = path.resolve(import.meta.dirname, "../../../tools/vendor-guard/src/cli.ts");

// Where the evidence reads (withheld), as JSON paths.
function withheldAt(value: unknown, at = "$"): string[] {
	if (value === "(withheld)") return [at];
	if (Array.isArray(value))
		return value.flatMap((item, index) => withheldAt(item, `${at}[${index}]`));
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value).flatMap(([key, item]) => withheldAt(item, `${at}.${key}`));
}

// git acts on the throwaway repository, not on one a hook or `rebase -x` exported.
const gitEnv = (): NodeJS.ProcessEnv =>
	Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|PREFIX)$/i.test(key),
		),
	);

it("rehearses the session on port 1455, and vendor-guard finds nothing in its evidence", async (ctx) => {
	const repo = mkdtempSync(path.join(os.tmpdir(), "draftyak-s07-guard-"));
	const env = gitEnv();
	await run("git", ["-c", "init.defaultBranch=main", "init", "-q", repo], { env });
	await run("git", ["-C", repo, "config", "maintenance.auto", "false"], { env });
	const item = await rehearsal({ root: repo, apiKey: true });
	try {
		let redirect = "";
		const result = await item
			.run({
				port: undefined,
				holdPort: (signal) =>
					acquireBenchLock({ label: "s07-siwc-rehearsal-1455", idle: false, signal }),
				openBrowser: async (url) => {
					redirect = new URL(url).searchParams.get("redirect_uri") ?? "";
					await item.auth.browse(url);
				},
				signal: ctx.signal,
			})
			.catch((error: unknown) => {
				if (error instanceof SessionStopped && error.code === "PORT_IN_USE") {
					skipOrFail(ctx, `127.0.0.1:${CALLBACK_PORT} is held by another program`);
				}
				throw error;
			});
		expect(result.lines).toEqual([
			"signin: ok",
			"text.format: ok",
			"submit_draft: ok",
			"transfer: ok",
			"revoked: yes",
		]);
		expect(redirect).toBe(`http://127.0.0.1:${CALLBACK_PORT}/auth/callback`);
		const written = JSON.parse(item.evidenceText());
		expect(written.data).toMatchObject({
			port: CALLBACK_PORT,
			lock: { waitedMs: expect.any(Number), idle: null },
			apiKey: { present: true, models: { shape: "data" } },
		});
		// Only the fakes' loopback hosts fail the name rule; live, auth.openai.com and api.openai.com pass.
		const endpoints = [
			"authorization_endpoint",
			"jwks_uri",
			"revocation_endpoint",
			"token_endpoint",
		];
		const hosts = [
			"$.apiHost",
			...endpoints.map((endpoint) => `$.discovery.endpoints.${endpoint}.host`),
			"$.issuerHost",
		];
		expect(withheldAt(written.data).sort()).toEqual(hosts);
		expect(written.data.withheld).toBe(hosts.length);
		expect(written.fingerprint.load.cpuPercent).toEqual(expect.any(Number));
		const guard = await run(process.execPath, [GUARD, "--json"], { cwd: repo, env }).catch(
			(error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }),
		);
		expect(JSON.parse(guard.stdout)).toEqual({ findings: [], files: 1, commits: null });
	} finally {
		await item.close();
		rmSync(repo, { recursive: true, force: true });
	}
});
