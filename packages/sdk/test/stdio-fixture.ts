import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export interface Reply {
	readonly id: number;
	readonly result?: Record<string, unknown>;
	readonly error?: unknown;
}
interface Clock {
	now(): number;
	schedule(callback: () => void, delay: number): () => void;
}
interface Request {
	readonly method: string;
	readonly id: number;
	readonly started: number;
}
interface Pending extends Request {
	readonly resolve: (value: Reply) => void;
	readonly reject: (error: Error) => void;
	readonly cancel: () => void;
}
interface StdioFixture {
	diagnostics(reason?: string): string;
	stderr(): string;
	ask(method: string, params?: Record<string, unknown>): Promise<Reply>;
	close(): Promise<void>;
}
const clock: Clock = {
	now: () => performance.now(),
	schedule(callback, delay) {
		const timer = setTimeout(callback, delay);
		return () => clearTimeout(timer);
	},
};
const metadata = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};
function bounded(text: string): string {
	const bytes = Buffer.from(text);
	let end = Math.min(bytes.length, 2048);
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

/** Synthetic test subprocess only; the production parent launch is a separate contract. */
export function stdioFixture(
	fixture: URL,
	options: { readonly args?: readonly string[]; readonly clock?: Clock } = {},
): StdioFixture {
	const timing = options.clock ?? clock;
	const child = spawn(
		process.execPath,
		["--disallow-code-generation-from-strings", fileURLToPath(fixture), ...(options.args ?? [])],
		{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
	);
	const stopped = Promise.withResolvers<void>();
	const lines = createInterface({ input: child.stdout });
	let stderr = "",
		lastFrame: string | null = null,
		stdoutBytes = 0,
		nextId = 0,
		eof = false,
		closed = false;
	let exit: { code: number | null; signal: string | null } | null = null;
	let ioError: string | undefined;
	let current: Request | undefined;
	let pending: Pending | undefined;
	const diagnostics = (reason = "assertion"): string =>
		JSON.stringify({
			reason,
			method: current ? bounded(current.method) : null,
			id: current?.id ?? null,
			elapsedMs: current ? Math.round(timing.now() - current.started) : null,
			exit,
			eof,
			ioError,
			stderr,
			stdout: { bytes: stdoutBytes, lastFrame },
		});
	const fail = (reason: string): void => {
		const request = pending;
		if (!request) return;
		pending = undefined;
		request.cancel();
		request.reject(new Error(`Stdio fixture request failed: ${diagnostics(reason)}`));
	};
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = bounded(stderr + chunk.toString("utf8"));
	});
	child.stdout.prependListener("data", (chunk: Buffer) => {
		stdoutBytes += chunk.length;
	});
	child.on("error", (error) => {
		ioError = bounded(error.message);
		fail("spawn");
	});
	child.stdin.on("error", (error) => {
		ioError = bounded(error.message);
	});
	child.once("exit", (code, signal) => {
		exit = { code, signal };
	});
	child.once("close", (code, signal) => {
		exit = { code, signal };
		closed = true;
		fail("eof");
		stopped.resolve();
	});
	lines.on("close", () => {
		eof = true;
	});
	lines.on("line", (line) => {
		lastFrame = bounded(line);
		const request = pending;
		if (!request) return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			fail("invalid-json");
			return;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			fail("invalid-reply");
			return;
		}
		const reply = value as Reply;
		if (reply.id !== request.id) {
			fail("correlation");
			return;
		}
		pending = undefined;
		request.cancel();
		request.resolve(reply);
	});
	return {
		diagnostics,
		stderr: () => stderr,
		ask(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
			if (pending) throw new Error("Only one fixture request may be pending");
			current = { method, id: ++nextId, started: timing.now() };
			if (closed)
				return Promise.reject(new Error(`Stdio fixture request failed: ${diagnostics("eof")}`));
			const reply = Promise.withResolvers<Reply>();
			pending = {
				...current,
				resolve: reply.resolve,
				reject: reply.reject,
				cancel: timing.schedule(() => fail(eof ? "eof" : "timeout"), 3000),
			};
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: current.id, method, params: { ...params, _meta: metadata } })}\n`,
			);
			return reply.promise;
		},
		async close(): Promise<void> {
			fail("closed");
			lines.close();
			child.stdin.end();
			if (!closed) child.kill();
			await stopped.promise;
		},
	};
}
