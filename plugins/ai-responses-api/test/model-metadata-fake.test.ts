import { createRecorder } from "@draftyak/fakes/recorder";
import { createResponsesApiFake } from "@draftyak/fakes/responses-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelMetadata, type ResponsesFetch } from "../src/client.ts";
import { ResponsesError } from "../src/shared.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

function noNetwork(): ReturnType<typeof vi.fn> {
	const tripwire = vi.fn(() => {
		throw new Error("Global network forbidden");
	});
	vi.stubGlobal("fetch", tripwire);
	return tripwire;
}

describe("actual model client with the scripted Responses fake", () => {
	it("lists and retrieves scripted models through injected fetch and records empty GET bodies", async () => {
		const network = noNetwork();
		const listed = { object: "list", data: [{ id: "gpt-synthetic", object: "model" }] };
		const retrieved = { id: "gpt-synthetic", object: "model", owned_by: "synthetic" };
		const recorder = createRecorder({ headerValues: ["accept"] });
		const fake = createResponsesApiFake({
			recorder,
			steps: [
				{ kind: "json", body: listed },
				{ kind: "json", body: retrieved },
			],
		});
		const injected: ResponsesFetch = (input, init) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer brokered");
			return fake.fetch(input, init);
		};
		expect(await modelMetadata(injected)).toEqual(listed);
		expect(await modelMetadata(injected, "gpt-synthetic")).toEqual(retrieved);
		expect(fake.pending()).toBe(0);
		const records = recorder.takeRequests();
		expect(records.map(({ method, target }) => ({ method, target }))).toEqual([
			{ method: "GET", target: "/v1/models" },
			{ method: "GET", target: "/v1/models/gpt-synthetic" },
		]);
		for (const record of records) {
			expect(record.host).toBe("api.openai.com");
			expect(record.bodyLength).toBe(0);
			expect(record.body).toHaveLength(0);
			expect(record.headers).toEqual({ accept: "application/json" });
			expect(record.headerNames).toContain("authorization");
		}
		expect(network).not.toHaveBeenCalled();
	});

	it("retains the actual client's encoded model segment without URL rewriting", async () => {
		const network = noNetwork();
		const model = "gpt-synthetic/a?b=%25#d+e";
		const payload = { id: model, object: "model" };
		const fake = createResponsesApiFake({ steps: [{ kind: "json", body: payload }] });
		expect(await modelMetadata((input, init) => fake.fetch(input, init), model)).toEqual(payload);
		expect(fake.recorder.takeRequests().map(({ target }) => target)).toEqual([
			"/v1/models/gpt-synthetic%2Fa%3Fb=%2525%23d+e",
		]);
		expect(fake.pending()).toBe(0);
		expect(network).not.toHaveBeenCalled();
	});

	it("refuses an invalid client model before injected fetch or script admission", async () => {
		const network = noNetwork();
		const fake = createResponsesApiFake({ steps: [{ kind: "json", body: { scripted: true } }] });
		const injected = vi.fn<ResponsesFetch>((input, init) => fake.fetch(input, init));
		await expect(modelMetadata(injected, "gpt synthetic")).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
		expect(injected).not.toHaveBeenCalled();
		expect(fake.pending()).toBe(1);
		expect(fake.recorder.takeRequests()).toHaveLength(0);
		expect(network).not.toHaveBeenCalled();
	});

	it("preserves malformed scripted metadata for the real client to refuse", async () => {
		const network = noNetwork();
		const fake = createResponsesApiFake({
			steps: [{ kind: "raw", body: "{not-json", contentType: "application/json" }],
		});
		await expect(modelMetadata((input, init) => fake.fetch(input, init))).rejects.toBeInstanceOf(
			ResponsesError,
		);
		expect(fake.pending()).toBe(0);
		expect(fake.recorder.takeRequests()).toHaveLength(1);
		expect(network).not.toHaveBeenCalled();
	});
});
