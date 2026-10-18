// When s03's tests record evidence, and the fingerprint they record it with.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { type Fingerprint, fingerprint } from "@draftyak/spike-kit";

const spike = path.resolve(import.meta.dirname, "..");

// DRAFTYAK_RECORD_EVIDENCE=1 records and 0 doesn't; unset, only CI runs record.
export function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (!["", "0", "1"].includes(value)) {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1" || (value === "" && !!env.CI);
}

// Tracked changes anywhere in the repository except this spike's evidence/, so the files one
// recording writes don't mark the next one dirty (null when git can't tell). GIT_* variables from a
// hook or `rebase -x` would point git at another repository.
export function codeChanged(): boolean | null {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
	);
	const args = ["status", "--porcelain", "--untracked-files=no", "--", ":/", ":(exclude)evidence"];
	const status = spawnSync("git", args, { cwd: spike, encoding: "utf8", env, windowsHide: true });
	return status.status === 0 ? status.stdout.trim() !== "" : null;
}

export async function codeFingerprint(): Promise<Fingerprint> {
	const print = await fingerprint({ cwd: spike });
	return { ...print, dirty: codeChanged() ?? print.dirty };
}
