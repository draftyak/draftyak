import { setImmediate as nextTurn } from "node:timers/promises";
import { createFake } from "@draftyak/fakes/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindProcessPlugin, createMockHub, createMockSocketUpstream } from "../src/index.ts";
import { MockHubError } from "../src/types.ts";
import { bundleCloseObservation } from "./fixtures/process-close-observation/bundle.ts";
import {
	CLOSE_ACCOUNT,
	CLOSE_SOCKET,
	type CloseMode,
	closeObservationPlugin,
} from "./fixtures/process-close-observation/plugin.ts";

let packed: Awaited<ReturnType<typeof bundleCloseObservation>> | undefined;
let cleanupQualified = true;
const cleanupJoins: Promise<void>[] = [];
beforeAll(async () => {
	packed = await bundleCloseObservation();
}, 30_000);
afterAll(async () => {
	await Promise.all(cleanupJoins);
	if (packed && cleanupQualified) await packed.close();
});

describe("Process cleanup and refused observations", () => {
	it.each([
		["malformed", "PROCESS_FRAME_INVALID"],
		["oversized", "PROCESS_FRAME_TOO_LARGE"],
		["stderr", "PROCESS_STDERR_LIMIT"],
	] as const)(
		"joins owned cleanup for %s while preserving the refused observation",
		async (mode: CloseMode, code) => {
			if (!packed) throw new Error("DYTEST built process fixture required");
			const backendClosed = Promise.withResolvers<void>();
			const closeEntered = Promise.withResolvers<void>();
			let backendCloseCalls = 0,
				parentCalls = 0,
				httpCalls = 0;
			const fake = createFake(
				{
					fetch: () => {
						httpCalls++;
						return new Response("DYTEST unexpected HTTP", { status: 500 });
					},
				},
				{ host: "slack.com" },
			);
			const socket = createMockSocketUpstream(fake, {
				url: CLOSE_SOCKET,
				open: () => ({
					ack() {},
					close() {
						backendCloseCalls++;
						closeEntered.resolve();
					},
					closed: backendClosed.promise,
				}),
			});
			const plugin = closeObservationPlugin(mode, () => {
				parentCalls++;
				throw new Error("DYTEST parent handler refused");
			});
			const hub = createMockHub({
				mode: "process",
				plugin: bindProcessPlugin(plugin, packed.files(mode)),
				account: { id: CLOSE_ACCOUNT, mode: "full" },
				instance: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
				upstreams: [fake],
				socketUpstreams: [socket],
			});
			const processHandle = hub.process;
			if (!processHandle) throw new Error("DYTEST actual process handle required");
			const observation = processHandle.whenClosed.then(
				() => ({ outcome: "qualified" }),
				(error: unknown) => ({
					outcome: "refused",
					code: error instanceof MockHubError ? error.code : "unexpected",
				}),
			);
			const callFailure = hub
				.call("channel_fetch", { url: "https://slack.com/api/auth.test" })
				.then(
					() => null,
					(error: unknown) => error,
				);
			const closings: Promise<unknown>[] = [];
			try {
				await expect(observation).resolves.toEqual({
					outcome: "refused",
					code: "PROCESS_OBSERVATION_FAILED",
				});
				let closeSettlements = 0;
				for (let index = 0; index < 2; index++)
					closings.push(
						hub.close().then(
							() => {
								closeSettlements++;
								return "closed";
							},
							(error: unknown) => {
								closeSettlements++;
								return error;
							},
						),
					);
				await closeEntered.promise;
				await nextTurn();
				expect(closeSettlements).toBe(0);
				backendClosed.resolve();
				await expect(callFailure).resolves.toMatchObject({ code });
				await expect(Promise.all(closings)).resolves.toEqual(["closed", "closed"]);
				expect(backendCloseCalls).toBe(1);
				expect(parentCalls).toBe(0);
				expect(httpCalls).toBe(0);
			} finally {
				backendClosed.resolve();
				const cleanup = hub.close().then(
					() => {},
					() => {
						cleanupQualified = false;
					},
				);
				cleanupJoins.push(cleanup);
				await Promise.all([cleanup, observation, callFailure, ...closings]);
			}
		},
	);
});
