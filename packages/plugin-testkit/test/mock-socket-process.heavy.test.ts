import { lstat, mkdtemp, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFake } from "@draftyak/fakes";
import { build } from "tsdown";
import { expect, it, vi } from "vitest";
import { createMockHub } from "../src/mock-hub.ts";
import { createMockSocketUpstream } from "../src/mock-socket-upstream.ts";
import { bindProcessPlugin } from "../src/process.ts";
import type { MockHub } from "../src/types.ts";
import {
	ACK_ID,
	EARLY_MESSAGE,
	SOCKET_URL,
	socketProcessPlugin,
} from "./fixtures/mock-socket-process/plugin.ts";

async function bundleSocketProcess() {
	const temporary = await realpath(tmpdir());
	const directory = await realpath(await mkdtemp(path.join(temporary, "draftyak-socket-process-")));
	const owner = await lstat(directory, { bigint: true });
	let removed = false;
	async function close() {
		if (removed) return;
		const current = await lstat(directory, { bigint: true });
		if (
			current.isSymbolicLink() ||
			current.dev !== owner.dev ||
			current.ino !== owner.ino ||
			(await realpath(directory)) !== directory ||
			path.dirname(directory) !== temporary
		) {
			throw new Error("DYTEST packed directory changed");
		}
		for (const name of await readdir(directory)) {
			if (name !== "server.mjs") throw new Error("DYTEST unexpected packed file");
			const member = path.join(directory, name);
			if (!(await lstat(member)).isFile()) throw new Error("DYTEST packed member changed");
			await unlink(member);
		}
		await rmdir(directory);
		removed = true;
	}
	try {
		await build({
			config: false,
			entry: {
				server: fileURLToPath(new URL("./fixtures/mock-socket-process/entry.ts", import.meta.url)),
			},
			outDir: directory,
			platform: "node",
			format: "esm",
			target: "node26",
			fixedExtension: true,
			deps: { alwaysBundle: [/.*/] },
			dts: false,
			sourcemap: false,
			clean: false,
			exports: false,
			report: false,
			logLevel: "warn",
			failOnWarn: true,
		});
		if ((await readdir(directory)).join() !== "server.mjs")
			throw new Error("DYTEST bundle is not self-contained");
		return {
			files: Object.freeze({
				directory,
				entry: "server.mjs",
				files: Object.freeze(["server.mjs"]),
			}),
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}

it("delivers an early socket frame through the real process bridge before the first user subscription", async () => {
	const packed = await bundleSocketProcess();
	const releaseOpen = Promise.withResolvers<void>(),
		published = Promise.withResolvers<void>();
	const backendClosed = Promise.withResolvers<void>(),
		closeStarted = Promise.withResolvers<void>();
	const parentHandler = vi.fn(() => {
		throw new Error("DYTEST parent handler executed");
	});
	const acknowledgements: string[] = [];
	const close = vi.fn(() => {
		closeStarted.resolve();
	});
	let openReturned = false,
		hub: MockHub | undefined,
		unsubscribe = () => {};
	let reply: Promise<Record<string, unknown>> | undefined;
	try {
		const upstream = createFake(
			{ fetch: () => Response.json({ ok: true, url: SOCKET_URL }) },
			{ host: "slack.com" },
		);
		const companion = createMockSocketUpstream(upstream, {
			url: SOCKET_URL,
			async open({ onData }) {
				onData(EARLY_MESSAGE);
				await releaseOpen.promise;
				openReturned = true;
				return {
					ack(envelopeId) {
						acknowledgements.push(envelopeId);
					},
					close,
					closed: backendClosed.promise,
				};
			},
		});
		hub = createMockHub({
			mode: "process",
			plugin: bindProcessPlugin(socketProcessPlugin(parentHandler), packed.files),
			upstreams: [upstream],
			socketUpstreams: [companion],
		});
		unsubscribe = hub.host.subscribe((frame) => {
			if (frame.method === "host/ws.message" && frame.params.data === EARLY_MESSAGE)
				published.resolve();
		});
		reply = hub.call("channel_sync", { mode: "initial", since: 0 });
		void reply.catch(() => {});
		await Promise.race([
			published.promise,
			reply.then(() => {
				throw new Error("DYTEST expected early publication");
			}),
		]);
		expect(openReturned).toBe(false);
		// The process subscriber has enqueued this notification before the open-result response.
		releaseOpen.resolve();
		const result = await reply;
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({
			changes: [
				{
					kind: "chat.message",
					channelId: "DYTEST-channel",
					ts: "1700000000.000001",
					sentAt: 1_700_000_000_000,
					author: { kind: "user", id: "DYTEST-user" },
					text: EARLY_MESSAGE,
				},
			],
			cursor: ACK_ID,
			more: false,
		});
		expect(acknowledgements).toEqual([ACK_ID]);
		expect(parentHandler).not.toHaveBeenCalled();
		let joined = false;
		const closing = hub.close().then(() => {
			joined = true;
		});
		await closeStarted.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(joined).toBe(false);
		backendClosed.resolve();
		await closing;
		expect(close).toHaveBeenCalledTimes(1);
	} finally {
		releaseOpen.resolve();
		backendClosed.resolve();
		unsubscribe();
		await hub?.close();
		await reply?.catch(() => {});
		await packed.close();
	}
}, 30_000);
