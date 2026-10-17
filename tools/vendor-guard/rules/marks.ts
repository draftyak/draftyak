import type { Rule } from "../src/rules.ts";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// Guardrails 3 and 4: Anthropic and OpenAI marks never appear in names. Dependencies aren't names,
// and nominative channel names (channel-gmail, channel-slack) are allowed.
export const vendorMark: Rule = {
	id: "vendor-mark",
	kind: "mark",
	reason:
		"a vendor mark in a package, bin, crate, Python project or script, Tauri or Android identifier (guardrails 3 and 4)",
	marks: ["anthropic", "claude", "openai", "chatgpt", "gpt", "codex"],
	bad: [
		{ path: "package.json", text: json({ name: "@draftyak/claude-tools" }) },
		{
			path: "apps/cli/package.json",
			text: json({ name: "draftyak", bin: { "gpt-draft": "cli.js" } }),
		},
		{
			path: "crates/bridge/Cargo.toml",
			text: '[package]\nname = "openai-bridge"\nversion = "0.1.0"\n',
		},
		{
			path: "pyproject.toml",
			text: '[project]\nname = "draftyak"\n\n[project.scripts]\nchatgpt-sync = "draftyak.cli:main"\n',
		},
		{
			path: "apps/app/src-tauri/tauri.conf.json",
			text: json({ productName: "DraftYak", identifier: "com.draftyak.anthropic" }),
		},
		{
			path: "apps/sms-host/app/build.gradle.kts",
			text: 'android {\n    namespace = "com.draftyak.codex"\n}\n',
		},
		{ path: "apps/sms-host/settings.gradle.kts", text: 'rootProject.name = "codex-probe"\n' },
		{
			path: "apps/sms-host/app/src/main/AndroidManifest.xml",
			text: '<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n    package="com.draftyak.claude">\n</manifest>\n',
		},
	],
	good: [
		{
			path: "plugins/ai-messages-api/package.json",
			text: json({
				name: "@draftyak/ai-messages-api",
				bin: { draftyak: "cli.js" },
				dependencies: { "@anthropic-ai/sdk": "0.135.0", openai: "7.36.0" },
			}),
		},
		{
			path: "apps/app/src-tauri/tauri.conf.json",
			text: json({ productName: "DraftYak", identifier: "com.draftyak.client" }),
		},
		{
			path: "crates/transport/Cargo.toml",
			text: '[package]\nname = "draftyak-transport"\n\n[dependencies]\nopenai-api = "1"\n',
		},
	],
};
