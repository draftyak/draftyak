import path from "node:path";
import { acquireBenchLock, deleteEnvLive, skipOrFail } from "@draftyak/spike-kit";
import { expect, it } from "vitest";
import { ISSUER } from "../src/auth.ts";
import { API_ORIGIN } from "../src/verify.ts";
import { gate, liveTimeoutMs, openSystemBrowser, runLiveSession } from "./live-session.ts";
import { OPT_IN } from "./session-env.ts";

// S7b (M0.27): the owner's Sign in with ChatGPT session against OpenAI, run as notes/session.md
// says. It starts only after the owner's opt-in in .env.live, which it consumes, and records
// evidence/live.json. Progress goes to stderr as it happens; the acceptance lines go to stdout.

const EVIDENCE = path.join(import.meta.dirname, "..", "evidence", "live.json");
// An hour, plus the cap and budget of the step after expiry when DRAFTYAK_S7_DEFERRED_MIN is set.
const LIMIT = { timeout: liveTimeoutMs() };

const say = (text: string): void => {
	process.stderr.write(`${text.replace(/^/gm, "s07 live: ")}\n`);
};

it("S7b: Sign in with ChatGPT with the owner present", LIMIT, async (ctx) => {
	const opened = gate(EVIDENCE);
	if (!opened.run) {
		say(`skipped: ${opened.reason}`);
		skipOrFail(ctx, opened.reason);
	}
	deleteEnvLive([OPT_IN]);
	const result = await runLiveSession({
		run: "live",
		issuer: ISSUER,
		apiOrigin: API_ORIGIN,
		evidenceFile: EVIDENCE,
		openBrowser: openSystemBrowser,
		say,
		signal: ctx.signal,
		holdPort: (signal) => acquireBenchLock({ label: "s07-siwc-live-1455", idle: false, signal }),
		...(opened.deferredMinutes !== undefined && { deferredMinutes: opened.deferredMinutes }),
	});
	const shown = [...result.lines, ...result.details.map((detail) => `details: ${detail}`)];
	process.stdout.write(
		`${[...shown, `evidence: ${path.relative(process.cwd(), result.file)}`].join("\n")}\n`,
	);
	expect(
		result.lines.at(-1),
		"remove DraftYak in ChatGPT's settings (notes/session.md, step 7)",
	).toBe("revoked: yes");
});
