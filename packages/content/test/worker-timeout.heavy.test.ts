import type { WorkerOptions } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { cleanInWorker } from "../src/worker.ts";

const state = vi.hoisted(() => ({ first: true, exits: [] as Promise<number>[] }));
vi.mock("node:worker_threads", async () => {
	const actual = await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
	return {
		...actual,
		Worker: class extends actual.Worker {
			constructor(url: string | URL, options: WorkerOptions) {
				const blocked = state.first;
				state.first = false;
				super(
					blocked ? new URL("./fixtures/blocked-job.worker.ts", import.meta.url) : url,
					options,
				);
				if (blocked) state.exits.push(new Promise((resolve) => this.once("exit", resolve)));
			}
		},
	};
});

it("terminates a ready worker's blocked job on deadline and releases capacity", async () => {
	await expect(cleanInWorker("text", "synthetic", {}, { timeoutMs: 1 })).rejects.toMatchObject({
		code: "TIMEOUT",
		message: "Content processing timed out.",
	});
	expect(await Promise.all(state.exits)).toEqual([1]);
	expect((await cleanInWorker("text", "after timeout")).text).toBe("after timeout");
});
