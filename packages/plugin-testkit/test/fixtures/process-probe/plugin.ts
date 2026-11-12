import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import * as z from "zod";
import type { MockPlugin } from "../../../src/index.ts";
import { channelFixture } from "../channel/plugin.ts";

function code(error: unknown): string | undefined {
	return error !== null && typeof error === "object" && "code" in error
		? String(error.code)
		: undefined;
}

const inputSchema = z.strictObject({
	check: z.enum(["facts", "eval", "child", "sqlite", "fs", "ipc", "network", "wait", "late", "flush"]),
	path: z.string().optional(),
	port: z.number().int().min(1).max(65535).optional(),
	label: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
});

const requestIds = new Map<string, string | number>();
const aborted = new Set<string>();
let late: { readonly id: string | number; readonly label: string } | undefined;

/** Records only synthetic probe IDs, so a later test frame can target the exact retired call. */
export function observeProbeRequest(message: unknown): void {
	if (message === null || typeof message !== "object") return;
	const frame = message as Record<string, unknown>;
	if (frame.method !== "tools/call" || (typeof frame.id !== "string" && typeof frame.id !== "number")) return;
	const params = frame.params as { name?: unknown; arguments?: unknown } | undefined;
	if (params?.name !== "process_probe") return;
	const input = inputSchema.safeParse(params.arguments);
	if (!input.success || input.data.label === undefined) return;
	if (requestIds.size >= 16 && !requestIds.has(input.data.label)) throw new Error("Synthetic probe ID bound");
	requestIds.set(input.data.label, frame.id);
	if (input.data.check === "late") late = { id: frame.id, label: input.data.label };
}

export function probeFixture(): MockPlugin {
	const channel = channelFixture();
	return {
		...channel,
		entry: {
			...channel.entry,
			tools: [
				{
					name: "process_probe",
					inputSchema,
					async handler(value, context) {
						const input = inputSchema.parse(value);
						if (input.check === "flush") {
							const current = input.label === undefined ? undefined : requestIds.get(input.label);
							if (!late || current === undefined || current === late.id) throw new Error("Synthetic IDs missing");
							process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: late.id, result: { content: [{ type: "text", text: "Result in structuredContent." }], structuredContent: { marker: "stale" } } })}\n`);
							return { marker: "fresh", oldId: late.id, currentId: current, aborted: aborted.has(late.label) };
						}
						if (input.check === "late") {
							const label = input.label;
							if (label === undefined || !requestIds.has(label)) throw new Error("Synthetic late label required");
							context.signal.addEventListener("abort", () => aborted.add(label), { once: true });
							return { marker: "retired", oldId: requestIds.get(label) };
						}
						if (input.check === "wait") {
							const label = input.label;
							if (label === undefined) throw new Error("Synthetic wait label required");
							await (await context.fetch(`https://hello.draftyak.example/v1/conversations?cursor=${label}`)).text();
							return new Promise<never>((_resolve, reject) => {
								const stop = (): void => { aborted.add(label); reject(new Error("Synthetic probe aborted")); };
								if (context.signal.aborted) stop();
								else context.signal.addEventListener("abort", stop, { once: true });
							});
						}
						if (input.check === "facts")
							return {
								argv: process.execArgv,
								cwd: process.cwd(),
								envKeys: Object.keys(process.env).sort(),
								node: process.versions.node,
							};
						if (input.check === "ipc")
							return {
								channel: process.channel !== undefined,
								send: typeof process.send === "function",
								connected: process.connected === true,
							};
						if (input.check === "network") {
							const port = input.port;
							if (port === undefined) throw new TypeError("Synthetic port required");
							return new Promise<{ blocked: boolean }>((resolve) => {
								try {
									const socket = connect({ host: "127.0.0.1", port });
									const done = (blocked: boolean): void => {
										socket.destroy();
										resolve({ blocked });
									};
									socket.once("connect", () => done(false));
									socket.once("error", (error) => done(code(error) === "ERR_ACCESS_DENIED"));
									socket.setTimeout(1000, () => done(false));
								} catch (error) {
									resolve({ blocked: code(error) === "ERR_ACCESS_DENIED" });
								}
							});
						}
						try {
							switch (input.check) {
								case "eval":
									Reflect.construct(Function, ["return 1"])();
									break;
								case "child": {
									const child = spawnSync(process.execPath, ["--eval", "process.exit(0)"], {
										stdio: "ignore",
										windowsHide: true,
										timeout: 1000,
										env: {},
									});
									return { blocked: code(child.error) === "ERR_ACCESS_DENIED" };
								}
								case "sqlite": {
									const { DatabaseSync } = await import("node:sqlite");
									new DatabaseSync(":memory:").close();
									break;
								}
								case "fs":
									if (input.path === undefined) throw new TypeError("Synthetic path required");
									readFileSync(input.path);
									break;
							}
							return { blocked: false };
						} catch (error) {
							return {
								blocked:
									code(error) === "ERR_ACCESS_DENIED" ||
									(input.check === "eval" && error instanceof EvalError) ||
									(input.check === "sqlite" && code(error) === "ERR_UNKNOWN_BUILTIN_MODULE"),
							};
						}
					},
				},
			],
		},
	};
}

export const plugin: MockPlugin = probeFixture();
