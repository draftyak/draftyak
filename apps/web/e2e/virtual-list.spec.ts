import { test as base, expect, type Page } from "@playwright/test";

type Mode = "ready" | "reverse" | "empty" | "loading" | "error" | "large" | "duplicate" | "hostile";
interface Stats {
	readonly selections: number;
	readonly lastId: string | null;
	readonly retries: number;
}
declare global {
	interface Window {
		setVirtualListModeForTest?: (mode: Mode) => void;
		virtualListStatsForTest?: () => Stats;
		readonly virtualListCspCountForTest: number;
		readonly virtualListUnsafeExecutedForTest: boolean;
	}
}
const CSP = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self'",
	"connect-src 'none'",
	"img-src 'none'",
	"frame-src 'none'",
	"object-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
	"frame-ancestors 'none'",
	"require-trusted-types-for 'script'",
	"trusted-types 'none'",
].join("; ");
const id = (value: number): string => String(value).padStart(26, "0");
const button = (page: Page, value: number) =>
	page.getByRole("button", { name: new RegExp(`^DYTEST Conversation ${value} Email `) });
const test = base.extend<{ browserGuard: { mounted(): void } }>({
	browserGuard: [
		async ({ page, context, baseURL }, use) => {
			if (baseURL === undefined) throw new Error("DYTEST missing loopback origin");
			const origin = new URL(baseURL).origin;
			const raw: unknown = JSON.parse(process.env.DRAFTYAK_E2E_ALLOWED_PATHS ?? "null");
			if (
				!Array.isArray(raw) ||
				!raw.includes("/virtual-list.html") ||
				new Set(raw).size !== raw.length ||
				raw.some(
					(value) =>
						typeof value !== "string" ||
						!/^\/[A-Za-z0-9_./-]+$/.test(value) ||
						value.startsWith("//") ||
						value.split("/").some((part) => part === "." || part === "..") ||
						(value !== "/virtual-list.html" && !value.endsWith(".js") && !value.endsWith(".css")),
				)
			)
				throw new Error("DYTEST invalid asset catalogue");
			const allowed = new Set(raw as string[]);
			const counts = {
				pageErrors: 0,
				consoleErrors: 0,
				postMountRequests: 0,
				blockedRequests: 0,
				sockets: 0,
				popups: 0,
				dialogs: 0,
				cleanupErrors: 0,
			};
			const joins: Promise<void>[] = [];
			let mounted = false;
			page.on("pageerror", () => {
				counts.pageErrors++;
			});
			page.on("console", (message) => {
				if (message.type() === "error") counts.consoleErrors++;
			});
			page.on("websocket", () => {
				counts.sockets++;
			});
			context.on("page", (opened) => {
				counts.popups++;
				joins.push(
					opened.close().catch(() => {
						counts.cleanupErrors++;
					}),
				);
			});
			page.on("dialog", (dialog) => {
				counts.dialogs++;
				joins.push(
					dialog.dismiss().catch(() => {
						counts.cleanupErrors++;
					}),
				);
			});
			await context.route("**/*", async (route) => {
				const request = route.request();
				const url = new URL(request.url());
				if (mounted) counts.postMountRequests++;
				const kind =
					url.pathname === "/virtual-list.html"
						? request.resourceType() === "document"
						: url.pathname.endsWith(".js")
							? request.resourceType() === "script"
							: url.pathname.endsWith(".css") && request.resourceType() === "stylesheet";
				if (
					request.method() !== "GET" ||
					url.origin !== origin ||
					url.search ||
					url.hash ||
					!allowed.has(url.pathname) ||
					!kind
				) {
					counts.blockedRequests++;
					await route.abort("blockedbyclient");
				} else await route.continue();
			});
			await use({
				mounted: () => {
					mounted = true;
				},
			});
			await page.waitForLoadState("networkidle");
			await Promise.allSettled(joins);
			for (const value of Object.values(counts)) expect(value).toBe(0);
			expect(await page.evaluate(() => window.virtualListCspCountForTest)).toBe(0);
			expect(await page.evaluate(() => window.virtualListUnsafeExecutedForTest)).toBe(false);
			expect(await page.locator("[style]").count()).toBe(0);
		},
		{ auto: true },
	],
});
test.beforeEach(async ({ page, browserGuard }) => {
	const response = await page.goto("/virtual-list.html");
	expect(response !== null).toBe(true);
	expect(await response?.headerValue("content-security-policy")).toBe(CSP);
	await expect(
		page.getByRole("heading", { name: "Virtual conversation list fixture", exact: true }),
	).toBeVisible();
	await expect(page.locator("html")).toHaveAttribute("data-virtual-list-fixture-ready", "true");
	await page.waitForLoadState("networkidle");
	browserGuard.mounted();
});
async function mode(page: Page, value: Mode): Promise<void> {
	await page.evaluate((value) => {
		const set = window.setVirtualListModeForTest;
		if (set === undefined) throw new Error("DYTEST fixture unavailable");
		set(value);
	}, value);
}
async function stats(page: Page): Promise<Stats> {
	return page.evaluate(() => {
		const read = window.virtualListStatsForTest;
		if (read === undefined) throw new Error("DYTEST fixture unavailable");
		return read();
	});
}

test("real CSS and virtualizer render a bounded changing window with canonical selection", async ({
	page,
}) => {
	const list = page.getByRole("list", { name: "Conversations", exact: true });
	const viewport = page.locator(".inbox-panel__viewport");
	const geometry = await viewport.evaluate((element) => ({
		height: element.clientHeight,
		total: element.scrollHeight,
	}));
	expect(geometry.height).toBeGreaterThan(0);
	expect(geometry.height).toBeLessThanOrEqual(640);
	expect(geometry.total).toBe(1000 * 320);
	expect(await list.getByRole("listitem").count()).toBeLessThan(20);
	await expect(button(page, 500)).toHaveCount(0);
	await viewport.evaluate((element) => {
		element.scrollTop = 499 * 320;
	});
	await expect(button(page, 500)).toBeInViewport({ ratio: 0.9 });
	await expect(button(page, 500)).toHaveAttribute("aria-current", "true");
	await expect(button(page, 500).locator("..")).toHaveAttribute("aria-posinset", "500");
	await expect(button(page, 500).locator("..")).toHaveAttribute("aria-setsize", "1000");
	await expect(button(page, 1)).toHaveCount(0);
	expect(await list.getByRole("listitem").count()).toBeLessThan(20);
	await button(page, 500).click();
	expect(await stats(page)).toEqual({ selections: 1, lastId: id(500), retries: 0 });
});

test("native End Home and arrows move focus and scroll without activation", async ({ page }) => {
	const viewport = page.locator(".inbox-panel__viewport");
	await button(page, 1).focus();
	await viewport.evaluate((element) => {
		element.scrollTop = 499 * 320;
	});
	await expect(button(page, 500)).toBeInViewport({ ratio: 0.9 });
	await expect(button(page, 1)).toBeFocused();
	const beforeEnd = await viewport.evaluate((element) => element.scrollTop);
	expect(beforeEnd).toBe(499 * 320);
	await page.keyboard.press("End");
	await expect(button(page, 1000)).toBeFocused();
	expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(beforeEnd);
	await expect(button(page, 1000)).toBeInViewport({ ratio: 0.9 });
	await page.keyboard.press("Home");
	await expect(button(page, 1)).toBeFocused();
	await expect(button(page, 1)).toBeInViewport({ ratio: 0.9 });
	expect(await viewport.evaluate((element) => element.scrollTop)).toBe(0);
	await page.keyboard.press("ArrowDown");
	await expect(button(page, 2)).toBeFocused();
	await expect(button(page, 2)).toBeInViewport({ ratio: 0.9 });
	expect((await stats(page)).selections).toBe(0);
	await page.keyboard.press("Enter");
	await expect.poll(async () => (await stats(page)).selections).toBe(1);
	await page.keyboard.press("Space");
	await expect.poll(async () => (await stats(page)).selections).toBe(2);
	expect((await stats(page)).lastId).toBe(id(2));
});

test("canonical focus survives reordering and falls back locally when rows disappear", async ({
	page,
}) => {
	await button(page, 1).focus();
	await mode(page, "reverse");
	await expect(button(page, 1)).toBeFocused();
	await expect(button(page, 1).locator("..")).toHaveAttribute("aria-posinset", "1000");
	await mode(page, "empty");
	await expect(page.getByText("No conversations", { exact: true })).toBeVisible();
	await expect(page.getByRole("region", { name: "Inbox", exact: true })).toBeFocused();
	expect((await stats(page)).selections).toBe(0);
});

test("loading refusal bounds and untrusted labels stay honest and inert", async ({ page }) => {
	await mode(page, "loading");
	await expect(page.getByRole("status")).toHaveText("Loading conversations");
	await expect(page.getByRole("list")).toHaveCount(0);
	for (const value of ["error", "duplicate"] as const) {
		await mode(page, value);
		await expect(page.getByRole("alert")).toHaveText("Conversations unavailable");
		await expect(page.getByRole("list")).toHaveCount(0);
	}
	await mode(page, "large");
	await expect(page.getByRole("alert")).toHaveCount(0);
	const viewport = page.locator(".inbox-panel__viewport");
	expect(await viewport.evaluate((element) => element.scrollHeight)).toBe(1500 * 320);
	await viewport.evaluate((element) => {
		element.scrollTop = 1499 * 320;
	});
	await expect(button(page, 1500)).toBeInViewport({ ratio: 0.9 });
	await expect(button(page, 1500).locator("..")).toHaveAttribute("aria-setsize", "1500");
	expect(await page.getByRole("list").getByRole("listitem").count()).toBeLessThan(20);
	await mode(page, "error");
	await page.getByRole("button", { name: "Retry conversations", exact: true }).click();
	expect((await stats(page)).retries).toBe(1);
	await mode(page, "hostile");
	await expect(page.getByRole("list").getByRole("button")).toContainText(
		'<img src="https://synthetic.invalid/DYTEST-image" onerror="globalThis.DYTEST_virtual_unsafe=true">',
	);
	await expect(page.locator("img,iframe,object,embed,[onerror]")).toHaveCount(0);
});
