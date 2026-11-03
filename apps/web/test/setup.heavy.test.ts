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
} from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ARTIFACTS = path.join(ROOT, "test-results");
const requests: string[] = [];
let server: Server | undefined;
let engine: BrowserServer | undefined;
let browser: Browser | undefined;
let origin = "";

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
	mkdirSync(ARTIFACTS, { recursive: true });
	expect(existsSync(chromium.executablePath()), "The pinned Chromium artifact is required").toBe(
		true,
	);
	engine = await chromium.launchServer({ channel: "chromium", headless: true, host: "127.0.0.1" });
	browser = await chromium.connect(engine.wsEndpoint());
}, 60_000);

afterAll(async () => {
	const child = engine?.process();
	await browser?.close();
	await engine?.close();
	await new Promise<void>((resolve) => {
		if (server?.listening) server.close(() => resolve());
		else resolve();
	});
	const exited = child === undefined || child.exitCode !== null || child.signalCode !== null;
	mkdirSync(ARTIFACTS, { recursive: true });
	writeFileSync(
		path.join(ARTIFACTS, "browser-cleanup.json"),
		JSON.stringify({ pid: child?.pid ?? null, exited, listenerClosed: !server?.listening }) + "\n",
	);
	expect(exited).toBe(true);
	expect(server?.listening ?? false).toBe(false);
});

async function pageWithBridge(bridge: boolean): Promise<{ context: BrowserContext; page: Page }> {
	if (browser === undefined) throw new Error("Browser fixture unavailable");
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
		await context.close();
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
		await context.close();
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
		await context.close();
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
		await context.close();
	}
});
