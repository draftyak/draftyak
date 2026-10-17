# S8 consent and policy notes

What the owner and M0.29 check at the Google consent screen in session 1, and what ADR 0010 decides from it. Quotes are as the pages read on 2026-10-16; M0.29 re-reads each page before the session and records any change. The plan's sections are §3 (Scheduler limits), §5 (Compliance guardrails) and §15 (S8).

## The owner's Desktop client (guardrail 5)

- DraftYak ships no Google client. The owner creates a "Desktop app" OAuth client in their own Google Cloud project, and its ID and secret live only in the main checkout's `.env.live` (`DY_LIVE_GMAIL_CLIENT_ID`, `DY_LIVE_GMAIL_CLIENT_SECRET`). Google's terms rule out the alternative: "Developer credentials may not be embedded in open source projects" ([Google APIs Terms](https://developers.google.com/terms), §4b.1), and "You must never commit client credentials into publicly available code repositories" ([OAuth 2.0 Policies](https://developers.google.com/identity/protocols/oauth2/policies)).
- The flow is the system browser, a loopback redirect on `127.0.0.1` with a random port, and PKCE S256 (`src/oauth.ts`). Google's out-of-band copy-paste flow is "no longer supported" ([OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)), and the OAuth policies forbid embedded webviews.
- Scopes are `openid email https://www.googleapis.com/auth/gmail.modify`, or `gmail.readonly` in read-only mode ([Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes); both are restricted scopes). With granular consent users "can select which permissions they want to approve" and apps "can't assume users grant all requested scopes" ([granular permissions](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions)), so `checkScopes` fails a grant without `gmail.modify`. It also fails a Gmail scope that reaches past the mode's own: `https://mail.google.com/` or `gmail.settings.*`, or in read-only mode anything besides `gmail.readonly` and `gmail.metadata` (`WITHIN`, checked against the discovery document). Narrower scopes granted alongside are accepted.
- `connect` revokes a grant that fails the check at once, and `ScopeError.revoked` says whether Google confirmed it. Google's revoke ends the account's whole grant to that client, tokens from earlier consents included. So M0.29 runs the `gmail.modify` drop (procedure step 5) last, or on a client of its own, and confirms any revocation with a refresh that fails with `invalid_grant`.

## Question 1: the "AI-powered agent" flag

Creating an OAuth client now offers "Use this client for an AI-powered agent". Google calls it a "self-declaration" that "does not grant additional scopes or privileges"; an app with both agentic and standard features "must create and maintain separate OAuth 2.0 client IDs for each workflow"; the setting can't be changed after the client exists; and "Some Google MCP endpoints, such as Workspace tools, will only accept calls authorized with an agentic client ID" ([AI-powered agent clients](https://support.google.com/cloud/answer/15549257), [Create access credentials](https://developers.google.com/workspace/guides/create-credentials), updated 2026-10-12).

To decide for the setup wizard:
- Whether the hub's single Gmail client counts as agentic. The hub drafts with AI, and MCP agents act through DraftYak's tools; every send still needs the owner's per-item PIN approval, and DraftYak calls no Google MCP endpoint.
- Whether the answer means one client or two (agentic and standard), given that the flag is permanent.

M0.29 consents with and without the flag, records the consent wording of each as text (never screenshots of personal data), and ADR 0010 states the recommendation. Because the flag is fixed when a client is created, that takes two throwaway spike clients in the test project, one with the flag and one without:
- The one without uses `DY_LIVE_GMAIL_CLIENT_ID` and `DY_LIVE_GMAIL_CLIENT_SECRET`.
- The one with the flag uses `DY_LIVE_GMAIL_AGENT_CLIENT_ID` and `DY_LIVE_GMAIL_AGENT_CLIENT_SECRET`. These names are still to be added to `.env.live.example`.
- Both pairs are read only through the kit's `loadEnvLive()`.
- The session's cleanup (step 6) deletes both clients in the project, along with the revocations and the `DY_LIVE_*` entries.

The owner creates the client used after M0 only once that is decided (plan §16).

## Question 2: Testing or Production, and the scheduling horizon

- **Testing.** "limited to up to 100 test users listed in the OAuth consent screen", and "Authorizations by a test user will expire seven days from the time of consent", the refresh token included ([publishing status](https://support.google.com/cloud/answer/15549945), [OAuth 2.0 overview](https://developers.google.com/identity/protocols/oauth2)).
- **Production, unverified.** The unverified-app screen, and a cap of "100 new users in total" over the project's life ([unverified apps](https://support.google.com/cloud/answer/7454865)). A personal client stays outside restricted-scope verification "if you are the only user of your app or if your app is used by only a few users, all of whom are known personally to you" ([restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)).
- **Other refresh-token ends** for both: six months unused, "The user changed passwords and the refresh token contains Gmail scopes", and "a limit of 100 refresh tokens per Google Account per OAuth 2.0 client ID" ([OAuth 2.0 overview](https://developers.google.com/identity/protocols/oauth2)). Each shows up as `invalid_grant` (`refreshTokens`), which starts the 30-day deletion deadline (plan §3 Revocation).
- **Consequence for scheduled send.** In Testing, a Gmail item can't be due later than 7 days after the consent: the grant is gone by then, and the item would be missed. §3 allows scheduling up to 30 days ahead, so the composer warns when a Testing-mode grant ends before `deliverBy` (`grantCovers`, `TESTING_GRANT_MS` in `src/oauth.ts`), and the wizard records the client's publishing status.

M0.29 records `publishing status: Testing (refresh 7d)|Production` for the client the owner uses, and ADR 0010 states the horizon.

## Question 3: the homepage requirement

Homepage, privacy-policy and terms-of-service links "are required for all external production apps", and the homepage "must be hosted on a verified domain you own" ([branding](https://support.google.com/cloud/answer/15549049)). In August and September 2026 self-hosters met a publish gate: "Valid app name, support email, homepage url, and privacy policy url are required" ([rclone forum](https://forum.rclone.org/t/unable-to-publish-google-drive-client-as-docs-advise/54197)).

Reports of being blocked from publishing are out of date, even within that thread:
- On 2026-09-26 a user filled in the branding links, validation failed, but "the app got published anyway. It's just not validated".
- rclone's own docs now say Google "requires a homepage URL and a privacy policy URL before publishing, even for a personal single-user app".

The plan's research concluded, as of late September 2026, that an owned, verified domain is needed for brand verification but not to press Publish on an unverified personal app. Such an app leaves Testing and its 7-day expiry. Google doesn't document this route, and it could close at any time.

GitHub Pages isn't available while the repository is private, so the owner puts a placeholder homepage on draftyak.com, verified in Search Console (owner pre-task, 2026-10-22). M0.29 checks whether Google accepts it for External/Production and records `homepage: accepted|rejected|not checked(<owner reason>)`; the check is mandatory unless the owner declines it in session 1, with a reason. M0.29 also records whether Publish works without the homepage, so ADR 0010 doesn't rest on the undocumented route alone.

## The five consent-review readings

Google's [Workspace API User Data and Developer Policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy) (updated 2026-09-03) now covers agents. The sentences the readings rest on:
- (a) Access is requested in context, and the policy's example is to "granularly require users to confirm the MCP, tool, skill, or other agentic behavior invocation."
- (b) Transfers are allowed only "To provide or improve your appropriate use case or user-facing features that are visible and prominent in the requesting application's user interface and only with the user's consent".
- (c) The disclosure "must accompany and immediately precede a request for user consent" and "Cannot be placed only in a privacy policy or terms of service"; "You must not begin collection prior to obtaining affirmative consent."
- (d) Required security measures include "Protecting against prompt injection techniques by either using Google Cloud Platform's Model Armor or other prompt injection protection".
- (e) Approved Gmail uses include "delayed sending of email".

| # | Reading | Plan | Rests on |
|---|---|---|---|
| R1 | The per-item PIN: every send, agent-proposed or scheduled, needs a PIN approval over its exact content and send time, with no bulk or mail-merge scheduling. That is the granular confirmation for a send. | §5 Sends, §9.3 | (a), (e) |
| R2 | Secret iCal feeds carry no Limited Use obligations, because no Google API or scope is used to read them. | §5 First-party tool plugins | (b) |
| R3 | One "Draft with these lookups" confirmation per draft is granular enough before a cloud tool receives Gmail-derived values. | §5 Context lookups | (a), (b) |
| R4 | A time-boxed agent session per tool class (Gmail default 15 min) is granular enough for MCP tool calls and for `resources/read` of mail. | §5 Agent access, §6 | (a) |
| R5 | Gmail auto-drafts may run a `cloud-tool` lookup that receives no Gmail data without a per-draft confirmation. If the review rejects this, Gmail auto-drafts run only `local` and `local-network` lookups. | §5 Tool invocations | (a), (b) |

For each reading, M0.29's consent review records `consistent`, `inconsistent` or `unclear`, with the sentence it rests on, and ADR 0010 carries the result. R2–R5 stay open for the pre-launch legal review whatever the result (plan §16); R1 is what S8 itself must confirm. The prompt-injection measures (d) are §5's hub-bound tool arguments, hygiene, spotlighting, typed results, flags and per-item approval.

## Disclosure placement (guardrail 5)

The DraftYak disclosure comes immediately before the Google consent and before any AI or agent consent (sentence (c)). In session 1 the owner goes through the consent screen with the disclosure text the BYO wizard will show, and M0.29 records the order of the screens, not their contents.

## Shapes the session can't provoke

"Mail sending" (429 with a time to retry) locks sending for hours, so it is never provoked; its shape comes from the message texts in [Resolve errors](https://developers.google.com/workspace/gmail/api/guides/handle-errors) and the fake (`test/google-errors.ts`). `src/classify.ts` tells it from "Too many concurrent requests for user" by the message text alone, so it doesn't depend on an error reason the page doesn't pin down. Without a time to retry, "Mail sending" counts as past `deliverBy` (missed), never as a short retry. M0.29 provokes only the concurrency 429, with bounded parallel reads, and records its shape.
