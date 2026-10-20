import { fileURLToPath } from "node:url";
import { skipOrFail } from "@draftyak/spike-kit";
import { expect, it } from "vitest";
import { liveStub } from "../src/client.ts";
import { LIVE_TIMEOUT_MS, runLive, SESSION_ACCEPTANCE } from "./live-session.ts";

// S9b (M0.31): at most 6 requests with a US$1 planning/reservation gate. Current default fallback
// routing is held before transport; original live acceptance remains pending. See notes/session.md.
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
