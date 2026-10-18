import { connect, createServer, type Server } from "node:net";
import { acquireBenchLock, skipOrFail } from "@draftyak/spike-kit";
import { expect, it, type TestContext } from "vitest";
import { CALLBACK_PORT, discover, newHostId, signIn } from "../src/auth.ts";
import type { SiwcError } from "../src/errors.ts";
import { startFakeAuth } from "./fake-auth.ts";
import { failure } from "./harness.ts";

// The real callback port, 127.0.0.1:1455, bound only here and only under the kit's machine-wide
// lock (port-only, no idle check), so two S7 runs on one machine wait for each other instead of
// colliding. The unit tier checks the same refusal on OS-assigned ports.

const held = (port: number): Promise<boolean> =>
	new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port, timeout: 1_000 });
		const done = (result: boolean): void => {
			socket.destroy();
			resolve(result);
		};
		socket
			.once("connect", () => done(true))
			.once("timeout", () => done(true))
			.once("error", () => done(false));
	});

async function hold(host: string): Promise<Server> {
	const server = createServer((socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject).listen({ host, port: CALLBACK_PORT, exclusive: true }, resolve);
	});
	return server;
}

const release = (server: Server): Promise<void> =>
	new Promise((resolve) => server.close(() => resolve()));

async function lockPort(ctx: TestContext) {
	const lock = await acquireBenchLock({
		label: "s07-callback-1455",
		idle: false,
		signal: ctx.signal,
	});
	if (await held(CALLBACK_PORT)) {
		lock.release();
		skipOrFail(ctx, `127.0.0.1:${CALLBACK_PORT} is held by another program`);
	}
	return lock;
}

it.for(["127.0.0.1", "0.0.0.0"])(
	"port 1455 held on %s gives PORT_IN_USE before any browser opens",
	async (host, ctx) => {
		using _lock = await lockPort(ctx);
		const auth = await startFakeAuth();
		const holder = await hold(host);
		try {
			let opened = false;
			const error = (await failure(
				signIn({
					hostId: newHostId(),
					endpoints: await discover(auth.url),
					openBrowser: () => {
						opened = true;
					},
				}),
			)) as SiwcError;
			expect([error.code, error.facts.detail]).toEqual(["PORT_IN_USE", "127.0.0.1:1455"]);
			expect(error.message).toMatch(/held by another program/);
			expect(opened).toBe(false);
			expect(auth.authorizations).toEqual([]);
		} finally {
			await release(holder);
			await auth.close();
		}
	},
);

it("a free port 1455 carries the sign-in and is released after it", async (ctx) => {
	using _lock = await lockPort(ctx);
	const auth = await startFakeAuth();
	try {
		const credential = await signIn({
			hostId: newHostId(),
			endpoints: await discover(auth.url),
			openBrowser: auth.browse,
		});
		expect(auth.authorizations[0]?.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
		expect(auth.tokenForms[0]?.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
		expect(credential.tokens?.scopes).toContain("chatgpt.tokens.use.direct");
		expect(await held(CALLBACK_PORT)).toBe(false);
	} finally {
		await auth.close();
	}
});
