// The fingerprint S11c's heavy files record evidence under. dirty counts tracked changes outside this
// spike's evidence/, as S2's record.ts does, because one recording run writes several evidence files:
// allowlist-*.json, written first, must not mark budgets-*.json dirty.
import { spawnSync } from "node:child_process";
import { type Fingerprint, fingerprint } from "@draftyak/spike-kit";
import { spikeDir } from "../scripts/fetch-runtime.ts";

export function codeChanged(dir: string = spikeDir): boolean | null {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
	);
	const args = ["status", "--porcelain", "--untracked-files=no", "--", ":/", ":(exclude)evidence"];
	const status = spawnSync("git", args, { cwd: dir, encoding: "utf8", env, windowsHide: true });
	return status.status === 0 ? status.stdout.trim() !== "" : null;
}

export async function recordingFingerprint(dir: string = spikeDir): Promise<Fingerprint> {
	const print = await fingerprint({ cwd: dir });
	return { ...print, dirty: codeChanged(dir) ?? print.dirty };
}
