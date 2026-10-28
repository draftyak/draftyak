import path from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, skipOrFail, writeEvidence } from "@draftyak/spike-kit";
import { it } from "vitest";
import { LIVE_WAITS, liveSettings, liveTokens, runLive } from "./live-session.ts";
import { withSessionControl } from "./session-control.ts";

// M0.25 (S6b) in session 2: notes/session.md lists the owner's and the second user's steps, and
// test/live-session.ts the procedure, which test/rehearsal.test.ts runs against FakeSlack. Without
// both tokens in the main checkout's .env.live this test skips, and fails under
// DRAFTYAK_STRICT_SKIPS=1. Progress and prompts go straight to stderr, which Vitest shows at once
// in every reporter. A completed run writes evidence/live.json; a failed one writes nothing.
const spikeDir = fileURLToPath(new URL("..", import.meta.url));
const say = (line: string): void => {
	process.stderr.write(`S6 live: ${line}\n`);
};

it("S6 live: user events over Socket Mode, rate-limit headers and revocation", {
	timeout: 45 * 60_000,
}, async (ctx) => {
	await withSessionControl(
		process.env,
		path.join(spikeDir, "evidence", "live.json"),
		async (control) => {
			const tokens = liveTokens();
			if ("missing" in tokens) {
				const reason = `${tokens.missing} (session 2 saves them: spikes/s06-slack/notes/session.md)`;
				say(`skipped: ${reason}`);
				skipOrFail(ctx, reason);
			}
			const settings = liveSettings();
			const print = await fingerprint({ cwd: spikeDir });
			if (print.dirty !== false) {
				throw new Error("commit or stash tracked changes first: evidence comes from a clean tree");
			}
			const result = await runLive({
				...tokens,
				...settings,
				waits: LIVE_WAITS,
				say,
				...(control ? { cue: control.cue } : {}),
				signal: ctx.signal,
			});
			const file = await writeEvidence(path.join(spikeDir, "evidence", "live.json"), result.data, {
				fingerprint: print,
			});
			control?.artifact(file);
			for (const line of result.verdicts) say(line);
			const notes = [
				...(result.replaced > 0
					? [`${result.replaced} header value(s) replaced for their shape`]
					: []),
				...(result.redacted > 0 ? [`${result.redacted} value(s) redacted`] : []),
			];
			const where = path.relative(process.cwd(), file).replaceAll("\\", "/");
			say(`evidence written to ${where}${notes.map((note) => `; ${note}`).join("")}`);
		},
	);
});
