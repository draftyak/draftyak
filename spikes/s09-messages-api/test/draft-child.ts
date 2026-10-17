import { createClient, createCtxFetchStub } from "../src/client.ts";
import { draft } from "../src/draft.ts";

// Runs one draft against the fake whose URL test/no-codegen.test.ts passes; the key arrives on stdin.
const [upstream] = process.argv.slice(2);
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const key = Buffer.concat(chunks).toString("utf8");
const stub = createCtxFetchStub({ ...(upstream ? { upstream } : {}), key: { reveal: () => key } });
const result = await draft(createClient(stub), {
	system: "Draft a reply.",
	prompt: "<thread>Hi</thread>",
});
process.stdout.write(
	JSON.stringify({ kind: result.kind, verdicts: stub.requests.map((request) => request.verdict) }),
);
