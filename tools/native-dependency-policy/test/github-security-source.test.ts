import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	GitHubSecurityObservation,
	GitHubSecurityRequest,
	GitHubSecurityTestResponse,
} from "../src/github-security-source.ts";

const native = vi.hoisted(() => ({
	calls: [] as { url: string; options: unknown }[],
	response: undefined as
		| undefined
		| ((url: string) => {
				status?: number;
				type?: string;
				link?: string;
				body: Uint8Array;
				complete?: boolean;
		  }),
}));
vi.mock("node:https", async () => {
	const { EventEmitter } = await import("node:events");
	return {
		request: (url: string, options: unknown, callback: (response: unknown) => void) => {
			native.calls.push({ url, options });
			return Object.assign(new EventEmitter(), {
				destroy: vi.fn(),
				end: () =>
					queueMicrotask(() => {
						const selected = native.response?.(url);
						if (!selected) throw Error("DYTEST missing response");
						const response = Object.assign(new EventEmitter(), {
							statusCode: selected.status ?? 200,
							headers: {
								"content-type": selected.type ?? "application/json",
								...(selected.link === undefined ? {} : { link: selected.link }),
							},
							complete: selected.complete ?? true,
							destroy: vi.fn(),
						});
						callback(response);
						queueMicrotask(() => {
							response.emit("data", selected.body);
							response.emit("end");
						});
					}),
			});
		},
	};
});
const { createGitHubSecuritySource, githubSecurityTestInterface, GitHubSecurityError } =
	await import("../src/github-security-source.ts");
const NOW = 1_800_000_000_000;
const projects = [
	{ id: 366664320, name: "gtk-rs/gtk-rs-core" },
	{ id: 639304056, name: "z-galaxy/zbus" },
];
function raw(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}
function metadata(
	id = projects[0]?.id ?? 0,
	name = projects[0]?.name ?? "",
): Record<string, unknown> {
	return { id, full_name: name, private: false, archived: false, default_branch: "main" };
}
function defaultBody(url: string): Uint8Array {
	const project = projects.find((project) =>
		url.startsWith(`https://api.github.com/repos/${project.name}`),
	);
	if (!project) throw Error("DYTEST unexpected destination");
	return raw(
		url.includes("/security-advisories?")
			? "[]"
			: JSON.stringify(metadata(project.id, project.name)),
	);
}
function fake(
	adjust?: (
		request: GitHubSecurityRequest,
		ordinal: number,
		response: GitHubSecurityTestResponse,
	) => GitHubSecurityTestResponse | Promise<GitHubSecurityTestResponse>,
	clock = () => NOW,
) {
	const calls: GitHubSecurityRequest[] = [];
	const source = githubSecurityTestInterface.create({
		clock,
		transport: async (request) => {
			calls.push(request);
			const response = {
				status: 200,
				contentType: "application/json",
				body: defaultBody(request.url),
			};
			return adjust ? adjust(request, calls.length, response) : response;
		},
	});
	return { source, calls };
}
function code(value: string) {
	return expect.objectContaining({
		name: "GitHubSecurityError",
		code: value,
		message: "GitHub security channel refused",
	});
}
beforeEach(() => {
	native.calls.length = 0;
	native.response = (url) => ({ body: defaultBody(url) });
});
afterEach(() => vi.restoreAllMocks());

describe("fixed terminal-empty repository security channels", () => {
	it("collects both complete initial and recheck observations after repository identity", async () => {
		const { source, calls } = fake();
		const receipt = await source.observe();
		const fact = githubSecurityTestInterface.metadata(source, receipt);
		expect(fact.delivery).toBe("test-only");
		expect(fact.channels.map((c) => c.channel)).toEqual(["G1", "G2"]);
		expect(calls.map((c) => c.url)).toEqual(
			[0, 1]
				.flatMap((index) =>
					["", "/security-advisories?state=published&per_page=100"].map(
						(suffix) => `https://api.github.com/repos/${projects[index]?.name}${suffix}`,
					),
				)
				.concat(
					[0, 1].flatMap((index) =>
						["", "/security-advisories?state=published&per_page=100"].map(
							(suffix) => `https://api.github.com/repos/${projects[index]?.name}${suffix}`,
						),
					),
				),
		);
		for (const channel of fact.channels) {
			expect(channel.inventory).toEqual([]);
			expect(Object.isFrozen(channel.inventory)).toBe(true);
			for (const phase of [channel.initial, channel.recheck])
				for (const observation of [phase.repository, phase.advisories]) {
					expect(observation.observedAt).toBe(NOW);
					expect(observation.bodySha256).toMatch(/^[a-f0-9]{64}$/);
					expect(observation.projectionSha256).toMatch(/^[a-f0-9]{64}$/);
				}
		}
		expect(Object.isFrozen(receipt)).toBe(true);
		expect(Object.keys(receipt)).toEqual([]);
		expect(() => source.facts(receipt)).toThrow(code("GITHUB_SECURITY_TEST_ONLY"));
		expect(fact).not.toHaveProperty("events");
		expect(fact).not.toHaveProperty("source");
	});
	it("uses only fixed unauthenticated native requests and returns channel facts only", async () => {
		const source = createGitHubSecuritySource(),
			receipt = await source.observe(),
			facts = source.facts(receipt);
		expect(facts.delivery).toBe("fixed-public-github-advisory-channels");
		expect(facts.channels).toHaveLength(2);
		expect(native.calls).toHaveLength(8);
		for (const call of native.calls) {
			expect(call.options).toMatchObject({
				method: "GET",
				agent: false,
				rejectUnauthorized: true,
				headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
			});
			expect(call.options).not.toHaveProperty("auth");
			expect(call.options).not.toHaveProperty("headers.authorization");
			expect(call.options).not.toHaveProperty("proxy");
		}
		expect(() => githubSecurityTestInterface.metadata(source, receipt)).toThrow(
			GitHubSecurityError,
		);
	});
	it("keeps semantic content identity stable while fresh receipt times advance", async () => {
		let current = NOW;
		const { source } = fake(undefined, () => current);
		const first = await source.observe(),
			before = githubSecurityTestInterface.metadata(source, first);
		current += 1000;
		const second = await source.revalidate(first),
			after = githubSecurityTestInterface.metadata(source, second);
		expect(after.revision).toBe(before.revision);
		expect(after.deliveryRevision).not.toBe(before.deliveryRevision);
		expect(after.observedAt).toBe(current);
		expect(second).not.toBe(first);
	});
	it("separately binds ignored response bytes without treating them as semantic content", async () => {
		let ordinal = 0;
		const { source } = fake((request, _number, response) =>
			request.url.includes("/security-advisories?")
				? response
				: {
						...response,
						body: raw(
							JSON.stringify({
								...JSON.parse(new TextDecoder().decode(response.body)),
								description: `DYTEST opaque${++ordinal}`,
							}),
						),
					},
		);
		const before = githubSecurityTestInterface.metadata(source, await source.observe());
		const after = githubSecurityTestInterface.metadata(source, await source.observe());
		expect(after.revision).toBe(before.revision);
		expect(after.deliveryRevision).not.toBe(before.deliveryRevision);
		expect(JSON.stringify(after)).not.toContain("DYTEST");
	});
	it("rejects a rounded fractional wire repository id before advisory dispatch", async () => {
		const { source, calls } = fake((_request, ordinal, response) =>
			ordinal === 1
				? {
						...response,
						body: raw(
							new TextDecoder()
								.decode(response.body)
								.replace('"id":366664320', '"id":366664320.0000000001'),
						),
					}
				: response,
		);
		await expect(source.observe()).rejects.toEqual(code("GITHUB_SECURITY_INVALID"));
		expect(calls).toHaveLength(1);
	});
	it.each([
		"366664320.0",
		"366664320e0",
		"3.66664320e8",
		"366664320.0000000000000001",
		"0366664320",
		"+366664320",
		'"366664320"',
	])("rejects noncanonical or unsupported root id tokens", async (token) => {
		const { source, calls } = fake((_request, ordinal, response) =>
			ordinal === 1
				? {
						...response,
						body: raw(
							new TextDecoder().decode(response.body).replace('"id":366664320', `"id":${token}`),
						),
					}
				: response,
		);
		await expect(source.observe()).rejects.toBeInstanceOf(GitHubSecurityError);
		expect(calls).toHaveLength(1);
	});
	it("does not confuse a nested exact id with a rounded root id", async () => {
		const body = `{"owner":{"id":366664320},"id":366664320.0000000001,"full_name":"gtk-rs/gtk-rs-core","private":false,"archived":false,"default_branch":"main"}`;
		await expect(
			fake((_request, ordinal, response) =>
				ordinal === 1 ? { ...response, body: raw(body) } : response,
			).source.observe(),
		).rejects.toBeInstanceOf(GitHubSecurityError);
	});
	it("checks the second repository before dispatching its dependent advisory request", async () => {
		const { source, calls } = fake((_request, ordinal, response) =>
			ordinal === 3
				? { ...response, body: raw(JSON.stringify(metadata(639304057, "z-galaxy/zbus"))) }
				: response,
		);
		await expect(source.observe()).rejects.toBeInstanceOf(GitHubSecurityError);
		expect(calls).toHaveLength(3);
	});
	it.each([
		["full_name", "DYTEST/other"],
		["private", true],
		["archived", true],
		["default_branch", "other"],
	])("refuses changed repository identity/state", async (field, value) => {
		const { source, calls } = fake((_request, ordinal, response) =>
			ordinal === 1
				? { ...response, body: raw(JSON.stringify({ ...metadata(), [field]: value })) }
				: response,
		);
		await expect(source.observe()).rejects.toBeInstanceOf(GitHubSecurityError);
		expect(calls).toHaveLength(1);
	});
	it("refuses missing required repository state", async () => {
		const state = metadata();
		delete state.archived;
		await expect(
			fake((_request, ordinal, response) =>
				ordinal === 1 ? { ...response, body: raw(JSON.stringify(state)) } : response,
			).source.observe(),
		).rejects.toBeInstanceOf(GitHubSecurityError);
	});
	it("rechecks repository identity before the second advisory observation", async () => {
		const { source, calls } = fake((_request, ordinal, response) =>
			ordinal === 5
				? { ...response, body: raw(JSON.stringify({ ...metadata(), archived: true })) }
				: response,
		);
		await expect(source.observe()).rejects.toBeInstanceOf(GitHubSecurityError);
		expect(calls).toHaveLength(5);
	});
	it.each([
		"[{}]",
		JSON.stringify(Array.from({ length: 100 }, () => ({}))),
		JSON.stringify(Array.from({ length: 101 }, () => ({}))),
		"{}",
		"null",
	])("refuses populated/saturated/unsupported advisory inventory", async (body) => {
		await expect(
			fake((request, _ordinal, response) =>
				request.url.includes("/security-advisories?") ? { ...response, body: raw(body) } : response,
			).source.observe(),
		).rejects.toEqual(code("GITHUB_SECURITY_UNSUPPORTED"));
	});
	it("refuses advisory content appearing during the final recheck", async () => {
		const { source, calls } = fake((_request, ordinal, response) =>
			ordinal === 8 ? { ...response, body: raw("[{}]") } : response,
		);
		await expect(source.observe()).rejects.toEqual(code("GITHUB_SECURITY_UNSUPPORTED"));
		expect(calls).toHaveLength(8);
	});
	it.each([
		"",
		'<https://api.github.com/repos/639304056/security-advisories?page=2>; rel="next"',
		'<https://example.invalid/>; rel="next"',
	])("refuses any Link state and never follows it", async (link) => {
		const { source, calls } = fake((_request, ordinal, response) =>
			ordinal === 2 ? { ...response, link } : response,
		);
		await expect(source.observe()).rejects.toEqual(code("GITHUB_SECURITY_UNSUPPORTED"));
		expect(calls).toHaveLength(2);
	});
	it.each([302, 401, 404, 500])("refuses non200 without redirects or retry", async (status) => {
		const { source, calls } = fake((_request, _ordinal, response) => ({ ...response, status }));
		await expect(source.observe()).rejects.toEqual(code("GITHUB_SECURITY_UNAVAILABLE"));
		expect(calls).toHaveLength(1);
	});
	it.each([403, 429])("refuses simulated rate limits", async (status) => {
		await expect(
			fake((_request, _ordinal, response) => ({ ...response, status })).source.observe(),
		).rejects.toEqual(code("GITHUB_SECURITY_RATE_LIMIT"));
	});
	it.each(["text/html", "text/plain", ""])(
		"refuses unsupported content types",
		async (contentType) => {
			await expect(
				fake((_request, _ordinal, response) => ({ ...response, contentType })).source.observe(),
			).rejects.toEqual(code("GITHUB_SECURITY_UNSUPPORTED"));
		},
	);
	it.each(['{"id":366664320,"id":366664320}', "\ufeff[]", "[1,]", "[]junk"])(
		"rejects duplicate-key/BOM/trailing JSON forms",
		async (body) => {
			await expect(
				fake((_request, _ordinal, response) => ({ ...response, body: raw(body) })).source.observe(),
			).rejects.toEqual(code("GITHUB_SECURITY_INVALID"));
		},
	);
	it("refuses invalid UTF8 and oversized bodies", async () => {
		for (const body of [new Uint8Array([0xff]), new Uint8Array(1_048_577)])
			await expect(
				fake((_request, _ordinal, response) => ({ ...response, body })).source.observe(),
			).rejects.toEqual(code("GITHUB_SECURITY_INVALID"));
	});
	it("refuses response accessors/proxies without invoking them", async () => {
		let reads = 0;
		const accessor = Object.defineProperty({}, "status", {
			get() {
				reads++;
				return 200;
			},
		}) as GitHubSecurityTestResponse;
		await expect(fake(() => accessor).source.observe()).rejects.toBeInstanceOf(GitHubSecurityError);
		await expect(
			fake(
				(_request, _ordinal, response) =>
					new Proxy(response, {
						ownKeys() {
							reads++;
							return [];
						},
					}),
			).source.observe(),
		).rejects.toBeInstanceOf(GitHubSecurityError);
		expect(reads).toBe(0);
	});
	it("refuses exact one-hour receipt age without issuing another request", async () => {
		let current = NOW;
		const { source, calls } = fake(undefined, () => current);
		const receipt = await source.observe();
		current += 3_600_000;
		await expect(source.revalidate(receipt)).rejects.toEqual(code("GITHUB_SECURITY_STALE"));
		expect(calls).toHaveLength(8);
		expect(() => source.facts(receipt)).toThrow(code("GITHUB_SECURITY_STALE"));
	});
	it("refuses completion which crosses the actual oldest-observation cutoff", async () => {
		let current = NOW;
		const { source } = fake(
			(_request, ordinal, response) => {
				if (ordinal === 8) current += 3_600_000;
				return response;
			},
			() => current,
		);
		await expect(source.observe()).rejects.toEqual(code("GITHUB_SECURITY_STALE"));
	});
	it("refuses backward or invalid clocks", async () => {
		let reads = 0;
		await expect(
			fake(undefined, () => (++reads === 2 ? NOW - 1 : NOW)).source.observe(),
		).rejects.toEqual(code("GITHUB_SECURITY_CLOCK"));
		for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
			await expect(fake(undefined, () => value).source.observe()).rejects.toEqual(
				code("GITHUB_SECURITY_CLOCK"),
			);
	});
	it("bounds a stalled transport await", async () => {
		const original = setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) =>
			original(callback, delay === 10_000 ? 5 : delay)) as typeof setTimeout);
		await expect(fake(async () => new Promise(() => undefined)).source.observe()).rejects.toEqual(
			code("GITHUB_SECURITY_DEADLINE"),
		);
	});
	it("does not schedule another request after the whole collection deadline", async () => {
		let elapsed = 0,
			reads = 0;
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		const { source, calls } = fake(undefined, () => {
			if (++reads === 2) elapsed = 60_001;
			return NOW;
		});
		await expect(source.observe()).rejects.toEqual(code("GITHUB_SECURITY_DEADLINE"));
		expect(calls).toHaveLength(1);
	});
	it("refuses a prequeued whole-deadline advance before transport dispatch", async () => {
		let elapsed = 0;
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		const { source, calls } = fake();
		queueMicrotask(() => {
			elapsed = 60_000;
		});
		await expect(source.observe()).rejects.toEqual(code("GITHUB_SECURITY_DEADLINE"));
		expect(calls).toHaveLength(0);
	});
	it("refuses exact per-request deadline completion even before the timer callback", async () => {
		let elapsed = 0;
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		const { source, calls } = fake((_request, ordinal, response) => {
			if (ordinal === 1) elapsed = 10_000;
			return response;
		});
		await expect(source.observe()).rejects.toEqual(code("GITHUB_SECURITY_DEADLINE"));
		expect(calls).toHaveLength(1);
	});
	it("accepts subdeadline completion without widening the exact cutoff", async () => {
		let elapsed = 0;
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		const { source, calls } = fake((_request, ordinal, response) => {
			if (ordinal === 1) elapsed = 9_999;
			return response;
		});
		const receipt = await source.observe();
		expect(githubSecurityTestInterface.metadata(source, receipt).channels).toHaveLength(2);
		expect(calls).toHaveLength(8);
	});
	it("rejects forged and cross-owner receipts", async () => {
		const first = fake(),
			second = fake(),
			receipt = await first.source.observe();
		await expect(second.source.revalidate(receipt)).rejects.toEqual(
			code("GITHUB_SECURITY_INVALID"),
		);
		expect(() => first.source.facts({} as GitHubSecurityObservation)).toThrow(GitHubSecurityError);
		expect(() => githubSecurityTestInterface.metadata(second.source, receipt)).toThrow(
			GitHubSecurityError,
		);
	});
	it("accepts no source/auth/transport options on the native factory", () => {
		const factory = createGitHubSecuritySource as (...args: unknown[]) => unknown;
		for (const value of [
			{ url: "https://example.invalid" },
			{ transport: vi.fn() },
			{ auth: true },
			{ native: true },
			undefined,
		])
			expect(() => factory(value)).toThrow(GitHubSecurityError);
	});
	it("refuses native oversized and incomplete transport responses", async () => {
		native.response = () => ({ body: new Uint8Array(1_048_577) });
		await expect(createGitHubSecuritySource().observe()).rejects.toEqual(
			code("GITHUB_SECURITY_INVALID"),
		);
		native.response = (url) => ({ body: defaultBody(url), complete: false });
		await expect(createGitHubSecuritySource().observe()).rejects.toEqual(
			code("GITHUB_SECURITY_UNAVAILABLE"),
		);
	});
	it("native HTTP403 activates backoff without another request", async () => {
		native.response = () => ({ status: 403, body: raw("[]") });
		const source = createGitHubSecuritySource();
		await expect(source.observe()).rejects.toEqual(code("GITHUB_SECURITY_RATE_LIMIT"));
		await expect(source.observe()).rejects.toEqual(code("GITHUB_SECURITY_RATE_LIMIT"));
		expect(native.calls).toHaveLength(1);
	});
});
