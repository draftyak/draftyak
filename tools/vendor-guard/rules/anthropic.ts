import { inCode, type Rule, spawned } from "../src/rules.ts";

// Guardrail 3. The flags, variables, endpoints and the production OAuth client ID were checked
// against Claude Code 2.1.119.
export const anthropic: readonly Rule[] = [
	{
		id: "anthropic-config",
		kind: "vendor",
		reason:
			"Claude Code's per-user config: ~/.claude/, ~/.claude.json or CLAUDE_CONFIG_DIR (guardrail 3)",
		patterns: [/(?<![\w.-])\.claude(?:\.json)?(?![\w-])/i, /\bCLAUDE_CONFIG_DIR\b/i],
		bad: [
			inCode('const file = join(homedir(), ".claude", "settings.json");'),
			inCode('const file = home + "/.claude.json";'),
			inCode("const dir = process.env.CLAUDE_CONFIG_DIR;"),
			inCode("const dir = process.env.claude_config_dir;"),
		],
		good: [
			inCode('const file = "claude_desktop_config.json";'),
			inCode('const site = "https://www.claude.ai/";'),
		],
	},
	{
		id: "anthropic-desktop",
		kind: "vendor",
		reason:
			"Claude Desktop's per-user files other than claude_desktop_config.json, the one file `draftyak mcp add --write` may change (§6)",
		patterns: [
			/(?:[\\/]|["'`])Claude[\\/]+(?!claude_desktop_config\.json(?![\w.-]))[\w.-]/,
			/["'`]Claude["'`]\s*(?:\/|\)\s*\.join\()\s*["'`](?!claude_desktop_config\.json["'`])[\w.-]/,
			/\b(?:join|resolve|Path)\([^;]{0,200}?["'`]Claude["'`]\s*,\s*["'`](?!claude_desktop_config\.json["'`])[\w.-]/,
		],
		bad: [
			inCode('const cookies = "%APPDATA%/Claude/Cookies";'),
			inCode('const config = "~/Library/Application Support/Claude/config.json";'),
			inCode('const store = path.join(process.env.APPDATA, "Claude", "Local Storage");'),
			inCode('const cookies = new File(appData, "Claude/Cookies");'),
			{ path: "plugin/desktop.py", text: 'cookies = Path(appdata) / "Claude" / "Cookies"\n' },
			{ path: "src/desktop.rs", text: 'let cookies = dir.join("Claude").join("Cookies");\n' },
		],
		good: [
			inCode('const config = "%APPDATA%\\\\Claude\\\\claude_desktop_config.json";'),
			inCode('const config = "~/.config/Claude/claude_desktop_config.json";'),
			inCode('const config = path.join(appData, "Claude", "claude_desktop_config.json");'),
			inCode('const clients = ["Claude", "Codex"];'),
		],
	},
	{
		id: "anthropic-token",
		kind: "vendor",
		reason:
			"Claude Code's OAuth token: CLAUDE_CODE_OAUTH_TOKEN or `claude setup-token` (guardrail 3)",
		patterns: [/\bCLAUDE_CODE_OAUTH_TOKEN\b/i, spawned("claude", "setup-token")],
		bad: [
			inCode("const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;"),
			inCode("const token = process.env.claude_code_oauth_token;"),
			inCode('spawn("claude", ["setup-token"]);'),
			{ path: "scripts/login.sh", text: "claude --debug setup-token\n" },
		],
		good: [
			inCode("const key = process.env.ANTHROPIC_API_KEY;"),
			inCode("// claude mcp add --transport http draftyak <url>"),
		],
	},
	{
		id: "anthropic-print",
		kind: "vendor",
		reason: "spawning Claude Code's CLI in print mode, -p or --print (guardrail 3)",
		patterns: [spawned("claude", "-p|--print")],
		bad: [
			inCode('execFile("claude", ["-p", prompt]);'),
			inCode('const command = "claude --print summarize";'),
			inCode('spawn("claude", ["--model", "sonnet", "-p", prompt]);'),
			inCode('execFileSync("claude.exe", ["-c", "-p", "Check for type errors"]);'),
			{ path: "scripts/review.sh", text: 'claude --output-format json --print "x"\n' },
			{ path: "plugin/review.py", text: 'subprocess.run(["claude", "--verbose", "-p", prompt])\n' },
			{ path: "src/review.rs", text: 'Command::new("claude").arg("-c").arg("-p");\n' },
		],
		good: [
			inCode('spawn(process.execPath, ["-p", "1 + 1"]);'),
			inCode("// claude mcp list"),
			inCode('Command::new("claude").arg("--version");'),
			inCode("// claude mcp add --scope user draftyak -- node -p 1"),
		],
	},
	{
		id: "anthropic-agent-sdk",
		kind: "vendor",
		reason:
			"the proprietary Agent SDK (TypeScript or Python, current or former name); use the MIT Client SDK (guardrail 3)",
		patterns: [
			/@anthropic-ai\/claude-(?:agent-sdk|code)\b/,
			/(?<![\w-])claude[-_.](?:agent|code)[-_.]sdk\b/i,
		],
		bad: [
			inCode('import { query } from "@anthropic-ai/claude-agent-sdk";'),
			{
				path: "package.json",
				text: '{ "devDependencies": { "@anthropic-ai/claude-code": "2.1.119" } }\n',
			},
			{ path: "pyproject.toml", text: '[project]\ndependencies = ["claude-agent-sdk>=0.1"]\n' },
			{ path: "plugin/main.py", text: "from claude_code_sdk import query\n" },
		],
		good: [
			inCode('import Anthropic from "@anthropic-ai/sdk";'),
			{ path: "pyproject.toml", text: '[project]\ndependencies = ["anthropic>=0.70"]\n' },
		],
	},
	{
		id: "anthropic-login",
		kind: "vendor",
		reason:
			"claude.ai login: an Anthropic OAuth or login endpoint, or Claude Code's OAuth client ID (guardrail 3)",
		patterns: [
			/(?<![\w-])(?:claude\.(?:ai|com)|anthropic\.com)(?::\d+)?\/(?:[\w.~%-]+\/){0,8}?(?:oauth|login)(?![\w-])/i,
			/\b9d1c250a-e61b-44d9-88ed-5944d1962f5e\b/i,
		],
		bad: [
			inCode('const authorize = "https://claude.ai/oauth/authorize";'),
			inCode('const token = "https://platform.claude.com/v1/oauth/token";'),
			inCode('const authorize = "https://claude.com/cai/oauth/authorize";'),
			inCode('await fetch("https://api.anthropic.com/api/oauth/profile");'),
			inCode('const login = "https://claude.ai/login";'),
			inCode('const clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";'),
		],
		good: [
			inCode('const redirect = "https://claude.ai/api/mcp/auth_callback";'),
			inCode('const api = "https://api.anthropic.com/v1/messages";'),
		],
	},
];
