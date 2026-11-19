import { describe, expect, it } from "vitest";
import { API_URL, buildRequest, type OutgoingRequest, verifyRequest } from "../src/index.ts";
import { canary, input, pin } from "./helpers.ts";

describe("request verification data boundary", () => {
	it("refuses a changing endpoint without invoking its getter", () => {
		const request = buildRequest(input);
		let reads = 0;
		Object.defineProperty(request, "url", {
			enumerable: true,
			get: () => (++reads === 1 ? API_URL : `https://example.invalid/${canary}`),
		});
		expect(verifyRequest(request, pin)).toEqual({ ok: false, problems: ["request: refused"] });
		expect(reads).toBe(0);
	});
	it("refuses nested request and pin accessors without invoking them", () => {
		let reads = 0;
		for (const target of ["system", "content", "pin"] as const) {
			const request = buildRequest(input);
			const candidatePin = { ...pin };
			const object =
				target === "system"
					? request.body
					: target === "content"
						? request.body.messages[0]
						: candidatePin;
			Object.defineProperty(object, target === "pin" ? "model" : target, {
				enumerable: true,
				get: () => {
					reads++;
					throw new Error(canary);
				},
			});
			expect(verifyRequest(request, candidatePin)).toEqual({
				ok: false,
				problems: ["request: refused"],
			});
		}
		expect(reads).toBe(0);
	});
	it("refuses proxies before inspecting their properties or prototypes", () => {
		let traps = 0;
		const wrap = <T extends object>(value: T): T =>
			new Proxy(value, {
				get: () => {
					traps++;
					throw new Error(canary);
				},
				getPrototypeOf: () => {
					traps++;
					throw new Error(canary);
				},
				ownKeys: () => {
					traps++;
					throw new Error(canary);
				},
			});
		const request = buildRequest(input);
		for (const candidate of [
			wrap(request),
			{ ...request, body: wrap(request.body) },
			{ ...request, headers: wrap(request.headers) },
		])
			expect(verifyRequest(candidate, pin)).toEqual({ ok: false, problems: ["request: refused"] });
		expect(verifyRequest(request, wrap(pin)).ok).toBe(false);
		expect(traps).toBe(0);
	});
	it("preserves native Headers and a detached request", () => {
		const request = buildRequest(input);
		const headers = new Headers(request.headers);
		const checked = verifyRequest({ ...request, headers }, pin);
		expect(checked.ok).toBe(true);
		if (!checked.ok) throw new Error("Expected request");
		headers.set("x-api-key", canary);
		expect(verifyRequest(checked.request, pin).ok).toBe(true);
		expect(JSON.stringify(checked.request)).not.toContain(canary);
		headers.set("x-api-key", "brokered");
		headers.set("__proto__", canary);
		expect(verifyRequest({ ...request, headers }, pin).ok).toBe(false);
	});
	it("bounds cyclic, deep and sparse request data with fixed refusals", () => {
		const request = buildRequest(input);
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		let deep: unknown = null;
		for (let index = 0; index < 66; index++) deep = { child: deep };
		for (const body of [
			cycle,
			deep,
			{ ...request.body, messages: Array(1) },
			{ ...request.body, extra: "x".repeat(2_300_001) },
		])
			expect(verifyRequest({ ...request, body } as OutgoingRequest, pin)).toEqual({
				ok: false,
				problems: ["request: refused"],
			});
	});
	it("preserves the permitted codepoint maxima when text uses surrogate pairs", () => {
		const request = buildRequest({ system: "😀".repeat(100_000), prompt: "😀".repeat(1_000_000) });
		expect(verifyRequest(request, pin).ok).toBe(true);
	});
});
