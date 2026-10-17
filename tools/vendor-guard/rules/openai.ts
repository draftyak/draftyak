import { inCode, type PatternRule, type Rule, spawned } from "../src/rules.ts";

// The SIWC DevKit's package names, as S7 (M0.26) records them in spikes/s07-siwc/notes/sources.md;
// empty until then. Each name is flagged as an exact package or module name.
export const devkitNames: readonly string[] = [];

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function devkitRule(names: readonly string[]): PatternRule {
	return {
		id: "openai-devkit",
		kind: "vendor",
		reason: "the noncommercial SIWC DevKit; SIWC is implemented clean-room (guardrail 4)",
		patterns: [new RegExp(`(?<![\\w.@/-])(?:${names.map(literal).join("|")})(?![\\w-])`, "i")],
		bad: names.map((name) => inCode(`import devkit from "${name}";`)),
		good: [inCode('import OpenAI from "openai";')],
	};
}

// Guardrail 4. Codex's OAuth client ID is the value the plan's research recorded; no Codex CLI was
// installed to check it against.
export const openai: readonly Rule[] = [
	{
		id: "openai-backend",
		kind: "vendor",
		reason: "ChatGPT's private backend API (guardrail 4)",
		patterns: [/\b(?:chatgpt\.com|chat\.openai\.com)(?::\d+)?\/backend-(?:api|anon)\b/i],
		bad: [
			inCode('await fetch("https://chatgpt.com/backend-api/conversation");'),
			inCode('const base = "https://chat.openai.com/backend-api";'),
		],
		good: [
			inCode('const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";'),
			inCode('const api = "https://api.openai.com/v1/responses";'),
		],
	},
	{
		id: "openai-codex-auth",
		kind: "vendor",
		reason:
			"Codex's per-user files, such as ~/.codex/auth.json; only ~/.codex/config.toml may be written (§6, guardrail 4)",
		patterns: [
			/(?<![\w.-])\.codex(?:[\\/]+|["'`]\s*(?:,|\/|\)\s*\.join\()\s*["'`])(?!config\.toml(?![\w.-]))[\w.-]/i,
		],
		bad: [
			inCode('const auth = readFileSync(join(homedir(), ".codex", "auth.json"));'),
			inCode('const auth = "~/.codex/auth.json";'),
			inCode('const sessions = "%USERPROFILE%\\\\.codex\\\\sessions";'),
			{ path: "plugin/auth.py", text: 'auth = Path.home() / ".codex" / "auth.json"\n' },
			{ path: "src/auth.rs", text: 'let auth = home.join(".codex").join("auth.json");\n' },
		],
		good: [
			inCode('const config = join(homedir(), ".codex", "config.toml");'),
			inCode('const config = "~/.codex/config.toml";'),
			{ path: "plugin/config.py", text: 'config = Path.home() / ".codex" / "config.toml"\n' },
		],
	},
	{
		id: "openai-codex-client",
		kind: "vendor",
		reason:
			"Codex's client: its OAuth client ID, its CLI or SDK packages, or `codex exec` (guardrail 4)",
		patterns: [/\bapp_EMoamEEZ73f0CkXaXp7hrann\b/, /@openai\/codex\b/i, spawned("codex", "exec")],
		bad: [
			inCode('const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";'),
			{ path: "package.json", text: '{ "dependencies": { "@openai/codex-sdk": "0.1.0" } }\n' },
			inCode('spawn("codex", ["exec", task]);'),
			inCode('spawn("codex", ["-m", "o3", "exec", task]);'),
			{ path: "src/agent.rs", text: 'Command::new("codex").args(["exec", task]);\n' },
		],
		good: [
			inCode('import OpenAI from "openai";'),
			inCode("// codex mcp login draftyak"),
			inCode('spawn("codex", ["mcp", "list"]);'),
		],
	},
	...(devkitNames.length > 0 ? [devkitRule(devkitNames)] : []),
];
