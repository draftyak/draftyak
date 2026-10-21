import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Fingerprint, fingerprint, writeEvidence } from "@draftyak/spike-kit";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Clock } from "../src/api.ts";
import type { ChannelType } from "../src/reduce.ts";
import { FakeSlack, fakeToken, messageEvent, OWNER, TEAM } from "./fake-slack.ts";
import {
	Calls,
	type Cue,
	type LiveOptions,
	type LiveResult,
	liveSettings,
	liveTokens,
	NOT_DELIVERED,
	NOT_SENT,
	RECEIVED,
	runLive,
	type Waits,
} from "./live-session.ts";

// Session 2's procedure (test/live-session.ts) against FakeSlack and its Socket Mode link, before
// any live run: the evidence's shape, its redaction, and vendor-guard's evidence rules on it, in a
// temp git repository shaped like the spike (DRAFTYAK_S6_REHEARSAL_DIR keeps it in that folder).

const OTHER = "U0OTHER01";
const CHANNELS: Readonly<Record<ChannelType, string>> = {
	im: "D0DM00001",
	mpim: "G0MPIM001",
	channel: "C0CHAN001",
	group: "G0PRIV001",
};
const GENERAL = "C0GENERAL";
const CANARY = "canary-text-4f1d";
const NAME_CANARY = "canary-name-8b2e";
const WAITS: Waits = {
	connectMs: 5000,
	eventsMs: 5000,
	remindMs: 1000,
	checkMs: 2000,
	uninstallMs: 5000,
	deleteMs: 5000,
	pollMs: 50,
	pollerMs: 5000,
};
const ALL: readonly ChannelType[] = ["im", "mpim", "channel", "group"];

const spikeDir = fileURLToPath(new URL("..", import.meta.url));
const guardCli = fileURLToPath(new URL("../../../tools/vendor-guard/src/cli.ts", import.meta.url));
const loopback = (url: URL): boolean => url.protocol === "ws:" && url.hostname === "127.0.0.1";
const gitEnv = (): NodeJS.ProcessEnv =>
	Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));

let micros = 0;
// A Slack ts 50 ms in the past, unique within the run.
const nextTs = (): string => {
	const us = (Date.now() - 50) * 1000 + (micros++ % 1000);
	return `${Math.floor(us / 1e6)}.${String(us % 1e6).padStart(6, "0")}`;
};

// DRAFTYAK_S6_REHEARSAL_DIR: an absolute folder that is missing or empty and outside every git
// work tree, since the rehearsal runs `git init` there and leaves its evidence behind.
function rehearsalDir(keep: string): string {
	if (!path.isAbsolute(keep)) throw new Error("DRAFTYAK_S6_REHEARSAL_DIR must be absolute");
	if (existsSync(keep) && readdirSync(keep).length > 0) {
		throw new Error("DRAFTYAK_S6_REHEARSAL_DIR must be a missing or empty folder");
	}
	let probe = path.resolve(keep);
	while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
	const inside = spawnSync("git", ["-C", probe, "rev-parse", "--show-toplevel"], {
		env: gitEnv(),
		windowsHide: true,
	});
	if (inside.status === 0) {
		throw new Error("DRAFTYAK_S6_REHEARSAL_DIR must be outside every git work tree");
	}
	return keep;
}

let root = "";
let print: Fingerprint;
const fakes: FakeSlack[] = [];

const git = (...args: string[]) => {
	const result = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		env: gitEnv(),
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

beforeAll(async () => {
	const keep = process.env.DRAFTYAK_S6_REHEARSAL_DIR ?? "";
	root = keep ? rehearsalDir(keep) : mkdtempSync(path.join(os.tmpdir(), "draftyak-s06-rehearsal-"));
	mkdirSync(root, { recursive: true });
	git("init", "-q");
	git("config", "maintenance.auto", "false");
	print = await fingerprint({ cwd: spikeDir, sampleMs: 100 });
});

afterAll(() => {
	if (!process.env.DRAFTYAK_S6_REHEARSAL_DIR) rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
	await Promise.all(fakes.splice(0).map((each) => each.close()));
});

type Intercept = (method: string, url: URL) => Response | undefined;

interface Fixture {
	readonly fake: FakeSlack;
	readonly lines: string[];
	readonly cues: Cue[];
	readonly socketUrls: string[];
	readonly planted: string[];
	intercept: Intercept | null;
}

interface Setup {
	// Messages from the owner in the public test channel before the run (default 18).
	readonly channelMessages?: number;
	// A public channel with three messages, listed before the others.
	readonly general?: boolean;
	readonly types?: readonly ChannelType[];
}

// Response headers shaped like Slack's, with content in values that must never be kept.
function headers(planted: string[]): Record<string, string> {
	const values = {
		"x-slack-req-id": randomBytes(16).toString("hex"),
		"x-edge-request-id": randomUUID(),
		"x-debug-reporter": "someone@example.com",
		via: "1.1 10.0.0.12 (edge)",
		"x-backend-auth": `Bearer ${fakeToken("xoxp")}`,
		"x-ratelimit-scope": `team ${TEAM}`,
	};
	planted.push(...Object.values(values));
	return {
		...values,
		"x-oauth-scopes": "channels:history,groups:history,im:history,mpim:history",
		"x-ratelimit-limit": "50",
		"x-ratelimit-remaining": "49",
		"x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
	};
}

// conversations.info, which FakeSlack doesn't answer: the documented channel object, with content,
// and num_members only when asked for.
function info(slack: FakeSlack, url: URL, init?: RequestInit): Response {
	const conversation = slack.conversations.find(
		(each) => each.id === url.searchParams.get("channel"),
	);
	const authorized =
		new Headers(init?.headers).get("authorization") === `Bearer ${slack.userToken}`;
	const members = url.searchParams.get("include_num_members") === "true" ? { num_members: 3 } : {};
	const body = !authorized
		? { ok: false, error: "invalid_auth" }
		: conversation === undefined
			? { ok: false, error: "channel_not_found" }
			: {
					ok: true,
					channel: {
						id: conversation.id,
						name: NAME_CANARY,
						is_channel: conversation.type === "channel",
						is_group: conversation.type === "group",
						is_im: conversation.type === "im",
						is_mpim: conversation.type === "mpim",
						is_private: conversation.type !== "channel",
						is_archived: false,
						is_ext_shared: false,
						created: 1_760_000_000,
						creator: OTHER,
						topic: { value: CANARY, creator: OTHER, last_set: 1_760_000_000 },
						...members,
					},
				};
	return Response.json(body, {
		headers: { "content-type": "application/json; charset=utf-8", date: new Date().toUTCString() },
	});
}

async function setUp(setup: Setup = {}): Promise<Fixture> {
	const slack = await new FakeSlack().start();
	fakes.push(slack);
	if (setup.general) {
		// Ten minutes old: from before the run, outside its 2 s allowance for the clocks.
		const old = Math.floor(Date.now() / 1000) - 600;
		const messages = [0, 1, 2].map((index) => ({
			ts: `${old}.00010${index}`,
			user: OTHER,
			text: `${CANARY} ${index}`,
		}));
		slack.conversations.push({ id: GENERAL, type: "channel", messages });
	}
	for (const type of setup.types ?? ALL) {
		slack.conversations.push({ id: CHANNELS[type], type, messages: [] });
	}
	// The public test channel's earlier messages, from the owner, for the exemption check.
	const channel = slack.conversations.find((each) => each.id === CHANNELS.channel);
	for (let index = 0; index < (setup.channelMessages ?? 18); index++) {
		channel?.messages.push({ ts: nextTs(), user: OWNER, text: `${CANARY} ${index}` });
	}
	return { fake: slack, lines: [], cues: [], socketUrls: [], planted: [], intercept: null };
}

function options(fixture: Fixture, overrides: Partial<LiveOptions> = {}): LiveOptions {
	const { fake: slack, socketUrls, planted } = fixture;
	const Base = globalThis.WebSocket;
	let readNow = Date.now();
	return {
		appToken: slack.appToken,
		userToken: slack.userToken,
		expect: ALL,
		keepApp: false,
		debugReconnects: true,
		dropAck: false,
		waits: WAITS,
		say: (line) => fixture.lines.push(line),
		apiBase: slack.apiBase,
		allowSocketUrl: loopback,
		readClock: {
			now: () => readNow,
			delay: async (ms, signal) => {
				signal?.throwIfAborted();
				readNow += ms;
			},
		},
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : input);
			const method = url.pathname.split("/").at(-1) ?? "";
			const answer =
				fixture.intercept?.(method, url) ??
				(method === "conversations.info" ? info(slack, url, init) : await fetch(input, init));
			const merged = new Headers(answer.headers);
			for (const [name, value] of Object.entries(headers(planted))) merged.set(name, value);
			return new Response(answer.body, { status: answer.status, headers: merged });
		}) as typeof fetch,
		WebSocket: class extends Base {
			constructor(url: string | URL, protocols?: string | string[]) {
				socketUrls.push(String(url));
				super(url, protocols);
			}
		},
		...overrides,
	};
}

// A message from `user` in a conversation's history, without an event.
function post(slack: FakeSlack, type: ChannelType, user = OTHER): string {
	const ts = nextTs();
	slack.conversations
		.find((each) => each.id === CHANNELS[type])
		?.messages.push({ ts, user, text: `${CANARY} from ${user}` });
	return ts;
}

// The second user's messages, as Slack sends them and as conversations.history then returns them.
function send(slack: FakeSlack, types: readonly ChannelType[]): void {
	for (const type of types) {
		const ts = post(slack, type);
		slack.deliver(
			messageEvent({
				channel: CHANNELS[type],
				channel_type: type,
				user: OTHER,
				ts,
				text: `${CANARY} from the second user`,
				team: TEAM,
			}),
		);
	}
}

function ping(slack: FakeSlack): void {
	for (const { socket } of slack.live()) (socket as unknown as { ping(): void }).ping();
}

const revocationEvent = (event: object): object => ({
	token: "verification-token-placeholder",
	team_id: TEAM,
	api_app_id: "A0FAKEAPP",
	event,
	type: "event_callback",
	event_id: `Ev${randomBytes(5).toString("hex").toUpperCase()}`,
	event_time: Math.floor(Date.now() / 1000),
});

function revocationEvents(slack: FakeSlack): void {
	slack.deliver(revocationEvent({ type: "app_uninstalled" }));
	slack.deliver(revocationEvent({ type: "tokens_revoked", tokens: { oauth: [OWNER], bot: [] } }));
}

const eventIdOf = (payload: unknown): unknown => (payload as { event_id?: unknown }).event_id;

// Every raw value the evidence and the progress lines must never hold.
function forbidden(fixture: Fixture): string[] {
	const { fake: slack } = fixture;
	const tsValues = slack.conversations.flatMap((each) => each.messages.map(({ ts }) => ts));
	const eventIds = slack.envelopes.flatMap(({ payload }) => {
		const eventId = eventIdOf(payload);
		return typeof eventId === "string" ? [eventId] : [];
	});
	return [
		slack.appToken,
		slack.userToken,
		OWNER,
		OTHER,
		TEAM,
		GENERAL,
		"A0FAKEAPP",
		CANARY,
		NAME_CANARY,
		...Object.values(CHANNELS),
		...tsValues,
		...tsValues.map((ts) => ts.split(".")[0] ?? ts),
		...eventIds,
		...slack.envelopes.map(({ envelopeId }) => envelopeId),
		...slack.tickets,
		...fixture.planted,
	];
}

function leaks(text: string, fixture: Fixture): string[] {
	return [...new Set(forbidden(fixture))].filter((value) => text.includes(value));
}

// writeEvidence() into the temp repository, then vendor-guard's CLI over it, as `pnpm guard` runs.
async function guarded(
	name: string,
	result: LiveResult,
): Promise<{ readonly text: string; readonly findings: unknown[] }> {
	const file = path.join(root, "spikes", "s06-slack", "evidence", `${name}.json`);
	await writeEvidence(file, result.data, { fingerprint: print });
	return { text: readFileSync(file, "utf8"), findings: guard().findings };
}

function guard(): { readonly findings: unknown[]; readonly files: number } {
	const run = spawnSync(process.execPath, [guardCli, "--json"], {
		cwd: root,
		encoding: "utf8",
		windowsHide: true,
	});
	if (run.status === 2 || run.stdout === "") throw new Error(`vendor-guard: ${run.stderr}`);
	return JSON.parse(run.stdout) as { findings: unknown[]; files: number };
}

const at = (data: unknown, ...keys: string[]): unknown =>
	keys.reduce<unknown>(
		(node, key) =>
			node !== null && typeof node === "object"
				? (node as Record<string, unknown>)[key]
				: undefined,
		data,
	);

interface Call {
	readonly method: string;
	readonly purpose: string;
	readonly channel: string | null;
	readonly status: number | null;
	readonly ok: boolean;
	readonly error: string | null;
	readonly fields: string[] | null;
	readonly headers: { names: string[]; values: Record<string, string | number> } | null;
}

const callsOf = (result: LiveResult): Call[] => at(result.data, "rateLimits", "calls") as Call[];

// conversations.history as the exemption check calls it: limit 100, no `oldest`.
const exemptionRead = (method: string, url: URL): boolean =>
	method === "conversations.history" &&
	url.searchParams.get("limit") === "100" &&
	!url.searchParams.has("oldest");

const slackJson = (body: object, status = 200): Response =>
	Response.json(body, { status, headers: { "content-type": "application/json; charset=utf-8" } });

function manyConversations(slack: FakeSlack): void {
	for (const [index, type] of ALL.entries()) {
		for (let channel = 0; channel < 19; channel++) {
			slack.conversations.push({
				id: `C${index}EXTRA${String(channel).padStart(2, "0")}`,
				type,
				messages: [],
			});
		}
	}
}

async function until(done: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!done()) {
		if (Date.now() >= deadline) throw new Error("synthetic socket condition did not settle");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

describe("read pacing and send provenance", () => {
	it("shares the Tier 3 burst across history and replies and stamps after pacing", async () => {
		let now = 0;
		const waits: number[] = [];
		const sent: number[] = [];
		const clock: Clock = {
			now: () => now,
			delay: async (ms) => {
				waits.push(ms);
				now += ms;
			},
		};
		const calls = new Calls({
			base: (async () => {
				sent.push(now);
				return slackJson({ ok: true, messages: [] });
			}) as typeof fetch,
			apiBase: "http://127.0.0.1:1/api/",
			signal: undefined,
			since: () => now,
			hash: () => "hmac:synthetic",
			seen: () => {},
			clock,
		});
		for (let index = 0; index < 8; index++) {
			await calls.call(
				index % 2 === 0 ? "conversations.history" : "conversations.replies",
				fakeToken("xoxp"),
				{},
				"sent check",
				index !== 7,
			);
		}
		expect(sent).toEqual([0, 0, 0, 0, 0, 1200, 2400, 3600]);
		expect(waits).toEqual([1200, 1200, 1200]);
		expect(calls.audit.map(({ atMs }) => atMs)).toEqual(sent);
		expect(calls.records).toHaveLength(7);
		expect(calls.audit).toHaveLength(8);
	});

	it("cancellation during a pacing wait sends and records nothing further", async () => {
		const controller = new AbortController();
		let sent = 0;
		const calls = new Calls({
			base: (async () => {
				sent++;
				return slackJson({ ok: true, messages: [] });
			}) as typeof fetch,
			apiBase: "http://127.0.0.1:1/api/",
			signal: controller.signal,
			since: () => 0,
			hash: () => "hmac:synthetic",
			seen: () => {},
			clock: { now: () => 0, delay: async () => controller.abort() },
		});
		for (let index = 0; index < 5; index++) {
			await calls.call("conversations.history", fakeToken("xoxp"), {}, "sent check");
		}
		await expect(
			calls.call("conversations.replies", fakeToken("xoxp"), {}, "sent check"),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(sent).toBe(5);
		expect(calls.audit).toHaveLength(5);
		expect(calls.records).toHaveLength(5);
	});
});

describe("rehearsal: the S6 live procedure against FakeSlack", () => {
	it.each([
		{ count: 49, expire: false, qualified: false },
		{ count: 50, expire: false, qualified: true },
		{ count: 50, expire: true, qualified: false },
	])(
		"qualifies the first 429 from actual rolling read sends: $count, expiry $expire",
		async ({ count, expire, qualified }) => {
			const fixture = await setUp();
			manyConversations(fixture.fake);
			let reads = 0;
			let now = 0;
			fixture.intercept = (method) => {
				if (
					(method === "conversations.history" || method === "conversations.replies") &&
					++reads === count
				) {
					return slackJson({ ok: false, error: "ratelimited" }, 429);
				}
				return undefined;
			};
			const result = await runLive(
				options(fixture, {
					keepApp: true,
					waits: { ...WAITS, eventsMs: 10, checkMs: 10_000, pollerMs: 20 },
					readClock: {
						now: () => now,
						delay: async (ms) => {
							now += ms;
							if (expire && reads === 48) now += 60_000;
						},
					},
				}),
			);
			expect(result.verdicts[4]).toBe(
				qualified
					? "exemption: inconclusive (rate limited after 50 history/replies reads in 60 s)"
					: "exemption: does not hold (conversations.history rate limited: HTTP 429, ratelimited)",
			);
			const limited = callsOf(result).find((call) => call.status === 429);
			expect(limited?.purpose).toBe("sent check");
			expect(leaks(JSON.stringify(result.data), fixture)).toEqual([]);
		},
	);

	it("keeps late decisive records after more than 200 sent-check calls, with exact omissions and order", async () => {
		const fixture = await setUp();
		const slack = fixture.fake;
		manyConversations(slack);
		const result = await runLive(
			options(fixture, {
				waits: { ...WAITS, eventsMs: 1200, checkMs: 1, remindMs: 10_000, pollerMs: 20 },
				cue: (step) => {
					if (step === "uninstall") {
						slack.fail("auth.test", 50, "token_revoked");
						revocationEvents(slack);
					} else if (step === "delete") slack.fail("apps.connections.open", 50, "invalid_auth");
				},
			}),
		);
		const sent =
			Number(at(result.data, "sentChecks")) +
			slack.requests.filter(
				({ method, params }) =>
					method === "conversations.history" &&
					params.oldest !== undefined &&
					params.limit === "100",
			).length;
		expect(sent).toBeGreaterThan(200);
		const calls = callsOf(result);
		expect(calls.filter(({ purpose }) => purpose === "sent check")).toHaveLength(100);
		expect(at(result.data, "rateLimits", "omittedSentCheckCalls")).toBe(sent - 100);
		expect(calls[0]?.purpose).toBe("identity");
		expect(calls.slice(1, 101).every(({ purpose }) => purpose === "sent check")).toBe(true);
		expect(calls.slice(101).map(({ purpose }) => purpose)).toEqual([
			"discovery",
			"message.im",
			"message.im",
			"message.mpim",
			"message.mpim",
			"message.channels",
			"message.channels",
			"message.channels",
			"message.groups",
			"message.groups",
			"exemption",
			"exemption",
			"after uninstall",
			"after uninstall",
			"after delete",
			"final check",
			"final check",
		]);
		expect(result.verdicts.at(-1)).toBe("revoked: yes");
		const { text, findings } = await guarded("retained-late-records", result);
		expect(findings).toEqual([]);
		expect(leaks(text, fixture)).toEqual([]);
		expect(leaks(fixture.lines.join("\n"), fixture)).toEqual([]);
	}, 30_000);

	it.each(["early", "late"] as const)(
		"records %s revocation events without treating arrivals as token refusal",
		async (timing) => {
			const fixture = await setUp();
			const slack = fixture.fake;
			const result = await runLive(
				options(fixture, {
					expect: ["im"],
					waits: { ...WAITS, uninstallMs: 80, deleteMs: 60, pollMs: 10 },
					cue: (step) => {
						if (step === "send") {
							if (timing === "early") revocationEvents(slack);
							send(slack, ["im"]);
						} else if (step === "uninstall" && timing === "late") revocationEvents(slack);
					},
				}),
			);
			for (const kind of ["app_uninstalled", "tokens_revoked"]) {
				const note = at(result.data, "revocation", kind) as Record<string, unknown>;
				expect(note).toMatchObject({ verdict: RECEIVED, count: 1 });
				if (timing === "early") {
					expect(note.beforeCue).toBe(true);
					expect(note.afterCueMs).toBeLessThanOrEqual(0);
					expect(fixture.lines).toContain(`${kind} arrived before the uninstall prompt`);
				} else {
					expect(note).not.toHaveProperty("beforeCue");
					expect(note.afterCueMs).toBeGreaterThanOrEqual(0);
				}
			}
			expect(result.verdicts.at(-1)).toBe(
				"revoked: no (user token: still accepted; app-level token: still accepted)",
			);
			expect(at(result.data, "revocation", "finalCheck")).toEqual({
				userToken: "still accepted",
				appToken: "still accepted",
			});
			expect(leaks(JSON.stringify(result.data), fixture)).toEqual([]);
		},
	);

	it("retains pre-cue revocation markers even when no uninstall cue is planned", async () => {
		const fixture = await setUp();
		const result = await runLive(
			options(fixture, {
				expect: ["im"],
				keepApp: true,
				cue: () => {
					revocationEvents(fixture.fake);
					send(fixture.fake, ["im"]);
				},
			}),
		);
		expect(at(result.data, "revocation", "app_uninstalled")).toMatchObject({
			verdict: RECEIVED,
			beforeCue: true,
			afterCueMs: null,
			count: 1,
		});
		expect(at(result.data, "revocation", "tokens_revoked")).toMatchObject({
			verdict: RECEIVED,
			beforeCue: true,
			afterCueMs: null,
			count: 1,
		});
		expect(at(result.data, "revocation", "revoked")).toBe("not done (app kept for M6)");
	});

	it.each([OTHER, OWNER, null])(
		"qualifies absent types only for untyped messages from others: %s",
		async (user) => {
			const fixture = await setUp();
			const result = await runLive(
				options(fixture, {
					expect: ["im", "mpim"],
					keepApp: true,
					waits: { ...WAITS, eventsMs: 100, checkMs: 10_000 },
					cue: () => {
						send(fixture.fake, ["im"]);
						post(fixture.fake, "mpim");
						if (user !== null)
							fixture.fake.deliver(
								messageEvent({ channel: CHANNELS.mpim, user, ts: nextTs(), text: CANARY }),
							);
					},
				}),
			);
			expect(result.verdicts[0]).toBe(`message.im: ${RECEIVED}`);
			expect(result.verdicts[1]).toBe(
				user === OTHER
					? "message.mpim: not confirmed (1 untyped event(s) from others)"
					: `message.mpim: ${NOT_DELIVERED}`,
			);
			expect(at(result.data, "unknownTypeEvents")).toBe(user === null ? 0 : 1);
			expect(leaks(JSON.stringify(result.data), fixture)).toEqual([]);
		},
	);

	it.each(["continuous", "drop", "refresh", "unknown refresh"] as const)(
		"uses complete events-phase continuity for an absent type: %s",
		async (mode) => {
			const fixture = await setUp();
			const slack = fixture.fake;
			const result = await runLive(
				options(fixture, {
					expect: ["im", "mpim"],
					keepApp: true,
					waits: { ...WAITS, eventsMs: mode === "drop" ? 2000 : 900, checkMs: 10_000 },
					cue: () => {
						send(slack, ["im"]);
						post(slack, "mpim");
						const connection = slack.live()[0];
						if (connection === undefined) throw new Error("fake connection missing");
						if (mode === "drop") slack.terminate(connection);
						else if (mode !== "continuous")
							slack.disconnect(connection, mode === "refresh" ? "warning" : "other", null);
					},
				}),
			);
			const confirmed = mode === "continuous" || mode === "refresh";
			expect(result.verdicts[1]).toBe(
				confirmed
					? `message.mpim: ${NOT_DELIVERED}`
					: "message.mpim: not confirmed (socket continuity was interrupted or unknown)",
			);
			expect(at(result.data, "socketMode", "eventsContinuity", "confirmed")).toBe(confirmed);
			const gaps = Number(at(result.data, "socketMode", "eventsContinuity", "gaps"));
			if (confirmed) expect(gaps).toBe(0);
			else expect(gaps).toBeGreaterThan(0);
			expect(at(result.data, "socketMode", "eventsContinuity", "plannedRefreshOverlaps")).toBe(
				mode === "refresh" ? 1 : 0,
			);
			if (mode === "drop")
				expect(
					fixture.lines.filter((line) => line === "socket: ready:1").length,
				).toBeGreaterThanOrEqual(2);
			expect(leaks(JSON.stringify(result.data), fixture)).toEqual([]);
			expect(leaks(fixture.lines.join("\n"), fixture)).toEqual([]);
		},
	);

	it("includes a socket drop during the final history check in the delivery window", async () => {
		const fixture = await setUp();
		const slack = fixture.fake;
		let sendAt = 0;
		let finalReadAt = 0;
		let postedAt = 0;
		let finalReads = 0;
		const live = options(fixture, {
			expect: ["im", "mpim"],
			keepApp: true,
			waits: { ...WAITS, eventsMs: 100, checkMs: 10_000 },
			cue: () => {
				sendAt = Date.now();
				send(slack, ["im"]);
			},
		});
		const fakeFetch = live.fetch;
		if (!fakeFetch) throw new Error("fake fetch missing");
		const result = await runLive({
			...live,
			fetch: async (input, init) => {
				const url = new URL(input instanceof Request ? input.url : input);
				if (
					url.pathname.endsWith("/conversations.history") &&
					url.searchParams.has("oldest") &&
					url.searchParams.get("channel") === CHANNELS.mpim
				) {
					finalReads++;
					finalReadAt = Date.now();
					const connection = slack.live()[0];
					if (!connection) throw new Error("fake connection missing");
					slack.terminate(connection);
					await until(() => fixture.lines.includes("socket: closed:1006"));
					// This history-positive message is sent after the timed wait, while the read awaits.
					postedAt = Date.now();
					slack.conversations
						.find(({ id }) => id === CHANNELS.mpim)
						?.messages.push({ ts: String(postedAt / 1000), user: OTHER, text: CANARY });
				}
				return fakeFetch(input, init);
			},
		});
		expect(finalReads).toBe(1);
		expect(finalReadAt - sendAt).toBeGreaterThanOrEqual(100);
		expect(postedAt).toBeGreaterThanOrEqual(finalReadAt);
		expect(at(result.data, "events", "message.mpim", "historySinceConnect")).toMatchObject({
			read: 1,
			fromOthers: 1,
			failed: [],
			capped: false,
		});
		expect(result.verdicts[1]).toBe(
			"message.mpim: not confirmed (socket continuity was interrupted or unknown)",
		);
		const continuity = at(result.data, "socketMode", "eventsContinuity") as {
			confirmed: boolean;
			gaps: number;
			firstGapAtMs: number;
			untilMs: number;
		};
		expect(continuity).toMatchObject({ confirmed: false, gaps: 1 });
		expect(continuity.firstGapAtMs).toBeLessThanOrEqual(continuity.untilMs);
		expect(leaks(JSON.stringify(result.data), fixture)).toEqual([]);
	});

	it("ends the final history delivery window before later uninstall and deletion closes", async () => {
		const fixture = await setUp();
		const slack = fixture.fake;
		const result = await runLive(
			options(fixture, {
				expect: ["im", "mpim"],
				waits: { ...WAITS, eventsMs: 100, checkMs: 10_000 },
				cue: (step) => {
					fixture.cues.push(step);
					if (step === "send") {
						send(slack, ["im"]);
						post(slack, "mpim");
					} else if (step === "uninstall") {
						slack.fail("auth.test", 50, "token_revoked");
						revocationEvents(slack);
					} else {
						slack.fail("apps.connections.open", 50, "invalid_auth");
						for (const connection of slack.live()) slack.terminate(connection);
					}
				},
			}),
		);
		expect(fixture.cues).toEqual(["send", "uninstall", "delete"]);
		expect(at(result.data, "sentChecks")).toBe(1);
		expect(result.verdicts[1]).toBe(`message.mpim: ${NOT_DELIVERED}`);
		expect(at(result.data, "socketMode", "eventsContinuity")).toMatchObject({
			confirmed: true,
			gaps: 0,
		});
		expect(
			(at(result.data, "socketMode", "states") as { state: string }[]).some(
				({ state }) => state === "closed:1006",
			),
		).toBe(true);
	});

	it("a planned old socket closing before replacement hello is a gap despite quick recovery", async () => {
		const fixture = await setUp();
		const slack = fixture.fake;
		let driven: Promise<void> = Promise.resolve();
		const result = await runLive(
			options(fixture, {
				expect: ["im", "mpim"],
				keepApp: true,
				waits: { ...WAITS, eventsMs: 400, checkMs: 10_000 },
				cue: () => {
					send(slack, ["im"]);
					post(slack, "mpim");
					const old = slack.live()[0];
					if (!old) throw new Error("fake connection missing");
					slack.sendHello = false;
					slack.disconnect(old, "warning", 0);
					driven = (async () => {
						await until(
							() => old.closedCode !== null && slack.live().some(({ id }) => id !== old.id),
						);
						const replacement = slack.live().find(({ id }) => id !== old.id);
						if (!replacement) throw new Error("replacement missing");
						slack.frame(replacement, { type: "hello", num_connections: 1 });
					})();
				},
			}),
		);
		await driven;
		expect(result.verdicts[1]).toBe(
			"message.mpim: not confirmed (socket continuity was interrupted or unknown)",
		);
		expect(at(result.data, "socketMode", "eventsContinuity")).toMatchObject({
			confirmed: false,
			plannedRefreshOverlaps: 0,
		});
		expect(
			fixture.lines.filter((line) => line === "socket: ready:1").length,
		).toBeGreaterThanOrEqual(2);
	});

	it("an older draining socket cannot prove replacement overlap", async () => {
		const fixture = await setUp();
		const slack = fixture.fake;
		const Base = globalThis.WebSocket;
		let hold = true;
		const held: { socket: WebSocket; code: number | undefined; reason: string | undefined }[] = [];
		class HeldClose extends Base {
			close(code?: number, reason?: string): void {
				if (hold && code === 1000) held.push({ socket: this, code, reason });
				else super.close(code, reason);
			}
		}
		let driven: Promise<void> = Promise.resolve();
		const result = await runLive(
			options(fixture, {
				expect: ["im", "mpim"],
				keepApp: true,
				WebSocket: HeldClose,
				waits: { ...WAITS, eventsMs: 600, checkMs: 10_000 },
				cue: () => {
					send(slack, ["im"]);
					post(slack, "mpim");
					const old = slack.live()[0];
					if (!old) throw new Error("fake connection missing");
					slack.sendHello = false;
					slack.disconnect(old, "warning", null);
					driven = (async () => {
						await until(() => slack.live().some(({ id }) => id !== old.id));
						const middle = slack.live().find(({ id }) => id !== old.id);
						if (!middle) throw new Error("middle connection missing");
						slack.frame(middle, { type: "hello", num_connections: 2 });
						await until(() => held.length > 0);
						slack.disconnect(middle, "warning", null);
						await until(() => slack.live().some(({ id }) => id !== old.id && id !== middle.id));
						middle.socket.close(1000);
						await until(() => fixture.lines.includes("socket: closed:1000"));
						const replacement = slack.live().find(({ id }) => id !== old.id && id !== middle.id);
						if (!replacement) throw new Error("replacement missing");
						slack.frame(replacement, { type: "hello", num_connections: 2 });
						hold = false;
						for (const { socket, code, reason } of held) socket.close(code, reason);
					})();
				},
			}),
		);
		await driven;
		expect(result.verdicts[1]).toBe(
			"message.mpim: not confirmed (socket continuity was interrupted or unknown)",
		);
		expect(at(result.data, "socketMode", "eventsContinuity", "confirmed")).toBe(false);
	});

	it("a gap beyond the first 100 state examples still prevents a delivery failure verdict", async () => {
		const fixture = await setUp();
		const slack = fixture.fake;
		let driven: Promise<void> = Promise.resolve();
		const result = await runLive(
			options(fixture, {
				expect: ["im", "mpim"],
				keepApp: true,
				waits: { ...WAITS, eventsMs: 1600, checkMs: 10_000 },
				cue: () => {
					send(slack, ["im"]);
					post(slack, "mpim");
					driven = (async () => {
						for (let index = 0; index < 35; index++) {
							const current = slack.live().at(-1);
							if (!current) throw new Error("fake connection missing");
							slack.disconnect(current, "warning", null);
							await until(() => current.closedCode !== null);
						}
						const current = slack.live().at(-1);
						if (!current) throw new Error("fake connection missing");
						slack.terminate(current);
					})();
				},
			}),
		);
		await driven;
		expect(result.verdicts[1]).toBe(
			"message.mpim: not confirmed (socket continuity was interrupted or unknown)",
		);
		const states = at(result.data, "socketMode", "states") as { state: string }[];
		expect(states).toHaveLength(100);
		expect(states.some(({ state }) => state === "closed:1006")).toBe(false);
		const count = Number(at(result.data, "socketMode", "stateCount"));
		expect(count).toBeGreaterThan(100);
		expect(at(result.data, "socketMode", "stateExamplesOmitted")).toBe(count - 100);
		expect(at(result.data, "socketMode", "eventsContinuity")).toMatchObject({
			confirmed: false,
			gaps: 1,
			plannedRefreshOverlaps: 35,
		});
		const { text, findings } = await guarded("full-continuity", result);
		expect(findings).toEqual([]);
		expect(leaks(text, fixture)).toEqual([]);
	}, 15_000);

	it("records every type over Socket Mode, the headers, the exemption and the revocation", async () => {
		const fixture = await setUp();
		const slack = fixture.fake;
		const cue = (step: Cue): void => {
			fixture.cues.push(step);
			if (step === "send") {
				// The run drops the DM's first ack, so FakeSlack redelivers it after 100 ms, while the run
				// still waits for the other types; every later envelope has the usual 3 s.
				slack.ackTimeoutMs = 100;
				ping(slack);
				send(slack, ["im"]);
				slack.ackTimeoutMs = 3000;
				setTimeout(() => {
					ping(slack);
					send(slack, ["mpim", "channel", "group"]);
					// The owner's own message counts apart from the second user's.
					slack.deliver(
						messageEvent({
							channel: CHANNELS.channel,
							channel_type: "channel",
							user: OWNER,
							ts: nextTs(),
						}),
					);
					// An edit of a ten-minute-old message: it counts, but its old ts stays out of latency.
					const old = `${Math.floor(Date.now() / 1000) - 600}.000100`;
					fixture.planted.push(old, old.split(".")[0] ?? old);
					slack.deliver(
						messageEvent({
							channel: CHANNELS.channel,
							channel_type: "channel",
							subtype: "message_changed",
							message: { type: "message", user: OTHER, ts: old, text: CANARY },
							previous_message: { type: "message", user: OTHER, ts: old, text: CANARY },
						}),
					);
				}, 250);
			} else if (step === "uninstall") {
				slack.fail("auth.test", 50, "token_revoked");
				revocationEvents(slack);
			} else {
				slack.fail("apps.connections.open", 50, "invalid_auth");
				for (const connection of slack.live()) slack.terminate(connection);
			}
		};
		const result = await runLive(options(fixture, { cue, dropAck: true }));

		expect(result.verdicts).toEqual([
			`message.im: ${RECEIVED}`,
			`message.mpim: ${RECEIVED}`,
			`message.channels: ${RECEIVED}`,
			`message.groups: ${RECEIVED}`,
			"exemption: holds",
			`app_uninstalled: ${RECEIVED}`,
			`tokens_revoked: ${RECEIVED}`,
			"revoked: yes",
		]);
		expect(fixture.cues).toEqual(["send", "uninstall", "delete"]);
		expect(result.redacted).toBe(0);
		// Each response's planted x-ratelimit-scope value: replaced, and counted.
		expect(result.replaced).toBeGreaterThan(0);
		expect(at(result.data, "rateLimits", "headerValuesReplaced")).toBe(result.replaced);
		expect(fixture.socketUrls[0]).toContain("debug_reconnects=true");

		const { data } = result;
		expect(at(data, "events", "message.channels")).toMatchObject({
			expected: true,
			verdict: RECEIVED,
			fromOthers: 2,
			fromOwner: 1,
			historySinceConnect: null,
		});
		expect(at(data, "events", "message.channels", "samples")).toContainEqual(
			expect.objectContaining({ change: "edited", latencyMs: null }),
		);
		// The second user's messages carry a ts 50 ms before they are delivered.
		for (const type of ["message.im", "message.mpim", "message.channels", "message.groups"]) {
			const latency = at(data, "events", type, "latencyMs") as Record<string, number>;
			expect(latency.min, type).toBeGreaterThanOrEqual(0);
			expect(latency.min, type).toBeLessThanOrEqual(latency.max ?? Number.NaN);
			expect(latency.max, type).toBeLessThan(5000);
		}
		const [sample] = at(data, "events", "message.im", "samples") as Record<string, unknown>[];
		expect(sample).toMatchObject({
			latencyMs: expect.any(Number),
			change: "new",
			subtype: null,
			thread: false,
			sentBeforeConnect: false,
			channel: expect.stringMatching(/^hmac:[\w-]{22}$/),
			ts: expect.stringMatching(/^hmac:[\w-]{22}$/),
			eventId: expect.stringMatching(/^hmac:[\w-]{22}$/),
		});

		// The dropped ack: the DM's first envelope got none, and FakeSlack sent it again as a new
		// envelope with the same event_id. The evidence matches what FakeSlack actually sent.
		const dm = slack.envelopes.find(
			(envelope) =>
				(envelope.payload as { event?: { channel?: string } }).event?.channel === CHANNELS.im,
		);
		expect(dm?.retryAttempt).toBe(0);
		expect(slack.acksFor(dm?.envelopeId ?? "")).toEqual([]);
		const redelivered = slack.envelopes.filter((envelope) => envelope.retryAttempt > 0);
		expect(redelivered.map(({ payload }) => eventIdOf(payload))).toContain(eventIdOf(dm?.payload));
		const retries = at(data, "socketMode", "retries") as unknown[];
		expect(retries).toHaveLength(redelivered.length);
		expect(retries).toContainEqual(
			expect.objectContaining({ retryAttempt: 1, retryReason: "timeout" }),
		);
		expect(at(data, "socketMode", "repeatedEventIds")).toBe(redelivered.length);
		expect(at(data, "socketMode", "retryProbe")).toMatchObject({
			enabled: true,
			dropped: true,
			retried: true,
			retryAttempt: 1,
			retryReason: "timeout",
			newEnvelopeId: true,
			sameEventId: true,
			retryAfterMs: expect.any(Number),
		});
		expect(at(data, "procedure", "dropAck")).toBe(true);
		expect(at(data, "socketMode", "pings", "count")).toBeGreaterThanOrEqual(2);
		expect(at(data, "socketMode", "hellos")).toEqual([
			expect.objectContaining({ numConnections: 1, connectionTimeS: 18060 }),
		]);
		expect(at(data, "socketMode", "opens", "statuses")).toMatchObject({ "200": 1 });

		const calls = callsOf(result);
		for (const method of ["conversations.info", "conversations.history", "conversations.replies"]) {
			const mine = calls.filter(
				(call) => call.method === method && call.purpose.startsWith("message."),
			);
			expect(mine.map((call) => call.purpose).sort(), method).toEqual([
				"message.channels",
				"message.groups",
				"message.im",
				"message.mpim",
			]);
			for (const call of mine) {
				expect(call).toMatchObject({ status: 200, ok: true });
				expect(call.headers?.names).toEqual(
					expect.arrayContaining(["content-type", "x-ratelimit-limit", "x-slack-req-id", "via"]),
				);
				// Values only for *ratelimit*, retry-after and content-type: whole numbers as numbers,
				// other values in their expected shapes.
				expect(call.headers?.values).toEqual({
					"content-type": "application/json; charset=utf-8",
					"x-ratelimit-limit": 50,
					"x-ratelimit-remaining": 49,
					"x-ratelimit-reset": expect.any(Number),
					"x-ratelimit-scope": "[redacted:shape]",
				});
			}
		}
		const infoCall = calls.find((call) => call.method === "conversations.info");
		expect(infoCall?.fields).toEqual(
			expect.arrayContaining(["is_archived", "is_ext_shared", "name", "num_members"]),
		);
		expect(at(data, "rateLimits", "exemption")).toMatchObject({
			verdict: "holds",
			publicChannels: 1,
			probes: [expect.objectContaining({ status: 200, items: 19, hasMore: false })],
			chosen: 0,
			second: expect.objectContaining({ status: 200, items: 19 }),
		});
		expect(at(data, "poller")).toMatchObject({
			ok: true,
			conversations: 4,
			failed: 0,
			fromOthersSinceConnect: {
				"message.im": 1,
				"message.mpim": 1,
				"message.channels": 1,
				"message.groups": 1,
			},
		});
		expect(at(data, "revocation")).toMatchObject({
			uninstall: "done",
			userTokenAfterUninstall: "token_revoked",
			appTokenAfterUninstall: "still accepted",
			appTokenAfterDelete: "invalid_auth",
			finalCheck: { userToken: "token_revoked", appToken: "invalid_auth" },
			tokens_revoked: { verdict: RECEIVED, userTokens: 1, botTokens: 0, ownerListed: true },
			revoked: "yes",
		});
		// FakeSlack's HTTP server sends a Date header with every answer.
		const clock = at(data, "clock") as Record<string, number>;
		expect(clock.withDate).toBeGreaterThan(10);
		expect(clock.roundTrips).toBe(clock.withDate);
		const skew = at(data, "clock", "skewMs") as Record<string, number>;
		expect(skew.min).toBeGreaterThan(-2000);
		expect(skew.max).toBeLessThan(2000);

		const prompts = fixture.lines.filter((line) => /send now|Owner:/.test(line));
		expect(at(data, "sentChecks")).toBe(0);
		expect(at(data, "socketMode", "eventsContinuity", "confirmed")).toBe(true);
		expect(
			(at(data, "socketMode", "states") as { state: string }[]).some(
				({ state }) => state === "closed:1006",
			),
		).toBe(true);
		expect(prompts.map((line) => line.split(/[,.]/)[0])).toEqual([
			expect.stringMatching(/^connected after/),
			"Owner: uninstall the app now",
			"Owner: now delete the app",
		]);
		expect(fixture.lines).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^dropped the ack of the first message from another user once/),
				expect.stringMatching(
					/^Slack redelivered that message after [\d.]+ s \(retry_attempt 1, timeout\)$/,
				),
				expect.stringMatching(/^Slack's Date header: on \d+ of \d+ responses/),
			]),
		);
		const { text, findings } = await guarded("live", result);
		expect(findings).toEqual([]);
		expect(leaks(text, fixture)).toEqual([]);
		expect(leaks(fixture.lines.join("\n"), fixture)).toEqual([]);
		expect(text).not.toMatch(/\[redacted:(?!shape)/);
	});

	it("tells a type Slack didn't deliver from one nobody sent, and prompts the second user", async () => {
		const fixture = await setUp();
		const slack = fixture.fake;
		const cue = (step: Cue): void => {
			fixture.cues.push(step);
			send(slack, ["im", "channel"]);
			// In the group DM a message from the second user reaches history without an event; in the
			// private channel only the owner writes.
			post(slack, "mpim");
			post(slack, "group", OWNER);
		};
		const waits = { ...WAITS, eventsMs: 900, remindMs: 250, checkMs: 300 };
		const result = await runLive(options(fixture, { cue, waits, keepApp: true }));

		expect(result.verdicts.slice(0, 4)).toEqual([
			`message.im: ${RECEIVED}`,
			`message.mpim: ${NOT_DELIVERED}`,
			`message.channels: ${RECEIVED}`,
			`message.groups: ${NOT_SENT}`,
		]);
		expect(fixture.lines).toEqual(
			expect.arrayContaining([
				"message.mpim: 1 message(s) from others since the run connected, but no event yet",
				"message.groups: nothing from others since the run connected. Second user, send one in the private test channel now",
				expect.stringMatching(
					/^stopped waiting after 1 min: message\.mpim not delivered; message\.groups not sent/,
				),
			]),
		);
		expect(at(result.data, "events", "message.mpim")).toMatchObject({
			verdict: NOT_DELIVERED,
			fromOthers: 0,
			latencyMs: null,
			samples: [],
			historySinceConnect: { conversations: 1, read: 1, fromOthers: 1, failed: [], capped: false },
		});
		expect(at(result.data, "events", "message.groups", "historySinceConnect")).toMatchObject({
			conversations: 1,
			read: 1,
			fromOthers: 0,
		});
		expect(at(result.data, "sentChecks")).toBeGreaterThanOrEqual(2);
		expect(at(result.data, "poller", "fromOthersSinceConnect")).toEqual({
			"message.im": 1,
			"message.mpim": 1,
			"message.channels": 1,
			"message.groups": 0,
		});
		const { text, findings } = await guarded("live-degraded", result);
		expect(findings).toEqual([]);
		expect(leaks(text, fixture)).toEqual([]);
		expect(leaks(fixture.lines.join("\n"), fixture)).toEqual([]);
	});

	it("records a 429 on conversations.history, events that never come and a token that stays valid", async () => {
		const fixture = await setUp();
		const slack = fixture.fake;
		const cue = (step: Cue): void => {
			fixture.cues.push(step);
			if (step === "send") {
				slack.rateLimit("conversations.history", 1, "30");
				send(slack, ALL);
			} else if (step === "uninstall") {
				slack.fail("auth.test", 50, "invalid_auth");
			}
		};
		const waits = { ...WAITS, uninstallMs: 400, deleteMs: 300, remindMs: 150 };
		const result = await runLive(options(fixture, { cue, waits }));

		expect(result.verdicts.slice(4)).toEqual([
			"exemption: does not hold (conversations.history rate limited: HTTP 429, ratelimited)",
			`app_uninstalled: ${NOT_DELIVERED}`,
			`tokens_revoked: ${NOT_DELIVERED}`,
			"revoked: no (user token: invalid_auth; app-level token: still accepted)",
		]);
		const limited = callsOf(result).find((call) => call.status === 429);
		expect(limited).toMatchObject({
			method: "conversations.history",
			ok: false,
			error: "ratelimited",
		});
		expect(limited?.headers?.values).toMatchObject({ "retry-after": 30 });
		expect(fixture.lines).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^still waiting for app_uninstalled, tokens_revoked \(1 min left\)$/),
				"apps.connections.open didn't refuse the app-level token (still accepted)",
			]),
		);
		expect(at(result.data, "revocation")).toMatchObject({
			userTokenAfterUninstall: "invalid_auth",
			appTokenAfterDelete: "still accepted",
			finalCheck: { userToken: "invalid_auth", appToken: "still accepted" },
		});
		const { findings } = await guarded("live-limited", result);
		expect(findings).toEqual([]);
	});

	it("checks the exemption on the fullest public channel, whether or not message.channels arrives", async () => {
		// #general is listed first and holds the second user's messages from before the run.
		const fixture = await setUp({ general: true });
		const cue = (): void => send(fixture.fake, ["im", "mpim", "group"]);
		const waits = { ...WAITS, eventsMs: 400, checkMs: 10_000, remindMs: 10_000 };
		const result = await runLive(options(fixture, { cue, waits, keepApp: true }));
		expect(result.verdicts[2]).toBe(`message.channels: ${NOT_SENT}`);
		expect(at(result.data, "events", "message.channels", "historySinceConnect")).toMatchObject({
			conversations: 2,
			read: 2,
			fromOthers: 0,
		});
		expect(result.verdicts[4]).toBe("exemption: holds");
		expect(at(result.data, "rateLimits", "exemption")).toMatchObject({
			publicChannels: 2,
			probes: [
				expect.objectContaining({ items: 3, hasMore: false }),
				expect.objectContaining({ items: 18, hasMore: false }),
			],
			chosen: 1,
			second: expect.objectContaining({ status: 200, items: 18 }),
		});
		const reads = callsOf(result).filter((call) => call.purpose === "exemption");
		expect(reads).toHaveLength(3);
		expect(reads[0]?.channel).not.toBe(reads[1]?.channel);
		expect(reads[2]?.channel).toBe(reads[1]?.channel);
	});

	it("reads the exemption as capped, too thin, unchecked or failed on its second call", async () => {
		const exemption = async (setup: Setup, intercept: Intercept | null = null) => {
			const fixture = await setUp(setup);
			fixture.intercept = intercept;
			const cue = (): void => send(fixture.fake, ["im"]);
			const result = await runLive(options(fixture, { cue, expect: ["im"], keepApp: true }));
			return result.verdicts[4];
		};
		const messages = Array.from({ length: 15 }, () => ({
			type: "message",
			user: OWNER,
			ts: nextTs(),
		}));
		expect(
			await exemption({}, (method, url) =>
				exemptionRead(method, url)
					? slackJson({
							ok: true,
							messages,
							has_more: true,
							response_metadata: { next_cursor: "bmV4dA" },
						})
					: undefined,
			),
		).toBe("exemption: does not hold (capped at 15 objects with limit 100)");
		expect(await exemption({ channelMessages: 15 })).toBe(
			"exemption: inconclusive (15 messages with limit 100 in the fullest public channel; more than 15 are needed)",
		);
		expect(await exemption({ types: ["im", "mpim", "group"] })).toBe(
			"exemption: not checked (no public channel)",
		);
		const second = (answer: object) => {
			let reads = 0;
			return (method: string, url: URL): Response | undefined =>
				exemptionRead(method, url) && ++reads === 2 ? slackJson(answer) : undefined;
		};
		expect(await exemption({}, second({ ok: false, error: "ratelimited" }))).toBe(
			"exemption: does not hold (conversations.history rate limited: HTTP 200, ratelimited)",
		);
		expect(await exemption({}, second({ ok: false, error: "internal_error" }))).toBe(
			"exemption: inconclusive (second call: internal_error)",
		);
	});

	it("waits for revocation events that arrive after auth.test refuses the user token", async () => {
		const fixture = await setUp();
		const slack = fixture.fake;
		const cue = (step: Cue): void => {
			if (step === "send") send(slack, ["im"]);
			else if (step === "uninstall") {
				slack.fail("auth.test", 50, "token_revoked");
				setTimeout(() => revocationEvents(slack), 600);
			} else slack.fail("apps.connections.open", 50, "invalid_auth");
		};
		const result = await runLive(options(fixture, { cue, expect: ["im"] }));
		expect(result.verdicts.slice(5)).toEqual([
			`app_uninstalled: ${RECEIVED}`,
			`tokens_revoked: ${RECEIVED}`,
			"revoked: yes",
		]);
		const revocation = at(result.data, "revocation") as Record<string, unknown>;
		expect(revocation.userRefusedAfterMs).toBeLessThan(600);
		expect(at(revocation, "app_uninstalled", "afterCueMs")).toBeGreaterThanOrEqual(550);
	});

	it("counts only Slack's auth codes as refusals, and decides revoked from a final check", async () => {
		const fixture = await setUp();
		const slack = fixture.fake;
		const cue = (step: Cue): void => {
			if (step === "send") send(slack, ["im"]);
			else if (step === "uninstall") {
				// A proxy's own 403, with no Slack body, isn't Slack refusing the token.
				fixture.intercept = (method) =>
					method === "auth.test" ? new Response("<html>denied</html>", { status: 403 }) : undefined;
				revocationEvents(slack);
			} else {
				// The user token is refused only once the app is deleted.
				fixture.intercept = null;
				slack.fail("auth.test", 50, "token_revoked");
				slack.fail("apps.connections.open", 1, "unknown_refusal");
				slack.fail("apps.connections.open", 1, "service_unavailable", 503);
				slack.fail("apps.connections.open", 50, "invalid_auth");
			}
		};
		const waits = { ...WAITS, uninstallMs: 400 };
		const result = await runLive(options(fixture, { cue, expect: ["im"], waits }));
		expect(at(result.data, "revocation")).toMatchObject({
			userTokenAfterUninstall: "unexpected (http_403)",
			userRefusedAfterMs: null,
			appTokenAfterUninstall: "still accepted",
			appTokenAfterDelete: "invalid_auth",
			connectionChecks: 3,
			finalCheck: { userToken: "token_revoked", appToken: "invalid_auth" },
			revoked: "yes",
		});
		expect(fixture.lines).not.toContainEqual(expect.stringMatching(/^auth\.test refuses/));
		expect(fixture.lines).toEqual(
			expect.arrayContaining([
				"apps.connections.open refuses the app-level token now (invalid_auth)",
				"final check: user token token_revoked, app-level token invalid_auth",
			]),
		);
	});

	it("waits out the delete when apps.connections.open already refused after the uninstall", async () => {
		const fixture = await setUp();
		const slack = fixture.fake;
		const cue = (step: Cue): void => {
			if (step === "send") send(slack, ["im"]);
			else if (step === "uninstall") {
				slack.fail("auth.test", 50, "token_revoked");
				slack.fail("apps.connections.open", 50, "invalid_auth");
				revocationEvents(slack);
			}
		};
		const waits = { ...WAITS, deleteMs: 400, remindMs: 150 };
		const result = await runLive(options(fixture, { cue, expect: ["im"], waits }));
		const revocation = at(result.data, "revocation") as Record<string, unknown>;
		expect(revocation).toMatchObject({
			appTokenAfterUninstall: "invalid_auth",
			appTokenAfterDelete: "refused already after the uninstall (invalid_auth)",
			connectionChecks: 0,
			finalCheck: { userToken: "token_revoked", appToken: "invalid_auth" },
			revoked: "yes",
		});
		expect(revocation.deleteWaitMs).toBeGreaterThanOrEqual(390);
		expect(fixture.lines).toEqual(
			expect.arrayContaining([
				expect.stringMatching(
					/^Owner: now delete the app\. apps\.connections\.open already refuses the app-level token \(invalid_auth\)/,
				),
				expect.stringMatching(/^waiting for the owner to delete the app/),
			]),
		);
	});

	it("keeps the app when asked, waits only for the expected types and skips the refresh tip", async () => {
		const fixture = await setUp();
		const cue = (step: Cue): void => {
			fixture.cues.push(step);
			send(fixture.fake, ["im"]);
		};
		const result = await runLive(
			options(fixture, { cue, expect: ["im"], keepApp: true, debugReconnects: false }),
		);
		expect(result.verdicts).toEqual([
			`message.im: ${RECEIVED}`,
			"message.mpim: not checked",
			"message.channels: not checked",
			"message.groups: not checked",
			"exemption: holds",
			"app_uninstalled: not done (app kept for M6)",
			"tokens_revoked: not done (app kept for M6)",
			"revoked: not done (app kept for M6)",
		]);
		expect(fixture.cues).toEqual(["send"]);
		expect(fixture.socketUrls[0]).not.toContain("debug_reconnects");
		expect(at(result.data, "socketMode", "debugReconnects")).toBe(false);
		expect(at(result.data, "socketMode", "retryProbe")).toMatchObject({
			enabled: false,
			dropped: false,
		});
	});

	it("stops with a clear error, before any cue, when a token is refused, Slack is out of reach or Socket Mode stops", async () => {
		const fixture = await setUp();
		const slack = fixture.fake;
		await expect(runLive(options(fixture, { userToken: fakeToken("xoxp") }))).rejects.toThrow(
			"auth.test refused the user token (invalid_auth)",
		);
		fixture.intercept = (method) =>
			method === "auth.test" ? new Response("<html>proxy</html>", { status: 403 }) : undefined;
		await expect(runLive(options(fixture))).rejects.toThrow(
			"couldn't reach Slack: auth.test failed (http_403)",
		);
		fixture.intercept = null;
		slack.rateLimit("auth.test", 1, "30");
		await expect(runLive(options(fixture))).rejects.toThrow(
			"auth.test was rate limited (ratelimited)",
		);
		await expect(runLive(options(fixture, { appToken: fakeToken("xapp") }))).rejects.toThrow(
			/^Socket Mode didn't connect within 5\.0 s \(auth\)$/,
		);
		expect(fixture.cues).toEqual([]);
		const cue = (): void => {
			const [connection] = slack.live();
			if (connection) slack.disconnect(connection, "link_disabled", null);
		};
		await expect(runLive(options(fixture, { cue }))).rejects.toThrow(
			"Socket Mode stopped (link_disabled) during the events phase",
		);
	});

	it("proves the guard check isn't empty: raw ts and tokens in evidence are findings", () => {
		const file = path.join(root, "spikes", "s06-slack", "evidence", "planted.json");
		mkdirSync(path.dirname(file), { recursive: true });
		const planted = {
			ts: "1760000000.000100",
			token: fakeToken("xoxp"),
			id: "hmac:AbCdEfGhIjKlMnOpQrStUv",
		};
		writeFileSync(file, `${JSON.stringify({ data: planted }, null, 2)}\n`);
		try {
			const rules = guard().findings.map((finding) => (finding as { rule: string }).rule);
			expect(rules).toEqual(expect.arrayContaining(["evidence-digits", "evidence-token"]));
		} finally {
			rmSync(file);
		}
	});
});

describe("live settings, tokens and the rehearsal folder", () => {
	it("reads DRAFTYAK_S6_EXPECT, _KEEP_APP, _DEBUG_RECONNECTS and _DROP_ACK strictly", () => {
		expect(liveSettings({})).toEqual({
			expect: ALL,
			keepApp: false,
			debugReconnects: true,
			dropAck: true,
		});
		expect(
			liveSettings({
				DRAFTYAK_S6_EXPECT: "group, im",
				DRAFTYAK_S6_KEEP_APP: "1",
				DRAFTYAK_S6_DEBUG_RECONNECTS: "0",
				DRAFTYAK_S6_DROP_ACK: "0",
			}),
		).toEqual({ expect: ["im", "group"], keepApp: true, debugReconnects: false, dropAck: false });
		expect(() => liveSettings({ DRAFTYAK_S6_EXPECT: "im,dm" })).toThrow("not dm");
		expect(() => liveSettings({ DRAFTYAK_S6_KEEP_APP: "yes" })).toThrow('is 1 or 0, not "yes"');
		expect(() => liveSettings({ DRAFTYAK_S6_DEBUG_RECONNECTS: "true" })).toThrow("1 or 0");
		expect(() => liveSettings({ DRAFTYAK_S6_DROP_ACK: "off" })).toThrow("1 or 0");
	});

	it("names the missing .env.live entries, and loads both tokens once saved", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-s06-env-"));
		try {
			const env = { DRAFTYAK_ENV_LIVE: path.join(dir, ".env.live") };
			expect(liveTokens({ env })).toEqual({
				missing: `not set in ${env.DRAFTYAK_ENV_LIVE}: DY_LIVE_SLACK_APP_TOKEN, DY_LIVE_SLACK_USER_TOKEN`,
			});
			const app = fakeToken("xapp");
			const user = fakeToken("xoxp");
			writeFileSync(env.DRAFTYAK_ENV_LIVE, `DY_LIVE_SLACK_USER_TOKEN=${user}\n`);
			expect(liveTokens({ env })).toEqual({
				missing: `not set in ${env.DRAFTYAK_ENV_LIVE}: DY_LIVE_SLACK_APP_TOKEN`,
			});
			writeFileSync(
				env.DRAFTYAK_ENV_LIVE,
				`DY_LIVE_SLACK_USER_TOKEN=${user}\nDY_LIVE_SLACK_APP_TOKEN=${app}\n`,
			);
			expect(liveTokens({ env })).toEqual({ appToken: app, userToken: user });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the rehearsal only in a missing or empty folder outside every git work tree", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-s06-keep-"));
		try {
			expect(rehearsalDir(dir)).toBe(dir);
			expect(rehearsalDir(path.join(dir, "new", "folder"))).toBe(path.join(dir, "new", "folder"));
			writeFileSync(path.join(dir, "file.txt"), "");
			expect(() => rehearsalDir(dir)).toThrow("missing or empty");
			expect(() => rehearsalDir("relative/folder")).toThrow("must be absolute");
			expect(() => rehearsalDir(path.join(spikeDir, "rehearsal-new"))).toThrow(
				"outside every git work tree",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
