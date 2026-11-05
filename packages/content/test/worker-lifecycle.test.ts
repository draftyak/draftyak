import type { WorkerOptions as NativeWorkerOptions } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, type Mock, vi } from "vitest";
import { cleanInWorker, parseMailInWorker } from "../src/worker.ts";

interface ControlledWorker {
	readonly url: URL;
	readonly options: NativeWorkerOptions;
	readonly postMessage: Mock;
	readonly terminate: Mock;
	emit(name: string, ...args: unknown[]): boolean;
}
const state = vi.hoisted(() => ({ workers: [] as ControlledWorker[] }));

vi.mock("node:worker_threads", async () => {
	const { EventEmitter } = await import("node:events");
	class Worker extends EventEmitter {
		readonly url: URL;
		readonly options: NativeWorkerOptions;
		readonly stdout = { resume: vi.fn() };
		readonly stderr = { resume: vi.fn() };
		readonly postMessage = vi.fn();
		readonly terminate = vi.fn(async () => 0);
		constructor(url: URL, options: NativeWorkerOptions) {
			super();
			this.url = url;
			this.options = options;
			state.workers.push(this);
		}
	}
	return { Worker };
});

const worker = (): ControlledWorker => {
	const current = state.workers.at(-1);
	if (!current) throw new Error("No worker was created");
	return current;
};
const result = {
	text: "synthetic",
	removals: { hidden: 0, invisible: 0, quoted: 0, truncated: 0, uris: 0 },
	links: [],
	suspectedInstructions: false,
};
const complete = (current: ControlledWorker): void => {
	current.emit("message", { ready: true });
	current.emit("message", { ok: true, value: result });
};

beforeEach(() => {
	state.workers.length = 0;
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

it("waits for loaded modules and installs the fixed isolated worker options", async () => {
	const pending = cleanInWorker("text", "synthetic");
	const current = worker();
	try {
		expect(current.url.pathname).toMatch(/\/worker-entry\.ts$/);
		expect(current.options).toEqual({
			execArgv: [],
			env: {},
			stdout: true,
			stderr: true,
			resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
		});
		await vi.advanceTimersByTimeAsync(9_000);
		expect(current.postMessage).not.toHaveBeenCalled();
		complete(current);
		expect(current.postMessage).toHaveBeenCalledTimes(1);
		expect(current.postMessage.mock.calls[0]).toEqual([
			{ kind: "text", source: "synthetic", options: undefined },
		]);
		await expect(pending).resolves.toEqual(result);
		expect(current.terminate).toHaveBeenCalledOnce();
	} finally {
		complete(current);
		await pending.catch(() => undefined);
	}
});

it("reports the independent ten-second startup limit and releases its slot", async () => {
	const pending = cleanInWorker("text", "synthetic");
	const failed = expect(pending).rejects.toMatchObject({
		code: "STARTUP_TIMEOUT",
		message: "Content worker startup timed out.",
	});
	const current = worker();
	await vi.advanceTimersByTimeAsync(10_000);
	await failed;
	expect(current.postMessage).not.toHaveBeenCalled();
	expect(current.terminate).toHaveBeenCalledOnce();
	const next = cleanInWorker("text", "synthetic");
	complete(worker());
	await expect(next).resolves.toEqual(result);
});

it("starts the two-second processing deadline only after readiness", async () => {
	const pending = cleanInWorker("text", "synthetic");
	const failed = expect(pending).rejects.toMatchObject({
		code: "TIMEOUT",
		message: "Content processing timed out.",
	});
	const current = worker();
	await vi.advanceTimersByTimeAsync(9_000);
	current.emit("message", { ready: true });
	await vi.advanceTimersByTimeAsync(1_999);
	expect(current.terminate).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	await failed;
	expect(current.terminate).toHaveBeenCalledOnce();
});

it("discards a worker exception without exposing its content and accepts the next job", async () => {
	const pending = cleanInWorker("text", "synthetic");
	const failed = expect(pending).rejects.toMatchObject({
		code: "WORKER_FAILED",
		message: "Content processing failed.",
	});
	worker().emit("error", new Error("PRIVATE_WORKER_CANARY"));
	await failed;
	const next = cleanInWorker("text", "synthetic");
	complete(worker());
	await expect(next).resolves.toEqual(result);
});

it("refuses results before readiness and releases capacity", async () => {
	const pending = cleanInWorker("text", "synthetic");
	const failed = expect(pending).rejects.toMatchObject({ code: "WORKER_FAILED" });
	worker().emit("message", { ok: true, value: result });
	await failed;
	const next = cleanInWorker("text", "synthetic");
	complete(worker());
	await expect(next).resolves.toEqual(result);
});

it("honors cancellation during startup without posting input", async () => {
	const controller = new AbortController();
	const pending = cleanInWorker("text", "synthetic", undefined, { signal: controller.signal });
	const failed = expect(pending).rejects.toMatchObject({
		code: "ABORTED",
		message: "Content processing was cancelled.",
	});
	const current = worker();
	controller.abort(new Error("PRIVATE_ABORT_CANARY"));
	await failed;
	expect(current.postMessage).not.toHaveBeenCalled();
	expect(current.terminate).toHaveBeenCalledOnce();
});

it("keeps capacity reserved until worker termination finishes", async () => {
	const first = cleanInWorker("text", "synthetic");
	const a = worker();
	const termination = Promise.withResolvers<number>();
	a.terminate.mockReturnValue(termination.promise);
	complete(a);
	await Promise.resolve();
	const second = cleanInWorker("text", "synthetic");
	const b = worker();
	await expect(cleanInWorker("text", "third")).rejects.toMatchObject({ code: "BUSY" });
	expect(a.terminate).toHaveBeenCalledOnce();
	termination.resolve(0);
	await first;
	complete(b);
	await second;
	const third = cleanInWorker("text", "synthetic");
	complete(worker());
	await expect(third).resolves.toEqual(result);
});

it("applies the merged mailbox scalar outside the parser heap and clears refused From authority", async () => {
	const pending = parseMailInWorker(Buffer.from("synthetic"), {
		provider: "gmail",
		ownerAddresses: ["owner@example.test"],
	});
	const current = worker();
	current.emit("message", { ready: true });
	const invalid = { address: "invalid@127.0.0.1" };
	current.emit("message", {
		ok: true,
		value: {
			rawSha256: "0".repeat(64),
			direction: "outbound",
			auth: { dmarc: "pass", verifiedSender: invalid.address, reason: "verified" },
			from: [invalid],
			to: [invalid, { address: "valid@example.test" }],
			cc: [invalid],
			bcc: [invalid],
			replyTo: [invalid],
			subject: "",
			body: result,
			attachments: [],
		},
	});
	const mail = await pending;
	expect(mail.from).toEqual([]);
	expect(mail.to).toEqual([{ address: "valid@example.test" }]);
	expect(mail.cc).toEqual([]);
	expect(mail.bcc).toEqual([]);
	expect(mail.replyTo).toEqual([]);
	expect(mail.auth).toEqual({ dmarc: "none", reason: "ambiguous-from" });
	expect(mail.direction).toBe("inbound");
});

it("bounds the larger mail decode heap and starts its ten-second budget only when ready", async () => {
	const pending = parseMailInWorker(Buffer.from("From: sender@example.test\r\n\r\nvisible"), {
		provider: "generic",
		ownerAddresses: [],
	});
	const failed = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
	const current = worker();
	expect(current.options).toEqual({
		execArgv: [],
		env: {},
		stdout: true,
		stderr: true,
		resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
	});
	await vi.advanceTimersByTimeAsync(9000);
	current.emit("message", { ready: true });
	await vi.advanceTimersByTimeAsync(9999);
	expect(current.terminate).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	await failed;
	expect(current.terminate).toHaveBeenCalledOnce();
	const next = cleanInWorker("text", "synthetic");
	complete(worker());
	await expect(next).resolves.toEqual(result);
});
