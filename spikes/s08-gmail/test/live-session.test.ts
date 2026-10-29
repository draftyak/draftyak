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
import { registerSecret } from "@draftyak/spike-kit";
import { afterAll, describe, expect, it } from "vitest";
import { authorizationUrl, GOOGLE, scopesFor } from "../src/oauth.ts";
import { main as cli } from "./live-cli.ts";
import {
	acceptanceLines,
	buildReport,
	grantStatus,
	missingSteps,
	type Observations,
	parseObservations,
} from "./live-report.ts";
import {
	accountName,
	credentialsProblem,
	dateAnswer,
	declaredFromEnv,
	gmailFetch,
	type Limited,
	limitedLine,
	liveSession,
	messageIdAnswer,
	newTraffic,
	nextClockTime,
	readClientFile,
	readInput,
	readState,
	recording,
	recordProblems,
	type Session,
	type State,
	sameMailbox,
	sanitizeProblem,
	saveStep,
	secondAddress,
	sessionDir,
	shortScopes,
	stepFromEnv,
	systemLabels,
	testAccount,
	tokenShape,
} from "./live-session.ts";

const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "draftyak-s8-live-")));
let folders = 0;
const folder = (): string => {
	const dir = path.join(base, String(++folders));
	mkdirSync(dir, { recursive: true });
	return dir;
};
afterAll(() => rmSync(base, { recursive: true, force: true }));

function session(env: NodeJS.ProcessEnv = {}): Session {
	const dir = folder();
	const all = { ...process.env, DRAFTYAK_S8_SESSION: dir, ...env };
	return { ...liveSession(all, () => {}), envLive: { env: all } };
}

const consent = {
	wording: ["DraftYak S8 spike wants to access your Google Account", "<account>"],
	screens: ["disclosure", "consent"],
	scopeCheckboxes: true,
};
const valid = {
	consent: { agent: consent, standard: consent },
	bccInToCopy: "absent",
	publishing: {
		atConsent: "testing",
		withoutHomepage: "blocked",
		homepage: "accepted",
		final: "production",
	},
	readings: {
		R1: { verdict: "consistent" },
		R2: { verdict: "unclear", note: "no Google API reads the feed" },
		R3: { verdict: "consistent" },
		R4: { verdict: "inconsistent" },
		R5: { verdict: "unclear" },
	},
	policyPages: "unchanged",
	clientsDeleted: true,
};

describe("the owner's observations", () => {
	it("accepts a complete record and keeps it as given", () => {
		expect(parseObservations(valid)).toEqual(valid);
	});

	it("names every problem by its JSON path, never by its value", () => {
		const bad = {
			...valid,
			bccInToCopy: "maybe",
			publishing: { ...valid.publishing, final: "live" },
			readings: { ...valid.readings, R3: { verdict: "fine" } },
			consent: {
				agent: { ...consent, wording: ["Choose an account: someone@example.org"] },
				standard: { ...consent, screens: ["Consent Screen"] },
			},
		};
		const error = (() => {
			try {
				parseObservations(bad);
			} catch (caught) {
				return String(caught);
			}
			return "";
		})();
		for (const at of [
			"observations.bccInToCopy",
			"observations.publishing.final",
			"observations.readings.R3.verdict",
			"observations.consent.agent.wording[0]",
			"observations.consent.standard.screens[0]",
		]) {
			expect(error).toContain(at);
		}
		expect(error).not.toContain("someone@example.org");
		expect(error).not.toContain("maybe");
	});

	it("refuses addresses, long digit runs, template placeholders and line breaks in text", () => {
		for (const line of [
			"you are signed in as owner@example.org",
			"account 1234567",
			"<the page's first line>",
			"two\nlines",
		]) {
			const record = {
				...valid,
				consent: { ...valid.consent, agent: { ...consent, wording: [line] } },
			};
			expect(() => parseObservations(record), line).toThrow(
				/observations\.consent\.agent\.wording\[0\]/,
			);
		}
	});

	it("needs the owner's reason for an unchecked homepage, and a note for changed pages", () => {
		const unchecked = { ...valid, publishing: { ...valid.publishing, homepage: "not checked" } };
		expect(() => parseObservations(unchecked)).toThrow(/homepageReason: the owner's reason/);
		const reason = { ...unchecked.publishing, homepageReason: "the site isn't verified yet" };
		expect(parseObservations({ ...unchecked, publishing: reason }).publishing.homepageReason).toBe(
			"the site isn't verified yet",
		);
		expect(() => parseObservations({ ...valid, policyPages: "changed" })).toThrow(/policyNote/);
	});

	it("refuses unknown and missing fields", () => {
		const { clientsDeleted: _, ...missing } = valid;
		expect(() => parseObservations(missing)).toThrow(/observations\.clientsDeleted: missing/);
		expect(() => parseObservations({ ...valid, mood: "good" })).toThrow(
			/observations\.mood: unknown field/,
		);
		expect(() => parseObservations(undefined)).toThrow(/observations: expected an object/);
	});

	it("refuses the account's name and invisible format characters", () => {
		const names = ["Ann Example"];
		const wording = (line: string) => ({
			...valid,
			consent: { ...valid.consent, standard: { ...consent, wording: [line] } },
		});
		for (const line of [
			"Signed in as ann example",
			"Hi Ann",
			"Choose Example's account",
			"DraftYak​ S8 spike",
			"‮right to left",
		]) {
			expect(() => parseObservations(wording(line), names), line).toThrow(
				/observations\.consent\.standard\.wording\[0\]/,
			);
		}
		// A word that merely contains a part of the name passes.
		const kept = parseObservations(wording("Announcements from <account>"), names);
		expect(kept.consent.standard.wording).toEqual(["Announcements from <account>"]);
		let error = "";
		try {
			parseObservations(wording("Hi Ann"), names);
		} catch (caught) {
			error = String(caught);
		}
		expect(error).toContain("no names: write <account>");
		expect(error).not.toContain("Ann");
	});

	it("exempts only the five exact boilerplate components while always refusing the full name", () => {
		const wording = (line: string) => ({
			...valid,
			consent: { ...valid.consent, standard: { ...consent, wording: [line] } },
		});
		for (const word of ["Google", "Gmail", "Account", "DraftYak", "Spike"]) {
			expect(
				parseObservations(wording(`Your ${word} permissions for <account>`), [
					`${word.toUpperCase()} Morgan`,
				]),
			).toBeDefined();
		}
		for (const [name, line] of [
			["Google Morgan", "Hi Morgan"],
			["Google Morgan", "Hi google morgan"],
			["Google Account", "Your GOOGLE ACCOUNT"],
			["Googlex Morgan", "Hi Googlex"],
			["Gmaıl Morgan", "Hi Gmaıl"],
		]) {
			let error = "";
			try {
				parseObservations(wording(line ?? ""), [name ?? ""]);
			} catch (caught) {
				error = String(caught);
			}
			expect(error).toContain("observations.consent.standard.wording[0]: no names");
			expect(error).not.toContain(line);
		}
		expect(() =>
			parseObservations(wording("Morganite from <account>"), ["Google Morgan"]),
		).not.toThrow();
	});
});

function state(change: Partial<Record<string, Record<string, unknown>>> = {}): State {
	const record = (data: Record<string, unknown>) => ({
		at: "2026-10-22T15:00:00.000Z",
		commit: "a".repeat(40),
		dirty: false,
		data,
	});
	const results: Record<string, Record<string, unknown>> = {
		agent: { consent: {}, fullGrant: { refreshAfter: "invalid_grant" } },
		drop: { behaviour: "refused (scope_missing: gmail.modify)", finalRefresh: "invalid_grant" },
		connect: {},
		send: {
			probe: { messageId: "yes", date: "no" },
			bcc: { sentCopyHasBcc: true, otherCopies: 0 },
			indexDelayMs: { rfc822msgid: 1500, inSent: null },
			threadsGetMinimal: { internalDate: true },
			reconcile: {
				byMessageId: { status: "sent", via: "rfc822msgid", matchesSent: true },
				fallback: { status: "not_found", scanned: 3, complete: true },
			},
		},
		concurrency: { line: "not provoked (225 bounded parallel reads, at most 100 at once)" },
		schedule: {},
		scheduled: { inScheduled: "fails" },
		sent: {},
		revoke: { refreshAfter: "invalid_grant", entriesLeft: [] },
		...change,
	};
	return {
		version: 1,
		steps: Object.fromEntries(Object.entries(results).map(([step, data]) => [step, record(data)])),
		work: {},
	};
}

describe("the report", () => {
	const observations = parseObservations(valid) as Observations;

	it("prints the backlog's ten test:live lines in order, then the extra checks", () => {
		const { lines, acceptance } = buildReport(state(), observations);
		expect(acceptanceLines(acceptance)).toEqual([
			"messageId preserved: yes",
			"date preserved: no",
			"in:scheduled: fails",
			"scope drop: refused (scope_missing: gmail.modify)",
			"agent flag: wording recorded (with, without)",
			"publishing status: Production",
			"homepage: accepted",
			"429 concurrent: not provoked (225 bounded parallel reads, at most 100 at once)",
			"429 mail sending: documented only (not provoked)",
			"revoked: yes",
		]);
		expect(lines.slice(10)).toEqual([
			"bcc: the To copy: absent; the sent copy keeps it: yes; other copies: 0",
			"index delay: rfc822msgid: 1.5 s, in:sent: not seen",
			"threads.get minimal: internalDate yes",
			"reconcile: by rfc822msgid sent (rfc822msgid), fallback not found (3 scanned)",
			"publish without homepage: blocked",
			"readings: R1 consistent, R2 unclear, R3 consistent, R4 inconsistent, R5 unclear",
		]);
	});

	it("says revoked: no until every grant fails to refresh, the entries are gone and the clients deleted", () => {
		const revoked = (s: State, o: Observations = observations) =>
			buildReport(s, o).acceptance.revoked;
		expect(revoked(state({ revoke: { refreshAfter: "ok", entriesLeft: [] } }))).toBe("no");
		expect(
			revoked(
				state({
					revoke: { refreshAfter: "invalid_grant", entriesLeft: ["DY_LIVE_GMAIL_CLIENT_ID"] },
				}),
			),
		).toBe("no");
		expect(revoked(state(), { ...observations, clientsDeleted: false })).toBe("no");
		expect(revoked(state({ drop: { behaviour: "refused", finalRefresh: "ok" } }))).toBe("no");
		const noRefresh = state({
			agent: { consent: {}, fullGrant: { refreshAfter: "no-refresh-token" } },
		});
		expect(revoked(noRefresh)).toBe("yes");
		expect(revoked(noRefresh, { ...observations, clientsDeleted: false })).toBe("no");
		// Google refused the agent client's consent, so it never held a grant.
		const refused = state({ agent: { consent: { error: "access_denied" }, fullGrant: null } });
		expect(revoked(refused)).toBe("yes");
		// The drop step's consent page had no Gmail checkbox, so it made no grant either.
		const noCheckbox = state({ drop: { behaviour: "not possible", finalRefresh: "no-grant" } });
		expect(revoked(noCheckbox, { ...observations, clientsDeleted: true })).toBe("yes");
		expect(revoked(noCheckbox, { ...observations, clientsDeleted: false })).toBe("no");
	});

	it("shows each grant's state for live-cli status", () => {
		expect(grantStatus(state())).toEqual({
			agent: "ended (invalid_grant)",
			drop: "ended (invalid_grant)",
			standard: "ended (invalid_grant)",
		});
		const partial = state({
			agent: { consent: {}, fullGrant: null },
			drop: { behaviour: "refused", finalRefresh: "no-refresh-token" },
		});
		expect(grantStatus({ ...partial, steps: { ...partial.steps, revoke: undefined } })).toEqual({
			agent: "none (no grant made)",
			drop: "no refresh token: ends when the client is deleted",
			standard: "not yet",
		});
	});

	it("accepts only explicitly confirmed client-deletion cleanup, preserving its actual error and other gates", () => {
		for (const code of ["invalid_client", "deleted_client"]) {
			const cleanup = {
				refreshAfter: code,
				entriesLeft: [],
				cleanupBasis: "owner-confirmed-client-deletion",
			};
			const completed = state({ revoke: cleanup });
			expect(buildReport(completed, observations).acceptance.revoked).toBe("yes");
			expect(buildReport(completed, observations).lines).toContain(
				`cleanup basis: owner-confirmed deletion of both clients (${code}); token refusal not proved`,
			);
			expect(grantStatus(completed).standard).toBe(
				`owner-confirmed client deletion (${code}); token refusal not proved`,
			);
			expect(
				buildReport(state({ revoke: { refreshAfter: code, entriesLeft: [] } }), observations)
					.acceptance.revoked,
			).toBe("no");
			expect(
				buildReport(completed, { ...observations, clientsDeleted: false }).acceptance.revoked,
			).toBe("no");
			expect(
				buildReport(
					state({ revoke: { ...cleanup, entriesLeft: ["DY_LIVE_GMAIL_CLIENT_ID"] } }),
					observations,
				).acceptance.revoked,
			).toBe("no");
			expect(
				buildReport(
					state({ revoke: cleanup, agent: { consent: {}, fullGrant: { refreshAfter: "ok" } } }),
					observations,
				).acceptance.revoked,
			).toBe("no");
			expect(
				buildReport(
					state({ revoke: cleanup, drop: { behaviour: "refused", finalRefresh: "ok" } }),
					observations,
				).acceptance.revoked,
			).toBe("no");
			const partial = { ...completed, steps: { ...completed.steps, sent: undefined } };
			expect(() => buildReport(partial, observations)).toThrow(/run these steps first: sent/);
			expect(
				recordProblems(
					{ commit: "a".repeat(40), dirty: true },
					completed,
					true,
					buildReport(completed, observations).acceptance,
				),
			).toContain("the checkout has changed inputs or no verified commit/status");
		}
		for (const code of ["ok", "network", "http_503", "invalid_request", "error"]) {
			expect(
				buildReport(
					state({
						revoke: {
							refreshAfter: code,
							entriesLeft: [],
							cleanupBasis: "owner-confirmed-client-deletion",
						},
					}),
					observations,
				).acceptance.revoked,
			).toBe("no");
		}
	});

	it("shows an unchecked homepage with the owner's reason", () => {
		const reasoned = parseObservations({
			...valid,
			publishing: { ...valid.publishing, homepage: "not checked", homepageReason: "no site yet" },
		});
		expect(buildReport(state(), reasoned).acceptance.homepage).toBe("not checked(no site yet)");
	});

	it("lists the steps still to run", () => {
		const partial: State = { version: 1, steps: { agent: state().steps.agent }, work: {} };
		expect(missingSteps(partial)).toEqual([
			"drop",
			"connect",
			"send",
			"concurrency",
			"schedule",
			"scheduled",
			"sent",
			"revoke",
		]);
		expect(() => buildReport(partial, observations)).toThrow(
			/run these steps first: drop, connect, send/,
		);
	});

	it("records only from a clean checkout at the commit every step ran on", () => {
		const { acceptance } = buildReport(state(), observations);
		const clean = { commit: "a".repeat(40), dirty: false };
		expect(recordProblems(clean, state(), true, acceptance)).toEqual([]);
		expect(recordProblems({ ...clean, dirty: true }, state(), true, acceptance)).toEqual([
			"the checkout has changed inputs or no verified commit/status",
		]);
		expect(recordProblems({ ...clean, dirty: null }, state(), true, acceptance)).toEqual([
			"the checkout has changed inputs or no verified commit/status",
		]);
		const previous = state();
		const schedule = previous.steps.schedule;
		if (schedule === undefined) throw new Error("the synthetic schedule record is required");
		const unknownStep: State = {
			...previous,
			steps: { ...previous.steps, schedule: { ...schedule, dirty: null } },
		};
		expect(recordProblems(clean, unknownStep, true, acceptance)).toEqual([
			"these steps ran on other code: schedule",
		]);
		expect(recordProblems({ ...clean, commit: "b".repeat(40) }, state(), true, acceptance)).toEqual(
			[
				"these steps ran on other code: agent, drop, connect, send, concurrency, schedule, scheduled, sent, revoke",
			],
		);
		expect(recordProblems({ ...clean, dirty: true }, state(), false, acceptance)).toEqual([]);
		const open = { ...acceptance, revoked: "no" as const };
		expect(recordProblems(clean, state(), false, open)).toEqual([
			"revoked isn't yes: finish the revocation and cleanup",
		]);
	});
});

describe("what the steps record", () => {
	it("keeps scopes, labels and the token answer as names and numbers", () => {
		expect(
			shortScopes(
				"openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify https://mail.google.com/ urn:other",
			),
		).toEqual(["gmail.modify", "mail.google.com", "openid", "other", "userinfo.email"]);
		expect(systemLabels(["SENT", "Label_1234567890", "CATEGORY_PERSONAL", "SENT"])).toEqual([
			"CATEGORY_PERSONAL",
			"SENT",
			"user-label",
		]);
		const access = `ya29-like-${randomBytes(12).toString("hex")}`;
		expect(
			tokenShape(200, {
				access_token: access,
				expires_in: 3599,
				refresh_token_expires_in: 604_799,
				scope: "openid https://www.googleapis.com/auth/gmail.modify",
				token_type: "Bearer",
			}),
		).toEqual({
			status: 200,
			fields: ["access_token", "expires_in", "refresh_token_expires_in", "scope", "token_type"],
			expiresIn: 3599,
			refreshTokenExpiresIn: 604_799,
			tokenType: "Bearer",
			scopes: ["gmail.modify", "openid"],
		});
		expect(tokenShape(400, { error: "invalid_grant", error_description: "Bad Request" })).toEqual({
			status: 400,
			fields: ["error", "error_description"],
			error: "invalid_grant",
		});
		expect(tokenShape(400, { error: "Something someone@example.org" }).error).toBe("other");
	});

	it("checks Gmail requests and answers against the discovery document", async () => {
		const traffic = newTraffic();
		const answer = (status: number, body: unknown) => async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json; charset=UTF-8", "retry-after": "7" },
			});
		const profile = { emailAddress: "owner@example.com", historyId: "1234", surprise: true };
		await gmailFetch(
			answer(200, profile),
			traffic,
		)("https://gmail.googleapis.com/gmail/v1/users/me/profile?colour=blue");
		await gmailFetch(
			answer(429, { error: { code: 429 } }),
			traffic,
		)("https://gmail.googleapis.com/gmail/v1/users/me/messages/18c2f3a4b5d6e7f8?format=everything");
		expect(traffic).toEqual({
			requests: 2,
			responsesChecked: 1,
			problems: [
				"query colour is not in the discovery document",
				"response: surprise is not in the discovery document",
				"query format=<value> is not in its enum",
			],
			failures: [
				{
					status: 429,
					headers: {
						names: ["content-type", "retry-after"],
						values: { "content-type": "application/json; charset=UTF-8", "retry-after": "7" },
					},
				},
			],
		});
	});

	it("drops values and ids from discovery-document problems", () => {
		expect(
			sanitizeProblem(
				"GET /gmail/v1/users/me/messages/18c2f3a4b5d6e7f8 is not in the discovery document",
			),
		).toBe("GET /gmail/v1/users/me/messages/<id> is not in the discovery document");
		expect(sanitizeProblem("query format=raw2 is not in its enum")).toBe(
			"query format=<value> is not in its enum",
		);
		expect(sanitizeProblem("query maxResults is not uint32")).toBe(
			"query maxResults is not uint32",
		);
	});

	it("writes a 429 as one line", () => {
		const limited: Limited = {
			at: { call: "getProfile", parallel: 50 },
			status: 429,
			errorStatus: "RESOURCE_EXHAUSTED",
			reasons: ["rateLimitExceeded"],
			domains: ["usageLimits"],
			message: "Too many concurrent requests for user",
			classified: { kind: "retry", reason: "concurrent", retryAt: false },
			headers: null,
		};
		expect(limitedLine(limited)).toBe(
			'429 RESOURCE_EXHAUSTED rateLimitExceeded (usageLimits) "Too many concurrent requests for user" -> retry(concurrent) at 50 parallel getProfile',
		);
		expect(
			limitedLine({
				...limited,
				errorStatus: null,
				reasons: [],
				domains: [],
				classified: { kind: "unknown" },
			}),
		).toBe(
			'429 - - (-) "Too many concurrent requests for user" -> unknown at 50 parallel getProfile',
		);
	});

	it("answers messageId and date preserved", () => {
		expect([true, false, null].map(messageIdAnswer)).toEqual(["yes", "no", "inconclusive"]);
		const stamp = Date.parse("2026-10-22T15:00:00Z");
		const sent = { readBackDate: stamp, stamp, startedAt: stamp + 90_000 };
		expect(dateAnswer({ ...sent, dateKept: true })).toEqual({
			answer: "yes",
			internalDateFollowsDate: false,
		});
		expect(dateAnswer({ ...sent, dateKept: false })).toEqual({
			answer: "no",
			internalDateFollowsDate: null,
		});
		// Gmail kept the back-dated Date and took internalDate from it.
		expect(dateAnswer({ ...sent, dateKept: "inconclusive" })).toEqual({
			answer: "yes",
			internalDateFollowsDate: true,
		});
		expect(dateAnswer({ ...sent, startedAt: stamp + 1_000, dateKept: "inconclusive" }).answer).toBe(
			"inconclusive",
		);
		expect(dateAnswer({ ...sent, readBackDate: null, dateKept: null }).answer).toBe("inconclusive");
	});

	it("refuses content in a step's result before state.json holds it", () => {
		const s = session();
		saveStep(s, "schedule", { baseline: { ok: true, count: 2 } });
		expect(
			JSON.parse(readFileSync(path.join(s.dir, "state.json"), "utf8")).steps.schedule.data,
		).toEqual({
			baseline: { ok: true, count: 2 },
		});
		expect(() => saveStep(s, "send", { to: "someone@example.org" })).toThrow(/content-shaped/);
		const secret = `refresh-${randomBytes(16).toString("hex")}`;
		registerSecret(secret);
		expect(() => saveStep(s, "send", { note: `kept ${secret}` })).toThrow(/secret/);
		expect(
			Object.keys(JSON.parse(readFileSync(path.join(s.dir, "state.json"), "utf8")).steps),
		).toEqual(["schedule"]);
	});
});

describe("the authorization request", () => {
	it("asks for a refresh token with access_type=offline only when the session asks", () => {
		const request = {
			endpoint: GOOGLE.authorization,
			clientId: "client.test.invalid",
			redirectUri: "http://127.0.0.1:50123",
			scopes: scopesFor("full"),
			state: "s",
			challenge: "c",
		};
		expect(new URL(authorizationUrl(request)).searchParams.has("access_type")).toBe(false);
		const offline = new URL(authorizationUrl({ ...request, accessType: "offline" }));
		expect(offline.searchParams.get("access_type")).toBe("offline");
		expect(offline.searchParams.get("code_challenge_method")).toBe("S256");
	});
});

describe("session settings", () => {
	it("takes the step, the recording switch and the session folder from the environment", () => {
		expect(stepFromEnv({})).toBeUndefined();
		expect(stepFromEnv({ DRAFTYAK_S8_STEP: "send" })).toBe("send");
		expect(() => stepFromEnv({ DRAFTYAK_S8_STEP: "everything" })).toThrow(
			/one of agent, drop, connect, .*, report, not "everything"/,
		);
		expect([recording({}), recording({ DRAFTYAK_RECORD_EVIDENCE: "0" })]).toEqual([false, false]);
		expect(recording({ DRAFTYAK_RECORD_EVIDENCE: "1" })).toBe(true);
		expect(() => recording({ DRAFTYAK_RECORD_EVIDENCE: "yes" })).toThrow(/1 or 0/);
		const dir = path.join(base, "elsewhere");
		expect(sessionDir({ DRAFTYAK_S8_SESSION: dir })).toBe(path.resolve(dir));
		expect(() => sessionDir({ DRAFTYAK_S8_SESSION: "relative" })).toThrow(/absolute/);
		expect(sessionDir({ DRAFTYAK_CACHE_DIR: base })).toBe(path.join(base, "s08-session"));
	});

	it("reads input.json strictly, as UTF-8", () => {
		const dir = folder();
		const file = path.join(dir, "input.json");
		expect(() => readInput(dir)).toThrow(/no .*input\.json/);
		writeFileSync(
			file,
			Buffer.from(`﻿${JSON.stringify({ secondAddress: "a@example.net" })}`, "utf16le"),
		);
		expect(() => readInput(dir)).toThrow(/UTF-16/);
		writeFileSync(file, `﻿${JSON.stringify({ secondAddress: "a@example.net" })}`);
		expect(secondAddress(readInput(dir)).reveal()).toBe("a@example.net");
		writeFileSync(file, JSON.stringify({ secondAddress: "a@example.net", to: "b@example.net" }));
		expect(() => readInput(dir)).toThrow(/unknown fields to/);
		for (const value of ["not an address", 42, "two@@example.net"]) {
			expect(() => secondAddress({ secondAddress: value })).toThrow(/second e-mail address/);
		}
		const input = { testAccount: "t@example.net", accountName: " Test Account " };
		writeFileSync(file, JSON.stringify(input));
		expect(testAccount(readInput(dir))?.reveal()).toBe("t@example.net");
		expect(accountName(readInput(dir)).reveal()).toBe("Test Account");
		expect(testAccount({})).toBeUndefined();
		expect(() => testAccount({ testAccount: "nobody" })).toThrow(/test Gmail address/);
		expect(() => accountName({})).toThrow(/accountName must be the test account's name/);
	});

	it("takes the owner's declared outcome from the environment", () => {
		expect(declaredFromEnv({})).toBeUndefined();
		expect(declaredFromEnv({ DRAFTYAK_S8_OUTCOME: "refused" })).toBe("refused");
		expect(declaredFromEnv({ DRAFTYAK_S8_OUTCOME: "no-checkbox" })).toBe("no-checkbox");
		expect(() => declaredFromEnv({ DRAFTYAK_S8_OUTCOME: "toString" })).toThrow(
			/refused \(agent step\) or no-checkbox \(drop step\), not "toString"/,
		);
	});

	it("knows one mailbox under Gmail's dots, +tags and googlemail.com", () => {
		expect(sameMailbox("first.last@gmail.com", "FirstLast+s8@googlemail.com")).toBe(true);
		expect(sameMailbox("owner@example.com", "Owner+probe@Example.com")).toBe(true);
		expect(sameMailbox("first.last@example.com", "firstlast@example.com")).toBe(false);
		expect(sameMailbox("owner@gmail.com", "owner2@gmail.com")).toBe(false);
	});

	it("reads the owner's send time as the next such time on this computer's clock", () => {
		const after = new Date(2026, 9, 22, 15, 30, 20).getTime();
		expect(nextClockTime("15:47", after)).toBe(new Date(2026, 9, 22, 15, 47).getTime());
		expect(nextClockTime("3:47 pm", after)).toBe(new Date(2026, 9, 22, 15, 47).getTime());
		expect(nextClockTime("12:05 AM", after)).toBe(new Date(2026, 9, 23, 0, 5).getTime());
		expect(nextClockTime("15:30", after)).toBe(new Date(2026, 9, 23, 15, 30).getTime());
		expect(nextClockTime("3:47", after)).toBe(new Date(2026, 9, 23, 3, 47).getTime());
		for (const time of ["25:00", "7:60", "13:00 pm", "0:15 am", "noon"]) {
			expect(() => nextClockTime(time, after), time).toThrow(/HH:MM/);
		}
	});

	it("names the .env.live entries a step lacks, never their values", () => {
		const envLive = path.join(folder(), ".env.live");
		const s = session({ DRAFTYAK_ENV_LIVE: envLive });
		expect(credentialsProblem(undefined, s)).toMatch(
			/not set in .*: DY_LIVE_GMAIL_CLIENT_ID, DY_LIVE_GMAIL_CLIENT_SECRET, DY_LIVE_GMAIL_AGENT_CLIENT_ID, DY_LIVE_GMAIL_AGENT_CLIENT_SECRET/,
		);
		expect(credentialsProblem("report", s)).toBeUndefined();
		const value = `value-${randomBytes(8).toString("hex")}`;
		writeFileSync(
			envLive,
			`DY_LIVE_GMAIL_CLIENT_ID=${value}\nDY_LIVE_GMAIL_CLIENT_SECRET=${value}\n`,
		);
		expect(credentialsProblem("connect", s)).toBeUndefined();
		expect(credentialsProblem("send", s)).toMatch(/DY_LIVE_GMAIL_REFRESH_TOKEN/);
		expect(credentialsProblem("send", s)).not.toContain(value);
	});
});

function downloaded(dir: string, json: unknown): string {
	const file = path.join(dir, `client_secret_${randomBytes(4).toString("hex")}.json`);
	writeFileSync(file, typeof json === "string" ? json : JSON.stringify(json));
	return file;
}

describe("live-cli", () => {
	const clientId = () =>
		`${randomInt(1e11, 1e12)}-${randomBytes(16).toString("hex")}.apps.googleusercontent.com`;

	it("saves a Desktop client's ID and secret through saveEnvLive and deletes the download", () => {
		const dir = folder();
		const env = { ...process.env, DRAFTYAK_ENV_LIVE: path.join(dir, ".env.live") };
		const id = clientId();
		const secret = `test-${randomBytes(18).toString("base64url")}`;
		const file = downloaded(dir, { installed: { client_id: id, client_secret: secret } });
		const log: string[] = [];
		expect(cli(["save-client", "agent", file], env, (line) => log.push(line))).toBe(0);
		expect(existsSync(file)).toBe(false);
		expect(readFileSync(path.join(dir, ".env.live"), "utf8")).toBe(
			`DY_LIVE_GMAIL_AGENT_CLIENT_ID=${id}\nDY_LIVE_GMAIL_AGENT_CLIENT_SECRET=${secret}\n`,
		);
		expect(log.join("\n")).not.toContain(secret);
		expect(log).toEqual([
			"saved DY_LIVE_GMAIL_AGENT_CLIENT_ID and DY_LIVE_GMAIL_AGENT_CLIENT_SECRET in .env.live, and deleted the downloaded file",
		]);
	});

	it("refuses the client already saved under the other name", () => {
		const dir = folder();
		const env = { ...process.env, DRAFTYAK_ENV_LIVE: path.join(dir, ".env.live") };
		const id = clientId();
		const installed = {
			client_id: id,
			client_secret: `test-${randomBytes(18).toString("base64url")}`,
		};
		expect(cli(["save-client", "standard", downloaded(dir, { installed })], env, () => {})).toBe(0);
		const again = downloaded(dir, { installed });
		const errors: string[] = [];
		expect(
			cli(
				["save-client", "agent", again],
				env,
				() => {},
				(line) => errors.push(line),
			),
		).toBe(1);
		expect(errors).toEqual([
			"live-cli: that file is the client already saved as DY_LIVE_GMAIL_CLIENT_ID: download the agent client's JSON",
		]);
		expect(existsSync(again)).toBe(true);
		expect(readFileSync(path.join(dir, ".env.live"), "utf8")).not.toMatch(/AGENT/);
	});

	it("prints the disclosure, records the owner's send time and deletes the entries", () => {
		const dir = folder();
		const session = path.join(dir, "session");
		const env = {
			...process.env,
			DRAFTYAK_ENV_LIVE: path.join(dir, ".env.live"),
			DRAFTYAK_S8_SESSION: session,
		};
		const log: string[] = [];
		expect(cli(["disclosure", "agent"], env, (line) => log.push(line))).toBe(0);
		expect(log[0]).toMatch(/^Before Google's consent: .* AI-powered-agent Desktop client\.$/);
		const errors: string[] = [];
		const failed = (line: string) => errors.push(line);
		expect(cli(["send-at", "15:47"], env, () => {}, failed)).toBe(1);
		expect(errors).toEqual(["live-cli: run the schedule step first"]);
		const startedAt = Date.now();
		mkdirSync(session);
		writeFileSync(
			path.join(session, "state.json"),
			JSON.stringify({ version: 1, steps: {}, work: { startedAt } }),
		);
		log.length = 0;
		expect(cli(["send-at", "15:47"], env, (line) => log.push(line))).toBe(0);
		expect(readState(session).work.sendAt).toBe(nextClockTime("15:47", startedAt));
		expect(log[0]).toMatch(/^the scheduled mail goes out /);
		const value = `value-${randomBytes(8).toString("hex")}`;
		writeFileSync(
			path.join(dir, ".env.live"),
			`OTHER_ENTRY=${value}\nDY_LIVE_GMAIL_CLIENT_ID=${value}\nDY_LIVE_GMAIL_AGENT_CLIENT_SECRET=${value}\n`,
		);
		log.length = 0;
		expect(cli(["delete-entries"], env, (line) => log.push(line))).toBe(0);
		expect(log).toEqual([
			"deleted DY_LIVE_GMAIL_CLIENT_ID, DY_LIVE_GMAIL_AGENT_CLIENT_SECRET from .env.live",
		]);
		expect(readFileSync(path.join(dir, ".env.live"), "utf8")).toBe(`OTHER_ENTRY=${value}\n`);
	});

	it("refuses Web clients and files without a Desktop client, quoting no values", () => {
		const dir = folder();
		const secret = `test-${randomBytes(18).toString("base64url")}`;
		const cases: [unknown, RegExp][] = [
			[{ web: { client_id: clientId(), client_secret: secret } }, /Web application client/],
			[{ installed: { client_id: "someone", client_secret: secret } }, /no Desktop client_id/],
			[{ installed: { client_id: clientId() } }, /no client_secret/],
			["not json", /isn't a client JSON file/],
		];
		for (const [json, message] of cases) {
			const file = downloaded(dir, json);
			let error = "";
			try {
				readClientFile(file);
			} catch (caught) {
				error = String(caught);
			}
			expect(error).toMatch(message);
			expect(error).not.toContain(secret);
			expect(existsSync(file)).toBe(true);
		}
	});

	it("shows the session's status by entry names and step names", () => {
		const dir = folder();
		const env = {
			...process.env,
			DRAFTYAK_ENV_LIVE: path.join(dir, ".env.live"),
			DRAFTYAK_S8_SESSION: path.join(dir, "session"),
		};
		const value = `value-${randomBytes(8).toString("hex")}`;
		writeFileSync(path.join(dir, ".env.live"), `DY_LIVE_GMAIL_CLIENT_ID=${value}\n`);
		const log: string[] = [];
		expect(cli(["status"], env, (line) => log.push(line))).toBe(0);
		expect(log).toContain("  DY_LIVE_GMAIL_CLIENT_ID: set");
		expect(log).toContain("  DY_LIVE_GMAIL_REFRESH_TOKEN: missing");
		expect(log).toContain("  steps done: none");
		expect(log).toContain("  next step: agent");
		expect(log.join("\n")).not.toContain(value);
	});

	it("forgets a session folder, and nothing else", () => {
		const dir = folder();
		const sessionFolder = path.join(dir, "session");
		const env = {
			...process.env,
			DRAFTYAK_ENV_LIVE: path.join(dir, ".env.live"),
			DRAFTYAK_S8_SESSION: sessionFolder,
		};
		mkdirSync(path.join(sessionFolder, "evidence"), { recursive: true });
		writeFileSync(path.join(sessionFolder, "state.json"), "{}");
		writeFileSync(path.join(sessionFolder, "input.json"), "{}");
		const log: string[] = [];
		expect(cli(["forget"], env, (line) => log.push(line))).toBe(0);
		expect(existsSync(sessionFolder)).toBe(false);
		expect(log).toEqual([`deleted ${sessionFolder}`]);
		mkdirSync(sessionFolder);
		writeFileSync(path.join(sessionFolder, "notes.txt"), "mine");
		const errors: string[] = [];
		expect(
			cli(
				["forget"],
				env,
				() => {},
				(line) => errors.push(line),
			),
		).toBe(1);
		expect(errors).toEqual([
			`live-cli: ${sessionFolder} holds more than a session (notes.txt); left alone`,
		]);
		expect(existsSync(path.join(sessionFolder, "notes.txt"))).toBe(true);
	});

	it("prints its usage for anything else", () => {
		for (const [argv, code] of [
			[[], 2],
			[["save-client", "other", "file.json"], 1],
			[["status", "extra"], 2],
			[["revoke"], 2],
		] as const) {
			const errors: string[] = [];
			expect(
				cli(
					argv,
					process.env,
					() => {},
					(line) => errors.push(line),
				),
			).toBe(code);
			expect(errors).toHaveLength(1);
		}
	});
});
