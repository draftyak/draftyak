import { createBroker } from "../src/broker.ts";
import { createClient, runDraft } from "../src/responses.ts";

// One draft in a process started with --disallow-code-generation-from-strings (test/no-codegen.test.ts):
// the fake's URL comes as an argument, the access token on stdin.
const [upstream = ""] = process.argv.slice(2);
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const token = Buffer.concat(chunks).toString("utf8");
const broker = createBroker({ token: async () => token, upstream, frameBytes: 7 });
const outcome = await runDraft(createClient(broker.fetch), {
	model: "gpt-fake-plan",
	instructions: "Draft a short reply to the thread.",
	prompt: "<thread>Hi</thread>",
	structure: "tool-namespace",
});
process.stdout.write(
	JSON.stringify({ kind: outcome.kind, verdicts: broker.requests.map((r) => r.verdict) }),
);
