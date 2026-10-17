import { glue, inCode, type Rule } from "../src/rules.ts";

// Guardrail 5: owners bring their own Desktop OAuth client, and no client ID is ever in the repo.
export const google: readonly Rule[] = [
	{
		id: "google-client-id",
		kind: "secret",
		reason: "a Google OAuth client ID; owners bring their own (guardrail 5)",
		patterns: [/\b\d+-[0-9a-z]{20,}\.apps\.googleusercontent\.com\b/i],
		bad: [
			inCode(
				glue(
					'const clientId = "123456789012',
					"-abcdefghijklmnopqrstuvwxyz012345",
					'.apps.googleusercontent.com";',
				),
			),
		],
		good: [
			inCode("const desktop = /^\\d+-[0-9a-z]+\\.apps\\.googleusercontent\\.com$/;"),
			inCode('const hint = "<id>.apps.googleusercontent.com";'),
		],
	},
	{
		id: "google-client-secret",
		kind: "secret",
		reason: "a Google OAuth client secret (guardrail 5)",
		patterns: [/\bGOCSPX-[\w-]{20,}/],
		bad: [inCode(glue('const secret = "GOC', "SPX-", 'abcdefghijKLMNOPqrstUVWXyz01";'))],
		good: [inCode('const isSecret = value.startsWith("GOCSPX-");')],
	},
];
