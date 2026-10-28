import { createHash } from "node:crypto";
import { assertContentFree } from "@draftyak/spike-kit";
import { discovery, discoveryBytes } from "./fake-gmail.ts";
import type { State } from "./live-session.ts";

// The report step's half of the S8b session: the owner's observations, the acceptance lines and the
// evidence/live.json data, built from the steps' content-free results in state.json.

export const READINGS = ["R1", "R2", "R3", "R4", "R5"] as const;
export type Reading = (typeof READINGS)[number];

// The policy sentences (a)-(e) each reading rests on, from notes/consent-and-policy.md.
export const RESTS_ON: Readonly<Record<Reading, readonly string[]>> = {
	R1: ["a", "e"],
	R2: ["b"],
	R3: ["a", "b"],
	R4: ["a"],
	R5: ["a", "b"],
};

const VERDICTS = ["consistent", "inconsistent", "unclear"] as const;
export type ReadingVerdict = (typeof VERDICTS)[number];

export interface ConsentObservation {
	// The consent page's text, one line per entry, with the account's name and address as <account>.
	readonly wording: readonly string[];
	// The screens in the order they came, as short names (disclosure, account-chooser, consent, ...).
	readonly screens: readonly string[];
	// Whether the page offered a checkbox per permission (granular consent).
	readonly scopeCheckboxes: boolean;
}

export interface Observations {
	readonly consent: { readonly agent: ConsentObservation; readonly standard: ConsentObservation };
	readonly bccInToCopy: "absent" | "present" | "not checked";
	readonly publishing: {
		readonly atConsent: "testing" | "production";
		readonly withoutHomepage: "published" | "blocked" | "not tried";
		readonly homepage: "accepted" | "rejected" | "not checked";
		readonly homepageReason?: string;
		readonly final: "testing" | "production";
	};
	readonly readings: Readonly<
		Record<Reading, { readonly verdict: ReadingVerdict; readonly note?: string }>
	>;
	readonly policyPages: "unchanged" | "changed";
	readonly policyNote?: string;
	readonly clientsDeleted: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whole words only, so that a short name doesn't catch the words it is part of.
const wordsOf = (words: readonly string[], flags: string): RegExp =>
	new RegExp(`(?<![\\p{L}\\p{N}])${words.map(escaped).join("\\s+")}(?![\\p{L}\\p{N}])`, flags);

const BOILERPLATE = new Set(["google", "gmail", "account", "draftyak", "spike"]);

// Refuses with every problem at once, naming JSON paths, never the values. `names` are the test
// account's name as Google shows it: no line may hold it in any case, nor a word of it of three
// or more letters as written.
export function parseObservations(value: unknown, names: readonly string[] = []): Observations {
	const patterns = names.flatMap((name) => {
		const words = name.split(/\s+/).filter((word) => word !== "");
		const parts = words
			.filter((word) => word.length >= 3 && !BOILERPLATE.has(word.toLowerCase()))
			.map((word) => wordsOf([word], "u"));
		return words.length === 0 ? [] : [wordsOf(words, "iu"), ...parts];
	});
	const named = (input: string): boolean => patterns.some((pattern) => pattern.test(input));
	const problems: string[] = [];
	const fail = (at: string, what: string): void => {
		problems.push(`${at}: ${what}`);
	};
	const record = (
		input: unknown,
		at: string,
		required: readonly string[],
		optional: readonly string[] = [],
	): Readonly<Record<string, unknown>> => {
		if (!isRecord(input)) {
			fail(at, "expected an object");
			return {};
		}
		for (const key of required) if (!(key in input)) fail(`${at}.${key}`, "missing");
		for (const key of Object.keys(input)) {
			if (!required.includes(key) && !optional.includes(key)) fail(`${at}.${key}`, "unknown field");
		}
		return input;
	};
	const choice = <T extends string>(input: unknown, at: string, allowed: readonly T[]): T => {
		if (typeof input === "string" && (allowed as readonly string[]).includes(input)) {
			return input as T;
		}
		fail(at, `one of: ${allowed.join(", ")}`);
		return allowed[0] as T;
	};
	const flag = (input: unknown, at: string): boolean => {
		if (typeof input !== "boolean") fail(at, "true or false");
		return input === true;
	};
	const text = (input: unknown, at: string): string => {
		if (typeof input !== "string" || input.trim() === "" || input.length > 200) {
			fail(at, "1 to 200 characters of text");
			return "";
		}
		const control = [...input].some((char) => char.charCodeAt(0) < 32 || char === "\u007f");
		if (control) fail(at, "no control characters or line breaks");
		// Copies from a browser can carry bidi controls and zero-width marks.
		if (/\p{Cf}/u.test(input)) fail(at, "no invisible format characters: retype the line");
		if (input.includes("@")) fail(at, "no addresses: write <account> instead");
		if (named(input)) fail(at, "no names: write <account> for the account's name");
		if (/<(?!account>)[^<>]*>/.test(input)) fail(at, "replace the template's <placeholder>");
		if (/\d{6,}/.test(input)) fail(at, "no runs of 6 or more digits");
		return input.trim();
	};
	const list = (input: unknown, at: string, max: number): readonly unknown[] => {
		if (!Array.isArray(input) || input.length === 0 || input.length > max) {
			fail(at, `a list of 1 to ${max} entries`);
			return [];
		}
		return input;
	};
	const consent = (input: unknown, at: string): ConsentObservation => {
		const value = record(input, at, ["wording", "screens", "scopeCheckboxes"]);
		const screens = list(value.screens, `${at}.screens`, 12).map((screen, index) => {
			if (typeof screen !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(screen)) {
				fail(`${at}.screens[${index}]`, "a short name such as account-chooser");
			}
			return String(screen);
		});
		return {
			wording: list(value.wording, `${at}.wording`, 80).map((line, index) =>
				text(line, `${at}.wording[${index}]`),
			),
			screens,
			scopeCheckboxes: flag(value.scopeCheckboxes, `${at}.scopeCheckboxes`),
		};
	};

	const top = record(
		value,
		"observations",
		["consent", "bccInToCopy", "publishing", "readings", "policyPages", "clientsDeleted"],
		["policyNote"],
	);
	const consents = record(top.consent, "observations.consent", ["agent", "standard"]);
	const publishingIn = record(
		top.publishing,
		"observations.publishing",
		["atConsent", "withoutHomepage", "homepage", "final"],
		["homepageReason"],
	);
	const homepage = choice(publishingIn.homepage, "observations.publishing.homepage", [
		"accepted",
		"rejected",
		"not checked",
	] as const);
	const homepageReason =
		publishingIn.homepageReason === undefined
			? undefined
			: text(publishingIn.homepageReason, "observations.publishing.homepageReason");
	if (homepage === "not checked" && homepageReason === undefined) {
		fail(
			"observations.publishing.homepageReason",
			"the owner's reason is required when not checked",
		);
	}
	const readingsIn = record(top.readings, "observations.readings", READINGS);
	const readings = Object.fromEntries(
		READINGS.map((name) => {
			const at = `observations.readings.${name}`;
			const reading = record(readingsIn[name], at, ["verdict"], ["note"]);
			const note = reading.note === undefined ? undefined : text(reading.note, `${at}.note`);
			const verdict = choice(reading.verdict, `${at}.verdict`, VERDICTS);
			return [name, note === undefined ? { verdict } : { verdict, note }];
		}),
	) as Observations["readings"];
	const policyPages = choice(top.policyPages, "observations.policyPages", [
		"unchanged",
		"changed",
	] as const);
	const policyNote =
		top.policyNote === undefined ? undefined : text(top.policyNote, "observations.policyNote");
	if (policyPages === "changed" && policyNote === undefined) {
		fail("observations.policyNote", "say what changed");
	}
	const observations: Observations = {
		consent: {
			agent: consent(consents.agent, "observations.consent.agent"),
			standard: consent(consents.standard, "observations.consent.standard"),
		},
		bccInToCopy: choice(top.bccInToCopy, "observations.bccInToCopy", [
			"absent",
			"present",
			"not checked",
		] as const),
		publishing: {
			atConsent: choice(publishingIn.atConsent, "observations.publishing.atConsent", [
				"testing",
				"production",
			] as const),
			withoutHomepage: choice(
				publishingIn.withoutHomepage,
				"observations.publishing.withoutHomepage",
				["published", "blocked", "not tried"] as const,
			),
			homepage,
			...(homepageReason === undefined ? {} : { homepageReason }),
			final: choice(publishingIn.final, "observations.publishing.final", [
				"testing",
				"production",
			] as const),
		},
		readings,
		policyPages,
		...(policyNote === undefined ? {} : { policyNote }),
		clientsDeleted: flag(top.clientsDeleted, "observations.clientsDeleted"),
	};
	if (problems.length === 0) {
		try {
			assertContentFree(observations, "observations", 200);
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (problems.length > 0) throw new Error(`input.json: ${problems.join("; ")}`);
	return observations;
}

// What the report reads from each step's result in live-session.ts; the results hold more.
export type Answer = "yes" | "no" | "inconclusive";

interface Open {
	readonly [field: string]: unknown;
}

export type ReconcileShape =
	| { readonly status: "sent"; readonly via: string; readonly matchesSent: boolean }
	| { readonly status: "ambiguous"; readonly matches: number; readonly includesSent: boolean }
	| { readonly status: "not_found"; readonly scanned: number; readonly complete: boolean };

// refreshAfter is the last refresh's OAuth error code after the revocation (invalid_grant), or
// no-refresh-token when Google issued none to try. fullGrant is null when Google refused the consent.
export interface AgentResult extends Open {
	readonly consent: Open;
	readonly fullGrant: (Open & { readonly refreshAfter: string }) | null;
}

// finalRefresh is no-grant when the owner declared that the consent page had no Gmail checkbox.
export interface DropResult extends Open {
	readonly behaviour: string;
	readonly finalRefresh: string;
}

export interface SendSummary extends Open {
	readonly probe: Open & { readonly messageId: Answer; readonly date: Answer };
	readonly bcc: Open & { readonly sentCopyHasBcc: boolean; readonly otherCopies: number };
	readonly indexDelayMs: Open & {
		readonly rfc822msgid: number | null;
		readonly inSent: number | null;
	};
	readonly threadsGetMinimal: Open & { readonly internalDate: boolean };
	readonly reconcile: { readonly byMessageId: ReconcileShape; readonly fallback: ReconcileShape };
}

export interface ConcurrencySummary extends Open {
	readonly line: string;
}

export interface ScheduledSummary extends Open {
	readonly inScheduled: "works" | "fails";
}

export interface RevokeSummary extends Open {
	readonly refreshAfter: string;
	readonly entriesLeft: readonly string[];
	readonly cleanupBasis?: "owner-confirmed-client-deletion";
}

export const clientDeletedCode = (code: string): boolean =>
	code === "invalid_client" || code === "deleted_client";

// Deleting a client ends every grant it holds, which covers a grant with no refresh token to try.
// The steps save any other grant only once a refresh confirmed it ended.
const ended = (refreshAfter: string, clientsDeleted: boolean): boolean =>
	refreshAfter === "invalid_grant" ||
	refreshAfter === "no-grant" ||
	(refreshAfter === "no-refresh-token" && clientsDeleted);

const grantState = (refreshAfter: string | undefined): string => {
	if (refreshAfter === undefined) return "not yet";
	if (refreshAfter === "invalid_grant") return "ended (invalid_grant)";
	if (refreshAfter === "no-grant") return "none (no grant made)";
	if (refreshAfter === "no-refresh-token")
		return "no refresh token: ends when the client is deleted";
	return `not confirmed (${refreshAfter})`;
};

// Each grant the session made, for live-cli status: check them before the clients are deleted.
export function grantStatus(state: State): Readonly<Record<"agent" | "drop" | "standard", string>> {
	const agent = state.steps.agent?.data as AgentResult | undefined;
	const drop = state.steps.drop?.data as DropResult | undefined;
	const revoke = state.steps.revoke?.data as RevokeSummary | undefined;
	return {
		agent: grantState(
			agent === undefined ? undefined : (agent.fullGrant?.refreshAfter ?? "no-grant"),
		),
		drop: grantState(drop?.finalRefresh),
		standard:
			revoke?.cleanupBasis === "owner-confirmed-client-deletion" &&
			clientDeletedCode(revoke.refreshAfter)
				? `owner-confirmed client deletion (${revoke.refreshAfter}); token refusal not proved`
				: grantState(revoke?.refreshAfter),
	};
}

// The backlog's test:live lines (M0.29 acceptance), in its order.
export interface Acceptance {
	readonly messageIdPreserved: Answer;
	readonly datePreserved: Answer;
	readonly inScheduled: "works" | "fails";
	readonly scopeDrop: string;
	readonly agentFlag: string;
	readonly publishingStatus: "Testing (refresh 7d)" | "Production";
	readonly homepage: string;
	readonly concurrent429: string;
	readonly mailSending429: "documented only (not provoked)";
	readonly revoked: "yes" | "no";
}

const LABELS: Readonly<Record<keyof Acceptance, string>> = {
	messageIdPreserved: "messageId preserved",
	datePreserved: "date preserved",
	inScheduled: "in:scheduled",
	scopeDrop: "scope drop",
	agentFlag: "agent flag",
	publishingStatus: "publishing status",
	homepage: "homepage",
	concurrent429: "429 concurrent",
	mailSending429: "429 mail sending",
	revoked: "revoked",
};

export function acceptanceLines(acceptance: Acceptance): string[] {
	return (Object.keys(LABELS) as (keyof Acceptance)[]).map(
		(key) => `${LABELS[key]}: ${acceptance[key]}`,
	);
}

export const DATA_STEPS = [
	"agent",
	"drop",
	"connect",
	"send",
	"concurrency",
	"schedule",
	"scheduled",
	"sent",
	"revoke",
] as const;

export const seconds = (ms: number | null): string =>
	ms === null ? "not seen" : `${(ms / 1000).toFixed(1)} s`;

export function describeReconcile(shape: ReconcileShape): string {
	if (shape.status === "sent")
		return `sent (${shape.via}${shape.matchesSent ? "" : ", another id"})`;
	if (shape.status === "ambiguous") return `ambiguous (${shape.matches} matches)`;
	return `not found (${shape.scanned} scanned${shape.complete ? "" : ", incomplete"})`;
}

export interface Report {
	readonly acceptance: Acceptance;
	readonly data: Readonly<Record<string, unknown>>;
	readonly lines: readonly string[];
}

export function missingSteps(state: State): string[] {
	return DATA_STEPS.filter((step) => state.steps[step] === undefined);
}

export function buildReport(state: State, observations: Observations): Report {
	const missing = missingSteps(state);
	if (missing.length > 0) throw new Error(`run these steps first: ${missing.join(", ")}`);
	const result = <T>(step: (typeof DATA_STEPS)[number]): T => state.steps[step]?.data as T;
	const agent = result<AgentResult>("agent");
	const drop = result<DropResult>("drop");
	const send = result<SendSummary>("send");
	const concurrency = result<ConcurrencySummary>("concurrency");
	const scheduled = result<ScheduledSummary>("scheduled");
	const revoke = result<RevokeSummary>("revoke");
	const { publishing, clientsDeleted } = observations;
	const revoked =
		(agent.fullGrant === null || ended(agent.fullGrant.refreshAfter, clientsDeleted)) &&
		ended(drop.finalRefresh, clientsDeleted) &&
		(revoke.refreshAfter === "invalid_grant" ||
			(clientDeletedCode(revoke.refreshAfter) &&
				revoke.cleanupBasis === "owner-confirmed-client-deletion")) &&
		revoke.entriesLeft.length === 0 &&
		clientsDeleted;
	const acceptance: Acceptance = {
		messageIdPreserved: send.probe.messageId,
		datePreserved: send.probe.date,
		inScheduled: scheduled.inScheduled,
		scopeDrop: drop.behaviour,
		agentFlag: "wording recorded (with, without)",
		publishingStatus: publishing.final === "production" ? "Production" : "Testing (refresh 7d)",
		homepage:
			publishing.homepage === "not checked"
				? `not checked(${publishing.homepageReason ?? ""})`
				: publishing.homepage,
		concurrent429: concurrency.line,
		mailSending429: "documented only (not provoked)",
		revoked: revoked ? "yes" : "no",
	};
	const extra = {
		bcc: {
			toCopy: observations.bccInToCopy,
			sentCopyKeepsIt: send.bcc.sentCopyHasBcc,
			otherCopies: send.bcc.otherCopies,
		},
		indexDelayMs: send.indexDelayMs,
		threadsGetMinimal: send.threadsGetMinimal,
		reconcile: send.reconcile,
		publishWithoutHomepage: publishing.withoutHomepage,
	};
	const lines = [
		...acceptanceLines(acceptance),
		...(revoke.cleanupBasis === "owner-confirmed-client-deletion" &&
		clientDeletedCode(revoke.refreshAfter)
			? [
					`cleanup basis: owner-confirmed deletion of both clients (${revoke.refreshAfter}); token refusal not proved`,
				]
			: []),
		`bcc: the To copy: ${observations.bccInToCopy}; the sent copy keeps it: ${
			send.bcc.sentCopyHasBcc ? "yes" : "no"
		}; other copies: ${send.bcc.otherCopies}`,
		`index delay: rfc822msgid: ${seconds(send.indexDelayMs.rfc822msgid)}, in:sent: ${seconds(
			send.indexDelayMs.inSent,
		)}`,
		`threads.get minimal: internalDate ${send.threadsGetMinimal.internalDate ? "yes" : "no"}`,
		`reconcile: by rfc822msgid ${describeReconcile(send.reconcile.byMessageId)}, fallback ${describeReconcile(
			send.reconcile.fallback,
		)}`,
		`publish without homepage: ${publishing.withoutHomepage}`,
		`readings: ${READINGS.map((name) => `${name} ${observations.readings[name].verdict}`).join(", ")}`,
	];
	const data = {
		item: "M0.29",
		discovery: {
			revision: discovery.revision,
			sha256: createHash("sha256").update(discoveryBytes).digest("hex"),
		},
		acceptance,
		extra,
		steps: Object.fromEntries(
			DATA_STEPS.map((step) => {
				const record = state.steps[step];
				return [step, { at: record?.at, commit: record?.commit, dirty: record?.dirty }];
			}),
		),
		results: Object.fromEntries(DATA_STEPS.map((step) => [step, state.steps[step]?.data])),
		observations: {
			...observations,
			readings: Object.fromEntries(
				READINGS.map((name) => [name, { ...observations.readings[name], restsOn: RESTS_ON[name] }]),
			),
		},
	};
	return { acceptance, data, lines };
}
