import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { aiProviderV1 } from "@draftyak/protocol/ai-provider-v1";
import { validateManifest } from "@draftyak/protocol/manifest";
import { expect, it } from "vitest";
import manifest from "../draftyak.plugin.json" with { type: "json" };
import { createPlugin } from "../src/main.ts";

it("mounts the bundled Messages identity with brokered API-key credentials only", () => {
	const checked = validateManifest(manifest);
	expect(checked.ok).toBe(true);
	expect(manifest.id).toBe("@draftyak/ai-messages-api");
	expect(manifest.auth).toEqual({ kind: "api-key", scopes: [], requiredGrantedScopes: [] });
	expect(manifest.credentials).toEqual({ mode: "brokered", urlSecrets: [] });
	expect(manifest.egress).toEqual({ profile: "messages-api-v1" });
	expect(manifest.permissions).toEqual({});
	expect([...manifest.dataClasses].sort()).toEqual(
		["gmail.metadata", "gmail.content", "slack.metadata", "slack.content"].sort(),
	);
	const entry = createPlugin();
	expect(entry.plugin).toBe(manifest.id);
	expect(entry.version).toBe(manifest.version);
	expect(entry.tools.map((tool) => tool.name).sort()).toEqual(
		Object.keys(aiProviderV1.tools).sort(),
	);
});

it("keeps importing the production entry inert with dynamic code and network permission denied", () => {
	const entry = new URL("../src/main.ts", import.meta.url);
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	const script = [
		'import assert from "node:assert/strict";',
		"globalThis.fetch = async () => { throw new Error('Unexpected direct request'); };",
		`const { createPlugin } = await import(${JSON.stringify(entry.href)});`,
		"assert.equal(process.stdin.listenerCount('data'), 0);",
		"assert.equal(createPlugin().plugin, '@draftyak/ai-messages-api');",
		"process.stdout.write('messages-entry-import-ok');",
	].join("\n");
	const child = spawnSync(
		process.execPath,
		[
			"--permission",
			`--allow-fs-read=${root}`,
			"--disallow-code-generation-from-strings",
			"--input-type=module",
			"-e",
			script,
		],
		{
			encoding: "utf8",
			timeout: 15_000,
			windowsHide: true,
			env: {
				SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
				TEMP: tmpdir(),
				TMP: tmpdir(),
			},
		},
	);
	expect(child.error).toBeUndefined();
	expect(child.signal).toBeNull();
	expect(child.status, child.stderr).toBe(0);
	expect(child.stdout).toBe("messages-entry-import-ok");
	expect(child.stderr).toBe("");
});
