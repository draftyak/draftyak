// The session console in real browsers (Chromium and WebKit, the builds @playwright/test 1.64.1
// pins): the owner's forms must work from the page itself, whose Referrer-Policy decides the Origin
// a post carries (no-referrer made it "null", and the console refused every post), and the page must
// keep what the owner picked while it refreshes itself. Skips without the browsers, which
// pnpm m0:prefetch installs, and fails then under DRAFTYAK_STRICT_SKIPS=1.
import { skipOrFail } from "@draftyak/spike-kit";
import { browsersPath } from "@draftyak/spike-s03-mcp-sdk/prefetch.ts";
import type { Browser } from "@playwright/test";
import { afterAll, expect, it, type TestContext } from "vitest";
import { PRM_PATH } from "../src/routes.ts";
import { type ConsoleAction, type ConsoleView, startConsole } from "./live/console.ts";

const BROWSERS = ["chromium", "webkit"] as const;
type BrowserName = (typeof BROWSERS)[number];

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

afterAll(async () => {
	for (const launching of launched.values()) {
		await (await launching.catch(() => undefined))?.close();
	}
});

function view(progress: readonly string[]): ConsoleView {
	return {
		mcpUrl: "https://spike.example/mcp",
		checkUrl: `https://spike.example${PRM_PATH}`,
		phase: "steps",
		routes: {
			thisMachine: "reached over the tailnet",
			browser: "reached over the tailnet",
			publicIngress: "confirmed by the phone check",
		},
		step: { client: "chatgpt", title: "ChatGPT developer mode", endsAt: Date.now() + 600_000 },
		instructions: ["the client's steps"],
		pending: [
			{
				uid: "uid-for-the-console-test",
				ref: "e-test",
				client: "chatgpt",
				clientName: "ChatGPT",
				redirectHost: "chatgpt.com",
				scopes: ["inbox:read"],
				startedAt: Date.now(),
				requester: "203.0.113.5 (documentation)",
				userAgent: "a browser",
			},
		],
		dcr: { open: false, closesAt: undefined },
		cleanup: undefined,
		progress,
	};
}

for (const name of BROWSERS) {
	it(`${name}: a typed code, a reason picked across refreshes, and Done reach the session`, async (ctx) => {
		const target = await browser(name, ctx);
		const actions: ConsoleAction[] = [];
		const progress = ["the first line"];
		const console_ = await startConsole({
			view: () => view(progress),
			act: (action) => {
				actions.push(action);
				return `recorded ${actions.length}`;
			},
		});
		const context = await target.newContext();
		try {
			const page = await context.newPage();
			// A reload clears this; browsers may restore form values after one, so the values alone
			// wouldn't show whether the page held still.
			const mark = () => page.evaluate(() => Object.assign(window, { heldStill: true }));
			const heldStill = () => page.evaluate(() => "heldStill" in window);
			await page.goto(`${console_.url}/`);

			// The page refreshes every 3 s while idle; a half-typed code holds it, focus or not.
			await page.fill("input[name=code]", "4");
			await page.click("h1");
			await mark();
			await page.waitForTimeout(4_500);
			expect(await heldStill()).toBe(true);
			await page.fill("input[name=code]", "42");
			await page.click("text=Approve");
			await expect.poll(() => actions.length).toBe(1);
			expect(actions[0]).toStrictEqual({ kind: "approve", code: "42" });
			await page.waitForSelector("text=recorded 1");

			// So do a picked answer and reason.
			await page.selectOption("select[name=writeTool]", "not-offered");
			await page.selectOption("select[name=reason]", "no-time");
			await page.click("h1");
			await mark();
			await page.waitForTimeout(4_500);
			expect(await heldStill()).toBe(true);
			expect(await page.inputValue("select[name=reason]")).toBe("no-time");
			expect(await page.inputValue("select[name=writeTool]")).toBe("not-offered");
			await page.click("button[value=blocked]");
			await expect.poll(() => actions.length).toBe(2);
			expect(actions[1]).toStrictEqual({
				kind: "step",
				client: "chatgpt",
				decision: { kind: "blocked", reason: "no-time" },
				writeTool: "not-offered",
			});

			// Idle again, the page refreshes and shows what is new.
			await page.waitForSelector("text=recorded 2");
			await mark();
			progress.push("a later line");
			await page.waitForSelector("text=a later line", { timeout: 10_000 });
			expect(await heldStill()).toBe(false);

			await page.selectOption("select[name=writeTool]", "allowed");
			await page.click("button[value=done]");
			await expect.poll(() => actions.length).toBe(3);
			expect(actions[2]).toStrictEqual({
				kind: "step",
				client: "chatgpt",
				decision: { kind: "done" },
				writeTool: "allowed",
			});
		} finally {
			await context.close();
			await console_.close();
		}
	});
}
