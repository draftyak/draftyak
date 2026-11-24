import { Writable } from "node:stream";
import { hostFetch, serve, stdioHost } from "@draftyak/sdk";
import { channelFixture } from "../channel/plugin.ts";

let firstId: string | undefined;
const host = stdioHost({ output: new Writable({
	write(chunk, _encoding, callback) {
		const text = String(chunk);
		if (text.startsWith("\x1e")) {
			const frame = JSON.parse(text.slice(1)) as { id?: string; method?: string; params?: { url?: string } };
			if (frame.method === "host/fetch" && frame.params?.url?.endsWith("/first")) firstId = frame.id;
		}
		process.stdout.write(chunk, callback);
	},
}) });
const fetch = hostFetch(host);
const cancel = (requestId: string): void => {
	process.stdout.write(`\x1e${JSON.stringify({ jsonrpc: "2.0", method: "host/cancel", params: { requestId } })}\n`);
};
const outcome = (request: Promise<unknown>): Promise<string> =>
	request.then(() => "SUCCESS", (error: unknown) => (error as { code: string }).code);
const named = (name: string, signal?: AbortSignal) =>
	host.request("host/fetch", { method: "GET", url: `https://stream.invalid/${name}`, headers: [] }, signal ? { signal } : {});
const plugin = channelFixture(async (input) => {
	const mode = (input as { url: string }).url;
	if (mode === "stream") {
		const first = await fetch("https://stream.invalid/first");
		const sibling = await fetch("https://stream.invalid/sibling");
		const reader = first.body!.getReader();
		const chunk = await reader.read();
		if (chunk.done || Buffer.from(chunk.value).toString() !== "a" || !firstId)
			throw new Error("Synthetic held chunk missing");
		cancel("unknown-request");
		await reader.cancel();
		cancel(firstId); // The duplicate must neither abort the sibling nor produce an ACK.
		await host.request("host/log", { level: "info", message: "release-sibling" });
		return { first: "a", sibling: await sibling.text() };
	}
	if (mode === "pending") {
		const controller = new AbortController();
		const pending = host.request("host/fetch", { method: "GET", url: "https://stream.invalid/pending", headers: [] }, { signal: controller.signal });
		const refused = pending.then(() => "SUCCESS", (error: unknown) => (error as { code: string }).code);
		await host.request("host/log", { level: "info", message: "pending-admitted" });
		controller.abort();
		const code = await refused;
		await host.request("host/log", { level: "info", message: "pending-canceled" });
		return { code };
	}
	if (mode === "deadline") {
		await host.request("host/fetch", { method: "GET", url: "https://stream.invalid/deadline", headers: [] }, { timeoutMs: 2000 });
		await new Promise((resolve) => setTimeout(resolve, 2500));
		await host.request("host/log", { level: "info", message: "deadline-canceled" });
		return { deadline: true };
	}
	if (mode === "cycle") {
		const cancelled = new Set<string>();
		for (let index = 0; index < 15; index++) {
			const controller = new AbortController();
			const refused = outcome(named(`held-${index}`, controller.signal));
			await host.request("host/log", { level: "info", message: "held-admitted" });
			controller.abort();
			cancelled.add(await refused);
		}
		// The sixteenth stays active while the next request needs capacity.
		const last = new AbortController();
		const refused = outcome(named("held-15", last.signal));
		const over = await outcome(named("over"));
		last.abort();
		cancelled.add(await refused);
		return { cancelled: [...cancelled], over };
	}
	if (mode === "after") return { after: await outcome(named("after")) };
	if (mode === "flood") {
		// Bypasses the SDK's own limit to send seventeen uncancelled requests at once.
		process.stdout.write(Array.from({ length: 17 }, (_, index) => `\x1e${JSON.stringify({ jsonrpc: "2.0", id: `flood-${index}`, method: "host/fetch", params: { method: "GET", url: `https://stream.invalid/held-flood-${index}`, headers: [] } })}\n`).join(""));
		await host.request("host/log", { level: "info", message: "flood-sent" });
		return { flood: true };
	}
	throw new Error("Synthetic mode refused");
});
serve(plugin.entry, { host });
