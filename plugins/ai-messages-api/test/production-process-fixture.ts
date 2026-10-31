import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createMessagesApiDraftFake } from "@draftyak/fakes/messages-api";
import { HOST_FRAME_TAG, HostFetchParams, HostMessage } from "@draftyak/protocol/host-channel";
import { expect } from "vitest";
import {
	observeStdioFixture,
	STDIO_FIXTURE_STARTUP_MS,
	stdioFixtureRequestDeadline,
} from "../../../packages/sdk/test/stdio-readiness.ts";
import { DEFAULT_MODEL } from "../src/request.ts";
import { canary, draft, input, message } from "./helpers.ts";

export async function assertProductionProcess(
	mode: "main" | "configured" | "built",
): Promise<void> {
	const configuredModel = mode === "configured" ? "claude-configured-model" : DEFAULT_MODEL;
	const row = {
		id: configuredModel,
		type: "model",
		display_name: "Synthetic model",
		lifecycle: "active",
		max_input_tokens: 12_345,
	};
	const fake = createMessagesApiDraftFake({
		steps: [
			{
				kind: "json",
				body: { data: [row], has_more: false, first_id: row.id, last_id: row.id },
			},
			{ kind: "json", body: row },
			{ kind: "json", body: message() },
			{
				kind: "json",
				status: 429,
				headers: { "retry-after": "2" },
				body: {
					type: "error",
					error: { type: "rate_limit_error", message: "Synthetic rate limit" },
				},
			},
		],
	});
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	const child = spawn(
		process.execPath,
		[
			"--permission",
			`--allow-fs-read=${root}`,
			"--disallow-code-generation-from-strings",
			fileURLToPath(
				new URL(
					mode === "built"
						? "../dist/main.mjs"
						: mode === "main"
							? "../src/main.ts"
							: "./fixtures/production-start.ts",
					import.meta.url,
				),
			),
		],
		{
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			env: {
				SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
				TEMP: tmpdir(),
				TMP: tmpdir(),
				ANTHROPIC_API_KEY: canary,
				ANTHROPIC_AUTH_TOKEN: canary,
				ANTHROPIC_BASE_URL: "https://example.invalid/unused",
				ANTHROPIC_CUSTOM_HEADERS: "",
			},
		},
	);
	const fixture = observeStdioFixture(child);
	const lines = createInterface({ input: child.stdout });
	const output = lines[Symbol.asyncIterator]();
	const requests: HostFetchParams[] = [];
	const notifications: Record<string, unknown>[] = [];
	let id = 0;
	async function ask(method: string, params: Record<string, unknown> = {}) {
		const current = ++id;
		// The first real reply measures bootstrap; subsequent calls use the shared request budget.
		const deadline =
			current === 1 ? performance.now() + STDIO_FIXTURE_STARTUP_MS : stdioFixtureRequestDeadline();
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, ...(params._meta as object) } } })}\n`,
		);
		for (;;) {
			const line = await fixture.nextLine(output, method, current, deadline);
			if (line.startsWith(HOST_FRAME_TAG)) {
				const frame = HostMessage.parse(JSON.parse(line.slice(1)));
				if (!("method" in frame) || !("id" in frame) || frame.method !== "host/fetch")
					throw new Error("Unexpected host operation");
				const request = HostFetchParams.parse(frame.params);
				requests.push(request);
				const url = new URL(request.url);
				expect(url.origin).toBe("https://api.anthropic.com");
				const response = await fake.fetch(`${url.pathname}${url.search}`, {
					method: request.method,
					headers: request.headers.map(([name, value]): [string, string] => [name, value]),
					...(request.body && "base64" in request.body
						? { body: Buffer.from(request.body.base64, "base64url") }
						: {}),
				});
				child.stdin.write(
					`${HOST_FRAME_TAG}${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { status: response.status, headers: [...response.headers], body: { base64: Buffer.from(await response.arrayBuffer()).toString("base64url") } } })}\n`,
				);
				continue;
			}
			const frame = JSON.parse(line);
			if (frame.method) {
				notifications.push(frame);
				continue;
			}
			fixture.checkId(frame.id, current, method);
			expect(frame.error).toBeUndefined();
			return frame.result as Record<string, unknown>;
		}
	}
	try {
		expect((await ask("server/discover")).capabilities).toHaveProperty("tools");
		expect((await ask("tools/list")).tools).toHaveLength(4);
		expect(
			(await ask("tools/call", { name: "ai_describe", arguments: {} })).structuredContent,
		).toEqual({ name: "Anthropic Messages", structuredOutput: "native" });
		expect(requests).toEqual([]);
		expect(
			(await ask("tools/call", { name: "ai_models_list", arguments: {} })).structuredContent,
		).toEqual({
			models: [{ id: configuredModel, name: row.display_name, contextTokens: 12_345 }],
		});
		expect(
			(await ask("tools/call", { name: "ai_probe", arguments: {} })).structuredContent,
		).toEqual({ status: "ok" });
		const generated = await ask("tools/call", {
			name: "ai_draft_generate",
			arguments: { ...input, model: DEFAULT_MODEL },
			_meta: { progressToken: "synthetic-progress" },
		});
		expect(generated.isError).not.toBe(true);
		expect(generated.structuredContent).toMatchObject({ kind: "draft", output: draft });
		expect(notifications).toContainEqual(
			expect.objectContaining({
				method: "notifications/progress",
				params: expect.objectContaining({ progressToken: "synthetic-progress", progress: 0 }),
			}),
		);
		const limited = await ask("tools/call", {
			name: "ai_draft_generate",
			arguments: { ...input, model: DEFAULT_MODEL },
		});
		expect(limited.isError).toBe(true);
		expect(limited.structuredContent).toEqual({ code: "RATE_LIMITED", retryAfterMs: 2000 });
		expect(fake.pending()).toBe(0);
		expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "POST", "POST"]);
		expect(new URL(requests[1]?.url ?? "").pathname).toBe(`/v1/models/${configuredModel}`);
		const posted = requests[2]?.body;
		if (!posted || !("base64" in posted)) throw new Error("Missing inline synthetic request body");
		expect(
			JSON.parse(Buffer.from(posted.base64, "base64url").toString()).output_config.effort,
		).toBe(mode === "configured" ? "high" : "medium");
		for (const request of requests) {
			const headers = new Headers(
				request.headers.map(([name, value]): [string, string] => [name, value]),
			);
			expect(headers.get("x-api-key")).toBe("brokered");
			expect(headers.has("authorization")).toBe(false);
			expect(JSON.stringify(request)).not.toContain(canary);
		}
		expect(fixture.stderrText()).toBe("");
	} finally {
		lines.close();
		child.stdin.end();
		child.kill();
		await fixture.stopped;
	}
}
