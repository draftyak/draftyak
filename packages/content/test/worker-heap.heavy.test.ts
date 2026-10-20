import type { WorkerOptions } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { cleanInWorker } from "../src/worker.ts";

const state = vi.hoisted(() => ({ first: true, errorCodes: [] as string[] }));
vi.mock("node:worker_threads", async () => {
	const actual = await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
	return {
		...actual,
		Worker: class extends actual.Worker {
			constructor(url: string | URL, options: WorkerOptions) {
				const target = state.first
					? new URL("./fixtures/heap-limit.worker.ts", import.meta.url)
					: url;
				state.first = false;
				super(target, options);
				this.on("error", (error: Error & { code?: string }) => {
					state.errorCodes.push(error.code ?? "MISSING_ERROR_CODE");
				});
			}
		},
	};
});

it("reports a genuine isolated heap failure and releases capacity for the next real job", async () => {
	await expect(cleanInWorker("text", "synthetic")).rejects.toMatchObject({
		code: "WORKER_FAILED",
		message: "Content processing failed.",
	});
	expect(state.errorCodes).toEqual(["ERR_WORKER_OUT_OF_MEMORY"]);
	const next = await cleanInWorker("text", "capacity recovered");
	expect(next.text).toBe("capacity recovered");
});
