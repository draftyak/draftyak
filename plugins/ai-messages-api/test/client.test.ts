import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canary } from "./helpers.ts";

describe("pinned SDK compatibility in isolated synthetic processes", () => {
	it.each([
		"parse",
		"beta.parse",
		"create",
		"beta.create",
		"stream",
		"beta.stream",
		"config",
		"default-client",
		"retry",
		"beta-drift",
		"custom-headers",
		"no-fallback",
		"model-pin",
		"haiku-fallback",
		"max_tokens",
		"refusal",
		"invalid-options",
		"jitless",
	])("preserves the %s wire contract", (mode) => {
		const child = spawnSync(
			process.execPath,
			[
				"--disallow-code-generation-from-strings",
				fileURLToPath(new URL("./client-child.ts", import.meta.url)),
				mode,
			],
			{
				encoding: "utf8",
				// Only technical settings and synthetic provider values enter the child.
				env: {
					SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
					TEMP: tmpdir(),
					TMP: tmpdir(),
					ANTHROPIC_API_KEY: canary,
					ANTHROPIC_AUTH_TOKEN: canary,
					ANTHROPIC_WEBHOOK_SIGNING_KEY: canary,
					ANTHROPIC_BASE_URL: "https://example.invalid/unused",
					ANTHROPIC_LOG: "debug",
					ANTHROPIC_CUSTOM_HEADERS: "",
					ANTHROPIC_OPEN_TELEMETRY: "true",
					ANTHROPIC_OPEN_TELEMETRY_PROPAGATION: "true",
					ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE: "content",
				},
			},
		);
		expect(child.error).toBeUndefined();
		expect(child.signal).toBeNull();
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout.trim()).toBe("messages-sdk-case-ok");
		expect(child.stderr).toBe("");
	});
});
