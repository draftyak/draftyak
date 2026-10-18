// The session console: a loopback-only page standing in for the paired desktop. The owner checks the
// routes, types each sign-in's 2-digit code, ends each client's step (done, or blocked with a fixed
// reason) and confirms the clean-up here. Funnel never reaches it, a random path segment keeps other
// pages' forms out, and it accepts only its own Host and, on a post, its own Origin or none.
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { escapeHtml } from "../../src/provider.ts";
import {
	CLIENTS,
	type ClientName,
	type Decision,
	OWNER_REASONS,
	type OwnerReason,
	WRITE_TOOL_ANSWERS,
	type WriteToolAnswer,
} from "./record.ts";

export interface PendingSignIn {
	readonly uid: string;
	// The end of its consent page's address (…/oauth/interaction/<uid>), to tell sign-ins apart.
	readonly ref: string;
	readonly client: string;
	readonly clientName: string;
	readonly redirectHost: string;
	readonly scopes: readonly string[];
	readonly startedAt: number;
	// The requester the trusted proxy names, with its class, and its user agent: shown here only.
	readonly requester: string;
	readonly userAgent: string;
}

export type Phase = "route checks" | "steps" | "clean-up" | "finished";

export interface ConsoleView {
	readonly mcpUrl: string;
	// The protected resource metadata through Funnel, for the browser and phone checks.
	readonly checkUrl: string;
	readonly phase: Phase;
	readonly routes: {
		readonly thisMachine: string;
		readonly browser: string;
		readonly publicIngress: string;
	};
	readonly step:
		| { readonly client: ClientName; readonly title: string; readonly endsAt: number }
		| undefined;
	readonly instructions: readonly string[];
	readonly pending: readonly PendingSignIn[];
	readonly dcr: { readonly open: boolean; readonly closesAt: number | undefined };
	readonly cleanup:
		| {
				readonly steps: readonly string[];
				readonly awaitingOwner: boolean;
				readonly status: string;
		  }
		| undefined;
	readonly progress: readonly string[];
}

export type ConsoleAction =
	| { readonly kind: "approve"; readonly code: string }
	| { readonly kind: "deny"; readonly uid: string }
	| {
			readonly kind: "step";
			readonly client: ClientName;
			readonly decision: Decision;
			readonly writeTool?: WriteToolAnswer;
	  }
	| { readonly kind: "start" }
	| { readonly kind: "cleaned-up" };

export interface ConsoleOptions {
	readonly view: () => ConsoleView;
	// Carries out the owner's action and returns the notice the page shows until the next one.
	readonly act: (action: ConsoleAction) => string;
}

export interface SessionConsole {
	readonly url: string;
	close(): Promise<void>;
}

// The page reloads itself every 3 s, except while the owner is using it: a focused field, a typed
// code, a picked choice or selected text. A plain meta refresh reset a picked reason.
const RELOAD =
	"(()=>{const busy=()=>{const a=document.activeElement;" +
	"return !!(a&&a.matches('input,select,textarea'))||String(getSelection()).trim()!==''||" +
	"[...document.querySelectorAll('input[name=code],select')].some((e)=>e.value!=='')};" +
	"setInterval(()=>{if(!busy())location.reload()},3000)})()";

const CSP = [
	"default-src 'none'",
	`script-src 'sha256-${createHash("sha256").update(RELOAD).digest("base64")}'`,
	"style-src 'unsafe-inline'",
	"form-action 'self'",
	"base-uri 'none'",
	"frame-ancestors 'none'",
].join("; ");

const h = escapeHtml;
const left = (at: number): string =>
	`${Math.max(0, Math.ceil((at - Date.now()) / 60_000))} min left`;
const clock = (at: number): string => new Date(at).toLocaleTimeString("en-GB", { hour12: false });
const options = (choices: Readonly<Record<string, string>>, prompt: string): string =>
	`<option value="">${h(prompt)}</option>${Object.entries(choices)
		.map(([key, text]) => `<option value="${h(key)}">${h(text)}</option>`)
		.join("")}`;

function routesSection(view: ConsoleView, base: string): string {
	const { routes } = view;
	const start =
		view.phase === "route checks"
			? `<form method="post" action="${base}/start"><button>Start the steps without the remaining checks</button></form>`
			: "";
	return `<h2>Routes to this AS</h2><ul>
<li>This machine (the test's own check): ${h(routes.thisMachine)}.</li>
<li>Your browser on this machine: ${h(routes.browser)}. Open <a href="${h(view.checkUrl)}?check=browser" target="_blank" rel="noreferrer">the public check</a>: it shows a small JSON document.</li>
<li>Funnel's public route, which claude.ai and ChatGPT use: ${h(routes.publicIngress)}. On a phone with Tailscale off, on mobile data, open <code>${h(view.checkUrl)}?check=phone</code>.</li>
</ul>${start}`;
}

function pendingSection(view: ConsoleView, base: string): string {
	if (view.pending.length === 0) {
		return "<h2>Sign-ins waiting for your code</h2><p>No sign-in is waiting.</p>";
	}
	// Newest first; the view lists them in the order they started.
	const entries = [...view.pending]
		.reverse()
		.map(
			(
				item,
			) => `<div class="sign-in"><p><strong>${h(item.clientName)}</strong> (self-declared; ${h(item.client)}) asks for ${h(item.scopes.join(", "))}, answered to <strong>${h(item.redirectHost)}</strong>.<br>Started ${clock(item.startedAt)} from ${h(item.requester)}, ${h(item.userAgent)}. Its DraftYak page's address ends with <code>${h(item.ref)}</code>.</p>
<form method="post" action="${base}/deny"><input type="hidden" name="uid" value="${h(item.uid)}"><button>Deny this sign-in</button></form></div>`,
		)
		.join("");
	return `<h2>Sign-ins waiting for your code</h2>
<form method="post" action="${base}/approve"><label>Code shown on the DraftYak page: <input name="code" inputmode="numeric" pattern="[0-9]{2}" maxlength="2" autocomplete="off" required></label> <button>Approve</button></form>
<p>The code approves the waiting sign-in whose page shows it. Deny any sign-in you didn't start.</p>${entries}`;
}

function stepSection(view: ConsoleView, base: string): string {
	if (!view.step) return view.phase === "steps" ? "<h2>No client step is active</h2>" : "";
	const { client, title, endsAt } = view.step;
	const writeTool =
		client === "chatgpt"
			? `<p><label>What ChatGPT showed for the write tool draft_create: <select name="writeTool" required>${options(WRITE_TOOL_ANSWERS, "choose")}</select></label></p>`
			: "";
	return `<h2>Now: ${h(title)} (${left(endsAt)})</h2><pre>${h(view.instructions.join("\n"))}</pre>
<form method="post" action="${base}/step"><input type="hidden" name="client" value="${h(client)}">${writeTool}
<p><button name="action" value="done">Done with ${h(title)}</button></p>
<p><select name="reason">${options(OWNER_REASONS, "choose the closest reason")}</select> <button name="action" value="blocked" formnovalidate>Blocked</button></p></form>`;
}

function cleanupSection(view: ConsoleView, base: string): string {
	if (!view.cleanup) return "";
	const button = view.cleanup.awaitingOwner
		? `<form method="post" action="${base}/cleanup"><button>I removed the connectors</button></form>`
		: "";
	return `<h2>Clean-up</h2><pre>${h(view.cleanup.steps.join("\n"))}</pre>${button}<p>${h(view.cleanup.status)}</p>`;
}

function page(view: ConsoleView, base: string, notice: string): string {
	const dcr = view.dcr.open
		? `open (${left(view.dcr.closesAt ?? 0)})`
		: "closed (open it with <code>pnpm --filter @draftyak/spike-s04-oauth-as dcr-window</code> in a second terminal, only for a client that fails CIMD)";
	return `<!doctype html><html lang="en"><meta charset="utf-8"><title>DraftYak S4 session console</title>
<style>body{font:15px system-ui,sans-serif;margin:1.5em;max-width:60em}pre{background:#f4f4f4;padding:.8em;white-space:pre-wrap}.sign-in{border:2px solid #c60;padding:.5em 1em;margin:.5em 0}.notice{background:#ffd;padding:.5em}</style>
<h1>DraftYak S4 live session (${h(view.phase)})</h1>
${notice ? `<p class="notice">${h(notice)}</p>` : ""}
<p>MCP server URL to add in each client: <code>${h(view.mcpUrl)}</code></p>
${routesSection(view, base)}
${pendingSection(view, base)}
${stepSection(view, base)}
${cleanupSection(view, base)}
<h2>DCR window</h2><p>${dcr}</p>
<h2>Progress</h2><pre>${h(view.progress.slice(-40).join("\n"))}</pre>
<script>${RELOAD}</script></html>`;
}

const isClient = (value: string): value is ClientName => CLIENTS.includes(value as ClientName);

export async function startConsole(options: ConsoleOptions): Promise<SessionConsole> {
	const token = randomBytes(18).toString("base64url");
	const base = `/${token}`;
	let origin = "";
	let notice = "";
	const app = new Hono();
	// Its own Host only (no DNS rebinding), and for posts its own Origin or none. same-origin keeps
	// the Origin on the page's own posts (no-referrer made browsers send Origin: null) and sends no
	// Referer, so the random path never leaves the page.
	app.use("*", async (c, next) => {
		const host = c.req.header("host");
		const from = c.req.header("origin");
		if (
			`http://${host}` !== origin ||
			(c.req.method === "POST" && from !== undefined && from !== origin)
		) {
			return c.text("forbidden", 403);
		}
		c.header("content-security-policy", CSP);
		c.header("cache-control", "no-store");
		c.header("referrer-policy", "same-origin");
		c.header("x-frame-options", "DENY");
		await next();
	});
	const back = (c: Context, message: string) => {
		notice = message;
		return c.redirect(`${base}/`, 303);
	};
	app.get(`${base}/`, (c) => c.html(page(options.view(), base, notice)));
	app.get(`${base}/state`, (c) => c.json(options.view()));
	app.post(`${base}/approve`, async (c) => {
		const code = String((await c.req.parseBody()).code ?? "").trim();
		if (!/^\d{2}$/.test(code)) return back(c, "Type the 2-digit code the DraftYak page shows.");
		return back(c, options.act({ kind: "approve", code }));
	});
	app.post(`${base}/deny`, async (c) => {
		const uid = String((await c.req.parseBody()).uid ?? "");
		return back(c, options.act({ kind: "deny", uid }));
	});
	app.post(`${base}/step`, async (c) => {
		const form = await c.req.parseBody();
		const client = String(form.client ?? "");
		if (!isClient(client)) return back(c, "Unknown client.");
		const reason = String(form.reason ?? "");
		const answer = String(form.writeTool ?? "");
		const writeTool = Object.hasOwn(WRITE_TOOL_ANSWERS, answer)
			? (answer as WriteToolAnswer)
			: undefined;
		if (form.action === "blocked") {
			if (!Object.hasOwn(OWNER_REASONS, reason)) {
				return back(c, "Choose the closest reason, then press Blocked.");
			}
			const decision: Decision = { kind: "blocked", reason: reason as OwnerReason };
			return back(
				c,
				options.act({
					kind: "step",
					client,
					decision,
					...(client === "chatgpt" ? { writeTool: writeTool ?? "not-tried" } : {}),
				}),
			);
		}
		if (form.action !== "done") return back(c, "Press Done or Blocked.");
		if (client === "chatgpt" && writeTool === undefined) {
			return back(c, "Choose what ChatGPT showed for draft_create, then press Done.");
		}
		return back(
			c,
			options.act({
				kind: "step",
				client,
				decision: { kind: "done" },
				...(writeTool === undefined ? {} : { writeTool }),
			}),
		);
	});
	app.post(`${base}/start`, (c) => back(c, options.act({ kind: "start" })));
	app.post(`${base}/cleanup`, (c) => back(c, options.act({ kind: "cleaned-up" })));
	app.notFound((c) => c.text("not found", 404));
	const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false }) as Server;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject).listen(0, "127.0.0.1", () => resolve());
	});
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		url: `${origin}${base}`,
		close: () =>
			new Promise<void>((done) => {
				server.close(() => done());
				server.closeAllConnections();
			}),
	};
}
