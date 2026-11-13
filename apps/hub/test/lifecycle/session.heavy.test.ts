import { spawn, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listing, nativeBinding, type SessionFixture, sessionFixture } from "./session-helpers.ts";

const child = path.join(import.meta.dirname, "fixtures", "session-child.ts");
const env: NodeJS.ProcessEnv = {};
for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
	if (process.env[name] !== undefined) env[name] = process.env[name];

let f: SessionFixture;
beforeEach(() => {
	f = sessionFixture();
});
afterEach(() => f.remove());

function attempt(folder: string): unknown {
	const run = spawnSync(
		process.execPath,
		["--disable-sigusr1", child, "open", folder, nativeBinding],
		{ env, encoding: "utf8", maxBuffer: 65_536, windowsHide: true, shell: false, timeout: 60_000 },
	);
	expect(run.error).toBeUndefined();
	expect(run.status, run.stderr).toBe(0);
	return JSON.parse(run.stdout);
}

it("refuses every later open after a hard kill between file creation and audit genesis", async () => {
	const holder = spawn(
		process.execPath,
		["--disable-sigusr1", child, "hold", f.folder, nativeBinding],
		{ env, stdio: "pipe", windowsHide: true, shell: false },
	);
	try {
		let output = "",
			errors = "";
		holder.stdout.setEncoding("utf8");
		holder.stderr.setEncoding("utf8");
		holder.stderr.on("data", (chunk: string) => {
			errors += chunk;
		});
		await new Promise<void>((resolve, reject) => {
			holder.stdout.on("data", (chunk: string) => {
				output += chunk;
				if (output.includes("created\n")) resolve();
			});
			holder.once("error", reject);
			holder.once("exit", (code) => reject(new Error(`holder exited (${code}): ${errors}`)));
		});
		expect(attempt(f.folder)).toEqual({ refused: "SESSION_ACTIVE" });
		expect(attempt(f.scratch())).toEqual({ opened: expect.any(String) });
	} finally {
		if (holder.exitCode === null && holder.signalCode === null) {
			const exited = new Promise((resolve) => holder.once("exit", resolve));
			holder.kill("SIGKILL");
			await exited;
		}
	}
	expect(listing(f.folder)).toContain("draftyak.db");
	expect(lstatSync(f.database).size).toBeGreaterThan(0);
	for (let run = 0; run < 2; run++) {
		expect(attempt(f.folder)).toEqual({ refused: "FIRST_RUN_INTERRUPTED" });
		expect(listing(f.folder)).toContain("draftyak.db");
	}
});

const compiledSessionModes = [
	"positive",
	"missing-credentials",
	"missing-sealed-credentials",
	"invalid-credentials",
	"missing-revision-immutability",
	"missing-devices",
	"invalid-devices",
	"missing-accounts",
	"missing-pluginregistry",
	"missing-outbox",
	"missing-challenges",
	"missing-verifier",
	"missing-admin",
	"missing-adminchallenges",
	"missing-backup",
	"missing-backupops",
	"missing-backupchallenges",
] as const;
it.each(compiledSessionModes)(
	"opens and reopens a compiled session using all eighteen staged schemas (%s)",
	(mode) => {
		const hub = path.resolve(import.meta.dirname, "../.."),
			workspace = path.resolve(hub, "../..");
		// Below the package's real node_modules so native external dependencies resolve without links.
		const parent = realpathSync(path.join(hub, "node_modules"));
		const stage = realpathSync(mkdtempSync(path.join(parent, ".session-compiled-test-")));
		const cleanup = (): void => {
			if (
				path.dirname(stage) !== parent ||
				!path.basename(stage).startsWith(".session-compiled-test-") ||
				lstatSync(stage).isSymbolicLink() ||
				realpathSync(stage) !== stage
			)
				throw new Error("Compiled session fixture cleanup target refused");
			rmSync(stage, { recursive: true, force: true });
			expect(existsSync(stage)).toBe(false);
		};
		try {
			copyFileSync(path.join(hub, "dist/index.mjs"), path.join(stage, "index.mjs"));
			copyFileSync(
				path.join(import.meta.dirname, "fixtures/compiled-session.mjs"),
				path.join(stage, "smoke.mjs"),
			);
			for (const [source, relative] of [
				["store/migrations/audit/0001_chain.sql", "store/migrations/audit/0001_chain.sql"],
				["store/migrations/core/0001_identity.sql", "store/migrations/core/0001_identity.sql"],
				[
					"store/migrations/core/0002_native_runtime_state.sql",
					"store/migrations/core/0002_native_runtime_state.sql",
				],
				["identity/devices-migrations/0001_devices.sql", "devices-migrations/0001_devices.sql"],
				["jobs/jobs-migrations/0001_jobs.sql", "jobs-migrations/0001_jobs.sql"],
				["events/events-migrations/0001_events.sql", "events-migrations/0001_events.sql"],
				[
					"drafts/migrations/0001_native_revisions.sql",
					"drafts/migrations/0001_native_revisions.sql",
				],
				[
					"drafts/migrations/0002_immutable_revisions.sql",
					"drafts/migrations/0002_immutable_revisions.sql",
				],
				[
					"credentials/migrations/0001_credentials.sql",
					"credentials/migrations/0001_credentials.sql",
				],
				[
					"credentials/migrations/0002_sealed_credentials.sql",
					"credentials/migrations/0002_sealed_credentials.sql",
				],
				["outbox/migrations/0001_send_attempts.sql", "outbox/migrations/0001_send_attempts.sql"],
				["accounts/migrations/0001_accounts.sql", "accounts/migrations/0001_accounts.sql"],
				[
					"plugins/registry/migrations/0001_registry.sql",
					"plugins/registry/migrations/0001_registry.sql",
				],
				[
					"plugins/registry/migrations/0002_candidates.sql",
					"plugins/registry/migrations/0002_candidates.sql",
				],
				[
					"outbox/propose-migrations/0001_proposals.sql",
					"outbox/propose-migrations/0001_proposals.sql",
				],
				[
					"identity/challenges-migrations/0001_challenges.sql",
					"identity/challenges-migrations/0001_challenges.sql",
				],
				[
					"outbox/verifier-migrations/0001_approvals.sql",
					"outbox/verifier-migrations/0001_approvals.sql",
				],
				[
					"identity/admin-migrations/0001_operations.sql",
					"identity/admin-migrations/0001_operations.sql",
				],
				[
					"identity/admin-challenge-migrations/0001_admin_challenges.sql",
					"identity/admin-challenge-migrations/0001_admin_challenges.sql",
				],
				[
					"recovery/backup-migrations/0001_backup_recovery.sql",
					"recovery/backup-migrations/0001_backup_recovery.sql",
				],
				[
					"identity/backup-migrations/0001_backup_operations.sql",
					"identity/backup-migrations/0001_backup_operations.sql",
				],
				[
					"identity/backup-challenge-migrations/0001_backup_challenges.sql",
					"identity/backup-challenge-migrations/0001_backup_challenges.sql",
				],
			] as const) {
				const built = path.join(hub, "dist", relative);
				expect(readFileSync(built)).toEqual(readFileSync(path.join(hub, "src", source)));
				const target = path.join(stage, relative);
				mkdirSync(path.dirname(target), { recursive: true });
				copyFileSync(built, target);
			}
			// The hub's src and dist stay unreadable, so only the staged copies can serve the session.
			const run = spawnSync(
				process.execPath,
				[
					"--disable-sigusr1",
					"--permission",
					"--allow-addons",
					`--allow-fs-read=${path.join(workspace, "node_modules")}`,
					`--allow-fs-read=${path.join(workspace, "packages")}`,
					`--allow-fs-read=${path.join(hub, "node_modules")}`,
					`--allow-fs-read=${path.join(hub, "package.json")}`,
					`--allow-fs-write=${stage}`,
					path.join(stage, "smoke.mjs"),
					nativeBinding,
					mode,
					hub,
				],
				{ cwd: stage, env: {}, encoding: "utf8", timeout: 60_000, windowsHide: true, shell: false },
			);
			expect(run.error).toBeUndefined();
			expect(run.status, run.stderr).toBe(0);
			expect(run.stderr).toMatch(
				/^\(node:\d+\) \[PERM0001\] SecurityWarning: The flag --allow-addons must be used with extreme caution\. It could invalidate the permission model\.\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n$/,
			);
			expect(JSON.parse(run.stdout)).toEqual({
				ok: true,
				mode,
				schemas: 18,
				businessTables: 31,
				bookkeepingTables: 36,
				recoveryCapsule: mode === "positive",
				beforeIdentity: true,
				refused: mode === "positive" ? null : "STORE_UNAVAILABLE",
				failedOpenClosed: mode !== "positive",
				failedKeyErased: mode !== "positive",
				reopened: true,
				auditVerified: true,
				accountsRoundTrip: true,
				modules: 0,
			});
		} finally {
			cleanup();
		}
	},
);
