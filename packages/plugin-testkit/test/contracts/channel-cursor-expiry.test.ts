import { createFake } from "@draftyak/fakes";
import { expect, it } from "vitest";
import { type ChannelContractOptions, checkChannelSync } from "../../src/contracts/channel.ts";
import { contractChannel, contractFixtures } from "../fixtures/channel-contract/plugin.ts";

type ExpiryResponse = (request: Request) => Response;

const expired: ExpiryResponse = () => new Response(null, { status: 410 });
const nextPage =
	(cursor: string): ExpiryResponse =>
	() =>
		Response.json({ messages: [], cursor, more: true });

function expiryCase(
	steps: readonly ExpiryResponse[],
	expiryProgressPages?: number,
	resyncResponse?: ExpiryResponse,
) {
	const observed = {
		cursors: [] as (string | null)[],
		providerReads: 0,
		resync: 0,
		expired: 0,
		closed: 0,
	};
	const options: ChannelContractOptions = {
		plugin: contractChannel(),
		mode: "in-memory",
		fixtures: () => {
			const fixture = contractFixtures(() => {
				observed.closed++;
			});
			const upstream = fixture.upstreams[0];
			if (!upstream) throw new Error("DYTEST cursor provider missing");
			let checkingExpiry = false;
			let expiryDelivered = false;
			const provider = createFake(
				{
					fetch(request) {
						const url = new URL(request.url);
						if (request.method === "GET" && url.pathname === "/v1/conversations/conv-1/messages")
							observed.providerReads++;
						if (
							checkingExpiry &&
							request.method === "GET" &&
							url.pathname === "/v1/conversations/conv-1/messages"
						) {
							const cursor = url.searchParams.get("cursor");
							if (cursor === null) {
								observed.resync++;
								if (resyncResponse) return resyncResponse(request);
							} else if (!expiryDelivered) {
								const respond = steps[observed.cursors.length];
								observed.cursors.push(cursor);
								if (!respond) throw new Error("DYTEST cursor response exhausted");
								const response = respond(request);
								if (response.status === 410) {
									expiryDelivered = true;
									observed.expired++;
								}
								return response;
							}
						}
						return upstream.fetch(request);
					},
				},
				{ host: upstream.host },
			);
			return {
				...fixture,
				upstreams: [provider],
				sync: {
					...fixture.sync,
					...(expiryProgressPages === undefined ? {} : { expiryProgressPages }),
					async expireCursor() {
						await fixture.sync.expireCursor();
						checkingExpiry = true;
					},
				},
			};
		},
	};
	return { options, observed };
}

it("keeps omitted progress budgets strict and accepts immediate typed expiry", async () => {
	const sample = expiryCase([expired]);
	expect(await checkChannelSync(sample.options)).toEqual({ status: "pass" });
	expect(sample.observed.cursors).toEqual([expect.any(String)]);
	expect(sample.observed).toMatchObject({ resync: 1, expired: 1, closed: 1 });
});

it.each([0, 1, 2])(
	"accepts typed expiry after exactly %i declared progress pages",
	async (pages) => {
		const cursors = Array.from({ length: pages }, (_, index) => `DYTEST-expiry-${index}`);
		const sample = expiryCase([...cursors.map(nextPage), expired], pages);
		expect(await checkChannelSync(sample.options)).toEqual({ status: "pass" });
		expect(sample.observed.cursors).toEqual([expect.any(String), ...cursors]);
		expect(sample.observed).toMatchObject({ resync: 1, expired: 1, closed: 1 });
	},
);

it("accepts typed expiry on the sixty-fourth call and still checks resync", async () => {
	const cursors = Array.from({ length: 63 }, (_, index) => `DYTEST-boundary-${index}`);
	const sample = expiryCase([...cursors.map(nextPage), expired], 63);
	expect(await checkChannelSync(sample.options)).toEqual({ status: "pass" });
	expect(sample.observed.cursors).toEqual([expect.any(String), ...cursors]);
	expect(sample.observed).toMatchObject({ resync: 1, expired: 1, closed: 1 });
});

it("discards expiry-traversal changes before checking the full resync snapshot", async () => {
	const sample = expiryCase(
		[
			() =>
				Response.json({
					messages: [
						{
							id: "msg_000099",
							author: "user-99",
							text: "DYTEST expiry traversal only",
							createdAt: 1_800_000_000_000,
						},
					],
					cursor: "DYTEST-before-full-resync",
					more: true,
				}),
			expired,
		],
		1,
	);
	expect(await checkChannelSync(sample.options)).toEqual({ status: "pass" });
	expect(sample.observed.cursors).toEqual([expect.any(String), "DYTEST-before-full-resync"]);
	expect(sample.observed).toMatchObject({ resync: 1, expired: 1, closed: 1 });
});

it("rejects a resync that loses provider changes after a later typed expiry", async () => {
	const sample = expiryCase([nextPage("DYTEST-before-resync"), expired], 1, () =>
		Response.json({ messages: [], cursor: "DYTEST-incomplete-resync", more: false }),
	);
	expect(await checkChannelSync(sample.options)).toEqual({
		status: "fail",
		code: "CHANNEL_SYNC_RESYNC",
	});
	expect(sample.observed.cursors).toEqual([expect.any(String), "DYTEST-before-resync"]);
	expect(sample.observed).toMatchObject({ resync: 1, expired: 1, closed: 1 });
});

it("requires immediate expiry when no progress budget was supplied", async () => {
	const sample = expiryCase([nextPage("DYTEST-undeclared-progress"), expired]);
	expect(await checkChannelSync(sample.options)).toEqual({
		status: "fail",
		code: "CHANNEL_ERROR_RESULT",
	});
	expect(sample.observed.cursors).toHaveLength(1);
	expect(sample.observed).toMatchObject({ resync: 0, expired: 0, closed: 1 });
});

it.each([1, 2])("rejects expiry before all %i declared progress pages", async (pages) => {
	const sample = expiryCase(
		[
			...Array.from({ length: pages - 1 }, (_, index) => nextPage(`DYTEST-early-${index}`)),
			expired,
		],
		pages,
	);
	expect(await checkChannelSync(sample.options)).toEqual({
		status: "fail",
		code: "CHANNEL_RESULT",
	});
	expect(sample.observed.cursors).toHaveLength(pages);
	expect(sample.observed).toMatchObject({ resync: 0, expired: 1, closed: 1 });
});

it("rejects expiry later than the declared progress budget", async () => {
	const sample = expiryCase(
		[nextPage("DYTEST-declared-progress"), nextPage("DYTEST-extra-progress"), expired],
		1,
	);
	expect(await checkChannelSync(sample.options)).toEqual({
		status: "fail",
		code: "CHANNEL_ERROR_RESULT",
	});
	expect(sample.observed.cursors).toEqual([expect.any(String), "DYTEST-declared-progress"]);
	expect(sample.observed).toMatchObject({ resync: 0, expired: 0, closed: 1 });
});

it.each([0, 1])(
	"refuses normal completion after %i progress pages without expiry",
	async (pages) => {
		const sample = expiryCase(
			[
				...Array.from({ length: pages }, (_, index) => nextPage(`DYTEST-drain-${index}`)),
				() => Response.json({ messages: [], cursor: "DYTEST-drained", more: false }),
			],
			pages + 1,
		);
		expect(await checkChannelSync(sample.options)).toEqual({
			status: "fail",
			code: "CHANNEL_ERROR_RESULT",
		});
		expect(sample.observed.cursors).toHaveLength(pages + 1);
		expect(sample.observed).toMatchObject({ resync: 0, expired: 0, closed: 1 });
	},
);

it("refuses a first progress page that repeats the completed cursor", async () => {
	const sample = expiryCase(
		[
			(request) =>
				Response.json({
					messages: [],
					cursor: new URL(request.url).searchParams.get("cursor"),
					more: true,
				}),
			expired,
		],
		1,
	);
	expect(await checkChannelSync(sample.options)).toEqual({
		status: "fail",
		code: "CHANNEL_SYNC_STALLED",
	});
	expect(sample.observed.cursors).toHaveLength(1);
	expect(sample.observed).toMatchObject({ resync: 0, expired: 0, closed: 1 });
});

it("refuses a later cursor cycle before another provider call", async () => {
	const sample = expiryCase(
		[nextPage("DYTEST-cycle-a"), nextPage("DYTEST-cycle-b"), nextPage("DYTEST-cycle-a"), expired],
		3,
	);
	expect(await checkChannelSync(sample.options)).toEqual({
		status: "fail",
		code: "CHANNEL_SYNC_STALLED",
	});
	expect(sample.observed.cursors).toEqual([expect.any(String), "DYTEST-cycle-a", "DYTEST-cycle-b"]);
	expect(sample.observed).toMatchObject({ resync: 0, expired: 0, closed: 1 });
});

it("refuses a sixty-fourth progress page instead of reaching a later expiry", async () => {
	const sample = expiryCase(
		[...Array.from({ length: 64 }, (_, index) => nextPage(`DYTEST-limit-${index}`)), expired],
		63,
	);
	expect(await checkChannelSync(sample.options)).toEqual({
		status: "fail",
		code: "CHANNEL_ERROR_RESULT",
	});
	expect(sample.observed.cursors).toHaveLength(64);
	expect(sample.observed.cursors.at(-1)).toBe("DYTEST-limit-62");
	expect(sample.observed).toMatchObject({ resync: 0, expired: 0, closed: 1 });
});

it.each([429, 503])(
	"rejects HTTP %i instead of treating another typed error as expiry",
	async (status) => {
		const sample = expiryCase(
			[nextPage("DYTEST-before-error"), () => new Response(null, { status })],
			1,
		);
		expect(await checkChannelSync(sample.options)).toEqual({
			status: "fail",
			code: "CHANNEL_ERROR_CODE",
		});
		expect(sample.observed.cursors).toEqual([expect.any(String), "DYTEST-before-error"]);
		expect(sample.observed).toMatchObject({ resync: 0, expired: 0, closed: 1 });
	},
);

it.each([
	["missing cursor", { messages: [], more: true }],
	["empty cursor", { messages: [], cursor: "", more: true }],
	["nonboolean continuation", { messages: [], cursor: "DYTEST-invalid", more: "true" }],
] as const)("rejects a malformed %s before advancing or resyncing", async (_label, page) => {
	const sample = expiryCase([() => Response.json(page), expired], 1);
	expect(await checkChannelSync(sample.options)).toEqual({
		status: "fail",
		code: "CHANNEL_RESULT",
	});
	expect(sample.observed.cursors).toHaveLength(1);
	expect(sample.observed).toMatchObject({ resync: 0, expired: 0, closed: 1 });
});

it.each([
	["negative", -1],
	["over the maximum", 64],
	["fractional", 0.5],
	["NaN", Number.NaN],
	["infinite", Number.POSITIVE_INFINITY],
	["nonnumber", "1"],
	["null", null],
] as const)("rejects a %s fixture budget before any sync request", async (_label, budget) => {
	// Deliberately cross the typed fixture boundary with malformed trusted DATA.
	const sample = expiryCase([expired], budget as number);
	expect(await checkChannelSync(sample.options)).toEqual({
		status: "fail",
		code: "CHANNEL_SYNC_EXPIRY_FIXTURE",
	});
	expect(sample.observed).toEqual({
		cursors: [],
		providerReads: 0,
		resync: 0,
		expired: 0,
		closed: 1,
	});
});
