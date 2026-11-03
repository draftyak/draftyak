import { createHash } from "node:crypto";
import type { Fake, RecordedRequest } from "@draftyak/fakes";
import {
	type ChannelV1Tools,
	channelV1,
	MAX_LEASE_MS,
	MUTATIONS,
} from "@draftyak/protocol/channel-v1";
import type { PluginErrorCode } from "@draftyak/protocol/errors";
import { checkPluginSurface, checkToolResult } from "@draftyak/protocol/extension";
import { canonicalize } from "@draftyak/protocol/jcs";
import type { MessageBody, PluginChange } from "@draftyak/protocol/normalized-change";
import { SEND_TICKET_META } from "@draftyak/protocol/send-ticket";
import { HostError } from "@draftyak/sdk";
import * as z from "zod";
import { createMockHub } from "../mock-hub.ts";
import { matchRequest } from "../policy.ts";
import {
	type MockHub,
	MockHubError,
	type MockHubOptions,
	type MockPlugin,
	type RenderedRequest,
} from "../types.ts";

type Input<N extends keyof ChannelV1Tools> = z.output<ChannelV1Tools[N]["input"]>;
type Output<N extends keyof ChannelV1Tools> = z.output<ChannelV1Tools[N]["output"]>;
type MaybePromise<T> = T | Promise<T>;
type ErrorCase = {
	[N in keyof ChannelV1Tools]: {
		readonly name: N;
		readonly arguments: Input<N>;
		readonly code: PluginErrorCode;
		readonly retryAfterMs?: number;
		/** Script a fault on a fresh fake; this does not supply a check result. */
		readonly prepare?: () => MaybePromise<void>;
	};
}[keyof ChannelV1Tools];

/** Fresh fake state and concrete expected values, never assertion callbacks. */
export interface ChannelContractFixture {
	readonly upstreams: readonly Fake[];
	readonly account?: MockHubOptions["account"];
	readonly instance?: MockHubOptions["instance"];
	readonly secrets?: MockHubOptions["secrets"];
	readonly sync: {
		readonly since: number;
		readonly initial: readonly PluginChange[];
		/** Add provider changes and return the changes the next delta must report. */
		readonly addDelta: () => MaybePromise<readonly PluginChange[]>;
		/** Supply the full provider snapshot when resync order differs from initial plus delta. */
		readonly resync?: () => MaybePromise<readonly PluginChange[]>;
		/** Expire the provider's current cursor, without altering the plugin. */
		readonly expireCursor: () => MaybePromise<void>;
	};
	readonly body: {
		readonly message: Input<"channel_body_fetch">["message"];
		readonly expected: MessageBody;
	};
	readonly send: {
		/** Recorders must retain these header values and at least this many body bytes. */
		readonly rendered: Omit<RenderedRequest, "mintedAt" | "deliverBy">;
		readonly expectedMessage: NonNullable<Output<"channel_send">["message"]>;
		readonly reconcile: {
			readonly arguments: Input<"channel_send_reconcile">;
			readonly expected: Output<"channel_send_reconcile">;
		};
	};
	/** One state-observed scenario for every advertised mutation. */
	readonly mutations?: readonly {
		readonly arguments: Input<"channel_mutate">;
		readonly observe: () => MaybePromise<unknown>;
		readonly expected: unknown;
	}[];
	/** At least one deliberate provider error, in addition to cursor expiry. */
	readonly errors: readonly ErrorCase[];
	readonly close?: () => MaybePromise<void>;
}

export interface ChannelContractOptions {
	readonly plugin: MockPlugin;
	readonly mode?: MockHubOptions["mode"];
	/** Called once per check, including when checks are invoked directly. */
	readonly fixtures: () => MaybePromise<ChannelContractFixture>;
}
export type ChannelContractResult =
	| { readonly status: "pass" }
	| { readonly status: "fail"; readonly code: string };

const PASS: ChannelContractResult = Object.freeze({ status: "pass" });
const fail = (code: string): ChannelContractResult => ({ status: "fail", code });
const equal = (left: unknown, right: unknown): boolean =>
	left === undefined || right === undefined
		? left === right
		: canonicalize(left) === canonicalize(right);
class CheckFailure extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}
function requireCheck(condition: unknown, code: string): asserts condition {
	if (!condition) throw new CheckFailure(code);
}
interface Session {
	readonly hub: MockHub;
	readonly fixture: ChannelContractFixture;
	readonly takeRequests: () => RecordedRequest[];
}

async function run(
	options: ChannelContractOptions,
	check: (session: Session) => Promise<void>,
	ticketRefusal = false,
): Promise<ChannelContractResult> {
	let fixture: ChannelContractFixture | undefined;
	let hub: MockHub | undefined;
	let outcome = PASS;
	try {
		fixture = await options.fixtures();
		hub = createMockHub({
			mode: options.mode ?? "process",
			plugin: options.plugin,
			upstreams: fixture.upstreams,
			...(fixture.account ? { account: fixture.account } : {}),
			...(fixture.instance ? { instance: fixture.instance } : {}),
			...(fixture.secrets ? { secrets: fixture.secrets } : {}),
		});
		requireCheck(hub.manifest.kind === "channel", "CHANNEL_KIND");
		const requests: RecordedRequest[] = [];
		const takeRequests = (): RecordedRequest[] => {
			const next = fixture?.upstreams.flatMap((fake) => fake.recorder.takeRequests()) ?? [];
			requests.push(...next);
			return next;
		};
		await check({ hub, fixture, takeRequests });
		takeRequests();
		requireCheck(hub.host.auditComplete, "CHANNEL_AUDIT_INCOMPLETE");
		requireCheck(
			hub.host.denials.every((denial) => ticketRefusal && denial.reason === "TICKET_UNKNOWN"),
			"CHANNEL_EGRESS_DENIED",
		);
		requireCheck(ticketRefusal || !hub.host.disabled, "CHANNEL_DISABLED");
		for (const request of requests) {
			requireCheck(
				matchRequest(
					hub.manifest,
					`https://${request.host}${request.target}`,
					request.method,
					new Map(),
				),
				"CHANNEL_OFF_MANIFEST_EGRESS",
			);
		}
	} catch (error) {
		outcome = fail(
			error instanceof CheckFailure
				? error.code
				: error instanceof MockHubError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
					? error.code
					: "CHANNEL_CHECK_FAILED",
		);
	} finally {
		try {
			await hub?.close();
		} catch {
			outcome = fail("CHANNEL_CLOSE_FAILED");
		} finally {
			try {
				await fixture?.close?.();
			} catch {
				outcome = fail("CHANNEL_FIXTURE_CLOSE_FAILED");
			}
		}
	}
	return outcome;
}

function result<N extends keyof ChannelV1Tools>(
	name: N,
	reply: Record<string, unknown>,
): Output<N> {
	const checked = checkToolResult(channelV1, name, reply);
	requireCheck(checked.ok && !checked.isError, "CHANNEL_RESULT");
	// Content beyond the SDK's text mirror must not carry another result surface.
	requireCheck(
		!Array.isArray(reply.content) || reply.content.every((part) => part?.type === "text"),
		"CHANNEL_RESULT_SURFACE",
	);
	return checked.value as Output<N>;
}
function errorResult(
	name: keyof ChannelV1Tools,
	reply: Record<string, unknown>,
	code?: PluginErrorCode,
	retryAfterMs?: number,
): void {
	const checked = checkToolResult(channelV1, name, reply);
	requireCheck(checked.ok && checked.isError, "CHANNEL_ERROR_RESULT");
	requireCheck(
		!Array.isArray(reply.content) || reply.content.every((part) => part?.type === "text"),
		"CHANNEL_RESULT_SURFACE",
	);
	const value = checked.value as { code: PluginErrorCode; retryAfterMs?: number };
	requireCheck(code === undefined || value.code === code, "CHANNEL_ERROR_CODE");
	requireCheck(
		retryAfterMs === undefined || value.retryAfterMs === retryAfterMs,
		"CHANNEL_ERROR_RETRY",
	);
}
async function description(hub: MockHub): Promise<Output<"channel_describe">> {
	return result("channel_describe", await hub.call("channel_describe", {}));
}
async function pages(hub: MockHub, first: Input<"channel_sync">): Promise<Output<"channel_sync">> {
	let input = first;
	const changes: PluginChange[] = [];
	const cursors = new Set<string>();
	for (let page = 0; page < 64; page++) {
		const output = result("channel_sync", await hub.call("channel_sync", { ...input }));
		changes.push(...output.changes);
		if (!output.more) return { ...output, changes };
		requireCheck(!cursors.has(output.cursor), "CHANNEL_SYNC_STALLED");
		cursors.add(output.cursor);
		input = { ...first, cursor: output.cursor };
	}
	throw new CheckFailure("CHANNEL_SYNC_PAGE_LIMIT");
}

export async function checkChannelSurface(
	options: ChannelContractOptions,
): Promise<ChannelContractResult> {
	return run(options, async ({ hub }) => {
		const discovery = await hub.discover();
		requireCheck(equal(discovery.supportedVersions, ["2026-07-28"]), "CHANNEL_PROTOCOL_VERSION");
		requireCheck(
			checkPluginSurface(discovery, await hub.listTools(), channelV1).length === 0,
			"CHANNEL_SURFACE",
		);
	});
}

export async function checkChannelTools(
	options: ChannelContractOptions,
): Promise<ChannelContractResult> {
	return run(options, async ({ hub }) => {
		const first = await hub.listTools();
		requireCheck(
			checkPluginSurface(await hub.discover(), first, channelV1).length === 0,
			"CHANNEL_SURFACE",
		);
		for (const item of first.tools as Record<string, unknown>[]) {
			const contract = channelV1.tools[item.name as keyof ChannelV1Tools];
			requireCheck(contract, "CHANNEL_TOOL_UNKNOWN");
			requireCheck(item.description === contract.description, "CHANNEL_TOOL_DESCRIPTION");
			for (const [key, schema] of [
				["inputSchema", contract.input],
				["outputSchema", contract.output],
			] as const) {
				const expected = z.toJSONSchema(schema, {
					target: "draft-2020-12",
					io: key === "inputSchema" ? "input" : "output",
				});
				requireCheck(equal(item[key], expected), "CHANNEL_TOOL_SCHEMA");
			}
		}
		await description(hub);
		result("channel_probe", await hub.call("channel_probe", {}));
		for (let repeat = 0; repeat < 3; repeat++)
			requireCheck(equal(first, await hub.listTools()), "CHANNEL_TOOL_DRIFT");
	});
}

export async function checkChannelDescribeProbe(
	options: ChannelContractOptions,
): Promise<ChannelContractResult> {
	return run(options, async ({ hub }) => {
		const declared = await description(hub);
		const tools = (await hub.listTools()).tools as { name: string }[];
		requireCheck(
			tools.some((tool) => tool.name === "channel_attachment_fetch") === declared.attachments,
			"CHANNEL_ATTACHMENT_DECLARATION",
		);
		requireCheck(
			new Set(declared.mutations).size === declared.mutations.length,
			"CHANNEL_MUTATE_DECLARATION",
		);
		const probe = result("channel_probe", await hub.call("channel_probe", {}));
		requireCheck(probe.status === "ok", "CHANNEL_PROBE_NOT_READY");
	});
}

export async function checkChannelSync(
	options: ChannelContractOptions,
): Promise<ChannelContractResult> {
	return run(options, async ({ hub, fixture }) => {
		requireCheck(fixture.sync.initial.length > 0, "CHANNEL_SYNC_FIXTURE_EMPTY");
		const initial = await pages(hub, { mode: "initial", since: fixture.sync.since });
		requireCheck(equal(initial.changes, fixture.sync.initial), "CHANNEL_SYNC_INITIAL");
		const deltaChanges = await fixture.sync.addDelta();
		requireCheck(deltaChanges.length > 0, "CHANNEL_SYNC_FIXTURE_EMPTY");
		const delta = await pages(hub, { mode: "delta", cursor: initial.cursor });
		requireCheck(equal(delta.changes, deltaChanges), "CHANNEL_SYNC_DELTA");
		await fixture.sync.expireCursor();
		errorResult(
			"channel_sync",
			await hub.call("channel_sync", { mode: "delta", cursor: delta.cursor }),
			"CURSOR_EXPIRED",
		);
		const resync = await pages(hub, { mode: "resync", since: fixture.sync.since });
		requireCheck(
			equal(
				resync.changes,
				fixture.sync.resync
					? await fixture.sync.resync()
					: [...fixture.sync.initial, ...deltaChanges],
			),
			"CHANNEL_SYNC_RESYNC",
		);
	});
}

export async function checkChannelBody(
	options: ChannelContractOptions,
): Promise<ChannelContractResult> {
	return run(options, async ({ hub, fixture }) => {
		const body = result(
			"channel_body_fetch",
			await hub.call("channel_body_fetch", { message: fixture.body.message }),
		);
		requireCheck(equal(body.message, fixture.body.expected), "CHANNEL_BODY_MISMATCH");
	});
}

export async function checkChannelMutations(
	options: ChannelContractOptions,
): Promise<ChannelContractResult> {
	return run(options, async ({ hub, fixture }) => {
		const declared = await description(hub);
		const tools = (await hub.listTools()).tools as { name: string }[];
		const available = tools.some((tool) => tool.name === "channel_mutate");
		requireCheck(available === declared.mutations.length > 0, "CHANNEL_MUTATE_DECLARATION");
		const scenarios = fixture.mutations ?? [];
		requireCheck(
			equal(
				[...new Set(scenarios.map((item) => item.arguments.op))].sort(),
				[...new Set(declared.mutations)].sort(),
			),
			"CHANNEL_MUTATE_FIXTURES",
		);
		for (const scenario of scenarios) {
			requireCheck(
				!equal(await scenario.observe(), scenario.expected),
				"CHANNEL_MUTATE_FIXTURE_UNCHANGED",
			);
			result("channel_mutate", await hub.call("channel_mutate", { ...scenario.arguments }));
			requireCheck(equal(await scenario.observe(), scenario.expected), "CHANNEL_MUTATE_STATE");
		}
		if (available) {
			for (const op of MUTATIONS.filter((item) => !declared.mutations.includes(item))) {
				const before = await Promise.all(
					scenarios.map(async (scenario) => canonicalize(await scenario.observe())),
				);
				const args = {
					op,
					messages: [fixture.body.message],
					...(["label", "unlabel"].includes(op) ? { labelIds: ["DYTEST-label"] } : {}),
				};
				errorResult("channel_mutate", await hub.call("channel_mutate", args), "UNSUPPORTED");
				const after = await Promise.all(
					scenarios.map(async (scenario) => canonicalize(await scenario.observe())),
				);
				requireCheck(equal(before, after), "CHANNEL_UNDECLARED_MUTATE_STATE");
			}
		}
	});
}

async function sendOnce(
	session: Session,
): Promise<{ args: Input<"channel_send">; meta: Record<string, unknown> }> {
	const { hub, fixture, takeRequests } = session;
	const rendered = fixture.send.rendered;
	const now = Date.now();
	const ticket = hub.host.mintTicket({ ...rendered, mintedAt: now, deliverBy: now + 120_000 });
	const contentType = new Headers(rendered.headers as [string, string][]).get("content-type");
	requireCheck(contentType, "CHANNEL_SEND_CONTENT_TYPE");
	const args = {
		method: rendered.method,
		url: rendered.url,
		contentType,
		body: hub.host.putBlob(rendered.body),
	};
	const meta = { [SEND_TICKET_META]: ticket };
	takeRequests();
	const sent = result("channel_send", await hub.call("channel_send", args, meta));
	requireCheck(equal(sent.message, fixture.send.expectedMessage), "CHANNEL_SEND_PROVIDER_ID");
	requireCheck(!hub.host.hasTicket(ticket.id), "CHANNEL_SEND_TICKET_UNCONSUMED");
	requireCheck(hub.host.denials.length === 0, "CHANNEL_SEND_DENIED");
	const requests = takeRequests();
	requireCheck(requests.length === 1, "CHANNEL_SEND_COUNT");
	const request = requests[0];
	const target = new URL(rendered.url);
	requireCheck(
		request &&
			request.method === rendered.method &&
			request.host === target.host &&
			request.target === target.pathname + target.search,
		"CHANNEL_SEND_TARGET",
	);
	requireCheck(
		request.bodyLength === rendered.body.byteLength &&
			equal([...request.body], [...rendered.body]) &&
			request.bodySha256 === createHash("sha256").update(rendered.body).digest("hex") &&
			request.bodySha256 === ticket.bodySha256,
		"CHANNEL_SEND_BODY",
	);
	for (const [name, value] of new Headers(rendered.headers as [string, string][]))
		requireCheck(request.headers[name] === value, "CHANNEL_SEND_HEADERS");
	return { args, meta };
}

export async function checkChannelSend(
	options: ChannelContractOptions,
): Promise<ChannelContractResult> {
	return run(
		options,
		async (session) => {
			const { args, meta } = await sendOnce(session);
			try {
				errorResult("channel_send", await session.hub.call("channel_send", { ...args }, meta));
			} catch (error) {
				// A process call can observe lookup cancellation before its host audit settles.
				if ((options.mode ?? "process") === "process") await session.hub.close();
				requireCheck(
					error instanceof HostError && error.code === "DENIED",
					"CHANNEL_SEND_REPLAY_RESULT",
				);
				requireCheck(
					session.hub.host.denials.some((denial) => denial.reason === "TICKET_UNKNOWN"),
					"CHANNEL_SEND_REPLAY_RESULT",
				);
			}
			requireCheck(session.takeRequests().length === 0, "CHANNEL_SEND_REPLAY");
		},
		true,
	);
}

export async function checkChannelUnticketedSend(
	options: ChannelContractOptions,
): Promise<ChannelContractResult> {
	return run(
		options,
		async ({ hub, fixture, takeRequests }) => {
			const rendered = fixture.send.rendered;
			const contentType = new Headers(rendered.headers as [string, string][]).get("content-type");
			requireCheck(contentType, "CHANNEL_SEND_CONTENT_TYPE");
			errorResult(
				"channel_send",
				await hub.call("channel_send", {
					method: rendered.method,
					url: rendered.url,
					contentType,
					body: hub.host.putBlob(rendered.body),
				}),
			);
			requireCheck(takeRequests().length === 0, "CHANNEL_UNTICKETED_DISPATCH");
		},
		true,
	);
}

export async function checkChannelReconcile(
	options: ChannelContractOptions,
): Promise<ChannelContractResult> {
	return run(options, async (session) => {
		await sendOnce(session);
		const expected = session.fixture.send.reconcile;
		requireCheck(expected.expected.candidates.length > 0, "CHANNEL_RECONCILE_FIXTURE_EMPTY");
		const reconciled = result(
			"channel_send_reconcile",
			await session.hub.call("channel_send_reconcile", { ...expected.arguments }),
		);
		requireCheck(equal(reconciled, expected.expected), "CHANNEL_RECONCILE_MISMATCH");
	});
}

export async function checkChannelListen(
	options: ChannelContractOptions,
): Promise<ChannelContractResult> {
	return run(options, async ({ hub }) => {
		const declared = await description(hub);
		const tools = (await hub.listTools()).tools as { name: string }[];
		requireCheck(
			tools.some((tool) => tool.name === "channel_listen") === declared.listen,
			"CHANNEL_LISTEN_DECLARATION",
		);
		if (!declared.listen) return;
		const lease = result(
			"channel_listen",
			await hub.call("channel_listen", { leaseMs: MAX_LEASE_MS }),
		);
		requireCheck(lease.leaseMs <= MAX_LEASE_MS, "CHANNEL_LISTEN_LEASE");
	});
}

export async function checkChannelErrors(
	options: ChannelContractOptions,
): Promise<ChannelContractResult> {
	return run(options, async ({ hub, fixture }) => {
		requireCheck(fixture.errors.length > 0, "CHANNEL_ERROR_FIXTURE_EMPTY");
		for (const scenario of fixture.errors) {
			await scenario.prepare?.();
			errorResult(
				scenario.name,
				await hub.call(scenario.name, { ...scenario.arguments }),
				scenario.code,
				scenario.retryAfterMs,
			);
		}
	});
}

export async function checkChannelEgress(
	options: ChannelContractOptions,
): Promise<ChannelContractResult> {
	return run(options, async (session) => {
		await description(session.hub);
		result("channel_probe", await session.hub.call("channel_probe", {}));
		requireCheck(session.hub.host.denials.length === 0, "CHANNEL_EGRESS_DENIED");
		await pages(session.hub, { mode: "initial", since: session.fixture.sync.since });
		result(
			"channel_body_fetch",
			await session.hub.call("channel_body_fetch", { message: session.fixture.body.message }),
		);
		await sendOnce(session);
		result(
			"channel_send_reconcile",
			await session.hub.call("channel_send_reconcile", {
				...session.fixture.send.reconcile.arguments,
			}),
		);
	});
}

export const channelChecks: Readonly<
	Record<string, (options: ChannelContractOptions) => Promise<ChannelContractResult>>
> = Object.freeze({
	surface: checkChannelSurface,
	tools: checkChannelTools,
	describeProbe: checkChannelDescribeProbe,
	sync: checkChannelSync,
	body: checkChannelBody,
	mutations: checkChannelMutations,
	send: checkChannelSend,
	unticketedSend: checkChannelUnticketedSend,
	reconcile: checkChannelReconcile,
	listen: checkChannelListen,
	errors: checkChannelErrors,
	egress: checkChannelEgress,
});

/** Await at test-module scope to register one isolated Vitest test per directly callable check. */
export async function channelContract(options: ChannelContractOptions): Promise<void> {
	const { describe, it } = await import("vitest");
	describe("channel-v1 contract", () => {
		for (const [name, check] of Object.entries(channelChecks)) {
			it(name, async () => {
				const outcome = await check(options);
				if (outcome.status === "fail") throw new Error(outcome.code);
			});
		}
	});
}
