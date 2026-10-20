import { PassThrough } from "node:stream";
import { HOST_FRAME_TAG, type HostFetchParams } from "@draftyak/protocol/host-channel";
import { describe, expect, it } from "vitest";
import { type HostFetchInit, hostFetch } from "../src/fetch.ts";
import { HostError, memoryHost } from "../src/host.ts";
import { stdioHost } from "../src/stdio.ts";

const ref = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const url = "https://mail.example.invalid/message";
const mode = { kind: "base64url-json-member", member: "raw" } as const;

describe("decoded blob fetch option", () => {
	it.each(["raw", "data"] as const)(
		"forwards the exact %s selection and exposes only a body reference",
		async (member) => {
			const requests: unknown[] = [];
			const headers: [string, string][] = [
				["content-type", "application/json"],
				["content-length", "123"],
			];
			const host = memoryHost((method, params) => {
				requests.push({ method, params });
				return { status: 200, headers, body: { ref } };
			});
			try {
				const response = await hostFetch(host)(url, { saveAs: { ...mode, member }, stream: false });
				expect(requests).toEqual([
					{
						method: "host/fetch",
						params: { method: "GET", url, headers: [], saveAs: { ...mode, member }, stream: false },
					},
				]);
				expect(response.status).toBe(200);
				expect(response.headers.get("content-type")).toBe("application/json");
				expect(response.headers.get("content-length")).toBe("123");
				expect(response.bodyRef).toEqual({ ref });
				expect(Object.isFrozen(response.bodyRef)).toBe(true);
				expect(await response.text()).toBe("");
			} finally {
				host.close();
			}
		},
	);
	it("retains an ordinary bounded non-2xx body without projection", async () => {
		const host = memoryHost(() => ({
			status: 404,
			headers: [["content-type", "application/json"]],
			body: { base64: Buffer.from('{"error":"missing"}').toString("base64url") },
		}));
		try {
			const response = await hostFetch(host)(url, { saveAs: mode });
			expect(response.status).toBe(404);
			expect(response.bodyRef).toBeUndefined();
			expect(await response.text()).toBe('{"error":"missing"}');
		} finally {
			host.close();
		}
	});
	it.each([
		{ status: 200, body: { base64: "Zg" } },
		{ status: 200, streamId: "stream" },
		{ status: 404, body: { ref } },
		{ status: 404, streamId: "stream" },
	])("refuses a host response outside the selected mode: %j", async (result) => {
		const host = memoryHost(() => ({ headers: [], ...result }));
		try {
			await expect(hostFetch(host)(url, { saveAs: mode })).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		} finally {
			host.close();
		}
	});
	it.each([
		{ saveAs: null },
		{ saveAs: false },
		{ saveAs: 0 },
		{ saveAs: "" },
		{ method: "HEAD", saveAs: mode },
		{ method: "POST", saveAs: mode },
		{ saveAs: mode, stream: true },
		{ saveAs: { ...mode, member: "body.raw" } },
		{ saveAs: { ...mode, fallback: "blob" } },
	])("refuses invalid options before host dispatch: %j", async (init) => {
		let dispatched = 0;
		const host = memoryHost(() => {
			dispatched++;
			return { status: 200, headers: [], body: { ref } };
		});
		try {
			await expect(hostFetch(host)(url, init as HostFetchInit)).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			expect(dispatched).toBe(0);
		} finally {
			host.close();
		}
	});
	it("never retries or changes mode after an unsupported host error", async () => {
		const requests: unknown[] = [];
		const host = memoryHost((_method, params) => {
			requests.push(params);
			throw new HostError("UNSUPPORTED");
		});
		try {
			await expect(hostFetch(host)(url, { saveAs: mode })).rejects.toMatchObject({
				code: "UNSUPPORTED",
			});
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({ saveAs: mode });
		} finally {
			host.close();
		}
	});
	it("preserves the selected object over tagged child transport", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const host = stdioHost({ input, output });
		const requests: HostFetchParams[] = [];
		output.on("data", (data: Buffer) => {
			const request = JSON.parse(data.toString("utf8").slice(1));
			requests.push(request.params);
			input.write(
				`${HOST_FRAME_TAG}${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { status: 200, headers: [], body: { ref } } })}\n`,
			);
		});
		try {
			const response = await hostFetch(host)(url, { saveAs: mode });
			expect(requests).toEqual([{ method: "GET", url, headers: [], saveAs: mode }]);
			expect(response.bodyRef).toEqual({ ref });
		} finally {
			host.close();
			input.destroy();
			output.destroy();
		}
	});
	it("keeps raw-response blob behavior unchanged", async () => {
		const host = memoryHost((_method, params) => {
			expect((params as HostFetchParams).saveAs).toBe("blob");
			return { status: 200, headers: [], body: { ref } };
		});
		try {
			expect((await hostFetch(host)(url, { saveAs: "blob" })).bodyRef).toEqual({ ref });
		} finally {
			host.close();
		}
	});
});
