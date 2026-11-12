import { type HostFetchParams, LOOKUP_PERMIT_META_KEY } from "@draftyak/protocol/host-channel";
import { checkToolResult } from "@draftyak/protocol/tool-v1";
import { describe, expect, it } from "vitest";
import { hostFetch } from "../src/fetch.ts";
import { HostError, memoryHost } from "../src/host.ts";
import { defineToolPlugin } from "../src/tool.ts";
import { bootstrap, served, toolManifest } from "./definitions-fixtures.ts";
import { permitA } from "./lookup-fixtures.ts";

const body = '{"text":"DYTEST-body"}';
function within<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("Still pending")), 2000);
		}),
	]).finally(() => clearTimeout(timer));
}
function recording() {
	const requests: HostFetchParams[] = [];
	const host = memoryHost((method, params) => {
		expect(method).toBe("host/fetch");
		requests.push(params as HostFetchParams);
		return { status: 200, headers: [], body: { base64: "" } };
	});
	return { host, requests };
}

describe("secret references in Request inputs", () => {
	it("keep the Request's method, headers and body, and init replaces them and its signal as fetch does", async () => {
		const { host, requests } = recording();
		try {
			const request = (signal?: AbortSignal) =>
				new Request("secret://hook", {
					method: "POST",
					headers: { "content-type": "application/json", "x-dytest": "DYTEST-header" },
					body,
					...(signal ? { signal } : {}),
				});
			await hostFetch(host)(request());
			await hostFetch(host)(request(AbortSignal.abort()), {
				method: "PUT",
				headers: { "x-dytest": "DYTEST-init" },
				signal: new AbortController().signal,
			});
			const encoded = Buffer.from(body).toString("base64url");
			expect(requests).toEqual([
				{
					method: "POST",
					url: "secret://hook",
					headers: [
						["content-type", "application/json"],
						["x-dytest", "DYTEST-header"],
					],
					body: { base64: encoded },
				},
				{
					method: "PUT",
					url: "secret://hook",
					headers: [["x-dytest", "DYTEST-init"]],
					body: { base64: encoded },
				},
			]);
		} finally {
			host.close();
		}
	});

	it.each(["string", "Request"])(
		"send a secret %s fetch with its headers and cancel it through its own signal",
		async (kind) => {
			const started = Promise.withResolvers<{ params: unknown; signal: AbortSignal }>();
			const host = memoryHost((_method, params, signal) => {
				started.resolve({ params, signal });
				return new Promise<never>(() => {});
			});
			const controller = new AbortController();
			const init = { headers: { accept: "text/calendar" }, signal: controller.signal };
			try {
				const pending =
					kind === "string"
						? hostFetch(host)("secret://calendarUrl", init)
						: hostFetch(host)(new Request("secret://calendarUrl", init));
				void pending.catch(() => {});
				const { params, signal: upstream } = await within(started.promise);
				expect(params).toEqual({
					method: "GET",
					url: "secret://calendarUrl",
					headers: [["accept", "text/calendar"]],
				});
				controller.abort();
				const error = await within(
					pending.then(
						() => undefined,
						(reason: unknown) => reason,
					),
				);
				expect(error).toBeInstanceOf(HostError);
				expect((error as HostError).code).toBe("DENIED");
				expect(upstream.aborted).toBe(true);
			} finally {
				host.close();
			}
		},
	);

	it.each(["string", "Request"])(
		"refuse an already cancelled secret %s fetch before any host request",
		async (kind) => {
			const { host, requests } = recording();
			const controller = new AbortController();
			controller.abort();
			const init = { signal: controller.signal };
			try {
				await expect(
					kind === "string"
						? hostFetch(host)("secret://calendarUrl", init)
						: hostFetch(host)(new Request("secret://calendarUrl", init)),
				).rejects.toMatchObject({ name: "AbortError" });
				expect(requests).toEqual([]);
			} finally {
				host.close();
			}
		},
	);

	it("reach a tool's host fetch with their GET or HEAD method, allowed headers and signal", async () => {
		const { host, requests } = recording();
		let cancelled: unknown;
		await served(
			defineToolPlugin({
				manifest: toolManifest,
				probe: () => ({ status: "ok", bytes: 0, items: 0 }),
				lookup: {
					"kb.lookup": async (_args, context) => {
						await context.fetch(
							new Request("secret://calendarUrl", {
								headers: { accept: "text/calendar", "if-none-match": '"DYTEST-v1"' },
							}),
						);
						await context.fetch(
							new Request("secret://calendarUrl", {
								method: "HEAD",
								headers: { "if-modified-since": "Thu, 01 Jan 2026 00:00:00 GMT" },
							}),
						);
						const controller = new AbortController();
						controller.abort();
						await context
							.fetch(new Request("secret://calendarUrl", { signal: controller.signal }))
							.catch((error: unknown) => {
								cancelled = error;
							});
						return { entries: [] };
					},
				},
			}),
			async (ask) => {
				const reply = await ask("tools/call", {
					name: "kb.lookup",
					arguments: { topic: "work" },
					_meta: { [LOOKUP_PERMIT_META_KEY]: permitA },
				});
				expect(checkToolResult("kb.lookup", reply.result).status).toBe("ok");
			},
			bootstrap,
			host,
		);
		expect(cancelled).toMatchObject({ name: "AbortError" });
		expect(requests).toEqual([
			{
				method: "GET",
				url: "secret://calendarUrl",
				headers: [
					["accept", "text/calendar"],
					["if-none-match", '"DYTEST-v1"'],
				],
				lookupPermit: permitA,
			},
			{
				method: "HEAD",
				url: "secret://calendarUrl",
				headers: [["if-modified-since", "Thu, 01 Jan 2026 00:00:00 GMT"]],
				lookupPermit: permitA,
			},
		]);
	});
});
