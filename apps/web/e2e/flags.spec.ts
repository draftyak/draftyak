import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";

declare global {
	interface Window {
		setFlagsForTest?: (flags: unknown) => void;
		readonly flagListPopupAttempts: readonly string[];
		flagListCspViolations: {
			directive: string;
			blockedURI: string;
			sourceFile: string;
			lineNumber: number;
			columnNumber: number;
		}[];
	}
}

const CATALOGUE = [
	["NEW_RECIPIENT", "ack", "New recipient"],
	["RECIPIENT_ADDED_BY_AGENT", "ack", "Recipient added by automation"],
	["REPLY_TO_REDIRECT", "ack", "Reply-To redirects the reply"],
	["AGENT_AUTHORED", "ack", "Draft created by automation"],
	["DMARC_FAIL", "ack", "DMARC check failed"],
	["EXTERNAL_LINK", "ack", "External link"],
	["AGENT_INSERTED_CONTACT", "ack", "Contact added by automation"],
	["ATTACHMENT_ADDED_BY_AGENT", "ack", "Attachment added by automation"],
	["INVISIBLE_CHARS", "ack", "Invisible characters"],
	["MASS_MENTION", "ack", "Mass mention"],
	["CROSS_THREAD_DATA", "ack", "Data from another conversation"],
	["SECRET_PATTERN", "ack", "Potential secret"],
	["SUSPECTED_INSTRUCTIONS", "advisory", "Suspected instructions"],
	["TOOL_DATA_IN_BODY", "ack", "Tool data in draft"],
	["TOOL_CONTEXT_USED", "info", "Tool context used"],
	["TOOL_INSTRUCTIONS", "advisory", "Instructions in tool data"],
] as const;

const SEVERITY_TEXT = {
	ack: "Acknowledgement required",
	info: "Information",
	advisory: "Advisory warning",
} as const;

function fixtureRequests(baseURL: string | undefined): {
	origin: string;
	paths: ReadonlySet<string>;
} {
	if (baseURL === undefined) throw new Error("Missing browser fixture URL");
	const url = new URL(baseURL);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("Invalid browser fixture URL");
	let paths: unknown;
	try {
		paths = JSON.parse(process.env.DRAFTYAK_E2E_ALLOWED_PATHS ?? "null");
	} catch {
		throw new Error("Invalid browser fixture asset catalogue");
	}
	if (
		!Array.isArray(paths) ||
		paths.length === 0 ||
		!paths.includes("/") ||
		paths.some(
			(value) =>
				typeof value !== "string" ||
				!value.startsWith("/") ||
				value.startsWith("//") ||
				!/^\/[A-Za-z0-9_./-]*$/.test(value) ||
				value.split("/").some((part) => part === "." || part === "..") ||
				(value !== "/" &&
					value !== "/index.html" &&
					!value.endsWith(".js") &&
					!value.endsWith(".css")),
		) ||
		new Set(paths).size !== paths.length
	)
		throw new Error("Invalid browser fixture asset catalogue");
	return { origin: url.origin, paths: new Set(paths as string[]) };
}

const test = base.extend<{
	browserGuard: {
		mounted: () => void;
		driverPages: <T>(run: () => Promise<T>) => Promise<T>;
	};
}>({
	browserGuard: [
		async ({ page, context, baseURL }, use) => {
			const allowed = fixtureRequests(baseURL);
			const errors: string[] = [];
			const dialogs: string[] = [];
			const unexpectedRequests: string[] = [];
			const requestsAfterMount: string[] = [];
			const openedPages: Page[] = [];
			const driverPages = new Set<Page>();
			let mounted = false;
			context.on("page", (opened) => openedPages.push(opened));
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("dialog", (dialog) => {
				dialogs.push(dialog.type());
				void dialog.dismiss().catch(() => errors.push("Dialog dismissal failed"));
			});
			await page.addInitScript(() => {
				const attempts: string[] = [];
				const open = window.open;
				Object.defineProperty(window, "flagListPopupAttempts", {
					get: () => [...attempts],
					configurable: false,
				});
				window.open = function (this: Window, ...args: Parameters<Window["open"]>) {
					attempts.push("window.open");
					return Reflect.apply(open, this, args);
				};
				window.flagListCspViolations = [];
				document.addEventListener("securitypolicyviolation", (event) => {
					window.flagListCspViolations.push({
						directive: event.violatedDirective,
						blockedURI: event.blockedURI,
						sourceFile: event.sourceFile,
						lineNumber: event.lineNumber,
						columnNumber: event.columnNumber,
					});
				});
			});
			await context.routeWebSocket("**/*", async (socket) => {
				unexpectedRequests.push(socket.url());
				await socket.close();
			});
			await context.route("**/*", async (route) => {
				const request = route.request();
				const url = new URL(request.url());
				const type = request.resourceType();
				const document = url.pathname === "/" || url.pathname === "/index.html";
				const permittedType = document
					? type === "document"
					: url.pathname.endsWith(".js")
						? type === "script"
						: url.pathname.endsWith(".css") && type === "stylesheet";
				if (mounted) requestsAfterMount.push(request.url());
				if (
					request.method() !== "GET" ||
					url.origin !== allowed.origin ||
					url.search ||
					url.hash ||
					!allowed.paths.has(url.pathname) ||
					!permittedType
				) {
					unexpectedRequests.push(request.url());
					await route.abort("blockedbyclient");
					return;
				}
				await route.continue();
			});
			await use({
				mounted: () => (mounted = true),
				async driverPages<T>(run: () => Promise<T>): Promise<T> {
					const descriptor = Object.getOwnPropertyDescriptor(context, "newPage");
					const createPage = context.newPage.bind(context);
					const owned: Page[] = [];
					Object.defineProperty(context, "newPage", {
						configurable: true,
						writable: true,
						value: async (): Promise<Page> => {
							const created = await createPage();
							driverPages.add(created);
							owned.push(created);
							return created;
						},
					});
					try {
						return await run();
					} finally {
						if (descriptor) Object.defineProperty(context, "newPage", descriptor);
						else if (!Reflect.deleteProperty(context, "newPage"))
							errors.push("Unable to restore browser page creation");
						await Promise.all(owned.map((created) => created.close()));
					}
				},
			});
			await page.waitForLoadState("networkidle");
			expect(errors, "uncaught browser errors").toEqual([]);
			expect(dialogs, "unexpected browser dialogs").toEqual([]);
			expect(
				await page.evaluate(() => window.flagListPopupAttempts),
				"unexpected fixture popup attempts",
			).toEqual([]);
			expect(
				openedPages.filter((opened) => !driverPages.has(opened)).map((opened) => opened.url()),
				"unexpected fixture popups",
			).toEqual([]);
			expect(unexpectedRequests, "requests outside the built fixture catalogue").toEqual([]);
			expect(requestsAfterMount, "FlagList made a request after mounting").toEqual([]);
			expect(await page.evaluate(() => window.flagListCspViolations)).toEqual([]);
		},
		{ auto: true },
	],
});

test.beforeEach(async ({ page, browserGuard }) => {
	await page.goto("/");
	await expect(
		page.getByRole("heading", { name: "Flag rendering fixture", exact: true }),
	).toBeVisible();
	await expect(page.locator("html")).toHaveAttribute("data-fixture-ready", "true");
	await expect(
		page
			.getByRole("region", { name: "Flag display", exact: true })
			.getByText("No flags", { exact: true }),
	).toBeVisible();
	await page.waitForLoadState("networkidle");
	browserGuard.mounted();
});

async function setFlags(page: Page, flags: unknown): Promise<void> {
	await page.evaluate((value) => {
		const setter = window.setFlagsForTest;
		if (typeof setter !== "function") throw new Error("Flag fixture is not ready");
		setter(value);
	}, flags);
}

test("renders all canonical flags as a passive accessible list and skips it with Tab", async ({
	page,
}) => {
	await setFlags(
		page,
		CATALOGUE.map(([code, severity]) => ({ code, severity })),
	);
	const display = page.getByRole("region", { name: "Flag display", exact: true });
	const list = display.getByRole("list", { name: "Flags", exact: true });
	await expect(list).toBeVisible();
	expect(await list.evaluate((element) => element.tagName)).toBe("UL");
	const rows = list.getByRole("listitem");
	await expect(rows).toHaveCount(16);
	for (const [index, [code, severity, label]] of CATALOGUE.entries()) {
		const row = rows.nth(index);
		await expect(row).toHaveAttribute("data-flag-code", code);
		await expect(row).toHaveAttribute("data-severity", severity);
		await expect(row.locator("strong")).toHaveText(label);
		await expect(row.locator("code")).toHaveText(code);
		await expect(row.getByText(SEVERITY_TEXT[severity], { exact: true })).toBeVisible();
	}
	await expect(list.getByText(SEVERITY_TEXT.ack, { exact: true })).toHaveCount(13);
	await expect(list.getByText(SEVERITY_TEXT.info, { exact: true })).toHaveCount(1);
	await expect(list.getByText(SEVERITY_TEXT.advisory, { exact: true })).toHaveCount(2);
	await expect(
		display.locator(
			"a,area,button,input,select,textarea,form,summary,iframe,object,embed,[contenteditable],[tabindex]",
		),
	).toHaveCount(0);
	await expect(display.getByRole("alert")).toHaveCount(0);
	const before = page.getByRole("textbox", { name: "Before flags", exact: true });
	const after = page.getByRole("textbox", { name: "After flags", exact: true });
	await before.click();
	await page.keyboard.press("Tab");
	await expect(after).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(before).toBeFocused();
});

test("keeps hostile details as visible text without injected elements", async ({ page }) => {
	const markup =
		'<img id="flag-detail-injected" src="https://flags.example.invalid/pixel" onerror="alert(1)">' +
		'<a href="javascript:alert(2)">open</a>' +
		'<script>alert(3)</script><svg onload="alert(4)"></svg>';
	const url = "https://flags.example.invalid/path?next=javascript:alert(5)";
	const hidden =
		"left\u202Eright\u0000\n\r\t\u2060\u200D\u034F\uFE0F\u{E0100}\u00A0\u202F\u2028" +
		" literal\\u{202E}";
	const escaped =
		"left\\u{202E}right\\u{0000}\\u{000A}\\u{000D}\\u{0009}\\u{2060}\\u{200D}" +
		"\\u{034F}\\u{FE0F}\\u{E0100}\\u{00A0}\\u{202F}\\u{2028} literal\\\\u{202E}";
	await setFlags(page, [
		{ code: "SUSPECTED_INSTRUCTIONS", severity: "advisory", detail: markup },
		{ code: "EXTERNAL_LINK", severity: "ack", detail: url },
		{ code: "INVISIBLE_CHARS", severity: "ack", detail: hidden },
	]);
	const display = page.getByRole("region", { name: "Flag display", exact: true });
	await expect(display.getByRole("listitem")).toHaveCount(3);
	expect(await display.locator("bdi").allTextContents()).toEqual([markup, url, escaped]);
	await expect(
		display.locator("a,img,script,svg,iframe,object,embed,link,style,form,input,button"),
	).toHaveCount(0);
	await expect(display.getByRole("link")).toHaveCount(0);
	await expect(page.locator("#flag-detail-injected")).toHaveCount(0);
	await expect(display.getByRole("alert")).toHaveCount(0);
});

test("preserves 1000 Unicode scalars and wraps an unbroken detail in a narrow viewport", async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 720 });
	const detail = `😀${"x".repeat(999)}`;
	await setFlags(page, [{ code: "NEW_RECIPIENT", severity: "ack", detail }]);
	const display = page.getByRole("region", { name: "Flag display", exact: true });
	const rendered = display.locator("bdi");
	await expect(rendered).toBeVisible();
	expect(await rendered.textContent()).toBe(detail);
	await expect(display.getByRole("alert")).toHaveCount(0);
	const layout = await rendered.evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const lines = new Set(
			[...range.getClientRects()]
				.filter((rectangle) => rectangle.width > 0 && rectangle.height > 0)
				.map((rectangle) => Math.round(rectangle.top * 100) / 100),
		);
		return {
			lines: lines.size,
			width: element.clientWidth,
			scrollWidth: element.scrollWidth,
			documentWidth: document.documentElement.scrollWidth,
			viewportWidth: window.innerWidth,
		};
	});
	expect(layout.lines).toBeGreaterThan(2);
	expect(layout.width).toBeGreaterThan(0);
	expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
	expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
});

test("clears accepted details when rerendered with invalid data and then an empty list", async ({
	page,
}) => {
	const previous = { code: "NEW_RECIPIENT", severity: "ack", detail: "DYTEST previous detail" };
	const display = page.getByRole("region", { name: "Flag display", exact: true });
	await setFlags(page, [previous]);
	await expect(display.getByText(previous.detail, { exact: true })).toBeVisible();
	await setFlags(page, [
		previous,
		{ code: "DMARC_FAIL", severity: "info", detail: "DYTEST invalid detail" },
	]);
	await expect(display.getByRole("alert")).toHaveText("Flags unavailable");
	await expect(display.getByRole("list")).toHaveCount(0);
	await expect(display.getByRole("listitem")).toHaveCount(0);
	await expect(display.locator("bdi")).toHaveCount(0);
	await expect(display.getByText(previous.detail, { exact: true })).toHaveCount(0);
	await expect(display.getByText("DYTEST invalid detail", { exact: true })).toHaveCount(0);
	await expect(display.getByText("No flags", { exact: true })).toHaveCount(0);
	await setFlags(page, []);
	await expect(display.getByText("No flags", { exact: true })).toBeVisible();
	await expect(display.getByRole("alert")).toHaveCount(0);
	await expect(display.getByRole("list")).toHaveCount(0);
	await expect(display.locator("bdi")).toHaveCount(0);
	await expect(display.getByText(previous.detail, { exact: true })).toHaveCount(0);
});

test("has no WCAG A or AA violations across all canonical flag states", async ({
	page,
	browserGuard,
}) => {
	await setFlags(
		page,
		CATALOGUE.map(([code, severity]) => ({ code, severity, detail: `DYTEST ${code}` })),
	);
	const display = page.getByRole("region", { name: "Flag display", exact: true });
	await expect(display.getByRole("list", { name: "Flags", exact: true })).toBeVisible();
	await expect(display.getByRole("listitem")).toHaveCount(16);
	await expect(display.locator("bdi")).toHaveCount(16);
	const results = await browserGuard.driverPages(() =>
		new AxeBuilder({ page })
			.include(".flag-list")
			.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
			.analyze(),
	);
	const violations = results.violations.map(({ id, impact, nodes }) => ({
		id,
		impact,
		targets: nodes.map(({ target }) => target),
	}));
	expect(violations).toEqual([]);
});
