import { glue, inCode, type Rule } from "../src/rules.ts";

const issuers =
	/^(?:https?:\/\/)?(?:[\w-]+\.)*(?:openai\.com|chatgpt\.com|anthropic\.com|claude\.(?:ai|com)|google(?:apis)?\.com|slack\.com)(?:[:/]|$)/i;

// A JWT that a vendor issued: Sign in with ChatGPT and Codex tokens, Google ID tokens, Slack's.
function vendorIssued(token: string): boolean {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
		return typeof payload?.iss === "string" && issuers.test(payload.iss);
	} catch {
		return false;
	}
}

const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: object): string =>
	[part({ alg: "RS256", typ: "JWT" }), part(claims), part({ signature: "not a real one" })].join(
		".",
	);

// Real credentials have these shapes; fakes in tests are built at runtime or stay shorter.
export const secrets: readonly Rule[] = [
	{
		id: "secret-slack",
		kind: "secret",
		reason: "a Slack token or webhook URL",
		patterns: [
			/\bxox[a-z](?:\.xox[a-z])?-\d[\w-]{8,}/,
			/\bxapp-\d-[\w-]{8,}/,
			/\bhooks\.slack\.com\/(?:services|workflows|triggers)\/T\w+\/[\w/]{16,}/,
		],
		bad: [
			inCode(glue('const bot = "xo', "xb-1234567890-1234567890-", 'abcdefghijKLMNOPqrstUVWX";')),
			inCode(glue('const app = "xa', "pp-1-A0123456789-1234567890-", 'abcdef0123456789";')),
			inCode(
				glue(
					'const hook = "https://hooks.',
					"slack.com/services/T0123456/",
					'B0123456/abcdefghijKLMNOPqrstUVWX";',
				),
			),
		],
		good: [inCode('const isBot = token.startsWith("xoxb-");'), inCode('const hint = "xoxp-…";')],
	},
	{
		id: "secret-anthropic",
		kind: "secret",
		reason: "an Anthropic API or OAuth key",
		patterns: [/\bsk-ant-[a-z]+\d*-[\w-]{20,}/],
		bad: [inCode(glue('const key = "sk-', "ant-api03-", 'abcdefghijKLMNOPqrstUVWXyz0123456789";'))],
		good: [inCode('const isKey = value.startsWith("sk-ant-");')],
	},
	{
		id: "secret-openai",
		kind: "secret",
		reason: "an OpenAI API key",
		patterns: [
			/\bsk-(?:proj|svcacct|admin)-[\w-]{20,}/,
			/\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/,
		],
		bad: [
			inCode(glue('const key = "sk-', "proj-", 'abcdefghijKLMNOPqrstUVWXyz0123456789";')),
			inCode(
				glue('const key = "sk-', "abcdefghijKLMNOPqrst", "T3Blbk", 'FJabcdefghijKLMNOPqrst";'),
			),
		],
		good: [inCode('const isKey = value.startsWith("sk-proj-");')],
	},
	{
		id: "secret-google",
		kind: "secret",
		reason: "a Google API key or OAuth token",
		patterns: [/\bAIza[\w-]{35}(?![\w-])/, /\bya29\.[\w-]{20,}/, /\b1\/\/0[\w-]{20,}/],
		bad: [
			inCode(glue('const key = "AI', "za", 'SyA-abcdefghijKLMNOPqrstUVWXyz01234";')),
			inCode(glue('const access = "ya', "29.", 'a0AfH6SMBabcdefghijKLMNOPqrst";')),
			inCode(glue('const refresh = "1', "//0", 'gabcdefghijKLMNOPqrstUVWXyz";')),
		],
		good: [inCode('const isKey = value.startsWith("AIza");')],
	},
	{
		id: "secret-jwt",
		kind: "secret",
		reason: "a token (JWT) issued by OpenAI, Anthropic, Google or Slack",
		patterns: [/(?<![\w-])eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{20,}/],
		accept: vendorIssued,
		bad: [
			inCode(`const access = "${jwt({ iss: "https://auth.openai.com", sub: "user-1" })}";`),
			{
				path: "spikes/s08-gmail/fixtures/token.json",
				text: `${JSON.stringify({ id_token: jwt({ iss: "accounts.google.com", sub: "1" }) })}\n`,
			},
		],
		good: [inCode(`const token = "${jwt({ iss: "https://hub.example.test", sub: "agent-1" })}";`)],
	},
];
