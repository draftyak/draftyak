// The hub side of one S11c plugin session: MCP on stdio with the 2026-07-28 envelope, the fd-3 host
// channel through M0.12's decoder (./channel.ts), host/log notifications and the shim's boot report.
// Unlike suite.ts's attach, every request has a deadline and stdout isn't kept, so 1 MiB frames can
// repeat. Imports only node: built-ins and ./channel.ts, so the Docker runner stages it unchanged.
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import { createInterface } from "node:readline";
import { serveHostChannel } from "./channel.ts";

const ENVELOPE = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};

export interface Frame {
	readonly jsonrpc?: string;
	readonly id?: unknown;
	readonly result?: Record<string, unknown>;
	readonly error?: { readonly code: number; readonly message?: unknown };
}

export interface LogLine {
	readonly level: string;
	readonly message: string;
}

export interface Session {
	readonly child: ChildProcess;
	// The frame answering this request; null when the plugin exits or the deadline passes first.
	ask(method: string, params: object, timeoutMs?: number): Promise<Frame | null>;
	readonly ready: () => Readonly<Record<string, unknown>> | null;
	readonly bootFailure: () => Readonly<Record<string, unknown>> | null;
	readonly logs: () => readonly LogLine[];
	readonly stderr: () => string;
	readonly nonFrameLines: () => number;
	readonly exit: Promise<number | null>;
	// Ends stdin, waits up to graceMs for the plugin to exit, then kills it.
	close(graceMs?: number): Promise<number | null>;
}

const nothing = (): Record<string, unknown> => ({ status: 403, headers: {} });

export async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
	});
	try {
		return await Promise.race([promise, late]);
	} finally {
		clearTimeout(timer);
	}
}

export function openSession(
	child: ChildProcess,
	fetch: (params: Record<string, unknown>) => Record<string, unknown> = nothing,
): Session {
	const waiters = new Map<number, (frame: Frame) => void>();
	let next = 0;
	let ready: Record<string, unknown> | null = null;
	let bootFailure: Record<string, unknown> | null = null;
	let stderr = "";
	let nonFrames = 0;
	const logs: LogLine[] = [];
	createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
		if (line.trim() === "") return;
		try {
			const frame = JSON.parse(line) as Frame;
			if (frame.jsonrpc === "2.0" && typeof frame.id === "number") {
				waiters.get(frame.id)?.(frame);
				return;
			}
		} catch {
			// counted below
		}
		nonFrames += 1;
	});
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-8_000);
	});
	serveHostChannel(child, {
		fetch,
		notify: (method, params) => {
			if (method !== "host/log") return;
			const message = String(params.message ?? "");
			logs.push({ level: String(params.level ?? ""), message });
			const data = (params.data as Record<string, unknown> | undefined) ?? null;
			if (message === "ready") ready = data;
			if (message === "boot failed") bootFailure = data;
		},
	});
	const exit = (once(child, "close") as Promise<[number | null]>).then(
		([code]) => code,
		() => null,
	);
	const ask = async (method: string, params: object, timeoutMs = 60_000): Promise<Frame | null> => {
		const id = ++next;
		const answer = new Promise<Frame>((resolve) => waiters.set(id, resolve));
		const body = { ...params, _meta: ENVELOPE };
		child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: body })}\n`);
		try {
			return await within(
				Promise.race([answer, exit.then(() => null)]),
				timeoutMs,
				null as Frame | null,
			);
		} finally {
			waiters.delete(id);
		}
	};
	const close = async (graceMs = 8_000): Promise<number | null> => {
		child.stdin?.end();
		const code = await within(exit, graceMs, undefined);
		if (code !== undefined) return code;
		child.kill("SIGKILL");
		return await within(exit, 10_000, null);
	};
	return {
		child,
		ask,
		ready: () => ready,
		bootFailure: () => bootFailure,
		logs: () => logs,
		stderr: () => stderr,
		nonFrameLines: () => nonFrames,
		exit,
		close,
	};
}

export const structured = (frame: Frame | null): Record<string, unknown> | null =>
	(frame?.result?.structuredContent as Record<string, unknown> | undefined) ?? null;

export const firstText = (frame: Frame | null): string | null =>
	(frame?.result?.content as { text?: unknown }[] | undefined)?.[0]?.text?.toString() ?? null;

// A path's folders may hold single spaces when another separator follows ("Jane Doe" in
// C:\Users\Jane Doe\x); its last part may not. So a folder name with a space leaves no fragment.
const SEGMENT = String.raw`[^\s\\/'"\x60,;:()]+`;
const FOLDERS = String.raw`(?:[\\/]${SEGMENT}(?: ${SEGMENT})*(?=[\\/]))*`;
const PATH = new RegExp(String.raw`(?:[A-Za-z]:)?${FOLDERS}[\\/]${SEGMENT}[\\/]?`, "g");
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// This machine's temp and home folders and any given root, longest first, with either separator.
function rootsPattern(roots: readonly string[]): RegExp {
	const all = [os.tmpdir(), os.homedir(), ...roots]
		.map((root) => root.replace(/[\\/]+$/, ""))
		.filter((root) => root.length > 3)
		.toSorted((a, b) => b.length - a.length)
		.map((root) => escaped(root).replace(/\\\\|\//g, String.raw`[\\/]`));
	if (all.length === 0) return /(?!)/g;
	const tail = String.raw`${FOLDERS}(?:[\\/]${SEGMENT})?[\\/]?`;
	return new RegExp(`(?:${all.join("|")})(?![\\w.-])${tail}`, "gi");
}

// Paths, quoted values and long numbers out, at most 200 characters: what evidence may hold. Paths
// under the home or temp folder (or a given root) go whole, spaces included, before the pattern.
export function contentFree(text: string, roots: readonly string[] = []): string {
	return text
		.slice(0, 2_000)
		.replace(rootsPattern(roots), "<path>")
		.replace(PATH, "<path>")
		.replace(/(['"`]).*?\1/g, "<value>")
		.replace(/\d{5,}/g, "<n>")
		.replace(/[^\w .,:;=()<>!?%+-]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);
}

// Why a plugin failed or didn't exit cleanly, from its stderr and host/log lines: the shim's boot
// failure, a Rust panic's message, the cause of a Pyodide fatal error, else the first line naming an
// error or a failed assertion.
export function reasonOf(output: readonly string[]): string | null {
	const lines = output.flatMap((text) => text.split(/\r?\n/)).map((line) => line.trim());
	const found = new Set<string>();
	for (const [index, line] of lines.entries()) {
		const next = lines[index + 1] ?? "";
		if (line.includes("shim: boot failed")) found.add(line.replace(/^.*?shim: /, ""));
		if (/ panicked at /.test(line) && next !== "") found.add(`Rust panic: ${next}`);
		if (line.startsWith("The cause of the fatal error was") && next !== "") {
			found.add(`fatal error: ${next}`);
		}
	}
	if (found.size === 0) {
		const named = /\w(?:Error|Exception)\b|abort|denied|unable|assertion failed/i;
		const first = lines.find((line) => named.test(line));
		if (first !== undefined) found.add(first);
	}
	const reason = contentFree([...found].join("; "));
	return reason === "" ? null : reason;
}

// Why a process didn't exit with 0: its stderr, else the signal or the code.
export function exitReasonOf(
	code: number | null,
	signal: string | null,
	stderr: string,
): string | null {
	if (code === 0) return null;
	return reasonOf([stderr]) ?? (signal !== null ? `signal ${signal}` : `exit ${code}`);
}
