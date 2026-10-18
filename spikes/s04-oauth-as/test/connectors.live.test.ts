// M0.20 (session 2): claude.ai, ChatGPT developer mode, remote Claude Code and Codex connect to the
// spike AS and its fake-data MCP endpoint through Tailscale Funnel, while the owner follows the
// printed steps (notes/session.md) and types each sign-in's code in the session console. It
// records AS-side facts only. Without DY_LIVE_FUNNEL_BASE_URL in the main checkout's .env.live it
// skips, and fails under DRAFTYAK_STRICT_SKIPS=1. Evidence (evidence/live-clients.json) is written
// only with DRAFTYAK_RECORD_EVIDENCE=1, from a clean tree, after a run that covered all four
// clients and the clean-up. Output goes to stderr, which every Vitest reporter shows at once.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	acquireBenchLock,
	deleteEnvLive,
	type Fingerprint,
	fingerprint,
	loadEnvLive,
	skipOrFail,
	writeEvidence,
} from "@draftyak/spike-kit";
import { loadViews } from "@draftyak/spike-s03-mcp-sdk/src/apps.ts";
import { buildViews } from "@draftyak/spike-s03-mcp-sdk/views/build.ts";
import { expect, it } from "vitest";
import {
	LIVE_PORT,
	livePlans,
	recordDecision,
	recordingRequested,
	selfCheckMessage,
	startLiveSession,
} from "./live/session.ts";

const ENTRY = "DY_LIVE_FUNNEL_BASE_URL";
const spikeDir = path.join(import.meta.dirname, "..");
const plans = livePlans();
// The view build, the route checks and the clean-up, beside each client's deadline.
const SETUP_MS = 30 * 60_000;
const CLEANUP_MS = 35 * 60_000;
const say = (text: string): void => {
	process.stderr.write(`${text}\n`);
};

it("connects claude.ai, ChatGPT, remote Claude Code and Codex through Funnel and records what the AS saw", {
	timeout: SETUP_MS + CLEANUP_MS + plans.reduce((total, plan) => total + plan.deadlineMs, 0),
}, async (ctx) => {
	let base: string;
	try {
		base = loadEnvLive([ENTRY])[ENTRY].reveal();
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("not set in ")) throw error;
		const reason = `${ENTRY} isn't set in the main checkout's .env.live: session 2 sets it (spikes/s04-oauth-as/notes/session.md)`;
		say(`skipped: ${reason}`);
		return skipOrFail(ctx, reason);
	}
	const decision = recordDecision(recordingRequested(), plans);
	let print: Fingerprint | undefined;
	if (decision.record) {
		print = await fingerprint({ cwd: spikeDir });
		if (print.dirty !== false) {
			throw new Error("commit or stash tracked changes first: evidence comes from a clean tree");
		}
	}
	// The AS needs the fixed port Funnel forwards to.
	using _port = await acquireBenchLock({
		label: `s04 live connectors on port ${LIVE_PORT}`,
		idle: false,
		signal: ctx.signal,
	});
	const viewsDir = mkdtempSync(path.join(os.tmpdir(), "draftyak-s04-live-views-"));
	ctx.onTestFinished(() => rmSync(viewsDir, { recursive: true, force: true }));
	await buildViews(viewsDir);
	const started = Date.now();
	await using session = await startLiveSession({
		publicBaseUrl: base,
		port: LIVE_PORT,
		views: loadViews(viewsDir),
		print: say,
	});
	say(
		`AS and MCP endpoint listening on 127.0.0.1:${LIVE_PORT}; checking the route from this machine`,
	);
	say(selfCheckMessage(await session.selfCheck({ signal: ctx.signal })));
	const rows = await session.run(plans, ctx.signal);
	if (decision.record) {
		await session.cleanUp({ signal: ctx.signal, deleteEntry: () => deleteEnvLive([ENTRY]) });
	} else {
		say("clean-up: after the recorded run (spikes/s04-oauth-as/notes/session.md, step 9)");
	}
	const data = session.evidence(plans, started);
	if (decision.record) {
		const file = path.join(spikeDir, "evidence", "live-clients.json");
		say(`evidence: ${await writeEvidence(file, data, { ...(print && { fingerprint: print }) })}`);
	} else {
		say(`evidence not recorded: ${decision.reason}`);
	}
	expect(rows.map((row) => row.client)).toStrictEqual(plans.map((plan) => plan.client));
	for (const row of rows) expect(["ok", "fallback", "blocked"]).toContain(row.outcome);
});
