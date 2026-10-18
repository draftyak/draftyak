import { skipOrFail } from "@draftyak/spike-kit";
import { describe, it } from "vitest";
import {
	credentialsProblem,
	liveSession,
	runStep,
	STEP_TIMEOUT_MS,
	statusLines,
	stepFromEnv,
} from "./live-session.ts";

// S8b against Google (M0.29), one step of notes/session.md per run, picked by DRAFTYAK_S8_STEP.
// Without a step the run checks the .env.live entries and prints the session's state; missing
// entries skip it, or fail it under DRAFTYAK_STRICT_SKIPS=1. A step that was asked for always
// fails without its entries, so that a skip can't pass for a step that ran.
const step = stepFromEnv();
const session = liveSession();

describe("S8b Gmail live", () => {
	it(step === undefined ? "preflight" : `step ${step}`, {
		timeout: STEP_TIMEOUT_MS[step ?? "preflight"],
	}, async (ctx) => {
		const problem = credentialsProblem(step, session);
		if (problem !== undefined && step !== undefined) {
			throw new Error(`the ${step} step can't run: ${problem}`);
		}
		if (problem !== undefined) skipOrFail(ctx, problem);
		const lines = step === undefined ? statusLines(session) : await runStep(step, session);
		for (const line of lines) console.log(line);
	});
});
