import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Browser,
	type BrowserContext,
	type BrowserServer,
	expect as browserExpect,
	chromium,
	type Page,
	webkit,
} from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WEB_ENGINE = process.env.DRAFTYAK_WEB_TEST_ENGINE ?? "chromium";
if (WEB_ENGINE !== "chromium" && WEB_ENGINE !== "webkit")
	throw new Error("Browser test engine must be chromium or webkit");
const browserEngine = WEB_ENGINE === "webkit" ? webkit : chromium;
const ARTIFACTS = path.join(ROOT, "test-results", WEB_ENGINE, randomUUID());
const ARTIFACT_RELATIVE = path.relative(ROOT, ARTIFACTS).split(path.sep).join("/");
const requests: string[] = [];
let server: Server | undefined;
let engine: BrowserServer | undefined;
let browser: Browser | undefined;
let origin = "";
let artifactsOwned = false;
let launchAttempted = false;
let engineChild: ReturnType<BrowserServer["process"]> | undefined;
let engineClosed: Promise<void> | undefined;
let engineCloseObserved = false;
const contexts = new Map<BrowserContext, { closeAttempted: boolean }>();

interface Fixture {
	calls: { command: string; args?: { mode?: string } }[];
	mode: string | null;
	resolve?: () => void;
	reject?: () => void;
}
type FixtureWindow = Window & {
	isTauri: boolean;
	__SHELL_FIXTURE__: Fixture;
	__TAURI_INTERNALS__: { invoke: (command: string, args?: { mode?: string }) => Promise<unknown> };
};

beforeAll(async () => {
	const assets = new Map<string, Buffer>();
	const walk = (directory: string, prefix = ""): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const relative = prefix + "/" + entry.name;
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) walk(file, relative);
			else if (entry.isFile()) assets.set(relative, readFileSync(file));
		}
	};
	expect(
		existsSync(path.join(ROOT, "dist/index.html")),
		"Build the web app before browser checks",
	).toBe(true);
	walk(path.join(ROOT, "dist"));
	server = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		const name = pathname === "/" ? "/index.html" : pathname;
		const asset = assets.get(name);
		if (asset === undefined) {
			response.writeHead(404).end();
			return;
		}
		const type = name.endsWith(".html")
			? "text/html"
			: name.endsWith(".js")
				? "application/javascript"
				: name.endsWith(".css")
					? "text/css"
					: "application/octet-stream";
		response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
		response.end(asset);
	});
	await new Promise<void>((resolve, reject) => {
		server?.once("error", reject);
		server?.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("Browser fixture unavailable");
	origin = "http://127.0.0.1:" + address.port;
	mkdirSync(path.dirname(ARTIFACTS), { recursive: true });
	mkdirSync(ARTIFACTS);
	artifactsOwned = true;
	expect(
		existsSync(browserEngine.executablePath()),
		"The pinned selected browser artifact is required",
	).toBe(true);
	launchAttempted = true;
	engine = await browserEngine.launchServer({
		...(WEB_ENGINE === "chromium" ? { channel: "chromium" } : {}),
		headless: true,
		host: "127.0.0.1",
	});
	engineChild = engine.process();
	if (!engineChild) throw new Error("Browser engine process unavailable");
	const child = engineChild;
	engineClosed = new Promise<void>((resolve) => {
		child.once("close", () => {
			engineCloseObserved = true;
			resolve();
		});
	});
	console.info(
		"WEB_BROWSER_LAUNCH " +
			JSON.stringify({
				requestedEngine: WEB_ENGINE,
				pid: child.pid ?? null,
				artifactRelative: ARTIFACT_RELATIVE,
			}),
	);
	browser = await browserEngine.connect(engine.wsEndpoint());
	expect(browser.browserType().name()).toBe(WEB_ENGINE);
}, 60_000);

afterAll(async () => {
	let cleanupFailed = false;
	const closes: Promise<void>[] = [];
	const startClose = (close: () => Promise<void>): void => {
		closes.push(Promise.resolve().then(close));
	};
	// Retain failed tickets; start all independent owners before awaiting any close.
	for (const [context, owner] of contexts) {
		if (owner.closeAttempted) {
			cleanupFailed = true;
			continue;
		}
		startClose(() => closeContext(context));
	}
	startClose(async () => {
		await browser?.close();
	});
	startClose(async () => {
		await engine?.close();
	});
	startClose(
		() =>
			new Promise<void>((resolve, reject) => {
				if (server?.listening) server.close((error) => (error ? reject(error) : resolve()));
				else resolve();
			}),
	);
	const outcomes = await Promise.allSettled(closes);
	cleanupFailed ||= outcomes.some((outcome) => outcome.status === "rejected");
	// An exit-code snapshot is not a physical close observation. The existing hook timeout
	// remains authoritative if this close never arrives; no successful receipt is fabricated.
	if (engineClosed) await engineClosed;
	const exited = !launchAttempted || engineCloseObserved;
	if (!exited || contexts.size !== 0 || !artifactsOwned) cleanupFailed = true;
	const receipt = {
		requestedEngine: WEB_ENGINE,
		observedEngine: browser?.browserType().name() ?? null,
		artifactsOwned,
		launchAttempted,
		pid: engineChild?.pid ?? null,
		engineChildCloseObserved: engineCloseObserved,
		exited,
		pendingContexts: contexts.size,
		listenerClosed: !server?.listening,
		cleanupFailed,
	};
	if (artifactsOwned) {
		writeFileSync(path.join(ARTIFACTS, "browser-cleanup.json"), JSON.stringify(receipt) + "\n", {
			flag: "wx",
		});
	}
	console.info(
		"WEB_BROWSER_CLEANUP " +
			JSON.stringify({
				...receipt,
				artifactRelative: artifactsOwned ? ARTIFACT_RELATIVE : null,
			}),
	);
	expect(cleanupFailed).toBe(false);
	expect(exited).toBe(true);
	expect(contexts.size).toBe(0);
	expect(server?.listening ?? false).toBe(false);
});

async function closeContext(context: BrowserContext): Promise<void> {
	const owner = contexts.get(context);
	if (!owner || owner.closeAttempted) throw new Error("Browser context close unavailable");
	owner.closeAttempted = true;
	await context.close();
	contexts.delete(context);
}

async function pageWithBridge(bridge: boolean): Promise<{ context: BrowserContext; page: Page }> {
	if (browser === undefined) throw new Error("Browser fixture unavailable");
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	contexts.set(context, { closeAttempted: false });
	await context.route("**/*", (route) => {
		requests.push(route.request().url());
		return new URL(route.request().url()).origin === origin ? route.continue() : route.abort();
	});
	if (bridge) {
		await context.addInitScript(() => {
			const target = window as unknown as FixtureWindow;
			const fixture: Fixture = { calls: [], mode: null };
			target.isTauri = true;
			target.__SHELL_FIXTURE__ = fixture;
			target.__TAURI_INTERNALS__ = {
				invoke(command, args) {
					fixture.calls.push({ command, ...(args === undefined ? {} : { args }) });
					if (command === "shell_state") return Promise.resolve({ mode: fixture.mode });
					if (command !== "shell_select_mode") return Promise.reject(new Error("DYTEST"));
					return new Promise((resolve, reject) => {
						fixture.resolve = () => {
							fixture.mode = args?.mode ?? null;
							resolve({ mode: fixture.mode });
						};
						fixture.reject = () => reject(new Error("DYTEST"));
					});
				},
			};
		});
	}
	const page = await context.newPage();
	await page.goto(origin);
	return { context, page };
}

async function release(page: Page, outcome: "resolve" | "reject"): Promise<void> {
	await page.waitForFunction(
		() => typeof (window as unknown as FixtureWindow).__SHELL_FIXTURE__.resolve === "function",
	);
	await page.evaluate((action) => {
		const fixture = (window as unknown as FixtureWindow).__SHELL_FIXTURE__;
		const settle = action === "resolve" ? fixture.resolve : fixture.reject;
		delete fixture.resolve;
		delete fixture.reject;
		settle?.();
	}, outcome);
}

it("renders the built browser fallback without a native session or remote content", async () => {
	const { context, page } = await pageWithBridge(false);
	try {
		await browserExpect(page.getByRole("heading", { level: 1 })).toHaveText(
			"An inbox that feelsa little more yours.",
		);
		await browserExpect(page.getByText("Open the desktop app to save your choice.")).toBeVisible();
		for (const radio of await page.getByRole("radio").all())
			await browserExpect(radio).toBeDisabled();
		await browserExpect(page.getByRole("button", { name: "Save choice" })).toBeDisabled();
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		await page.screenshot({ path: path.join(ARTIFACTS, "shell-fallback.png"), fullPage: true });
		expect(requests.every((url) => new URL(url).origin === origin)).toBe(true);
	} finally {
		await closeContext(context);
	}
});

it("waits for the actual bridge acknowledgement and can change a saved mode", async () => {
	const { context, page } = await pageWithBridge(true);
	try {
		await browserExpect(page.getByRole("radio").first()).toBeEnabled();
		await page.getByText("On this computer", { exact: true }).click();
		await page.getByRole("button", { name: "Save choice" }).click();
		await browserExpect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
		await browserExpect(page.getByRole("radio").first()).toBeDisabled();
		await browserExpect(page.getByText("Saved for this session")).toHaveCount(0);
		await release(page, "resolve");
		await browserExpect(page.getByText("Saved for this session")).toBeVisible();
		await browserExpect(page.getByRole("button", { name: "Save choice" })).toBeDisabled();
		await page.getByText("Connect to my hub", { exact: true }).click();
		await page.getByRole("button", { name: "Save choice" }).click();
		await release(page, "resolve");
		await browserExpect(page.getByRole("radio", { name: /Connect to my hub/ })).toBeChecked();
		await browserExpect(page.getByRole("button", { name: "Save choice" })).toBeDisabled();
		await browserExpect(page.locator(".selection-status")).toContainText("Connect to a hub");
		expect(
			await page.evaluate(() => (window as unknown as FixtureWindow).__SHELL_FIXTURE__.calls),
		).toEqual([
			{ command: "shell_state", args: {} },
			{ command: "shell_select_mode", args: { mode: "hub" } },
			{ command: "shell_select_mode", args: { mode: "connect" } },
		]);
		await page.screenshot({ path: path.join(ARTIFACTS, "shell-selected.png"), fullPage: true });
	} finally {
		await closeContext(context);
	}
});

it("keeps a refused choice unsaved and retries without a local success", async () => {
	const { context, page } = await pageWithBridge(true);
	try {
		await browserExpect(page.getByRole("radio").first()).toBeEnabled();
		await page.getByText("On this computer", { exact: true }).click();
		await page.getByRole("button", { name: "Save choice" }).click();
		await release(page, "reject");
		await browserExpect(page.getByRole("alert")).toHaveText("Your choice wasn’t saved. Try again.");
		await browserExpect(page.getByText("Saved for this session")).toHaveCount(0);
		await page.getByRole("button", { name: "Try again" }).click();
		await release(page, "resolve");
		await browserExpect(page.getByText("Saved for this session")).toBeVisible();
		expect(
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).__SHELL_FIXTURE__.calls.filter(
					(call) => call.command === "shell_select_mode",
				),
			),
		).toHaveLength(2);
	} finally {
		await closeContext(context);
	}
});

it("keeps the narrow layout and native radio keyboard interaction usable", async () => {
	const { context, page } = await pageWithBridge(true);
	try {
		await page.setViewportSize({ width: 390, height: 844 });
		const first = page.getByRole("radio").first();
		await browserExpect(first).toBeEnabled();
		await first.focus();
		await page.keyboard.press("ArrowRight");
		await browserExpect(page.getByRole("radio", { name: /Connect to my hub/ })).toBeChecked();
		await browserExpect(page.getByRole("button", { name: "Save choice" })).toBeEnabled();
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		await page.screenshot({ path: path.join(ARTIFACTS, "shell-narrow.png"), fullPage: true });
	} finally {
		await closeContext(context);
	}
});
