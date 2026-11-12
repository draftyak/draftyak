import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildSlackMain, type MainProcess, startMain } from "./helpers/main-process.ts";
import { productionPollCases } from "./helpers/production-poll-cases.ts";
import { productionSocketCases } from "./helpers/production-socket-cases.ts";

let entry: string;
const children: MainProcess[] = [];

// Build the real runtime entry with the package's unchanged production config.
// Fresh unit-tier checkouts need no preexisting dist or alternate test entry.
beforeAll(async () => {
	entry = await buildSlackMain();
}, 60_000);

afterEach(async () => {
	const finished = await Promise.allSettled(children.splice(0).map((child) => child.close()));
	expect(finished.filter((result) => result.status === "rejected")).toEqual([]);
});

describe("built Slack main process", () => {
	// The portable bridge emits a Node event; this does not claim OS signal
	// delivery or production permission-flag/platform acceptance.
	it.each([{ event: "SIGINT" as const }, { event: "SIGTERM" as const }])(
		"handles $event and exits while the parent retains stdin",
		async ({ event }) => {
			// startMain waits for the actual SDK channel_describe reply from the
			// compiled runtime before the bridge can emit the Node signal event.
			const child = await startMain(entry);
			children.push(child);
			expect(child.stdinOpen()).toBe(true);
			expect(child.inputEnded).toBe(false);
			expect(await child.signal(event)).toBe(1);
			await expect(child.waitForExit(3_000)).resolves.toEqual({
				code: 0,
				signal: null,
			});
			// Cleanup runs only after this assertion. It cannot supply a successful
			// exit by sending EOF to a broken main or by force-terminating the child.
			expect(child.inputEnded).toBe(false);
			expect(child.errors).toEqual([]);
		},
	);

	it("still exits naturally on plain stdin EOF", async () => {
		const child = await startMain(entry, { signalBridge: false });
		children.push(child);
		expect(child.stdinOpen()).toBe(true);
		child.endInput();
		expect(await child.waitForExit(3_000)).toEqual({ code: 0, signal: null });
		expect(child.inputEnded).toBe(true);
		expect(child.errors).toEqual([]);
	});
});

productionSocketCases(() => entry);
productionPollCases(() => entry);
