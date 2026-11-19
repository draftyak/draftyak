import { describe, expect, it, vi } from "vitest";
import {
	CompatibleError,
	type CompatibleFormat,
	type CompatibleRequest,
	MAX_RESPONSE_BYTES,
} from "../src/index.ts";
import { completion, core, OUTPUT, REQUEST, response } from "./helpers.ts";

describe("injected compatible runner", () => {
	it("uses a caller-rebuilt repair prompt only in a separate provider call", async () => {
		const provider = core();
		const seen: CompatibleRequest[] = [];
		const transport = async (request: CompatibleRequest) => {
			seen.push(request);
			return seen.length === 1
				? completion(provider, "PRIVATE_CANARY invalid JSON")
				: completion(provider);
		};
		const invalid = await provider.generate(REQUEST, transport);
		expect(seen).toHaveLength(1);
		expect(invalid.kind).toBe("invalid");
		if (invalid.kind !== "invalid") throw Error("Expected invalid synthetic draft");
		const repairInput = {
			...REQUEST,
			system: `${REQUEST.system}\nHub-owned repair issues: ${invalid.problems.join("; ")}.`,
		};
		const result = await provider.generate(repairInput, transport);
		expect(result.kind).toBe("draft");
		expect(result.usage).toEqual({ input: 10, output: 3 });
		expect(seen).toHaveLength(2);
		expect(seen.map((request) => request.url)).toEqual([
			provider.config.endpoint,
			provider.config.endpoint,
		]);
		const repaired = JSON.parse(seen[1]?.body ?? "{}");
		expect(repaired.messages[0].content).toBe(repairInput.system);
		expect(repaired.messages[1].content).toBe(REQUEST.prompt);
		expect(JSON.stringify(repaired)).not.toContain("PRIVATE_CANARY");
	});
	it("does not retry an invalid-schema outcome inside a provider call", async () => {
		const provider = core("json_object");
		let calls = 0;
		const result = await provider.generate(REQUEST, async () => {
			calls++;
			return completion(provider, { ...OUTPUT, body: 1 });
		});
		expect(calls).toBe(1);
		expect(result.kind).toBe("invalid");
	});
	it.each(["length", "content_filter", "PRIVATE_CANARY"])(
		"does not repair stop reason %s",
		async (reason) => {
			const provider = core();
			let calls = 0;
			await provider.generate(REQUEST, async () => {
				calls++;
				return completion(provider, "not JSON", reason);
			});
			expect(calls).toBe(1);
		},
	);
	it.each(["connection", "timeout"])(
		"rejects a %s failure with a content-free transient code and no retry",
		async (kind) => {
			const provider = core();
			for (const operation of ["generate", "probe"] as const) {
				let calls = 0;
				const transport = async () => {
					calls++;
					const error = new Error("PRIVATE_CANARY");
					error.name = kind === "timeout" ? "TimeoutError" : "TypeError";
					throw error;
				};
				await expect(
					operation === "generate"
						? provider.generate(REQUEST, transport)
						: provider.probe(transport),
				).rejects.toMatchObject({
					name: "CompatibleError",
					code: "TRANSIENT",
					message: "TRANSIENT",
				});
				expect(calls).toBe(1);
			}
		},
	);
	it.each([
		...(["json_schema", "json_object", "ollama"] as const).flatMap((format) =>
			[
				{ status: 400, code: "INVALID_INPUT" },
				{ status: 401, code: "AUTH_REVOKED" },
				{ status: 403, code: "PERMISSION_DENIED" },
				{ status: 408, code: "TRANSIENT" },
				{ status: 429, code: "RATE_LIMITED" },
				{ status: 500, code: "TRANSIENT" },
				{ status: 503, code: "TRANSIENT" },
				{ status: 599, code: "TRANSIENT" },
			].map((value) => ({ format, ...value })),
		),
		{ format: "ollama" as CompatibleFormat, status: 404, code: "INVALID_INPUT" },
	])(
		"exposes $format HTTP $status as $code from generate and probe",
		async ({ format, status, code }) => {
			const provider = core(format);
			for (const operation of ["generate", "probe"] as const) {
				let calls = 0;
				const transport = async () => {
					calls++;
					return {
						...response(provider, "PRIVATE_CANARY", status),
						headers: { "retry-after": "2" },
					};
				};
				const result =
					operation === "generate"
						? provider.generate(REQUEST, transport)
						: provider.probe(transport);
				await expect(result).rejects.toMatchObject({
					name: "CompatibleError",
					code,
					message: code,
					...(status === 429 ? { retryAfterMs: 2000 } : {}),
				});
				expect(calls).toBe(1);
			}
		},
	);
	it.each(["json_schema", "json_object", "ollama"] as const)(
		"exposes a bounded %s insufficient_quota error without its text",
		async (format) => {
			const provider = core(format);
			for (const operation of ["generate", "probe"] as const) {
				let calls = 0;
				const transport = async () => {
					calls++;
					return {
						...response(
							provider,
							{ error: { code: "insufficient_quota", message: "PRIVATE_CANARY" } },
							429,
						),
						headers: { "retry-after": "2" },
					};
				};
				await expect(
					operation === "generate"
						? provider.generate(REQUEST, transport)
						: provider.probe(transport),
				).rejects.toMatchObject({
					code: "QUOTA_EXCEEDED",
					message: "QUOTA_EXCEEDED",
					retryAfterMs: 2000,
				});
				expect(calls).toBe(1);
			}
		},
	);
	it("bounds quota error JSON before inspecting its code", async () => {
		const provider = core();
		await expect(
			provider.generate(REQUEST, async () =>
				response(
					provider,
					{ error: { code: "insufficient_quota", message: "x".repeat(MAX_RESPONSE_BYTES) } },
					429,
				),
			),
		).rejects.toMatchObject({ code: "RATE_LIMITED", message: "RATE_LIMITED" });
	});
	it("preserves a typed transport failure's retry hint without its message", async () => {
		const provider = core();
		const error = new CompatibleError("RATE_LIMITED", 2500);
		error.message = "PRIVATE_CANARY";
		for (const operation of ["generate", "probe"] as const) {
			const transport = async () => {
				throw error;
			};
			await expect(
				operation === "generate"
					? provider.generate(REQUEST, transport)
					: provider.probe(transport),
			).rejects.toMatchObject({
				code: "RATE_LIMITED",
				message: "RATE_LIMITED",
				retryAfterMs: 2500,
			});
		}
	});
	it("preserves a canonical typed failure with no retry hint", async () => {
		const provider = core();
		for (const operation of ["generate", "probe"] as const) {
			const transport = async () => {
				throw new CompatibleError("AUTH_REVOKED");
			};
			await expect(
				operation === "generate"
					? provider.generate(REQUEST, transport)
					: provider.probe(transport),
			).rejects.toMatchObject({ code: "AUTH_REVOKED", message: "AUTH_REVOKED" });
		}
	});
	it("does not invoke error getters or proxy hooks while preserving coded failures", async () => {
		const provider = core();
		let hooks = 0;
		const getter = () => {
			hooks++;
			throw Error("PRIVATE_CANARY");
		};
		const codeGetter = new CompatibleError("RATE_LIMITED", 2000);
		Object.defineProperty(codeGetter, "code", { get: getter });
		const hintGetter = new CompatibleError("RATE_LIMITED", 2000);
		Object.defineProperty(hintGetter, "retryAfterMs", { get: getter });
		const badCode = new CompatibleError("RATE_LIMITED", 2000);
		Object.defineProperty(badCode, "code", { value: "PRIVATE_CANARY" });
		const badHint = new CompatibleError("RATE_LIMITED", 2000);
		Object.defineProperty(badHint, "retryAfterMs", { value: Number.POSITIVE_INFINITY });
		const plain = Object.defineProperty(new Error("PRIVATE_CANARY"), "code", { get: getter });
		const proxy = new Proxy(new CompatibleError("RATE_LIMITED", 2000), {
			get: getter,
			getPrototypeOf: getter,
			getOwnPropertyDescriptor: getter,
		});
		for (const error of [codeGetter, hintGetter, badCode, badHint, plain, proxy]) {
			for (const operation of ["generate", "probe"] as const) {
				const transport = async () => {
					throw error;
				};
				await expect(
					operation === "generate"
						? provider.generate(REQUEST, transport)
						: provider.probe(transport),
				).rejects.toMatchObject({
					code: "TRANSIENT",
					message: "TRANSIENT",
				});
			}
		}
		const messageGetter = new CompatibleError("RATE_LIMITED", 2000);
		Object.defineProperty(messageGetter, "message", { get: getter });
		await expect(
			provider.generate(REQUEST, async () => {
				throw messageGetter;
			}),
		).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 2000, message: "RATE_LIMITED" });
		expect(hooks).toBe(0);
	});
	it("uses a bounded Retry-After date and ignores invalid retry hints", async () => {
		const provider = core();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
		try {
			for (const [header, expected] of [
				["Tue, 01 Jan 2030 00:00:03 GMT", 3000],
				["Mon, 31 Dec 2029 23:59:59 GMT", 0],
				["PRIVATE_CANARY", undefined],
				["-1", undefined],
				["1.5", undefined],
				["99999999999999999999999", Number.MAX_SAFE_INTEGER],
				["9".repeat(129), Number.MAX_SAFE_INTEGER],
			] as const) {
				await expect(
					provider.generate(REQUEST, async () => ({
						...response(provider, "PRIVATE_CANARY", 429),
						headers: { "Retry-After": header },
					})),
				).rejects.toSatisfy(
					(error: unknown) =>
						error instanceof CompatibleError &&
						error.code === "RATE_LIMITED" &&
						error.retryAfterMs === expected &&
						error.message === "RATE_LIMITED",
				);
			}
		} finally {
			vi.useRealTimers();
		}
	});
	it("honors cancellation before and after a transport completes", async () => {
		const provider = core();
		const first = new AbortController();
		first.abort();
		let calls = 0;
		await expect(
			provider.generate(
				REQUEST,
				async () => {
					calls++;
					return completion(provider);
				},
				first.signal,
			),
		).rejects.toThrow(CompatibleError);
		expect(calls).toBe(0);
		const second = new AbortController();
		await expect(
			provider.generate(
				REQUEST,
				async () => {
					second.abort();
					return completion(provider);
				},
				second.signal,
			),
		).rejects.toMatchObject({ code: "ABORTED" });
		const third = new AbortController();
		await expect(
			provider.generate(
				REQUEST,
				async () => {
					third.abort();
					throw new CompatibleError("RATE_LIMITED", 2000);
				},
				third.signal,
			),
		).rejects.toMatchObject({ code: "ABORTED" });
	});
	it.each(["json_schema", "json_object", "ollama"] as const)(
		"constructs an exact synthetic DraftOutputV1 probe in %s format",
		async (format) => {
			const provider = core(format);
			const emptyDraft = {
				body: "",
				ownerNotes: "",
				needsOwnerInput: [],
				suspectedInstructions: false,
				contextRefs: [],
			};
			const seen: CompatibleRequest[] = [];
			expect(
				await provider.probe(async (request) => {
					seen.push(request);
					return completion(provider, emptyDraft);
				}),
			).toEqual({ status: "ok" });
			expect(seen).toHaveLength(1);
			const body = JSON.parse(seen[0]?.body ?? "{}");
			expect(body.model).toBe(provider.config.model);
			expect(body.messages).toEqual([
				{ role: "system", content: expect.stringContaining("DraftOutputV1") },
				{ role: "user", content: `Return exactly ${JSON.stringify(emptyDraft)}.` },
			]);
			for (const field of Object.keys(emptyDraft))
				expect(body.messages[0].content).toContain(field);
			expect(await provider.probe(async () => completion(provider, "not JSON"))).toEqual({
				status: "degraded",
				detail: "probe: invalid",
			});
		},
	);
});
