import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	EXTENSION_ID,
	getUiCapability,
	RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { type AuthInfo, createMcpHandler } from "@modelcontextprotocol/server";
import { afterAll, describe, expect, it } from "vitest";
import { browsersDir } from "../../../tools/verify/profiles/m0.ts";
import { browsersPath, playwrightCore } from "../prefetch.ts";
import {
	type Apps,
	cspFor,
	cspMeta,
	DRAFT_VIEW,
	loadViews,
	MAX_VIEW_BYTES,
	pinProblem,
	registerApps,
	UI_EXTENSION,
	UI_MIME_TYPE,
	VIEWS_MANIFEST,
	type View,
} from "../src/apps.ts";
import { createHub, GUIDE_URI } from "../src/resources.ts";
import { createApp, createMcpServer, serveLegacy, surfaceFactory } from "../src/server.ts";
import { pinCsp } from "../views/build.ts";
import { FLAG_LABELS, renderDraft, visible } from "../views/draft-v1/render.ts";
import { SMUGGLED } from "./apps-corpus.ts";
import { type Fetcher, legacy, modern, type Served, serve } from "./harness.ts";

const dirs: string[] = [];
const tempDir = (): string => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-s03-apps-unit-"));
	dirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const PAGE =
	'<!doctype html><html><head><meta charset="utf-8"><title>v</title><script type="module">document.title = "view";</script></head><body></body></html>';
const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

// A built view as views/build.ts lays it out: the pinned file and views.manifest.json.
function builtView(page: string = PAGE): { dir: string; html: string; csp: string } {
	const dir = tempDir();
	const { html, csp } = pinCsp(page);
	writeFileSync(path.join(dir, "draft-v1.html"), html);
	const entry = {
		uri: DRAFT_VIEW,
		file: "draft-v1.html",
		sha256: sha256(html),
		size: html.length,
		csp,
	};
	writeFileSync(path.join(dir, VIEWS_MANIFEST), JSON.stringify({ views: [entry] }));
	return { dir, html, csp };
}

const DRAFT_ID = "01J00000000000000000000001";
const DRAFT = {
	draftId: DRAFT_ID,
	account: "gmail-1",
	channel: "gmail",
	revision: 2,
	aiAuthored: true,
	flags: ["AGENT_AUTHORED"],
	body: "Fake reply",
};
const apps = (): Apps => ({ views: loadViews(builtView().dir), drafts: { [DRAFT_ID]: DRAFT } });

const UI = { extensions: { [UI_EXTENSION]: { mimeTypes: [UI_MIME_TYPE] } } };
const grant = (extra: Record<string, unknown> = {}): AuthInfo => ({
	token: "test-token",
	clientId: "shared-client",
	scopes: [],
	extra: { grantId: "apps", ...extra },
});

function principal(hub = createHub({ apps: apps() }), authInfo = grant()): Fetcher {
	const handler = createMcpHandler(surfaceFactory(hub), { legacy: "reject", responseMode: "json" });
	return { fetch: (request) => handler.fetch(request, { authInfo }) };
}

function legacyPrincipal(hub = createHub({ apps: apps() }), authInfo = grant()): Fetcher {
	const factory = surfaceFactory(hub);
	return {
		fetch: async (request) => serveLegacy(factory, request, await request.clone().json(), authInfo),
	};
}

interface Listed {
	readonly name: string;
	readonly _meta?: { readonly ui?: unknown };
}
const uiOf = (response: Served): Record<string, unknown> =>
	Object.fromEntries(
		(response.body.result.tools as Listed[]).map((tool) => [tool.name, tool._meta?.ui ?? null]),
	);
const MODEL = { visibility: ["model"] };
const WITH_UI = {
	accounts_list: MODEL,
	message_get: MODEL,
	draft_get: { resourceUri: DRAFT_VIEW, ...MODEL },
};
const WITHOUT_UI = { accounts_list: null, message_get: null, draft_get: null };

describe("_meta.ui (plan §6 Tool metadata)", () => {
	it("is on 2026-era requests only when they declare the extension for the views' MIME type, never by clientInfo", async () => {
		const target = principal();
		const listed = (capabilities: Record<string, unknown>, name = "in-memory") =>
			serve(target, modern("tools/list", {}, { capabilities, clientInfo: { name, version: "1" } }));
		expect(uiOf(await listed(UI))).toEqual(WITH_UI);
		const undeclared = await listed({});
		expect(uiOf(undeclared)).toEqual(WITHOUT_UI);
		for (const capabilities of [
			{ extensions: { [UI_EXTENSION]: {} } },
			{ extensions: { [UI_EXTENSION]: { mimeTypes: ["text/html"] } } },
			{ extensions: { [UI_EXTENSION]: { mimeTypes: UI_MIME_TYPE } } },
			{ extensions: { "io.example/ui": { mimeTypes: [UI_MIME_TYPE] } } },
			{ experimental: { [UI_EXTENSION]: { mimeTypes: [UI_MIME_TYPE] } } },
		]) {
			expect(uiOf(await listed(capabilities)), JSON.stringify(capabilities)).toEqual(WITHOUT_UI);
		}
		for (const name of [
			"claude-ai",
			"Claude Desktop",
			"chatgpt",
			"Visual Studio Code",
			"basic-host",
		]) {
			expect((await listed({}, name)).body, name).toEqual(undeclared.body);
		}
	});

	it("is always on the 2025 legacy path, where requests carry no capabilities of their own", async () => {
		expect(uiOf(await serve(legacyPrincipal(), legacy("tools/list")))).toEqual(WITH_UI);
	});

	it("is never on while the principal's appsViews toggle is off, in either era", async () => {
		const off = grant({ appsViews: false });
		const hub = createHub({ apps: apps() });
		const declared = modern("tools/list", {}, { capabilities: UI });
		expect(uiOf(await serve(principal(hub, off), declared))).toEqual(WITHOUT_UI);
		expect(uiOf(await serve(legacyPrincipal(hub, off), legacy("tools/list")))).toEqual(WITHOUT_UI);
	});

	it("leaves every tool result the same with and without it", async () => {
		const target = principal();
		for (const call of [
			{ name: "draft_get", arguments: { draftId: DRAFT_ID } },
			{ name: "accounts_list", arguments: {} },
		]) {
			const plain = await serve(target, modern("tools/call", call));
			const declared = await serve(target, modern("tools/call", call, { capabilities: UI }));
			expect(declared.body, call.name).toEqual(plain.body);
		}
		const draft = await serve(
			target,
			modern("tools/call", { name: "draft_get", arguments: { draftId: DRAFT_ID } }),
		);
		expect(draft.body.result.structuredContent).toEqual(DRAFT);
		expect(JSON.parse(draft.body.result.content[0].text)).toEqual(DRAFT);
		const unknown = await serve(
			target,
			modern("tools/call", {
				name: "draft_get",
				arguments: { draftId: "01J00000000000000000000099" },
			}),
		);
		expect(unknown.body.result.isError).toBe(true);
	});

	it("covers the fake read tools of a hub without views, which serves no draft_get", async () => {
		const app = createApp();
		expect(uiOf(await serve(app, modern("tools/list", {}, { capabilities: UI })))).toEqual({
			accounts_list: MODEL,
			message_get: MODEL,
		});
		expect(uiOf(await serve(app, modern("tools/list")))).toEqual({
			accounts_list: null,
			message_get: null,
		});
	});
});

describe("ui:// views", () => {
	it("serves draft-v1 to any principal in both eras as one text/html;profile=mcp-app item, public for an hour, and keeps it out of resources/list", async () => {
		const view = builtView();
		const hub = createHub({ apps: { views: loadViews(view.dir), drafts: {} } });
		const read = await serve(principal(hub), modern("resources/read", { uri: DRAFT_VIEW }));
		expect(read.body.result.contents).toEqual([
			{ uri: DRAFT_VIEW, mimeType: UI_MIME_TYPE, text: view.html },
		]);
		expect([read.body.result.cacheScope, read.body.result.ttlMs]).toEqual(["public", 3_600_000]);
		const old = await serve(legacyPrincipal(hub), legacy("resources/read", { uri: DRAFT_VIEW }));
		expect(old.body.result.contents).toEqual(read.body.result.contents);
		for (const listed of [
			await serve(principal(hub), modern("resources/list")),
			await serve(legacyPrincipal(hub), legacy("resources/list")),
		]) {
			expect(listed.body.result.resources.map((resource: { uri: string }) => resource.uri)).toEqual(
				[GUIDE_URI],
			);
		}
	});

	it("registers draft_get only beside the view it links to", () => {
		expect(() => registerApps(createMcpServer(), { views: [], drafts: {} })).toThrow(
			`draft_get needs the ${DRAFT_VIEW} view`,
		);
	});

	it("passes an own __proto__ key of structuredContent through on the 2026 leg and drops it on the 2025 leg, which the basic host uses", async () => {
		const draft = JSON.parse(`{"__proto__":{"polluted":"yes"},${JSON.stringify(DRAFT).slice(1)}`);
		expect(Object.hasOwn(draft, "__proto__")).toBe(true);
		const hub = createHub({
			apps: { views: loadViews(builtView().dir), drafts: { [DRAFT_ID]: draft } },
		});
		const call = { name: "draft_get", arguments: { draftId: DRAFT_ID } };
		const modernLeg = (await serve(principal(hub), modern("tools/call", call))).body.result;
		const legacyLeg = (await serve(legacyPrincipal(hub), legacy("tools/call", call))).body.result;
		expect(Object.hasOwn(modernLeg.structuredContent, "__proto__")).toBe(true);
		expect(Object.hasOwn(legacyLeg.structuredContent, "__proto__")).toBe(false);
		expect(legacyLeg.structuredContent).toEqual(DRAFT);
		for (const { content } of [modernLeg, legacyLeg]) {
			expect(Object.hasOwn(JSON.parse(content[0].text), "__proto__")).toBe(true);
		}
		expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
	});
});

describe("the Playwright browsers folder", () => {
	it("is the one verify:m0's prerequisite check looks in: the cache unless PLAYWRIGHT_BROWSERS_PATH is set", () => {
		const core = playwrightCore();
		const cache = path.join(tempDir(), "cache");
		const absolute = path.join(tempDir(), "browsers");
		for (const env of [
			{ DRAFTYAK_CACHE_DIR: cache },
			{ DRAFTYAK_CACHE_DIR: cache, PLAYWRIGHT_BROWSERS_PATH: absolute },
			{ PLAYWRIGHT_BROWSERS_PATH: "0" },
			{},
		]) {
			expect(browsersPath(env), JSON.stringify(env)).toBe(browsersDir(core, env));
		}
		expect(browsersPath({ DRAFTYAK_CACHE_DIR: cache })).toBe(path.join(cache, "playwright"));
		expect(browsersPath({ PLAYWRIGHT_BROWSERS_PATH: "0" })).toBe(
			path.join(core, ".local-browsers"),
		);
		expect(existsSync(path.join(core, "browsers.json"))).toBe(true);
		for (const relative of ["browsers", "./browsers"]) {
			const env = { PLAYWRIGHT_BROWSERS_PATH: relative };
			expect(() => browsersPath(env)).toThrow("must be absolute or 0");
			expect(() => browsersDir(core, env)).toThrow("must be absolute or 0");
		}
	});
});

describe("loadViews, the hub's check of the built views at start", () => {
	it("returns each view with its HTML when the files match views.manifest.json", () => {
		const { dir, html, csp } = builtView();
		expect(loadViews(dir)).toEqual<View[]>([
			{
				uri: DRAFT_VIEW,
				file: "draft-v1.html",
				sha256: sha256(html),
				size: html.length,
				csp,
				html,
			},
		]);
	});

	it("refuses changed bytes, a wrong size, another CSP, a path, another scheme and a view over 256 KiB", () => {
		const cases: [
			string,
			(dir: string, manifest: { views: Record<string, unknown>[] }) => void,
			RegExp,
		][] = [
			[
				"changed bytes",
				(dir) => writeFileSync(path.join(dir, "draft-v1.html"), PAGE.replace("view", "viex")),
				/doesn't match/,
			],
			["wrong size", (_, m) => Object.assign(m.views[0] ?? {}, { size: 12 }), /doesn't match/],
			[
				"another CSP",
				(_, m) => Object.assign(m.views[0] ?? {}, { csp: "default-src *" }),
				/isn't §6's policy/,
			],
			["path", (_, m) => Object.assign(m.views[0] ?? {}, { file: "../draft-v1.html" }), /file/],
			[
				"scheme",
				(_, m) => Object.assign(m.views[0] ?? {}, { uri: "https://draftyak/draft-v1" }),
				/uri/,
			],
			["size cap", (_, m) => Object.assign(m.views[0] ?? {}, { size: MAX_VIEW_BYTES + 1 }), /size/],
		];
		for (const [what, spoil, error] of cases) {
			const { dir } = builtView();
			const file = path.join(dir, VIEWS_MANIFEST);
			const manifest = JSON.parse(readFileSync(file, "utf8"));
			spoil(dir, manifest);
			writeFileSync(file, JSON.stringify(manifest));
			expect(() => loadViews(dir), what).toThrow(error);
		}
	});

	it("refuses a view whose HTML and manifest agree on a CSP that isn't the pinned one, or put it anywhere but first", () => {
		const { html, csp } = pinCsp(PAGE);
		const pinned = `<meta charset="utf-8">${cspMeta(csp)}`;
		const cases: [string, string, string, RegExp][] = [
			[
				"a permissive policy",
				html.replace(cspMeta(csp), cspMeta("default-src *")),
				"default-src *",
				/isn't §6's policy/,
			],
			[
				"a policy without one of the scripts",
				html.replace("</head>", "<script>let two = 2;</script></head>"),
				csp,
				/isn't §6's policy/,
			],
			[
				"§6's policy with an extra source",
				html.replace(csp, `${csp} https:`),
				`${csp} https:`,
				/isn't §6's policy/,
			],
			[
				"the CSP after the script",
				html.replace(pinned, '<meta charset="utf-8">').replace("</head>", `${cspMeta(csp)}</head>`),
				csp,
				/doesn't open its head/,
			],
			[
				"the charset and CSP inside a comment",
				html.replace(pinned, `<!--${pinned}-->`),
				csp,
				/doesn't open its head/,
			],
			["no inline script", html.replace(/<script[\s\S]*<\/script>/, ""), cspFor([]), /no inline/],
		];
		for (const [what, page, policy, error] of cases) {
			const dir = tempDir();
			writeFileSync(path.join(dir, "draft-v1.html"), page);
			const entry = {
				uri: DRAFT_VIEW,
				file: "draft-v1.html",
				sha256: sha256(page),
				size: Buffer.byteLength(page),
				csp: policy,
			};
			writeFileSync(path.join(dir, VIEWS_MANIFEST), JSON.stringify({ views: [entry] }));
			expect(() => loadViews(dir), what).toThrow(error);
		}
		expect(pinProblem(html, csp)).toBeUndefined();
	});
});

describe("the hash-pinned meta CSP (views/build.ts)", () => {
	it("is plan §6's policy with the build's script hashes", () => {
		expect(cspFor(["abc="])).toBe(
			"default-src 'none'; script-src 'sha256-abc='; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'",
		);
	});

	it("pins every inline script by its SHA-256, right after the charset and ahead of any script", () => {
		const page = PAGE.replace("</head>", "<script>let two = 2;</script></head>");
		const { html, csp } = pinCsp(page);
		const hash = (code: string) => createHash("sha256").update(code).digest("base64");
		expect(csp).toBe(cspFor([hash('document.title = "view";'), hash("let two = 2;")]));
		expect(html).toBe(
			page.replace(
				'<meta charset="utf-8">',
				`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`,
			),
		);
	});

	it("refuses a script from a URL, a page with no script, and a missing or repeated charset", () => {
		expect(() => pinCsp(PAGE.replace('type="module"', 'type="module" src="x.js"'))).toThrow(
			"inline only",
		);
		expect(() => pinCsp(PAGE.replace(/<script.*<\/script>/, ""))).toThrow("no inline script");
		expect(() => pinCsp(PAGE.replace('<meta charset="utf-8">', ""))).toThrow("needs one");
		expect(() => pinCsp(PAGE.replace("<title>", '<meta charset="utf-8"><title>'))).toThrow(
			"needs one",
		);
		const late = PAGE.replace(
			'<meta charset="utf-8"><title>v</title>',
			'<title>v</title><meta charset="utf-8">',
		);
		expect(() => pinCsp(late)).toThrow("doesn't open its head");
	});
});

// A stand-in document with the view's ids, enough for renderDraft.
function documentStandIn() {
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
	const text = (id: string) => nodes.get(id)?.textContent ?? null;
	const flags = () =>
		(nodes.get("flags")?.children ?? []).map(
			(item) => (item as { textContent: string }).textContent,
		);
	return { doc: doc as unknown as Document, nodes, text, flags };
}

describe("draft-v1 rendering (views/draft-v1/render.ts)", () => {
	it("shows bidi, zero-width, tag and control characters as visible markers, and leaves other text alone", () => {
		expect(visible("a\u202Eb\u2066c\u2069d")).toBe("a⟨U+202E⟩b⟨U+2066⟩c⟨U+2069⟩d");
		expect(visible("zero\u200B\u200C\u200D\u2060\uFEFFwidth\u00AD")).toBe(
			"zero⟨U+200B⟩⟨U+200C⟩⟨U+200D⟩⟨U+2060⟩⟨U+FEFF⟩width⟨U+00AD⟩",
		);
		expect(visible("tag\u{E0001}\u{E0041}\u{E007F}")).toBe("tag⟨U+E0001⟩⟨U+E0041⟩⟨U+E007F⟩");
		expect(visible("nul\u0000esc\u001Bcr\r")).toBe("nul⟨U+0000⟩esc⟨U+001B⟩cr⟨U+000D⟩");
		const plain = "line one\n\tline two: héllo 日本 👍 <b>&amp;</b>";
		expect(visible(plain)).toBe(plain);
	});

	it("also marks the default-ignorable characters outside Cf: variation selectors, fillers, joiners and unassigned tags", () => {
		const hidden = visible(`Approve${SMUGGLED}`);
		expect(hidden.startsWith("Approve⟨U+E0159⟩⟨U+E0157⟩")).toBe(true);
		expect(hidden.split("⟨U+").length - 1).toBe([...SMUGGLED].length);
		expect(visible("vs︀️\u{E0100}\u{E01EF}")).toBe("vs⟨U+FE00⟩⟨U+FE0F⟩⟨U+E0100⟩⟨U+E01EF⟩");
		expect(visible("ᅟᅠㅤﾠ")).toBe("⟨U+115F⟩⟨U+1160⟩⟨U+3164⟩⟨U+FFA0⟩");
		expect(visible("a͏b឴឵᠋᠏")).toBe("a⟨U+034F⟩b⟨U+17B4⟩⟨U+17B5⟩⟨U+180B⟩⟨U+180F⟩");
		expect(visible("\u{E0002}\u{E0080}\u{E01F0}\u{E0FFF}")).toBe(
			"⟨U+E0002⟩⟨U+E0080⟩⟨U+E01F0⟩⟨U+E0FFF⟩",
		);
		// The joiners and VS16 inside emoji and Persian or Indic words show too (M8b decides on them).
		expect(visible("❤️ \u{1F469}‍\u{1F4BB} می‌خواهم")).toBe(
			"❤⟨U+FE0F⟩ \u{1F469}⟨U+200D⟩\u{1F4BB} می⟨U+200C⟩خواهم",
		);
		for (const space of [" ", "　", " "]) expect(visible(space)).toBe(space);
	});

	it("puts every field through textContent: known flags as labels, others as their codes, unknown fields ignored", () => {
		const { doc, text, flags, nodes } = documentStandIn();
		const codes = ["AGENT_AUTHORED", "UNLISTED", "constructor", "__proto__", "toString"];
		renderDraft(doc, {
			structuredContent: {
				...DRAFT,
				account: "gmail\u202E-1",
				flags: codes,
				body: "<img src=x onerror=alert(1)>",
				sendRequest: {
					state: "scheduled",
					notBefore: "2026-10-20T09:00:00+01:00",
					zone: "Europe/London",
				},
				extra: "<script>ignored</script>",
			},
		});
		expect(flags()).toEqual([
			FLAG_LABELS.get("AGENT_AUTHORED"),
			"UNLISTED",
			"constructor",
			"__proto__",
			"toString",
		]);
		expect(text("body")).toBe("<img src=x onerror=alert(1)>");
		expect(text("source")).toBe("gmail⟨U+202E⟩-1 · gmail");
		expect(text("send")).toBe(
			"Send request: scheduled, not before 2026-10-20T09:00:00+01:00, zone Europe/London",
		);
		expect([nodes.get("draft")?.hidden, nodes.get("status")?.hidden]).toEqual([false, true]);
	});

	it("shows nothing of a result that isn't a draft or reports an error", () => {
		for (const result of [
			{ structuredContent: { body: 1 } },
			{ isError: true, structuredContent: DRAFT },
			{},
		]) {
			const { doc, text, nodes } = documentStandIn();
			renderDraft(doc, result);
			expect(text("status")).toBe("This draft can't be shown here.");
			expect([text("body"), nodes.get("draft")?.hidden]).toEqual([null, true]);
		}
	});

	it("uses no HTML sink, code from strings, network, navigation or App call but connect and addEventListener", () => {
		const dir = path.resolve(import.meta.dirname, "..", "views", "draft-v1");
		const banned: Record<string, RegExp> = {
			sink: /\b(?:innerHTML|outerHTML|insertAdjacentHTML|srcdoc|createContextualFragment|DOMParser|setAttribute)\b|document\.write/,
			code: /\beval\b|\bFunction\s*\(|\bset(?:Timeout|Interval)\s*\(|\bimportScripts\b/,
			network: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|Worker)\b/,
			navigation: /\blocation\b|\bwindow\.open\b|\.(?:src|href|action)\s*=|\bpostMessage\b/,
		};
		const files = readdirSync(dir).filter((file) => file.endsWith(".ts"));
		expect(files.toSorted()).toEqual(["jitless.ts", "main.ts", "render.ts"]);
		for (const file of files) {
			// Code only: the view's sources have whole-line comments.
			const source = readFileSync(path.join(dir, file), "utf8").replace(/^\s*\/\/.*$/gm, "");
			for (const [kind, pattern] of Object.entries(banned)) {
				expect(source.match(pattern), `${file}: ${kind}`).toBeNull();
			}
			const calls = [...source.matchAll(/\bapp\.(\w+)/g)].map(([, method]) => method);
			expect([...new Set(calls)].toSorted(), file).toEqual(
				file === "main.ts" ? ["addEventListener", "connect"] : [],
			);
		}
		const html = readFileSync(path.join(dir, "index.html"), "utf8");
		expect(
			html.match(/\son\w+\s*=|https?:|\/\/|<(?:iframe|object|embed|form|base|link|img)\b/gi),
		).toBeNull();
		expect([...html.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag)).toEqual([
			'<script type="module" src="./main.ts">',
		]);
	});
});

describe("the vendored ext-apps basic host and constants", () => {
	it("is the basic host at the commit SOURCE names, every file unmodified", () => {
		const dir = path.resolve(import.meta.dirname, "..", "vendor", "basic-host");
		const source = readFileSync(path.join(dir, "SOURCE"), "utf8");
		expect(source).toMatch(/^Commit: 82221c0c8ce7661efa6771c9d461511b1650495f$/m);
		const listed = Object.fromEntries(
			[...source.matchAll(/^([0-9a-f]{64}) {2}(\S+)$/gm)].map(([, hash, file]) => [file, hash]),
		);
		const onDisk = (
			readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[]
		)
			.filter((entry) => entry.isFile())
			.map((entry) =>
				path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
			)
			.filter((file) => file !== "SOURCE")
			.toSorted();
		expect(onDisk).toEqual(Object.keys(listed).toSorted());
		for (const file of onDisk)
			expect(sha256(readFileSync(path.join(dir, file))), file).toBe(listed[file]);
		expect(onDisk).toContain("LICENSE");
	});

	it("names the extension and MIME type as @modelcontextprotocol/ext-apps 2.0.3 does", () => {
		expect([UI_EXTENSION, UI_MIME_TYPE]).toEqual([EXTENSION_ID, RESOURCE_MIME_TYPE]);
		expect(getUiCapability(UI)).toEqual({ mimeTypes: [UI_MIME_TYPE] });
	});
});
