import { fileURLToPath } from "node:url";
import { skipOrFail } from "@draftyak/spike-kit";
import { expect, it } from "vitest";
import { liveStub } from "../src/client.ts";
import { LIVE_TIMEOUT_MS, runLive, SESSION_ACCEPTANCE } from "./live-session.ts";

// S9b (M0.31) on the owner's key from .env.live: at most 6 calls under US$1, then, once the key is
// revoked, the same command records revoked: yes. The runbook is notes/session.md.
const file = fileURLToPath(new URL("../evidence/live.json", import.meta.url));

it("S9b: the Messages API through ctx.fetch, live", { timeout: LIVE_TIMEOUT_MS }, async (ctx) => {
	const outcome = await runLive({ file, openStub: liveStub, signal: ctx.signal, log: console.log });
	if (outcome.step === "skipped") return skipOrFail(ctx, outcome.reason);
	if (outcome.step === "revocation") {
		expect(outcome.acceptance).toEqual(["revoked: yes"]);
		return;
	}
	for (const [index, line] of SESSION_ACCEPTANCE.entries()) {
		expect.soft(outcome.acceptance[index]).toBe(line);
	}
});
