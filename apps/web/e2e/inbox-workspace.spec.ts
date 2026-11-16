import { test as base, expect } from "@playwright/test";

declare global {
	interface Window {
		readonly inboxWorkspaceCspCountForTest: number;
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
const test = base.extend<{ guarded: undefined }>({
	guarded: [
		async ({ page, context, baseURL }, use) => {
			if (baseURL === undefined) throw new Error("DYTEST missing fixture origin");
			const origin = new URL(baseURL).origin;
			const raw: unknown = JSON.parse(process.env.DRAFTYAK_E2E_ALLOWED_PATHS ?? "null");
			if (
				!Array.isArray(raw) ||
				!raw.includes("/inbox-workspace.html") ||
				new Set(raw).size !== raw.length ||
				raw.some(
					(value) =>
						typeof value !== "string" ||
						!/^\/[A-Za-z0-9_./-]+$/.test(value) ||
						value.startsWith("//") ||
						value.split("/").some((part) => part === "." || part === "..") ||
						(value !== "/inbox-workspace.html" &&
							!value.endsWith(".js") &&
							!value.endsWith(".css")),
				)
			)
				throw new Error("DYTEST invalid fixture asset catalogue");
			const assets = new Set(raw as string[]);
			const counts = {
				errors: 0,
				consoleErrors: 0,
				unexpectedRequests: 0,
				postMountRequests: 0,
				sockets: 0,
				popups: 0,
				dialogs: 0,
				cleanupErrors: 0,
			};
			const joins: Promise<void>[] = [];
			let mounted = false;
			page.on("pageerror", (error) => {
				counts.errors++;
				process.stdout.write(
					`${JSON.stringify({
						fixturePageFault: true,
						kind: ["Error", "ReferenceError", "TypeError", "SyntaxError"].includes(error.name)
							? error.name
							: "Other",
						missingProcess: /process is not defined|Can't find variable: process/.test(
							error.message,
						),
						missingBuffer: /Buffer is not defined|Can't find variable: Buffer/.test(error.message),
					})}\n`,
				);
			});
			page.on("console", (message) => {
				if (message.type() === "error") counts.consoleErrors++;
			});
			page.on("websocket", () => {
				counts.sockets++;
			});
			page.on("dialog", (dialog) => {
				counts.dialogs++;
				joins.push(
					dialog.dismiss().catch(() => {
						counts.cleanupErrors++;
					}),
				);
			});
			context.on("page", (opened) => {
				counts.popups++;
				joins.push(
					opened.close().catch(() => {
						counts.cleanupErrors++;
					}),
				);
			});
			await context.route("**/*", async (route) => {
				const request = route.request();
				const url = new URL(request.url());
				if (mounted) counts.postMountRequests++;
				const kind =
					url.pathname === "/inbox-workspace.html"
						? request.resourceType() === "document"
						: url.pathname.endsWith(".js")
							? request.resourceType() === "script"
							: url.pathname.endsWith(".css") && request.resourceType() === "stylesheet";
				if (
					request.method() !== "GET" ||
					url.origin !== origin ||
					url.search ||
					url.hash ||
					!assets.has(url.pathname) ||
					!kind
				) {
					counts.unexpectedRequests++;
					await route.abort("blockedbyclient");
				} else await route.continue();
			});
			const response = await page.goto("/inbox-workspace.html");
			expect(response?.status()).toBe(200);
			expect(response?.headers()["content-security-policy"]).toBe(CSP);
			await expect(page.getByText("DYTEST body 1-1", { exact: true })).toBeVisible();
			await page.waitForLoadState("networkidle");
			mounted = true;
			await use(undefined);
			await page.waitForLoadState("networkidle");
			await Promise.allSettled(joins);
			for (const count of Object.values(counts)) expect(count).toBe(0);
			expect(await page.evaluate(() => window.inboxWorkspaceCspCountForTest)).toBe(0);
			expect(
				await page.locator("[style],img,iframe,object,embed").evaluateAll((elements) =>
					elements.map((element) => ({
						tag: element.localName,
						styleProperties: element instanceof HTMLElement ? Array.from(element.style) : [],
					})),
				),
			).toEqual([]);
		},
		{ auto: true },
	],
});

test("native list focus moves without selection and activation selects exactly once", async ({
	page,
}) => {
	const list = page.getByRole("list", { name: "Conversations", exact: true });
	const buttons = list.getByRole("button");
	await buttons.nth(0).focus();
	await page.keyboard.press("ArrowDown");
	await expect(buttons.nth(1)).toBeFocused();
	await expect(buttons.nth(0)).toHaveAttribute("aria-current", "true");
	await expect(page.getByLabel("Conversation selections")).toHaveText("0");
	await page.keyboard.press("Enter");
	await expect(buttons.nth(1)).toHaveAttribute("aria-current", "true");
	await expect(page.getByLabel("Conversation selections")).toHaveText("1");
	await expect(page.getByText("DYTEST body 1-2", { exact: true })).toBeVisible();
	await expect(page.getByText("DYTEST body 1-1", { exact: true })).toHaveCount(0);
	await page.keyboard.press("Home");
	await expect(buttons.nth(0)).toBeFocused();
	await page.keyboard.press("Space");
	await expect(page.getByLabel("Conversation selections")).toHaveText("2");
	await expect(page.getByText("DYTEST body 1-1", { exact: true })).toBeVisible();
});

test("account keyboard selection disposes dirty editing and foreign rows withhold every panel", async ({
	page,
}) => {
	await page
		.getByRole("textbox", { name: "Draft body", exact: true })
		.fill("DYTEST dirty old account");
	await page.getByRole("button", { name: "dytest-mail-1 Email", exact: true }).focus();
	await page.keyboard.press("Tab");
	await expect(
		page.getByRole("button", { name: "dytest-mail-2 Email", exact: true }),
	).toBeFocused();
	await page.keyboard.press("Space");
	await expect(page.getByRole("textbox", { name: "Draft body", exact: true })).toHaveValue(
		"DYTEST reply 2-1",
	);
	await expect(page.getByText("DYTEST body 2-1", { exact: true })).toBeVisible();
	await expect(page.getByText("DYTEST body 1-1", { exact: true })).toHaveCount(0);
	await expect(page.getByText("DYTEST dirty old account", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Supply foreign list row", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveText("Inbox workspace unavailable");
	await expect(page.getByRole("list", { name: "Conversations", exact: true })).toHaveCount(0);
	await expect(page.getByRole("list", { name: "Messages", exact: true })).toHaveCount(0);
	await expect(page.getByRole("article", { name: "Selected message", exact: true })).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Draft body", exact: true })).toHaveCount(0);
});

for (const width of [360, 1280]) {
	test(`real ${width}px layout wraps panels and keeps keyboard focus visible`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		const account = page.getByRole("button", { name: "dytest-mail-2 Email", exact: true });
		await page.getByRole("button", { name: "dytest-mail-1 Email", exact: true }).focus();
		await page.keyboard.press("Tab");
		await expect(account).toBeFocused();
		const geometry = await account.evaluate((element) => {
			const bounds = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return {
				left: bounds.left,
				right: bounds.right,
				width: innerWidth,
				height: bounds.height,
				outline: Number.parseFloat(style.outlineWidth),
			};
		});
		expect(geometry.left).toBeGreaterThanOrEqual(0);
		expect(geometry.right).toBeLessThanOrEqual(geometry.width);
		expect(geometry.height).toBeGreaterThanOrEqual(44);
		expect(geometry.outline).toBeGreaterThan(0);
	});
}
