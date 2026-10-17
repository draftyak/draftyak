// The unit tier's setup file (vitest.config.ts): fetch and WebSocket refuse anything beyond
// loopback, so no test can reach Slack. Live tests never load it.
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

const RealWebSocket = globalThis.WebSocket;
if (!(RealWebSocket as { loopbackOnly?: boolean }).loopbackOnly) {
	class LoopbackWebSocket extends RealWebSocket {
		static readonly loopbackOnly = true;
		constructor(url: string | URL, protocols?: string | string[]) {
			const host = new URL(url).hostname;
			if (!LOOPBACK.has(host)) throw new Error(`test WebSocket outside loopback refused: ${host}`);
			super(url, protocols);
		}
	}
	globalThis.WebSocket = LoopbackWebSocket;
}
