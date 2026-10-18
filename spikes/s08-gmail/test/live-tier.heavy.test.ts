import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { spikeDir } from "./live-session.ts";

// The live tier started as the session starts it, against an .env.live without the S8 entries
// (never the real one): its preflight skips with the missing names, or fails under strict skips,
// and a step that was asked for fails either way.
const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "draftyak-s8-tier-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const MISSING =
	/not set in .*: DY_LIVE_GMAIL_CLIENT_ID, DY_LIVE_GMAIL_CLIENT_SECRET, DY_LIVE_GMAIL_AGENT_CLIENT_ID, DY_LIVE_GMAIL_AGENT_CLIENT_SECRET/;

function liveTier(
	strict: boolean,
	step?: string,
): { readonly code: number | null; readonly output: string } {
	const inherited = Object.entries(process.env).filter(
		([name]) => !/^(?:VITEST|TEST$|NODE_ENV$|DRAFTYAK_|FORCE_COLOR$)/i.test(name),
	);
	const env = {
		...Object.fromEntries(inherited),
		DRAFTYAK_ENV_LIVE: path.join(base, ".env.live"),
		DRAFTYAK_S8_SESSION: path.join(base, "session"),
		DRAFTYAK_STRICT_SKIPS: strict ? "1" : "0",
		...(step === undefined ? {} : { DRAFTYAK_S8_STEP: step }),
		DO_NOT_TRACK: "1",
		NO_COLOR: "1",
	};
	const result = spawnSync(process.execPath, ["../kit/run.ts", "--live", "--reporter=verbose"], {
		cwd: spikeDir,
		encoding: "utf8",
		env,
		windowsHide: true,
		timeout: 120_000,
	});
	return {
		code: result.status,
		output: stripVTControlCharacters(`${result.stdout}\n${result.stderr}`),
	};
}

describe("the S8b live tier without its .env.live entries", () => {
	it("skips, naming the missing entries", () => {
		const run = liveTier(false);
		expect(run.code, run.output).toBe(0);
		expect(run.output).toMatch(/Tests\s+1 skipped \(1\)/);
		expect(run.output).toMatch(MISSING);
	});

	it("fails under DRAFTYAK_STRICT_SKIPS=1", () => {
		const run = liveTier(true);
		expect(run.code, run.output).toBe(1);
		expect(run.output).toMatch(new RegExp(`cannot run: ${MISSING.source}`));
	});

	it("fails a step it was asked for, without strict skips too", () => {
		const run = liveTier(false, "send");
		expect(run.code, run.output).toBe(1);
		expect(run.output).toMatch(
			/the send step can't run: not set in .*: DY_LIVE_GMAIL_CLIENT_ID, DY_LIVE_GMAIL_CLIENT_SECRET, DY_LIVE_GMAIL_REFRESH_TOKEN/,
		);
	});
});
