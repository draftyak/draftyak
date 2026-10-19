import { spawnSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { newClaimStamp, type Rendered, renderMime } from "../src/mime.ts";
import { GMAIL_MODIFY } from "../src/oauth.ts";
import { type FakeGmail, startFakeGmail } from "./fake-gmail.ts";
import {
	type FakeOAuth,
	fakeBrowser,
	type Grant,
	startFakeOAuth,
	TokenRegistry,
} from "./fake-google-oauth.ts";
import {
	concurrent429,
	dailyLimit403,
	domainPolicy403,
	errorResponse,
	rateLimit403,
	userRateLimit403,
} from "./google-errors.ts";
import { main as cli } from "./live-cli.ts";
import {
	type Burst,
	MAX_SENDS,
	readState,
	runStep,
	SCHEDULED_SUBJECT,
	SEND_SUBJECT,
	type Session,
	type Step,
	spikeDir,
	type Timing,
	type Work,
} from "./live-session.ts";
import { parseMessage } from "./mime-parse.ts";
import { json } from "./serve.ts";

// The S8b session rehearsed: every live step, through the same code as gmail.live.test.ts, against
// FakeGmail and two fake Google OAuth servers (one per spike client), with the owner's clicks and
// Gmail's scheduled send simulated between steps. Output goes to temp folders only.

const OWNER = "owner@example.com";
const SECOND = "second.mailbox@example.net";
const ACCOUNT_NAME = "Morgan Example";

const FAST: Timing = {
	pollMs: 10,
	indexTimeoutMs: 2_000,
	findTimeoutMs: 5_000,
	sentPollMs: 10,
	sentTimeoutMs: 5_000,
	roundPauseMs: 5,
	backoffMs: 5,
	revokePollMs: 10,
	revokeTimeoutMs: 300,
	consentTimeoutMs: 10_000,
	scheduleLeadMs: 60_000,
	sendMarginMs: 1_000,
};

const consentSeen = {
	wording: [
		"DraftYak S8 spike wants to access your Google Account",
		"<account>",
		"Select what DraftYak S8 spike can access",
		"Read, compose, and send emails from your Gmail account",
	],
	screens: ["disclosure", "account-chooser", "unverified-app", "consent", "done"],
	scopeCheckboxes: true,
};

const OBSERVATIONS = {
	consent: { agent: consentSeen, standard: consentSeen },
	bccInToCopy: "absent",
	publishing: {
		atConsent: "testing",
		withoutHomepage: "published",
		homepage: "accepted",
		final: "testing",
	},
	readings: {
		R1: { verdict: "consistent" },
		R2: { verdict: "unclear", note: "Limited Use names no calendar feeds" },
		R3: { verdict: "consistent" },
		R4: { verdict: "consistent" },
		R5: { verdict: "unclear" },
	},
	policyPages: "unchanged",
	clientsDeleted: true,
};

const gitless = (): NodeJS.ProcessEnv =>
	Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));

interface TempRepo {
	readonly dir: string;
	write(file: string, text: string): void;
	commit(message: string): void;
}

// A throwaway repository shaped like this one, isolated from the user's git config (signing,
// hooks, eol) and without background maintenance, which writes into .git while tests read it.
function tempRepo(base: string): TempRepo {
	const dir = path.join(base, "repo");
	const config = path.join(base, "gitconfig");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		config,
		"[maintenance]\n\tauto = false\n[commit]\n\tgpgsign = false\n[user]\n\tname = Rehearsal\n\temail = rehearsal@example.invalid\n",
	);
	const git = (...args: string[]): void => {
		const result = spawnSync("git", args, {
			cwd: dir,
			encoding: "utf8",
			env: { ...gitless(), GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
			windowsHide: true,
		});
		if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	};
	const write = (file: string, text: string): void => {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		writeFileSync(path.join(dir, file), text);
	};
	git("init", "-q");
	git("config", "maintenance.auto", "false");
	write("README.md", "A stand-in for the repository.\n");
	write("spikes/s08-gmail/package.json", '{ "name": "stand-in" }\n');
	write("spikes/s07-siwc/evidence/run.json", '{ "data": { "count": 1 } }\n');
	const commit = (message: string): void => {
		git("add", "-A", "--", ":/", ":(exclude)spikes/s08-gmail/evidence");
		git("commit", "-qm", message);
	};
	commit("stand-in");
	return { dir, write, commit };
}

const guardCli = path.resolve(spikeDir, "..", "..", "tools", "vendor-guard", "src", "cli.ts");

// vendor-guard over a throwaway repository, as `pnpm guard` runs over the real one.
function guard(repo: string): { readonly code: number | null; readonly findings: Finding[] } {
	const result = spawnSync(process.execPath, [guardCli, "--json"], {
		cwd: repo,
		encoding: "utf8",
		env: gitless(),
		windowsHide: true,
	});
	if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr);
	return {
		code: result.status,
		findings: (JSON.parse(result.stdout) as { findings: Finding[] }).findings,
	};
}

interface Finding {
	readonly file?: string;
	readonly rule: string;
}

// A Desktop client as the Cloud console's Download JSON writes it, made up at run time.
function downloadedClient(dir: string, name: string) {
	const clientId = `${randomInt(1e11, 1e12)}-${randomBytes(16).toString("hex")}.apps.googleusercontent.com`;
	const clientSecret = `test-${randomBytes(18).toString("base64url")}`;
	const file = path.join(dir, `client_secret_${name}.json`);
	const installed = {
		client_id: clientId,
		client_secret: clientSecret,
		redirect_uris: ["http://localhost"],
	};
	writeFileSync(file, JSON.stringify({ installed }));
	return { clientId, clientSecret, file };
}

// FakeGmail takes tokens from either client's authorization server; each keeps its own grants.
function either(first: TokenRegistry, second: TokenRegistry): TokenRegistry {
	return new (class extends TokenRegistry {
		lookup(token: string, kind: "access" | "refresh"): Grant | undefined {
			return first.lookup(token, kind) ?? second.lookup(token, kind);
		}
	})();
}

const urlOf = (input: RequestInfo | URL): string =>
	input instanceof Request ? input.url : String(input);

const formOf = (init: RequestInit | undefined): URLSearchParams =>
	new URLSearchParams(typeof init?.body === "string" ? init.body : "");

// The network between the session and the fakes. Gmail's per-user concurrency limit: requests
// beyond `limit` at once get `limited()` before reaching the fake. At most WIRE requests are on the
// wire at once, each read to its end, so that wide bursts reuse a few keep-alive sockets instead
// of leaving hundreds of loopback sockets in TIME_WAIT (ENOBUFS on a busy machine).
const WIRE = 8;
function network(root: string, limit: number, limited: () => Response): typeof fetch {
	let inFlight = 0;
	let wire = 0;
	const waiting: (() => void)[] = [];
	const send = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (wire < WIRE) wire++;
		else await new Promise<void>((resolve) => waiting.push(resolve));
		try {
			const response = await fetch(input, init);
			const body = await response.arrayBuffer();
			return new Response([204, 304].includes(response.status) ? null : body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} finally {
			const next = waiting.shift();
			if (next === undefined) wire--;
			else next();
		}
	};
	return async (input, init) => {
		if (!urlOf(input).startsWith(root)) return send(input, init);
		if (inFlight >= limit) return limited();
		inFlight++;
		try {
			return await send(input, init);
		} finally {
			inFlight--;
		}
	};
}

// Google's revocation taking effect late: after the n-th revoke request, the next lags[n] refreshes
// still work (Infinity: until another revoke).
function lateRevocation(base: typeof fetch, lags: readonly number[]): typeof fetch {
	let revokes = 0;
	let owed = 0;
	return async (input, init) => {
		const url = urlOf(input);
		if (url.endsWith("/revoke")) owed = lags[revokes++] ?? 0;
		if (url.endsWith("/token") && formOf(init).get("grant_type") === "refresh_token" && owed > 0) {
			owed--;
			const accessToken = `fake-access-${randomBytes(18).toString("base64url")}`;
			return json(200, { access_token: accessToken, expires_in: 3599, token_type: "Bearer" });
		}
		return base(input, init);
	};
}

interface Scenario {
	readonly gmail: "keeps" | "replaces";
	// How Gmail shows the owner's scheduled mail: SCHEDULED alone, SENT and SCHEDULED, or as a new
	// message when it goes out.
	readonly scheduled: "scheduled" | "sent-and-scheduled" | "new-id";
	readonly concurrencyLimit: number;
	// Gmail's answer beyond the limit; the concurrency 429 unless set.
	readonly limited?: () => Response;
	readonly bursts?: readonly Burst[];
	readonly record: boolean;
	readonly requireClean?: boolean;
	// The scheduled step starts while the probe is still a draft.
	readonly lateSchedule?: boolean;
	// Google refuses the agent client on its own page, which never redirects back.
	readonly agentRefused?: boolean;
	readonly testAccount?: string;
	readonly searchLagMs?: number;
}

interface Rehearsal {
	readonly lines: Readonly<Partial<Record<Step, readonly string[]>>>;
	readonly logs: readonly string[];
	readonly cliLog: readonly string[];
	readonly status: readonly string[];
	readonly evidenceFile: string;
	readonly evidence: string;
	readonly state: string;
	readonly envLive: string;
	readonly repo: TempRepo;
	readonly session: Session;
	readonly downloads: readonly string[];
	readonly sentinels: readonly string[];
	readonly calls: readonly string[];
	readonly problems: readonly string[];
}

const bases: string[] = [];
afterAll(() => {
	for (const base of bases) rmSync(base, { recursive: true, force: true });
});

interface Setup {
	readonly session: Session;
	readonly env: NodeJS.ProcessEnv;
	readonly fake: FakeGmail;
	readonly oauth: { readonly standard: FakeOAuth; readonly agent: FakeOAuth };
	readonly dirs: Readonly<Record<"env" | "downloads" | "session", string>>;
	readonly repo: TempRepo;
	readonly clients: readonly ReturnType<typeof downloadedClient>[];
	// The owner's clicks: untick Gmail at the standard client's consent, or Cancel the agent's.
	readonly owner: { untickGmail: boolean; cancel: boolean };
	readonly logs: string[];
	readonly cliLog: string[];
	close(): Promise<void>;
}

function writeInput(world: Setup, input: Readonly<Record<string, unknown>> = {}): void {
	const file = path.join(world.dirs.session, "input.json");
	writeFileSync(
		file,
		JSON.stringify({ secondAddress: SECOND, accountName: ACCOUNT_NAME, ...input }),
	);
}

// Moves the session's clock-bound values, as time passing would.
function setWork(dir: string, change: Partial<Work>): void {
	const file = path.join(dir, "state.json");
	const state = JSON.parse(readFileSync(file, "utf8")) as { work: Work };
	writeFileSync(file, JSON.stringify({ ...state, work: { ...state.work, ...change } }));
}

const scheduledProbe = (text: string): Promise<Rendered> =>
	renderMime(
		{
			from: { address: OWNER },
			to: [{ address: SECOND }],
			subject: SCHEDULED_SUBJECT,
			text: `${text}\n`,
		},
		newClaimStamp(OWNER),
	);

async function setup(scenario: Scenario): Promise<Setup> {
	const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "draftyak-s8-rehearsal-")));
	bases.push(base);
	const dirs = {
		env: path.join(base, "env"),
		downloads: path.join(base, "downloads"),
		session: path.join(base, "session"),
	};
	for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
	const repo = tempRepo(base);
	const env = {
		...process.env,
		DRAFTYAK_ENV_LIVE: path.join(dirs.env, ".env.live"),
		DRAFTYAK_S8_SESSION: dirs.session,
	};
	const standard = downloadedClient(dirs.downloads, "standard");
	const agent = downloadedClient(dirs.downloads, "agent");
	const cliLog: string[] = [];
	const log = (line: string): void => {
		cliLog.push(line);
	};
	expect(cli(["save-client", "standard", standard.file], env, log)).toBe(0);
	expect(cli(["--", "save-client", "agent", agent.file], env, log)).toBe(0);

	const tokens = { standard: new TokenRegistry(), agent: new TokenRegistry() };
	const owner = { untickGmail: false, cancel: false };
	const oauth = {
		standard: await startFakeOAuth({
			clientId: standard.clientId,
			clientSecret: standard.clientSecret,
			tokens: tokens.standard,
			consent: (requested) =>
				owner.untickGmail ? requested.filter((scope) => scope !== GMAIL_MODIFY) : requested,
		}),
		agent: await startFakeOAuth({
			clientId: agent.clientId,
			clientSecret: agent.clientSecret,
			tokens: tokens.agent,
			consent: (requested) => (owner.cancel ? "deny" : requested),
		}),
	};
	const fake = await startFakeGmail({
		tokens: either(tokens.standard, tokens.agent),
		email: OWNER,
		searchLagMs: scenario.searchLagMs ?? 25,
		...(scenario.gmail === "replaces"
			? { messageIdPolicy: "replace" as const, datePolicy: "replace" as const }
			: {}),
	});
	const logs: string[] = [];
	const session: Session = {
		envLive: { env },
		endpoints: { standard: oauth.standard.endpoints, agent: oauth.agent.endpoints },
		gmailRoot: fake.url,
		fetch: network(
			fake.url,
			scenario.concurrencyLimit,
			scenario.limited ?? (() => errorResponse(429, concurrent429)),
		),
		// Google's own error page for a client it refuses: nothing comes back to the loopback.
		openBrowser: async (url) => {
			const refused = scenario.agentRefused && url.startsWith(oauth.agent.endpoints.authorization);
			if (!refused) await fakeBrowser(url);
		},
		dir: dirs.session,
		evidenceDir: path.join(repo.dir, "spikes", "s08-gmail", "evidence"),
		repoDir: path.join(repo.dir, "spikes", "s08-gmail"),
		record: scenario.record,
		requireClean: scenario.requireClean ?? false,
		timing: FAST,
		...(scenario.bursts === undefined ? {} : { bursts: scenario.bursts }),
		sampleMs: 50,
		log: (line) => logs.push(line),
	};
	const world: Setup = {
		session,
		env,
		fake,
		oauth,
		dirs,
		repo,
		clients: [standard, agent],
		owner,
		logs,
		cliLog,
		close: async () => {
			await Promise.all([fake.close(), oauth.standard.close(), oauth.agent.close()]);
		},
	};
	writeInput(
		world,
		scenario.testAccount === undefined ? {} : { testAccount: scenario.testAccount },
	);
	return world;
}

// Everything that must never reach evidence: addresses, the account's name, credentials, tokens,
// Gmail ids, headers and text of every message the fake holds.
function sentinels(world: Setup): string[] {
	const found = new Set<string>([OWNER, SECOND, ACCOUNT_NAME, SEND_SUBJECT, SCHEDULED_SUBJECT]);
	for (const client of world.clients) found.add(client.clientId).add(client.clientSecret);
	for (const prefix of ["fake-access-", "fake-refresh-", "fake-code-"]) found.add(prefix);
	for (const message of world.fake.messages.values()) {
		found.add(message.id).add(message.threadId);
		const parsed = parseMessage(message.raw);
		const parts = [parsed, ...parsed.parts];
		for (const part of parts) {
			for (const header of part.headers) {
				if (
					/^(?:message-id|subject|from|to|cc|bcc|in-reply-to|references|date)$/i.test(header.name)
				) {
					found.add(header.value);
				}
			}
			for (const line of part.body.toString("utf8").split(/\r?\n/)) {
				if (line.trim().length >= 8) found.add(line.trim());
			}
		}
	}
	return [...found].filter((value) => value.length >= 6);
}

async function rehearse(scenario: Scenario): Promise<Rehearsal> {
	const world = await setup(scenario);
	const { session, fake, dirs, owner } = world;
	const lines: Partial<Record<Step, readonly string[]>> = {};
	const step = async (name: Step, change: Partial<Session> = {}): Promise<void> => {
		lines[name] = await runStep(name, { ...session, ...change });
	};
	try {
		if (scenario.agentRefused) {
			// The consent waits in vain, then the owner declares what Google's page said.
			await expect(step("agent", { timing: { ...FAST, consentTimeoutMs: 300 } })).rejects.toThrow(
				/the consent didn't finish \(timeout\): rerun agent\. If Google refused this client on its own page, record that with: s8 agent refused/,
			);
			await step("agent", { declared: "refused" });
		} else {
			await step("agent");
		}
		owner.untickGmail = true;
		await step("drop");
		owner.untickGmail = false;
		for (const name of ["connect", "send", "concurrency", "schedule"] as const) {
			await step(name);
		}
		// The owner writes the probe in Gmail's web UI, which saves a draft, then schedules it.
		const probe = await scheduledProbe("A scheduled probe for the rehearsal.");
		const draft = fake.insert(probe.raw, ["DRAFT"]);
		const shown =
			scenario.scheduled === "sent-and-scheduled" ? ["SENT", "SCHEDULED"] : ["SCHEDULED"];
		const schedule = (): void => fake.relabel(draft.id, shown, ["DRAFT"]);
		if (scenario.lateSchedule) setTimeout(schedule, 150);
		else schedule();
		await step("scheduled");
		// Gmail sends it at the scheduled time.
		if (scenario.scheduled === "new-id") {
			fake.relabel(draft.id, ["TRASH"], ["SCHEDULED"]);
			fake.insert(probe.raw, ["SENT"], { threadId: draft.threadId });
		} else {
			fake.relabel(draft.id, scenario.scheduled === "scheduled" ? ["SENT"] : [], ["SCHEDULED"]);
		}
		setWork(dirs.session, { sendAt: Date.now() });
		await step("sent");
		await step("revoke");
		const status: string[] = [];
		expect(cli(["status"], world.env, (line) => status.push(line))).toBe(0);
		writeInput(world, {
			observations: OBSERVATIONS,
			...(scenario.testAccount === undefined ? {} : { testAccount: scenario.testAccount }),
		});
		await step("report");
		const evidenceFile = path.join(
			scenario.record ? session.evidenceDir : path.join(dirs.session, "evidence"),
			"live.json",
		);
		return {
			lines,
			logs: world.logs,
			cliLog: world.cliLog,
			status,
			evidenceFile,
			evidence: readFileSync(evidenceFile, "utf8"),
			state: JSON.stringify(readState(dirs.session).steps),
			envLive: readFileSync(path.join(dirs.env, ".env.live"), "utf8"),
			repo: world.repo,
			session,
			downloads: world.clients.map((client) => client.file),
			sentinels: sentinels(world),
			calls: [...fake.calls],
			problems: [
				...fake.violations,
				...fake.unimplemented,
				...world.oauth.standard.problems,
				...world.oauth.agent.problems,
			],
		};
	} finally {
		await world.close();
	}
}

const ACCEPTANCE_KEYS = [
	"messageIdPreserved",
	"datePreserved",
	"inScheduled",
	"scopeDrop",
	"agentFlag",
	"publishingStatus",
	"homepage",
	"concurrent429",
	"mailSending429",
	"revoked",
];

const ASKED = [
	"access_type",
	"client_id",
	"code_challenge",
	"code_challenge_method",
	"redirect_uri",
	"response_type",
	"scope",
	"state",
];

function commonChecks(run: Rehearsal): Record<string, unknown> {
	expect(run.problems).toEqual([]);
	expect(run.calls.filter((call) => call === "gmail.users.messages.send")).toHaveLength(2);
	expect(run.downloads.filter((file) => existsSync(file))).toEqual([]);
	expect(run.cliLog).toHaveLength(2);
	expect(run.envLive).not.toMatch(/DY_LIVE_GMAIL_/);
	for (const value of run.sentinels) {
		expect(run.evidence.includes(value), `evidence holds "${value}"`).toBe(false);
		expect(run.state.includes(value), `state.json's results hold "${value}"`).toBe(false);
	}
	const document = JSON.parse(run.evidence) as { data: Record<string, unknown> };
	expect(Object.keys(document)).toEqual(["recordedAt", "fingerprint", "data"]);
	expect(Object.keys(document.data)).toEqual([
		"item",
		"discovery",
		"acceptance",
		"extra",
		"steps",
		"results",
		"observations",
	]);
	expect(Object.keys(document.data.acceptance as object)).toEqual(ACCEPTANCE_KEYS);
	expect(run.evidence).toMatch(/"hmac:[\w-]{22}"/);
	const results = document.data.results as Record<string, { discovery?: { problems: unknown[] } }>;
	for (const result of Object.values(results)) expect(result.discovery?.problems ?? []).toEqual([]);
	return document.data;
}

const ALL_ENDED =
	"  grants: agent ended (invalid_grant); drop ended (invalid_grant); standard ended (invalid_grant)";

const SMALL_BURSTS: readonly Burst[] = [
	{ call: "getProfile", parallel: 4 },
	{ call: "getProfile", parallel: 8 },
	{ call: "messages.list", parallel: 6 },
];

describe("the S8b session rehearsed against FakeGmail and fake Google OAuth", () => {
	it("keeps Gmail's answers: the acceptance lines, content-free evidence, vendor-guard clean", {
		timeout: 120_000,
	}, async () => {
		const run = await rehearse({
			gmail: "keeps",
			scheduled: "scheduled",
			concurrencyLimit: 5,
			bursts: SMALL_BURSTS,
			record: true,
			testAccount: OWNER,
		});
		expect(run.lines.report?.slice(0, 10)).toEqual([
			"messageId preserved: yes",
			"date preserved: yes",
			"in:scheduled: works",
			"scope drop: refused (scope_missing: gmail.modify), grant revoked by connect (refresh: invalid_grant)",
			"agent flag: wording recorded (with, without)",
			"publishing status: Testing (refresh 7d)",
			"homepage: accepted",
			'429 concurrent: 429 RESOURCE_EXHAUSTED rateLimitExceeded (usageLimits) "Too many concurrent requests for user" -> retry(concurrent) at 8 parallel getProfile',
			"429 mail sending: documented only (not provoked)",
			"revoked: yes",
		]);
		expect(run.lines.report?.at(-1)).toMatch(/^evidence: .*live\.json$/);
		expect(run.lines.agent?.[0]).toBe(
			"agent client: Gmail API works; grant revoked (refresh: invalid_grant)",
		);
		expect(run.status).toContain(ALL_ENDED);
		const data = commonChecks(run);
		const results = data.results as Record<string, Record<string, unknown>>;
		expect(results.concurrency).toMatchObject({
			bursts: [
				{ call: "getProfile", parallel: 4, statuses: { 200: 4 } },
				{ call: "getProfile", parallel: 8, statuses: { 200: 5, 429: 3 } },
			],
			maxParallel: 8,
			boundParallel: 8,
		});
		expect(results.send).toMatchObject({
			sends: 2,
			probe: { messageId: "yes", date: "yes", readBack: true },
			bcc: { sentCopyHasBcc: true, otherCopies: 0 },
			reply: { threadKept: true, sameThread: true },
			threadsGetMinimal: { messages: 2, internalDate: true },
			reconcile: {
				byMessageId: { status: "sent", via: "rfc822msgid", matchesSent: true },
				fallback: { status: "sent", via: "fallback", matchesSent: true },
			},
		});
		expect(results.scheduled).toMatchObject({
			found: { viaHistory: true, viaInScheduled: true, viaLabelFilter: true },
			firstSeen: { messages: [{ labels: ["SCHEDULED"] }] },
			listedAfterMs: { cutShort: false },
			messages: [{ labels: ["SCHEDULED"], inSent: false, countsAsSent: false }],
			countedAsSent: false,
		});
		expect(results.sent).toMatchObject({ sameId: true, labels: ["SENT"], sentIn: true });
		// input.json's testAccount goes to Google as login_hint.
		const asked = [...ASKED, "login_hint"].toSorted();
		expect(results.connect).toMatchObject({ consent: { asked, refreshIssued: true } });
		expect(results.agent).toMatchObject({
			consent: { asked, gmailApi: "works" },
			fullGrant: { revokes: 1, accepted: true, refreshAfter: "invalid_grant" },
		});
		expect(results.drop).toMatchObject({
			client: "standard",
			asked,
			missing: ["gmail.modify"],
			revokedByConnect: true,
			revocation: { revokes: 0, refreshAfter: "invalid_grant" },
			finalRefresh: "invalid_grant",
		});
		expect(run.logs.some((line) => line.startsWith("Before Google's consent"))).toBe(true);

		// The same file where a commit would put it: vendor-guard's evidence rules pass it.
		const clean = guard(run.repo.dir);
		expect(clean).toEqual({ code: 0, findings: [] });
		// And they do apply there: an address in a second evidence file is caught.
		const leak = path.join(path.dirname(run.evidenceFile), "leak.json");
		writeFileSync(leak, `${JSON.stringify({ data: { to: SECOND } }, null, 2)}\n`);
		const caught = guard(run.repo.dir);
		expect(caught.code).toBe(1);
		expect(caught.findings).toEqual([
			expect.objectContaining({
				file: "spikes/s08-gmail/evidence/leak.json",
				rule: "evidence-email",
			}),
		]);
	});

	it("reports Gmail replacing the Message-ID and Date, SENT+SCHEDULED mail and no 429, and records only from a clean checkout", {
		timeout: 120_000,
	}, async () => {
		const run = await rehearse({
			gmail: "replaces",
			scheduled: "sent-and-scheduled",
			concurrencyLimit: Number.POSITIVE_INFINITY,
			record: true,
			requireClean: true,
		});
		expect(run.lines.report?.slice(0, 3)).toEqual([
			"messageId preserved: no",
			"date preserved: no",
			"in:scheduled: works",
		]);
		expect(run.lines.report?.[7]).toBe(
			"429 concurrent: not provoked (225 bounded parallel reads, at most 100 at once)",
		);
		expect(run.status).toContain(ALL_ENDED);
		const data = commonChecks(run);
		const results = data.results as Record<string, Record<string, unknown>>;
		expect(results.send).toMatchObject({
			probe: { messageId: "no", date: "no" },
			indexDelayMs: { messageIdSearched: "gmail's" },
			reconcile: {
				byMessageId: { status: "sent", via: "fallback", matchesSent: true },
				fallback: { status: "sent", via: "fallback", matchesSent: true },
			},
		});
		expect(results.scheduled).toMatchObject({
			messages: [{ labels: ["SCHEDULED", "SENT"], inSent: true, countsAsSent: false }],
			countedAsSent: false,
		});
		expect(results.sent).toMatchObject({ sameId: true, labels: ["SENT"], sentIn: true });
		expect(guard(run.repo.dir)).toEqual({ code: 0, findings: [] });

		// Recorded from a clean checkout at the commit every step ran on; then neither a tracked
		// change outside s08's evidence/ nor steps that ran on another commit record.
		expect(run.lines.report?.at(-1)).toBe(`evidence: ${path.resolve(run.evidenceFile)}`);
		const report = async (): Promise<string | undefined> =>
			(await runStep("report", run.session)).at(-1);
		run.repo.write("README.md", "Changed.\n");
		expect(await report()).toMatch(
			/^evidence not recorded \(the checkout has tracked changes or no commit\); preview: /,
		);
		run.repo.commit("change");
		expect(await report()).toMatch(
			/^evidence not recorded \(these steps ran on other code: agent, drop, connect, send, concurrency, schedule, scheduled, sent, revoke\); preview: /,
		);
	});

	it("follows a scheduled mail that Gmail sends as a new message, and previews unless recording", {
		timeout: 120_000,
	}, async () => {
		const run = await rehearse({
			gmail: "keeps",
			scheduled: "new-id",
			concurrencyLimit: 8,
			// Gmail may answer a burst with a 403 rate limit instead of a 429.
			limited: () => errorResponse(403, userRateLimit403),
			bursts: [
				{ call: "getProfile", parallel: 3 },
				{ call: "getProfile", parallel: 6 },
				{ call: "getProfile", parallel: 12 },
				{ call: "getProfile", parallel: 24 },
			],
			record: false,
			lateSchedule: true,
			agentRefused: true,
		});
		expect(run.lines.report?.at(-1)).toMatch(
			/^evidence not recorded \(DRAFTYAK_RECORD_EVIDENCE isn't 1\); preview: .*live\.json$/,
		);
		expect(existsSync(path.join(run.repo.dir, "spikes", "s08-gmail", "evidence"))).toBe(false);
		const data = commonChecks(run);
		const results = data.results as Record<string, Record<string, unknown>>;
		expect(run.lines.agent).toEqual([
			"agent client: Google refused the consent on its own page (declared)",
			"Record that page's wording under observations.consent.agent.",
		]);
		expect(results.agent).toMatchObject({
			consent: { asked: ASKED, error: "refused-on-page", redirected: false, declared: true },
			fullGrant: null,
		});
		expect(run.status).toContain(
			"  grants: agent none (no grant made); drop ended (invalid_grant); standard ended (invalid_grant)",
		);
		expect(results.drop).toMatchObject({ client: "standard", finalRefresh: "invalid_grant" });
		expect(run.lines.report?.[3]).toBe(
			"scope drop: refused (scope_missing: gmail.modify), grant revoked by connect (refresh: invalid_grant)",
		);
		expect(run.lines.report?.[7]).toBe(
			'429 concurrent: 403 PERMISSION_DENIED userRateLimitExceeded (usageLimits) "User Rate Limit Exceeded" -> retry(rate_limit) at 12 parallel getProfile',
		);
		expect(run.lines.report?.[9]).toBe("revoked: yes");
		expect(results.concurrency).toMatchObject({
			firstLimit: { status: 403, at: { parallel: 12 } },
			maxParallel: 12,
			boundParallel: 24,
			recovered: true,
		});
		// The step waited past the draft for the scheduled mail.
		expect(results.scheduled).toMatchObject({
			messages: [{ labels: ["SCHEDULED"], inScheduled: true }],
		});
		expect(results.sent).toMatchObject({ sameId: false, labels: ["SENT"], sentIn: true });
	});

	it("takes Gmail's concurrency limit only from a 429 or a 403 rate limit, and stops when a request fails without Gmail's answer", {
		timeout: 60_000,
	}, async () => {
		const world = await setup({
			gmail: "keeps",
			scheduled: "scheduled",
			concurrencyLimit: Number.POSITIVE_INFINITY,
			bursts: SMALL_BURSTS,
			record: false,
		});
		try {
			const { session } = world;
			const dir = world.dirs.session;
			await runStep("connect", session);
			// Gmail allows 5 requests at once and gives `limited()` beyond them. `nth` answers the step's
			// n-th Gmail request itself: 0 is its first getProfile, 1–4 the first burst, 5–12 the second.
			const concurrency = (
				limited: () => Response,
				nth?: { readonly n: number; readonly answer: () => Response },
			): Promise<readonly string[]> => {
				const gmail = network(world.fake.url, 5, limited);
				let seen = 0;
				return runStep("concurrency", {
					...session,
					fetch: async (input, init) =>
						nth !== undefined && urlOf(input).startsWith(world.fake.url) && seen++ === nth.n
							? nth.answer()
							: gmail(input, init),
				});
			};
			const bursts = (): unknown => readState(dir).steps.concurrency?.data.bursts;
			const tooMany = (): Response => errorResponse(429, concurrent429);
			const requestTimeout = (): Response => new Response(null, { status: 408 });

			for (const [status, body, shape] of [
				[
					429,
					concurrent429,
					'429 RESOURCE_EXHAUSTED rateLimitExceeded (usageLimits) "Too many concurrent requests for user" -> retry(concurrent)',
				],
				[
					403,
					rateLimit403,
					'403 PERMISSION_DENIED rateLimitExceeded (usageLimits) "Rate Limit Exceeded" -> retry(rate_limit)',
				],
				[
					403,
					userRateLimit403,
					'403 PERMISSION_DENIED userRateLimitExceeded (usageLimits) "User Rate Limit Exceeded" -> retry(rate_limit)',
				],
			] as const) {
				expect(await concurrency(() => errorResponse(status, body))).toEqual([
					`429 concurrent: ${shape} at 8 parallel getProfile`,
				]);
			}

			// Any other answer isn't the limit: the bursts go on.
			for (const limited of [
				() => errorResponse(403, dailyLimit403),
				() => errorResponse(403, domainPolicy403),
				requestTimeout,
			]) {
				expect(await concurrency(limited)).toEqual([
					"429 concurrent: not provoked (18 bounded parallel reads, at most 8 at once)",
				]);
			}
			expect(bursts()).toEqual([
				{ call: "getProfile", parallel: 4, statuses: { 200: 4 } },
				{ call: "getProfile", parallel: 8, statuses: { 200: 5, 408: 3 } },
				{ call: "messages.list", parallel: 6, statuses: { 200: 5, 408: 1 } },
			]);
			expect(await concurrency(tooMany, { n: 2, answer: requestTimeout })).toEqual([
				'429 concurrent: 429 RESOURCE_EXHAUSTED rateLimitExceeded (usageLimits) "Too many concurrent requests for user" -> retry(concurrent) at 8 parallel getProfile',
			]);
			expect(bursts()).toEqual([
				{ call: "getProfile", parallel: 4, statuses: { 200: 3, 408: 1 } },
				{ call: "getProfile", parallel: 8, statuses: { 200: 5, 429: 3 } },
			]);

			// A request that failed without Gmail's answer (a DNS failure, a timeout, a failed token
			// refresh) stops the step, even beside Gmail's 429s, and the earlier result stands.
			const kept = readState(dir).steps.concurrency;
			const notFound = (): Response => {
				const lookup = new Error("getaddrinfo ENOTFOUND gmail.googleapis.com");
				throw new TypeError("fetch failed", {
					cause: Object.assign(lookup, { code: "ENOTFOUND" }),
				});
			};
			await expect(concurrency(tooMany, { n: 5, answer: notFound })).rejects.toThrow(
				/^1 of 8 parallel getProfile requests failed without an answer from Gmail \(not_written\): not Gmail's limit, so nothing was recorded; rerun concurrency$/,
			);
			const timeoutError = (): Response => {
				throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
			};
			await expect(concurrency(tooMany, { n: 1, answer: timeoutError })).rejects.toThrow(
				/^1 of 4 parallel getProfile requests failed without an answer from Gmail \(timeout\): /,
			);
			// The first access token lasts a minute, so the first burst refreshes it, and that refresh
			// fails: none of the burst's requests went out.
			const base = network(world.fake.url, 5, tooMany);
			let refreshes = 0;
			await expect(
				runStep("concurrency", {
					...session,
					fetch: async (input, init) => {
						if (urlOf(input) !== world.oauth.standard.endpoints.token) return base(input, init);
						if (refreshes++ > 0) return json(400, { error: "invalid_grant" });
						const answer = (await (await base(input, init)).json()) as Record<string, unknown>;
						return json(200, { ...answer, expires_in: 60 });
					},
				}),
			).rejects.toThrow(
				/^4 of 4 parallel getProfile requests failed without an answer from Gmail \(token refresh: invalid_grant\): not Gmail's limit, so nothing was recorded; rerun concurrency$/,
			);
			expect(readState(dir).steps.concurrency).toEqual(kept);
			expect(world.fake.violations).toEqual([]);
		} finally {
			await world.close();
		}
	});

	it("records a scheduled mail that Gmail shows only as a draft", { timeout: 60_000 }, async () => {
		const world = await setup({
			gmail: "keeps",
			scheduled: "scheduled",
			concurrencyLimit: Number.POSITIVE_INFINITY,
			record: false,
		});
		try {
			const session = {
				...world.session,
				timing: { ...FAST, findTimeoutMs: 200, indexTimeoutMs: 200 },
			};
			await runStep("connect", session);
			await runStep("schedule", session);
			world.fake.insert((await scheduledProbe("Only ever a draft.")).raw, ["DRAFT"]);
			expect(await runStep("scheduled", session)).toContain("in:scheduled: fails");
			const result = readState(world.dirs.session).steps.scheduled?.data;
			expect(result).toMatchObject({
				inScheduled: "fails",
				firstSeen: { messages: [{ labels: ["DRAFT"] }] },
				messages: [{ labels: ["DRAFT"], inDrafts: true, inScheduled: false, countsAsSent: false }],
			});
		} finally {
			await world.close();
		}
	});

	it("stops the scheduled step when the mail went out before or while it reads", {
		timeout: 60_000,
	}, async () => {
		const world = await setup({
			gmail: "keeps",
			scheduled: "scheduled",
			concurrencyLimit: Number.POSITIVE_INFINITY,
			record: false,
			// in:scheduled lags past the index delay, so the step reads until it goes out.
			searchLagMs: 5_000,
		});
		try {
			const { session } = world;
			const dir = world.dirs.session;
			await runStep("connect", session);
			await runStep("schedule", session);
			const early = world.fake.insert((await scheduledProbe("Out already.")).raw, ["SENT"]);
			await expect(runStep("scheduled", session)).rejects.toThrow(
				/^the scheduled mail already went out: rerun schedule/,
			);
			// Rerun: the mail that went out before this schedule step is an earlier attempt's.
			await runStep("schedule", session);
			world.fake.relabel(early.id, ["IMPORTANT"], []);
			const probe = world.fake.insert((await scheduledProbe("Out mid-step.")).raw, ["SCHEDULED"]);
			// Gmail sends it once the step's second look has started.
			const looks = (): number => world.fake.searches.filter((q) => q === "in:scheduled").length;
			const before = looks();
			const timer = setInterval(() => {
				if (looks() < before + 2) return;
				clearInterval(timer);
				world.fake.relabel(probe.id, ["SENT"], ["SCHEDULED"]);
			}, 5);
			await expect(runStep("scheduled", session)).rejects.toThrow(
				/^the scheduled mail went out while the step read it: rerun schedule/,
			);
			clearInterval(timer);
			// Or once the step has stopped polling, while it reads in:sent and in:drafts.
			await runStep("schedule", session);
			const last = world.fake.insert((await scheduledProbe("Out at the end.")).raw, ["SCHEDULED"]);
			const sendsOnInSent: Session = {
				...session,
				fetch: async (input, init) => {
					const q = new URL(urlOf(input)).searchParams.get("q") ?? "";
					if (q.startsWith("in:sent after:")) world.fake.relabel(last.id, ["SENT"], ["SCHEDULED"]);
					return session.fetch(input, init);
				},
			};
			await expect(runStep("scheduled", sendsOnInSent)).rejects.toThrow(
				/^the scheduled mail went out while the step read it: rerun schedule/,
			);
			const { steps, work } = readState(dir);
			expect(steps.scheduled).toBeUndefined();
			expect(work.scheduledHistory).toBeUndefined();
			expect(world.fake.violations).toEqual([]);
		} finally {
			await world.close();
		}
	});

	it("reads the scheduled mail only until a minute before its send time", {
		timeout: 60_000,
	}, async () => {
		const world = await setup({
			gmail: "keeps",
			scheduled: "scheduled",
			concurrencyLimit: Number.POSITIVE_INFINITY,
			record: false,
			searchLagMs: 10_000,
		});
		try {
			const { session } = world;
			const dir = world.dirs.session;
			await runStep("connect", session);
			const before = Date.now();
			const schedule = await runStep("schedule", session);
			const { sendAt } = readState(dir).work;
			expect((sendAt ?? 0) % 60_000).toBe(0);
			expect(sendAt).toBeGreaterThanOrEqual(before + FAST.scheduleLeadMs);
			expect(schedule[1]).toMatch(/pick .* \(in about [12] minutes\), and Schedule send\.$/);

			setWork(dir, { sendAt: Date.now() + 500 });
			await expect(runStep("scheduled", session)).rejects.toThrow(/too close to the send time/);

			// Reading stops 3 s before the send time, a second from now, well inside the index delay.
			world.fake.insert((await scheduledProbe("Listed late.")).raw, ["SCHEDULED"]);
			const bounded = {
				...session,
				timing: { ...FAST, indexTimeoutMs: 20_000, sendMarginMs: 3_000 },
			};
			setWork(dir, { sendAt: Date.now() + 4_000 });
			const lines = await runStep("scheduled", bounded);
			expect(lines[0]).toMatch(
				/^in:scheduled: fails \(not listed in \d+\.\d s: stopped before the send time\)$/,
			);
			const result = readState(dir).steps.scheduled?.data;
			expect(result).toMatchObject({
				inScheduled: "fails",
				listedAfterMs: { inScheduled: null, labelFilter: 0, cutShort: true },
			});
			expect(result?.finishedBeforeSendMs).toBeGreaterThan(0);

			setWork(dir, { sendAt: Date.now() + 30_000 });
			await expect(runStep("sent", session)).rejects.toThrow(
				/^the scheduled mail goes out .*: run the sent step after that$/,
			);
			setWork(dir, { sendAt: Date.now() - 1_000, scheduledHistoryAt: Date.now() });
			await expect(runStep("sent", session)).rejects.toThrow(
				/took its history start after the send time/,
			);
		} finally {
			await world.close();
		}
	});

	it("waits for a revocation to take effect, and stops while a grant still refreshes", {
		timeout: 60_000,
	}, async () => {
		const world = await setup({
			gmail: "keeps",
			scheduled: "scheduled",
			concurrencyLimit: Number.POSITIVE_INFINITY,
			record: false,
		});
		try {
			const { session } = world;
			const dir = world.dirs.session;
			// A second per check, so that three late refreshes fit in one on a busy machine.
			const late = (lags: readonly number[]): Session => ({
				...session,
				timing: { ...FAST, revokeTimeoutMs: 1_000 },
				fetch: lateRevocation(session.fetch, lags),
			});
			expect(await runStep("agent", late([3]))).toContain(
				"agent client: Gmail API works; grant revoked (refresh: invalid_grant)",
			);
			expect(readState(dir).steps.agent?.data).toMatchObject({
				fullGrant: { revokes: 1, refreshes: 4, refreshAfter: "invalid_grant" },
			});
			const forever = Number.POSITIVE_INFINITY;
			await expect(runStep("agent", late([forever, forever]))).rejects.toThrow(
				/^the agent client's grant still refreshes \(ok\) after 2 revocations: rerun agent/,
			);
			// The earlier result stands.
			expect(readState(dir).steps.agent?.data).toMatchObject({ fullGrant: { refreshes: 4 } });

			// connect()'s revoke doesn't take; the step's second one does.
			world.owner.untickGmail = true;
			expect(await runStep("drop", late([forever, 0]))).toEqual([
				"scope drop: refused (scope_missing: gmail.modify), grant revoked by connect, then again by the step (refresh: invalid_grant)",
			]);
			expect(readState(dir).steps.drop?.data).toMatchObject({
				revokedByConnect: true,
				revocation: { revokes: 1, refreshAfter: "invalid_grant" },
			});
		} finally {
			await world.close();
		}
	});

	it("tells the owner's Cancel, a token-endpoint failure and Google's refusal apart", {
		timeout: 60_000,
	}, async () => {
		const world = await setup({
			gmail: "keeps",
			scheduled: "scheduled",
			concurrencyLimit: Number.POSITIVE_INFINITY,
			record: false,
		});
		try {
			const { session } = world;
			const dir = world.dirs.session;
			world.owner.cancel = true;
			await expect(runStep("agent", session)).rejects.toThrow(
				/^the consent didn't finish \(access_denied\): rerun agent/,
			);
			world.owner.cancel = false;
			const tokenDown: typeof fetch = async (input, init) =>
				urlOf(input) === world.oauth.agent.endpoints.token &&
				formOf(init).get("grant_type") === "authorization_code"
					? json(503, {})
					: session.fetch(input, init);
			await expect(runStep("agent", { ...session, fetch: tokenDown })).rejects.toThrow(
				/^the token request failed \(http_503\): rerun agent$/,
			);
			const silent = {
				...session,
				openBrowser: async () => {},
				timing: { ...FAST, consentTimeoutMs: 200 },
			};
			await expect(runStep("agent", silent)).rejects.toThrow(/didn't finish \(timeout\)/);
			expect(readState(dir).steps.agent).toBeUndefined();

			// Google's own error code on its redirect is the finding.
			const refusing = async (url: string): Promise<void> => {
				const asked = new URL(url).searchParams;
				const back = new URL(asked.get("redirect_uri") ?? "");
				back.searchParams.set("error", "admin_policy_enforced");
				back.searchParams.set("state", asked.get("state") ?? "");
				await (await fetch(back)).text();
			};
			expect(await runStep("agent", { ...session, openBrowser: refusing })).toEqual([
				"agent client: Google refused the consent (admin_policy_enforced)",
				"Record that page's wording under observations.consent.agent.",
			]);
			expect(readState(dir).steps.agent?.data).toMatchObject({
				consent: { error: "admin_policy_enforced", redirected: true, declared: false },
				fullGrant: null,
			});

			// A declaration belongs to its own step; the drop step's no-checkbox page.
			await expect(runStep("connect", { ...session, declared: "refused" })).rejects.toThrow(
				/DRAFTYAK_S8_OUTCOME=refused is for the agent step only/,
			);
			expect(await runStep("drop", { ...session, declared: "no-checkbox" })).toEqual([
				"scope drop: not possible at consent (the page offered no Gmail checkbox) (declared)",
			]);
			expect(readState(dir).steps.drop?.data).toMatchObject({
				result: "not possible at consent",
				declared: true,
				finalRefresh: "no-grant",
			});
			// A drop consent that kept Gmail is ended, never recorded.
			await expect(runStep("drop", session)).rejects.toThrow(
				/^the consent kept gmail\.modify: rerun drop and untick the Gmail permission\. If the page offered no Gmail checkbox, record that with: s8 drop no-checkbox$/,
			);
			expect(world.oauth.standard.revocations).toHaveLength(1);
			expect(readState(dir).steps.drop?.data).toMatchObject({ declared: true });

			// A grant from another account than input.json's testAccount is ended, never kept.
			writeInput(world, { testAccount: "someone.else@example.com" });
			await expect(runStep("connect", session)).rejects.toThrow(
				/another account than input\.json's testAccount/,
			);
			expect(world.oauth.standard.revocations).toHaveLength(2);
			expect(readFileSync(path.join(world.dirs.env, ".env.live"), "utf8")).not.toMatch(
				/DY_LIVE_GMAIL_REFRESH_TOKEN/,
			);
		} finally {
			await world.close();
		}
	});

	it("sends within the session's limit, never to the test account itself, and reads each send back", {
		timeout: 60_000,
	}, async () => {
		const world = await setup({
			gmail: "keeps",
			scheduled: "scheduled",
			concurrencyLimit: Number.POSITIVE_INFINITY,
			record: false,
		});
		try {
			const { session } = world;
			const dir = world.dirs.session;
			await runStep("connect", session);
			const sends = () =>
				world.fake.calls.filter((call) => call === "gmail.users.messages.send").length;
			// Gmail delivers a +tag to the same mailbox.
			writeInput(world, { secondAddress: "Owner+probe@Example.com" });
			await expect(runStep("send", session)).rejects.toThrow(/the test account itself/);
			expect(sends()).toBe(0);
			writeInput(world);

			// The probe's read-back fails twice, then answers: one send, never a resend.
			const readBacks = (failures: number): Session => {
				let left = failures;
				return {
					...session,
					fetch: async (input, init) => {
						if (left > 0 && /metadataHeaders=Message-ID/.test(urlOf(input))) {
							left--;
							return errorResponse(503, { error: { code: 503, status: "UNAVAILABLE" } });
						}
						return session.fetch(input, init);
					},
				};
			};
			await runStep("send", readBacks(2));
			expect(sends()).toBe(2);
			expect(readState(dir).steps.send?.data).toMatchObject({
				sends: 2,
				probe: { readBack: true, messageId: "yes", date: "yes" },
			});
			await expect(runStep("send", readBacks(10))).rejects.toThrow(
				/^Gmail accepted the send, but reading it back failed 4 times: rerun send/,
			);
			expect(sends()).toBe(3);

			setWork(dir, { sends: MAX_SENDS });
			await expect(runStep("send", session)).rejects.toThrow(/has sent 8 messages/);
			expect(sends()).toBe(3);
			await expect(runStep("report", session)).rejects.toThrow(
				/run these steps first: agent, drop, concurrency, schedule, scheduled, sent, revoke/,
			);

			// A revocation that never takes effect deletes nothing; once it does, revoke goes on.
			const forever = Number.POSITIVE_INFINITY;
			const stuck = { ...session, fetch: lateRevocation(session.fetch, [forever, forever]) };
			await expect(runStep("revoke", stuck)).rejects.toThrow(
				/^the standard grant still refreshes \(ok\) after 2 revocations, so no entry was deleted: rerun revoke/,
			);
			const envLive = path.join(world.dirs.env, ".env.live");
			expect(readFileSync(envLive, "utf8")).toMatch(/DY_LIVE_GMAIL_REFRESH_TOKEN=/);
			expect(await runStep("revoke", session)).toEqual([
				"standard grant: revoke refused; refresh afterwards: invalid_grant",
				".env.live: deleted DY_LIVE_GMAIL_CLIENT_ID, DY_LIVE_GMAIL_CLIENT_SECRET, DY_LIVE_GMAIL_REFRESH_TOKEN, DY_LIVE_GMAIL_AGENT_CLIENT_ID, DY_LIVE_GMAIL_AGENT_CLIENT_SECRET; left: none",
				"Owner: delete both spike clients in the Cloud project, then record clientsDeleted: true.",
			]);
		} finally {
			await world.close();
		}
	});
});
