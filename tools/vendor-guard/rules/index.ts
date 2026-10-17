import type { Rule } from "../src/rules.ts";
import { anthropic } from "./anthropic.ts";
import { attribution } from "./attribution.ts";
import { evidence, evidenceFormat } from "./evidence.ts";
import { google } from "./google.ts";
import { vendorMark } from "./marks.ts";
import { openai } from "./openai.ts";
import { secrets } from "./secrets.ts";
import { slack } from "./slack.ts";

export { evidenceFormat, evidenceSubject } from "./evidence.ts";

export const rules: readonly Rule[] = [
	...anthropic,
	...openai,
	...slack,
	...google,
	...secrets,
	vendorMark,
	attribution,
	...evidence,
	evidenceFormat,
];
