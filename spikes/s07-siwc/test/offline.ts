import os from "node:os";
import path from "node:path";

// The unit tier's setup file (vitest.config.ts): any fetch beyond loopback throws, so no unit test
// reaches OpenAI, and .env.live resolves to a file that doesn't exist. Live tests never load it.
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
const realFetch = globalThis.fetch;
if (!(realFetch as { loopbackOnly?: boolean }).loopbackOnly) {
	const guarded = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (!LOOPBACK.has(url.hostname)) {
			return Promise.reject(new Error(`test fetch outside loopback refused: ${url.host}`));
		}
		return realFetch(input, init);
	};
	globalThis.fetch = Object.assign(guarded, { loopbackOnly: true }) as typeof fetch;
}
process.env.DRAFTYAK_ENV_LIVE = path.join(os.tmpdir(), "draftyak-s07-unit", "no-such", ".env.live");
// The SDK reads OPENAI_* settings, and nothing turns OPENAI_CUSTOM_HEADERS off, so a developer's
// own settings never reach these tests; tests that need one set it themselves.
for (const name of Object.keys(process.env)) {
	if (name.toUpperCase().startsWith("OPENAI_")) delete process.env[name];
}
