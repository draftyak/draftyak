import os from "node:os";
import path from "node:path";

// The unit tier's setup file (vitest.config.ts). Any fetch beyond loopback throws, and .env.live
// resolves to a file that doesn't exist, so no unit test can reach the API or read the owner's key.
// Live tests never load it.
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
process.env.DRAFTYAK_ENV_LIVE = path.join(os.tmpdir(), "draftyak-s09-unit", "no-such", ".env.live");
// The SDK reads ANTHROPIC_* settings, and no client option turns ANTHROPIC_CUSTOM_HEADERS off, so a
// developer's own settings never reach these tests (or the child processes they start); tests that
// need one set it themselves.
for (const name of Object.keys(process.env)) {
	if (name.toUpperCase().startsWith("ANTHROPIC_")) delete process.env[name];
}
