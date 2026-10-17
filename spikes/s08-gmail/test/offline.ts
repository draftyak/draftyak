// The unit tier's setup file (vitest.config.ts): any fetch beyond loopback, Google's endpoints
// included, throws. Live tests never load it, so they can import the fakes' helpers.
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
