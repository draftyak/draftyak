import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Fingerprint, skipOrFail, writeEvidence } from "@draftyak/spike-kit";
import type { Browser, BrowserContext, Frame, Page } from "@playwright/test";
import type { Plugin } from "vite";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	type RunnerTask,
	type TestContext,
} from "vitest";
import { browsersPath } from "../prefetch.ts";
import {
	cspFor,
	DRAFT_VIEW,
	loadViews,
	MAX_VIEW_BYTES,
	pinProblem,
	UI_EXTENSION,
	UI_MIME_TYPE,
	VIEWS_MANIFEST,
	type View,
} from "../src/apps.ts";
import { createHub } from "../src/resources.ts";
import { createApp } from "../src/server.ts";
import { buildView, buildViews } from "../views/build.ts";
import { renderDraft } from "../views/draft-v1/render.ts";
import { DRAFT_IDS, type DraftCase, draftFixtures, xssCorpus } from "./apps-corpus.ts";
import {
	BASIC_HOST_CSP,
	buildHost,
	RECORDER,
	type Sites,
	startSites,
	VENDOR_HOST,
} from "./apps-harness.ts";
import { codeFingerprint, recording } from "./evidence.ts";
import { legacy, modern, serve } from "./harness.ts";

const BROWSERS = ["chromium", "webkit"] as const;
type BrowserName = (typeof BROWSERS)[number];
// The modes in which a host frame hands the view its result.
const MODES = ["sandbox", "direct"] as const;
type Mode = (typeof MODES)[number];
// The CSP control and the jitless check also load the view as the top document, as a WebView that
// loads it itself would: WebKit reports eval there, but not inside srcdoc or document.write frames.
const CONTROL_MODES = ["sandbox", "direct", "top"] as const;
const JITLESS_MODES = ["srcdoc", "top"] as const;
const CASES: readonly DraftCase[] = ["plain", "corpus", "bidi", "large", "proto"];
const HANDSHAKE = ["ui/initialize", "ui/notifications/initialized"];
const SIZE_CHANGED = "ui/notifications/size-changed";
// Sent by the basic host's sandbox proxy itself, never relayed from the view.
const PROXY_READY = "ui/notifications/sandbox-proxy-ready";
const SETTLE_MS = 500;
// Once the last draft rendered, the pages stay open until no message has arrived for QUIET_MS (at
// most WATCH_LIMIT_MS), so a view that sends something later than the first look is still seen.
const QUIET_MS = 2_500;
const WATCH_LIMIT_MS = 15_000;
const viewsRoot = path.resolve(import.meta.dirname, "..", "views");
const work = mkdtempSync(path.join(os.tmpdir(), "draftyak-s03-apps-"));

const once = <T>(make: () => Promise<T>): (() => Promise<T>) => {
	let made: Promise<T> | undefined;
	return () => {
		made ??= make();
		return made;
	};
};

const builtViews = once(async () => {
	const entries = await buildViews(path.join(work, "views"));
	return { entries, views: loadViews(path.join(work, "views")) };
});

// The view as built, but configuring zod after importing the SDK (only the App constructor's own
// z.config call left), to see what the early call prevents.
const lateJitless: Plugin = {
	name: "draftyak:late-jitless",
	transform(code, id) {
		if (!id.endsWith("/draft-v1/main.ts")) return null;
		if (!code.includes('import "./jitless.ts";'))
			this.error("main.ts no longer imports jitless.ts");
		return code.replace('import "./jitless.ts";', "");
	},
};
const lateJitlessView = once(() => buildView(path.join(viewsRoot, "draft-v1"), [lateJitless]));

interface Hosted {
	readonly sites: Sites;
	readonly view: View;
	readonly drafts: Record<DraftCase, Record<string, unknown>>;
}

let started: Promise<Hosted> | undefined;
const hosted = (): Promise<Hosted> => {
	started ??= startHosted();
	return started;
};
async function startHosted(): Promise<Hosted> {
	const { views } = await builtViews();
	const drafts: Record<string, unknown> = {};
	const sites = await startSites(createApp({ hub: createHub({ apps: { views, drafts } }) }));
	const fixtures = draftFixtures(sites.canary);
	for (const name of CASES) drafts[DRAFT_IDS[name]] = fixtures[name];
	sites.serve(await buildHost(`${sites.sandbox}/sandbox.html`, path.join(work, "host")));
	const view = views.find((entry) => entry.uri === DRAFT_VIEW);
	if (view === undefined) throw new Error(`no ${DRAFT_VIEW} built`);
	return { sites, view, drafts: fixtures };
}

const launched = new Map<BrowserName, Promise<Browser>>();
async function browser(name: BrowserName, ctx: TestContext): Promise<Browser> {
	let dir: string;
	try {
		dir = browsersPath();
	} catch (error) {
		return skipOrFail(ctx, error instanceof Error ? error.message : String(error));
	}
	let launching = launched.get(name);
	if (launching === undefined) {
		// Playwright reads its browsers folder once, when it loads: the cache, never the user profile.
		process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
		launching = import("@playwright/test").then((playwright) => playwright[name].launch());
		launched.set(name, launching);
	}
	try {
		return await launching;
	} catch (error) {
		launched.delete(name);
		if (!/Executable doesn't exist/.test(String(error))) throw error;
		return skipOrFail(ctx, `Playwright's ${name} isn't in ${dir}: run pnpm m0:prefetch`);
	}
}

// A frame evaluation waits without limit for the frame's next document, so a payload that
// navigated a frame would otherwise hold the test until the tier's timeout.
function bounded<T>(task: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms);
	});
	return Promise.race([task, late]).finally(() => clearTimeout(timer));
}

async function until<T>(
	probe: () => Promise<T | undefined> | T | undefined,
	what: string,
): Promise<T> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const left = Math.max(1, deadline - Date.now());
		const found = await bounded(Promise.resolve(probe()), left, what).catch(() => undefined);
		if (found !== undefined) return found;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

interface Watched {
	readonly context: BrowserContext;
	readonly page: Page;
	readonly requests: { readonly frame: Frame | null; readonly url: URL }[];
	readonly external: string[];
	readonly dialogs: string[];
	readonly errors: string[];
}

// A fresh browser context with the recorder in every frame and anything that isn't loopback refused.
async function watched(target: Browser): Promise<Watched> {
	const context = await target.newContext();
	try {
		await context.addInitScript({ content: RECORDER });
		const external: string[] = [];
		await context.route(
			(url) => url.hostname !== "127.0.0.1",
			(route) => {
				external.push(new URL(route.request().url()).protocol);
				return route.abort();
			},
		);
		const requests: Watched["requests"] = [];
		context.on("request", (request) => {
			requests.push({ frame: request.frame(), url: new URL(request.url()) });
		});
		const page = await context.newPage();
		const dialogs: string[] = [];
		const errors: string[] = [];
		page.on("dialog", (dialog) => {
			dialogs.push(dialog.type());
			void dialog.dismiss();
		});
		page.on("pageerror", (error) => errors.push(error.message));
		return { context, page, requests, external, dialogs, errors };
	} catch (error) {
		await context.close();
		throw error;
	}
}

interface Opened extends Watched {
	readonly harness: Record<string, unknown>;
}

// The harness page (test/apps-host) with the vendored basic host's code, once it has run.
async function open(target: Browser, query: Record<string, string>): Promise<Opened> {
	const { sites } = await hosted();
	const base = await watched(target);
	try {
		await base.page.goto(`${sites.host}/?${new URLSearchParams(query)}`);
		const harness = await until(
			() => base.page.evaluate(() => (window as { harness?: Record<string, unknown> }).harness),
			"the harness",
		);
		return { ...base, harness };
	} catch (error) {
		await base.context.close();
		throw error;
	}
}

interface Loaded extends Watched {
	readonly frame: Frame;
}

// A view with no host: the top document of a page served over HTTP, or a srcdoc frame of an empty
// page. It waits for a host that never answers, so it renders no draft.
async function load(target: Browser, mode: "srcdoc" | "top", html: string): Promise<Loaded> {
	const { sites } = await hosted();
	const base = await watched(target);
	try {
		if (mode === "top") {
			await base.page.goto(
				sites.put(`view-${createHash("sha256").update(html).digest("hex")}`, html),
			);
			return { ...base, frame: base.page.mainFrame() };
		}
		await base.page.setContent('<iframe id="view"></iframe>');
		await base.page.evaluate((markup) => {
			(document.getElementById("view") as HTMLIFrameElement).srcdoc = markup;
		}, html);
		const frame = await until(
			() => base.page.frames().find((candidate) => candidate.url() === "about:srcdoc"),
			"the frame",
		);
		return { ...base, frame };
	} catch (error) {
		await base.context.close();
		throw error;
	}
}

const viewOf = (page: Page, mode: Mode): Promise<Frame> =>
	until(
		() =>
			page
				.frames()
				.find((frame) =>
					mode === "sandbox"
						? frame.parentFrame()?.url().endsWith("/sandbox.html")
						: frame.parentFrame() === page.mainFrame(),
				),
		"the view's frame",
	);

interface Shown {
	readonly status: string | null;
	readonly hidden: boolean;
	readonly title: string | null;
	readonly source: string | null;
	readonly notice: string | null;
	readonly body: string | null;
	readonly send: string | null;
	readonly flags: readonly (string | null)[];
}

// Runs in the view's frame (Playwright passes its source), so it uses nothing from this module.
function shownIn(): Shown {
	const text = (id: string): string | null => document.getElementById(id)?.textContent ?? null;
	const doc = document;
	return {
		status: doc.getElementById("status")?.hidden ? null : text("status"),
		hidden: doc.getElementById("draft")?.hidden !== false,
		title: text("title"),
		source: text("source"),
		notice: text("notice"),
		body: text("body"),
		send: text("send"),
		flags: [...doc.querySelectorAll("#flags li")].map((item) => item.textContent),
	};
}

const rendered = (view: Frame, what: string): Promise<Shown> =>
	until(
		() =>
			view
				.evaluate(shownIn)
				.then((state) =>
					!state.hidden || state.status === "This draft can't be shown here." ? state : undefined,
				),
		what,
	);

// What render.ts computes for a tool result, through a stand-in document with the view's ids.
function expectedFor(result: { structuredContent?: unknown }): Shown {
	const nodes = new Map<
		string,
		{ textContent: string | null; hidden: boolean; children: unknown[] }
	>();
	const node = (id: string) => {
		const found = nodes.get(id) ?? { textContent: null, hidden: id === "draft", children: [] };
		nodes.set(id, found);
		return Object.assign(found, {
			replaceChildren: (...items: unknown[]) => {
				found.children = items;
			},
		});
	};
	const doc = { getElementById: node, createElement: () => ({ textContent: null }) };
	renderDraft(doc as unknown as Document, result);
	const text = (id: string): string | null => nodes.get(id)?.textContent ?? null;
	return {
		status: nodes.get("status")?.hidden ? null : text("status"),
		hidden: nodes.get("draft")?.hidden !== false,
		title: text("title"),
		source: text("source"),
		notice: text("notice"),
		body: text("body"),
		send: text("send"),
		flags: (nodes.get("flags")?.children ?? []).map(
			(item) => (item as { textContent: string | null }).textContent,
		),
	};
}

interface Violation {
	readonly directive: string;
	readonly blockedURI: string;
	readonly disposition: string;
}

async function violationsIn(page: Page): Promise<Violation[]> {
	const found: Violation[] = [];
	for (const frame of page.frames()) {
		const list = await bounded(
			frame.evaluate(() => (window as { __violations?: Violation[] }).__violations ?? []),
			10_000,
			"reading violations",
		);
		found.push(...list);
	}
	return found;
}

interface Codegen {
	readonly function: number;
	readonly eval: number;
	readonly stringTimer: number;
}
const NO_CODEGEN: Codegen = { function: 0, eval: 0, stringTimer: 0 };

// The recorder's counts of code made from strings in a frame (-1 each if the recorder is missing).
const codegenIn = (frame: Frame): Promise<Codegen> =>
	bounded(
		frame.evaluate(() => {
			const counts = (window as { __codegen?: Codegen }).__codegen;
			return counts ? { ...counts } : { function: -1, eval: -1, stringTimer: -1 };
		}),
		10_000,
		"reading the code-generation counts",
	);
const total = (counts: Codegen): number => counts.function + counts.eval + counts.stringTimer;

async function ranAnywhere(page: Page): Promise<boolean> {
	for (const frame of page.frames()) {
		const ran = frame.evaluate(() => "__xss" in window);
		if (await bounded(ran, 10_000, "reading the payload marker")) return true;
	}
	return false;
}

const messagesIn = (page: Page): Promise<{ method?: unknown }[]> =>
	bounded(
		page.evaluate(() => (window as { __messages?: { method?: unknown }[] }).__messages ?? []),
		10_000,
		"reading the recorder",
	);

// Waits until no page's recorder has grown for QUIET_MS; returns how long it watched.
async function quiet(pages: readonly Page[]): Promise<number> {
	const start = Date.now();
	let seen = -1;
	let since = start;
	for (;;) {
		let count = 0;
		for (const page of pages) count += (await messagesIn(page)).length;
		const now = Date.now();
		if (count !== seen) [seen, since] = [count, now];
		if (now - since >= QUIET_MS || now - start >= WATCH_LIMIT_MS) return now - start;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

const tally = (items: readonly string[]): Record<string, number> =>
	Object.fromEntries(
		[...new Set(items)].toSorted().map((item) => [item, items.filter((x) => x === item).length]),
	);

// Evidence: written only when asked (DRAFTYAK_RECORD_EVIDENCE=1) or in CI, and only when every
// test in this file ran and passed with every planned case observed.
const PLANNED = [
	"build",
	"gating",
	...BROWSERS.flatMap((name) => [
		...MODES.map((mode) => `${name}.render.${mode}`),
		`${name}.metaUi`,
		`${name}.appCall`,
		...CONTROL_MODES.map((mode) => `${name}.control.${mode}`),
		`${name}.jitless`,
	]),
];
const observed = new Map<string, unknown>();
function record(key: string, outcome: unknown): void {
	onTestFinished(({ task }) => {
		if (task.result?.state === "pass") observed.set(key, outcome);
	});
}
const versions: Record<string, string> = {};

const testsIn = (suite: { readonly tasks: readonly RunnerTask[] }): RunnerTask[] =>
	suite.tasks.flatMap((task) => (task.type === "suite" ? testsIn(task) : [task]));
let thisFile: { readonly tasks: readonly RunnerTask[] } | undefined;
let print: Fingerprint | undefined;
beforeAll(async () => {
	if (recording()) print = await codeFingerprint();
});
beforeEach(({ task }) => {
	thisFile = task.file;
});

afterAll(async () => {
	for (const launching of launched.values()) await (await launching.catch(() => null))?.close();
	await (await started?.catch(() => null))?.sites.close();
	rmSync(work, { recursive: true, force: true });
	if (!recording()) return;
	const unpassed = testsIn(thisFile ?? { tasks: [] }).filter(
		(task) => task.result?.state !== "pass",
	);
	const missing = PLANNED.filter((key) => !observed.has(key));
	if (unpassed.length > 0 || missing.length > 0) {
		const why = unpassed.length > 0 ? `${unpassed.length} test(s) not run or not passed` : "";
		console.log(`evidence not recorded: ${why || `no passing case for ${missing.join(", ")}`}`);
		return;
	}
	const versionOf = (name: string): string =>
		JSON.parse(
			readFileSync(
				path.join(import.meta.dirname, "..", "node_modules", name, "package.json"),
				"utf8",
			),
		).version;
	const source = readFileSync(path.join(VENDOR_HOST, "SOURCE"), "utf8");
	const written = await writeEvidence(
		new URL(`../evidence/apps-${process.platform}-${process.arch}.json`, import.meta.url),
		{
			extAppsVersion: versionOf("@modelcontextprotocol/ext-apps"),
			playwrightVersion: versionOf("@playwright/test"),
			viteVersion: versionOf("vite"),
			singlefileVersion: versionOf("vite-plugin-singlefile"),
			serverSdkVersion: versionOf("@modelcontextprotocol/server"),
			basicHostCommit: /^Commit: ([0-9a-f]{40})$/m.exec(source)?.[1] ?? null,
			corpusPayloads: xssCorpus("").length,
			view: observed.get("build"),
			metaUi: observed.get("gating"),
			browsers: Object.fromEntries(
				BROWSERS.map((name) => [
					name,
					{
						browserVersion: versions[name] ?? null,
						render: Object.fromEntries(
							MODES.map((mode) => [mode, observed.get(`${name}.render.${mode}`)]),
						),
						metaUiWithoutResourceUri: observed.get(`${name}.metaUi`),
						appToolCall: observed.get(`${name}.appCall`),
						control: Object.fromEntries(
							CONTROL_MODES.map((mode) => [mode, observed.get(`${name}.control.${mode}`)]),
						),
						jitless: observed.get(`${name}.jitless`),
					},
				]),
			),
		},
		print ? { fingerprint: print } : {},
	);
	console.log(`evidence: ${written}`);
});

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

describe("the draft-v1 build", () => {
	it("is one HTML file of at most 256 KiB whose meta CSP pins its one inline script, as views.manifest.json records", async () => {
		const { entries } = await builtViews();
		const manifest = JSON.parse(readFileSync(path.join(work, "views", VIEWS_MANIFEST), "utf8"));
		expect(manifest).toEqual({ views: entries });
		expect(entries.map((entry) => entry.uri)).toEqual([DRAFT_VIEW]);
		const [entry] = entries;
		if (entry === undefined) throw new Error("no view built");
		const bytes = readFileSync(path.join(work, "views", entry.file));
		expect(bytes.length).toBe(entry.size);
		expect(entry.size).toBeLessThanOrEqual(MAX_VIEW_BYTES);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
		const html = bytes.toString("utf8");
		const scripts = [...html.matchAll(SCRIPT)];
		expect(scripts.map(([, attributes]) => attributes)).toEqual([' type="module" crossorigin']);
		const scriptHash = createHash("sha256")
			.update(scripts[0]?.[2] ?? "", "utf8")
			.digest("base64");
		expect(entry.csp).toBe(cspFor([scriptHash]));
		const meta = `<meta http-equiv="Content-Security-Policy" content="${entry.csp}">`;
		expect(html.indexOf(`<meta charset="utf-8">${meta}`)).toBeGreaterThan(0);
		expect(html.indexOf(meta)).toBeLessThan(html.search(/<style|<script/));
		expect(pinProblem(html, entry.csp)).toBeUndefined();
		const markup = html.replace(SCRIPT, "");
		expect(markup.match(/\b(?:src|href|action|srcset|data)\s*=|https?:|\/\//gi)).toBeNull();

		const again = await buildViews(path.join(work, "views-again"));
		expect(again).toEqual(entries);
		// The basic host's sandbox header that the harness serves, directive by directive.
		const serveTs = readFileSync(path.join(VENDOR_HOST, "serve.ts"), "utf8");
		const missing = BASIC_HOST_CSP.split("; ").filter((directive) => !serveTs.includes(directive));
		expect(missing).toEqual([]);
		record("build", {
			uri: entry.uri,
			bytes: entry.size,
			capBytes: MAX_VIEW_BYTES,
			sha256: entry.sha256,
			scriptSha256: scriptHash,
			cspDirectives: entry.csp
				.split("; ")
				.map((directive) => directive.replace(/'sha256-[^']+'/, "'sha256-…'")),
			inlineScripts: scripts.length,
			reproducible: again[0]?.sha256 === entry.sha256,
		});
	});
});

describe("_meta.ui on tools/list", () => {
	it("is on the 2025 legacy path, and on 2026-era requests only when they declare the extension, whatever the clientInfo", async () => {
		const { views } = await builtViews();
		const app = createApp({ hub: createHub({ apps: { views, drafts: {} } }) });
		const listed = async (request: Request) => {
			const tools = (await serve(app, request)).body.result.tools as {
				name: string;
				_meta?: { ui?: { resourceUri?: string } };
			}[];
			const withUi = tools.filter((tool) => tool._meta?.ui !== undefined).map((tool) => tool.name);
			const linked = tools.filter((tool) => tool._meta?.ui?.resourceUri).map((tool) => tool.name);
			return { withUi, linked };
		};
		const declared = { extensions: { [UI_EXTENSION]: { mimeTypes: [UI_MIME_TYPE] } } };
		const appsHost = { name: "claude-ai", version: "1" };
		const outcome = {
			legacy: await listed(legacy("tools/list")),
			modernDeclared: await listed(modern("tools/list", {}, { capabilities: declared })),
			modernUndeclared: await listed(modern("tools/list")),
			modernUndeclaredAppsHostName: await listed(
				modern("tools/list", {}, { clientInfo: appsHost }),
			),
		};
		const all = { withUi: ["accounts_list", "message_get", "draft_get"], linked: ["draft_get"] };
		const none = { withUi: [], linked: [] };
		expect(outcome).toEqual({
			legacy: all,
			modernDeclared: all,
			modernUndeclared: none,
			modernUndeclaredAppsHostName: none,
		});
		record("gating", outcome);
	});
});

describe.each(BROWSERS)("in %s", (name) => {
	it.for(MODES)(
		"renders every draft as text in %s mode: no script, request, dialog, code from strings or CSP violation, and the recorder sees only the handshake and size changes",
		async (mode, ctx) => {
			const target = await browser(name, ctx);
			versions[name] = target.version();
			const { sites, drafts } = await hosted();
			const pages: Opened[] = [];
			const views: Frame[] = [];
			try {
				for (const draft of CASES) {
					const args = JSON.stringify({ draftId: DRAFT_IDS[draft] });
					const query: Record<string, string> = { mode, tool: "draft_get", args };
					// The SDK's 2025 leg drops own __proto__ keys, so this draft reaches the view from the host.
					if (draft === "proto") query.structured = JSON.stringify(drafts.proto);
					const opened = await open(target, query);
					pages.push(opened);
					expect(opened.harness, draft).toMatchObject({ state: "done", app: true });
					const view = await viewOf(opened.page, mode);
					views.push(view);
					const shown = await rendered(view, `${draft} rendered`);
					expect(shown, draft).toEqual(expectedFor({ structuredContent: drafts[draft] }));
					expect(shown.hidden, draft).toBe(false);
				}
				const watchedMs = await quiet(pages.map((opened) => opened.page));
				expect(watchedMs, "the views went quiet").toBeLessThan(WATCH_LIMIT_MS);

				const cases: Record<string, unknown> = {};
				for (const [index, draft] of CASES.entries()) {
					const opened = pages[index];
					const view = views[index];
					if (opened === undefined || view === undefined) throw new Error(`no page for ${draft}`);
					const methods = (await messagesIn(opened.page)).map((message) =>
						typeof message?.method === "string" ? message.method : "(no method)",
					);
					const fromView = methods.filter((method) => method !== PROXY_READY);
					expect(fromView.slice(0, 2), draft).toEqual(HANDSHAKE);
					expect(
						fromView.slice(2).filter((method) => method !== SIZE_CHANGED),
						draft,
					).toEqual([]);
					expect(methods.filter((method) => method === PROXY_READY).length, draft).toBe(
						mode === "sandbox" ? 1 : 0,
					);

					const violations = await violationsIn(opened.page);
					expect(violations, draft).toEqual([]);
					expect(await codegenIn(view), draft).toEqual(NO_CODEGEN);
					expect(await ranAnywhere(opened.page), draft).toBe(false);
					const polluted = await bounded(
						view.evaluate(
							() =>
								(({}) as { polluted?: unknown }).polluted !== undefined ||
								Object.hasOwn(Object.prototype, "polluted"),
						),
						10_000,
						"reading Object.prototype",
					);
					expect(polluted, draft).toBe(false);
					const received = await bounded(
						view.evaluate(() => (window as { __toolResults?: string[][] }).__toolResults ?? []),
						10_000,
						"reading the tool results the view got",
					);
					expect(received.length, draft).toBeGreaterThan(0);
					const ownProto = received.some((keys) => keys.includes("__proto__"));
					expect(ownProto, draft).toBe(draft === "proto");
					const fromViewFrame = opened.requests.filter((request) => request.frame === view);
					expect(fromViewFrame, draft).toEqual([]);
					const origins = new Set(opened.requests.map((request) => request.url.origin));
					expect(
						[...origins].filter((origin) => origin !== sites.host && origin !== sites.sandbox),
						draft,
					).toEqual([]);
					expect([opened.external, opened.dialogs, opened.errors, sites.canaryHits], draft).toEqual(
						[[], [], [], []],
					);
					const shown = await view.evaluate(shownIn);
					cases[draft] = {
						rendered: !shown.hidden,
						bodyChars: shown.body?.length ?? 0,
						markers: (shown.body?.split("⟨U+").length ?? 1) - 1,
						messages: tally(methods),
						violations: violations.length,
						codeFromStrings: 0,
						viewRequests: fromViewFrame.length,
						hostRequests: opened.requests.length,
						canaryHits: sites.canaryHits.length,
						dialogs: opened.dialogs.length,
						pageErrors: opened.errors.length,
						...(draft === "proto" ? { ownProtoKeyReachedView: ownProto } : {}),
					};
				}
				record(`${name}.render.${mode}`, { quietMs: QUIET_MS, watchedMs, cases });
			} finally {
				for (const opened of pages) await opened.context.close();
			}
		},
	);

	it("accepts _meta.ui without resourceUri: a tool with no view is listed and called as a plain tool", async (ctx) => {
		const target = await browser(name, ctx);
		const opened = await open(target, { mode: "sandbox", tool: "accounts_list", args: "{}" });
		try {
			const { harness } = opened;
			expect(harness).toMatchObject({ state: "done", app: false });
			const visibility = { visibility: ["model"] };
			expect(harness.listed).toEqual([
				{ name: "accounts_list", ui: visibility, resourceUri: null },
				{ name: "message_get", ui: visibility, resourceUri: null },
				{
					name: "draft_get",
					ui: { resourceUri: DRAFT_VIEW, ...visibility },
					resourceUri: DRAFT_VIEW,
				},
			]);
			expect(harness.resources).toEqual(["draftyak://guide/agents"]);
			const result = harness.result as { content: { type: string; text: string }[] };
			expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
				accounts: [{ alias: "gmail-1", channel: "gmail", mode: "full" }],
			});
			expect(opened.page.frames()).toHaveLength(1);
			expect(await messagesIn(opened.page)).toEqual([]);
			expect(await violationsIn(opened.page)).toEqual([]);
			record(`${name}.metaUi`, {
				toolsListed: (harness.listed as unknown[]).length,
				withoutResourceUri: ["accounts_list", "message_get"],
				calledWithoutView: true,
				framesCreated: opened.page.frames().length - 1,
			});
		} finally {
			await opened.context.close();
		}
	});

	it("forwards a view's tools/call for a tool marked visibility ['model']: the basic host doesn't enforce visibility", async (ctx) => {
		const target = await browser(name, ctx);
		const { sites } = await hosted();
		const args = JSON.stringify({ draftId: DRAFT_IDS.plain });
		const opened = await open(target, { mode: "sandbox", tool: "draft_get", args });
		try {
			const listed = opened.harness.listed as { name: string; ui: unknown }[];
			expect(listed.find((tool) => tool.name === "accounts_list")?.ui).toEqual({
				visibility: ["model"],
			});
			const view = await viewOf(opened.page, "sandbox");
			await rendered(view, "the plain draft");
			const before = sites.mcpCalls.length;
			// What the App's callServerTool would send, posted from the view's frame.
			const reply = await bounded(
				view.evaluate(
					() =>
						new Promise<{ answered: boolean; isError: boolean; error: unknown }>((resolve) => {
							const id = "visibility-control";
							window.addEventListener("message", (event) => {
								const data = event.data as {
									id?: unknown;
									result?: { isError?: unknown };
									error?: { code?: unknown };
								};
								if (data?.id !== id) return;
								resolve({
									answered: data.result !== undefined,
									isError: data.result?.isError === true,
									error: data.error?.code ?? null,
								});
							});
							const params = { name: "accounts_list", arguments: {} };
							window.parent.postMessage({ jsonrpc: "2.0", id, method: "tools/call", params }, "*");
						}),
				),
				10_000,
				"the host's answer",
			);
			const calls = sites.mcpCalls.slice(before).filter((call) => call.startsWith("tools/call"));
			expect(calls).toEqual(["tools/call accounts_list"]);
			expect(reply).toEqual({ answered: true, isError: false, error: null });
			record(`${name}.appCall`, {
				tool: "accounts_list",
				visibility: ["model"],
				forwardedToServer: true,
				answeredToView: reply.answered,
			});
		} finally {
			await opened.context.close();
		}
	});

	it.for(CONTROL_MODES)(
		"enforces the view's own CSP in %s mode: injected handlers, scripts, eval, Function, a fetch and an image are blocked",
		async (mode, ctx) => {
			const target = await browser(name, ctx);
			const { sites, view: built } = await hosted();
			let loaded: Loaded;
			if (mode === "top") {
				loaded = await load(target, "top", built.html);
			} else {
				const args = JSON.stringify({ draftId: DRAFT_IDS.plain });
				const opened = await open(target, { mode, tool: "draft_get", args });
				try {
					const view = await viewOf(opened.page, mode);
					await rendered(view, "the plain draft");
					loaded = { ...opened, frame: view };
				} catch (error) {
					await opened.context.close();
					throw error;
				}
			}
			try {
				await until(
					() =>
						loaded.frame.evaluate(() => (document.readyState === "complete" ? true : undefined)),
					"the view loaded",
				);
				// Injected the way a payload would be, after the view loaded; eval runs from a timer,
				// since Playwright's own evaluation is exempt from the CSP's eval check.
				const outcome = await loaded.frame.evaluate(async (canary) => {
					const later = (run: () => void) =>
						new Promise<boolean>((resolve) =>
							setTimeout(() => {
								try {
									run();
									resolve(false);
								} catch {
									resolve(true);
								}
							}, 0),
						);
					const image = document.createElement("img");
					image.setAttribute("onerror", "window.__xss = 'inline handler'");
					image.src = "data:,";
					document.body.append(image);
					const script = document.createElement("script");
					script.textContent = "window.__xss = 'inline script'";
					document.body.append(script);
					const remote = new Image();
					remote.src = `${canary}/control-image`;
					// biome-ignore lint/security/noGlobalEval: the control checks that the view's CSP blocks eval.
					const evalBlocked = await later(() => eval("window.__xss = 'eval'"));
					const functionBlocked = await later(() => new Function("window.__xss = 'Function'")());
					const fetchBlocked = await fetch(`${canary}/control-fetch`).then(
						() => false,
						() => true,
					);
					await new Promise((resolve) => setTimeout(resolve, 300));
					return { evalBlocked, functionBlocked, fetchBlocked, ran: "__xss" in window };
				}, sites.canary);
				const directives = [
					...new Set((await violationsIn(loaded.page)).map((v) => v.directive)),
				].toSorted();
				expect(outcome).toEqual({
					evalBlocked: true,
					functionBlocked: true,
					fetchBlocked: true,
					ran: false,
				});
				const counted = await codegenIn(loaded.frame);
				expect(counted.function).toBeGreaterThan(0);
				expect(counted.eval).toBeGreaterThan(0);
				// WebKit reports eval only in a top-level document; Chromium in every frame.
				const reported = ["connect-src", "img-src", "script-src-attr", "script-src-elem"];
				const evalReported = name === "chromium" || mode === "top";
				expect(directives).toEqual(
					evalReported ? [...reported, "script-src"].toSorted() : reported,
				);
				expect([sites.canaryHits, loaded.external, loaded.dialogs]).toEqual([[], [], []]);
				record(`${name}.control.${mode}`, {
					...outcome,
					directivesReported: directives,
					codeFromStringsCounted: counted,
					canaryHits: 0,
				});
			} finally {
				await loaded.context.close();
			}
		},
	);

	it("needs zod configured before the SDK loads: built with only the App's own z.config, the view makes code from a string at load", async (ctx) => {
		const target = await browser(name, ctx);
		const { view } = await hosted();
		const variant = await lateJitlessView();
		type Load = { evalViolations: number; codeFromStrings: number };
		const outcome: Record<string, Record<string, Load>> = {};
		for (const mode of JITLESS_MODES) {
			const kinds: Record<string, Load> = {};
			outcome[mode] = kinds;
			for (const [kind, html] of [
				["view", view.html],
				["lateJitless", variant.html],
			] as const) {
				const loaded = await load(target, mode, html);
				try {
					await until(
						() =>
							loaded.frame.evaluate(() =>
								document.readyState === "complete" && document.getElementById("status")
									? true
									: undefined,
							),
						`${kind} loaded`,
					);
					await loaded.page.waitForTimeout(SETTLE_MS);
					const violations = await violationsIn(loaded.page);
					expect(
						violations.filter((v) => v.blockedURI !== "eval"),
						`${mode} ${kind}`,
					).toEqual([]);
					const counted = await codegenIn(loaded.frame);
					kinds[kind] = { evalViolations: violations.length, codeFromStrings: total(counted) };
				} finally {
					await loaded.context.close();
				}
			}
		}
		for (const mode of JITLESS_MODES) {
			expect(outcome[mode]?.view, mode).toEqual({ evalViolations: 0, codeFromStrings: 0 });
			expect(outcome[mode]?.lateJitless?.codeFromStrings, mode).toBeGreaterThan(0);
		}
		// Both browsers report the blocked probe in a top-level document; in a srcdoc frame only
		// Chromium does.
		expect(outcome.top?.lateJitless?.evalViolations).toBeGreaterThan(0);
		if (name === "chromium") expect(outcome.srcdoc?.lateJitless?.evalViolations).toBeGreaterThan(0);
		record(`${name}.jitless`, outcome);
	});
});
