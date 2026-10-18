import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	type CallToolResult,
	CLIENT_CAPABILITIES_META_KEY,
	type McpServer,
	type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod";
import { ULID } from "./resources.ts";

// §6 MCP Apps: the extension, the views' MIME type and the spike's one view.
export const UI_EXTENSION = "io.modelcontextprotocol/ui";
export const UI_MIME_TYPE = "text/html;profile=mcp-app";
export const DRAFT_VIEW = "ui://draftyak/draft-v1";
export const VIEWS_MANIFEST = "views.manifest.json";
export const MAX_VIEW_BYTES: number = 256 * 1024;
const HOUR = 3_600_000;

// A built view as views.manifest.json lists it: the file's SHA-256 (hex), its size in bytes and the
// meta CSP the build pinned into it.
export interface ViewEntry {
	readonly uri: string;
	readonly file: string;
	readonly sha256: string;
	readonly size: number;
	readonly csp: string;
}
export interface View extends ViewEntry {
	readonly html: string;
}

// What the hub serves for Apps: the views and, standing in for its drafts, the fake data that the
// view-linked draft_get returns by draft id.
export interface Apps {
	readonly views: readonly View[];
	readonly drafts: Readonly<Record<string, unknown>>;
}

// Plan §6: no source but the hashed inline scripts, inline styles, data: images, no connections,
// no <base> and no form targets.
export function cspFor(scriptHashes: readonly string[]): string {
	const scripts = scriptHashes.map((hash) => `'sha256-${hash}'`).join(" ");
	return `default-src 'none'; script-src ${scripts}; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
}

export const CHARSET = '<meta charset="utf-8">';
export const cspMeta = (csp: string): string =>
	`<meta http-equiv="Content-Security-Policy" content="${csp}">`;
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const HEAD = /^<!doctype html>\s*<html\b[^>]*>\s*<head>\s*$/i;

// The base64 SHA-256 of each inline script; a script that loads from a URL is refused.
export function inlineScriptHashes(html: string): string[] {
	return [...html.matchAll(SCRIPT)].map(([, attributes = "", code = ""]) => {
		if (/\bsrc\s*=/i.test(attributes)) throw new Error("a view's scripts are inline only");
		return createHash("sha256").update(code, "utf8").digest("base64");
	});
}

// What the build pins and the hub requires: §6's policy over exactly the page's inline scripts, in a
// CSP meta right after the one charset meta, the two opening the head, so no comment, script or
// style comes first. Returns the problem, if any.
export function pinProblem(html: string, csp: string): string | undefined {
	const hashes = inlineScriptHashes(html);
	if (hashes.length === 0) return "has no inline script to pin";
	if (csp !== cspFor(hashes)) return "has a CSP that isn't §6's policy over its inline scripts";
	const at = html.indexOf(`${CHARSET}${cspMeta(csp)}`);
	if (html.split(CHARSET).length !== 2 || at < 0 || !HEAD.test(html.slice(0, at))) {
		return `doesn't open its head with ${CHARSET} and the CSP meta`;
	}
	return undefined;
}

const Manifest = z.object({
	views: z.array(
		z.object({
			uri: z.string().regex(/^ui:\/\/draftyak\/[a-z0-9-]+$/),
			file: z.string().regex(/^[a-z0-9-]+\.html$/),
			sha256: z.string().regex(/^[0-9a-f]{64}$/),
			size: z.number().int().positive().max(MAX_VIEW_BYTES),
			csp: z.string().min(1),
		}),
	),
});

// The hub checks the built views at start: each file matches the manifest's size and SHA-256, and
// its CSP is the one the build pins for its own scripts.
export function loadViews(dir: string): View[] {
	const manifest = Manifest.parse(JSON.parse(readFileSync(path.join(dir, VIEWS_MANIFEST), "utf8")));
	return manifest.views.map((entry) => {
		const bytes = readFileSync(path.join(dir, entry.file));
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (bytes.length !== entry.size || sha256 !== entry.sha256) {
			throw new Error(`${entry.file} doesn't match ${VIEWS_MANIFEST}`);
		}
		const html = bytes.toString("utf8");
		const problem = pinProblem(html, entry.csp);
		if (problem !== undefined) throw new Error(`${entry.file} ${problem}`);
		return { ...entry, html };
	});
}

// The request's own capabilities declare the Apps extension for the views' MIME type: the 2026-era
// envelope, never clientInfo.
export function declaresUi(ctx: ServerContext): boolean {
	const envelope = (ctx.mcpReq.envelope ?? {}) as Record<string, unknown>;
	const declared = envelope[CLIENT_CAPABILITIES_META_KEY] as { extensions?: unknown } | undefined;
	const extensions = declared?.extensions as Record<string, unknown> | undefined;
	const ui = extensions?.[UI_EXTENSION] as { mimeTypes?: unknown } | undefined;
	return Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(UI_MIME_TYPE);
}

// Tools whose results a view renders (§6 has six; the spike has draft_get).
const VIEW_OF: ReadonlyMap<string, string> = new Map([["draft_get", DRAFT_VIEW]]);

// §6 Tool metadata: every tool gets visibility ["model"], so compliant hosts refuse calls from a
// view, and view-linked tools also get resourceUri. Results are the same with or without it.
export function withUiMeta(result: unknown): unknown {
	const listed = result as { tools?: unknown };
	if (!Array.isArray(listed.tools)) return result;
	const tools = listed.tools.map((tool: { name: string; _meta?: Record<string, unknown> }) => {
		const resourceUri = VIEW_OF.get(tool.name);
		const ui = { ...(resourceUri === undefined ? {} : { resourceUri }), visibility: ["model"] };
		return { ...tool, _meta: { ...tool._meta, ui } };
	});
	return { ...listed, tools };
}

// ui:// views stay out of resources/list: hosts find them through tool metadata.
export function withoutViews(result: unknown): unknown {
	const listed = result as { resources?: unknown };
	if (!Array.isArray(listed.resources)) return result;
	const resources = listed.resources.filter(
		(resource: { uri?: unknown }) => !String(resource.uri).startsWith("ui://"),
	);
	return { ...listed, resources };
}

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

// The views, public and cached for an hour like the guide (any principal may read them), and the
// fake draft_get whose results draft-v1 renders.
export function registerApps(server: McpServer, apps: Apps): void {
	if (!apps.views.some((view) => view.uri === DRAFT_VIEW)) {
		throw new Error(`draft_get needs the ${DRAFT_VIEW} view`);
	}
	for (const view of apps.views) {
		server.registerResource(
			view.uri.slice(view.uri.lastIndexOf("/") + 1),
			view.uri,
			{ mimeType: UI_MIME_TYPE, cacheHint: { cacheScope: "public", ttlMs: HOUR } },
			() => ({ contents: [{ uri: view.uri, mimeType: UI_MIME_TYPE, text: view.html }] }),
		);
	}
	server.registerTool(
		"draft_get",
		{
			title: "Get a draft",
			description: "Reads one draft by its id (fake data).",
			inputSchema: z.object({ draftId: z.string().regex(ULID) }),
			annotations: READ_ONLY,
		},
		({ draftId }): CallToolResult => {
			const draft = Object.hasOwn(apps.drafts, draftId) ? apps.drafts[draftId] : undefined;
			if (draft === undefined) {
				return { isError: true, content: [{ type: "text", text: `No draft ${draftId}.` }] };
			}
			return {
				structuredContent: draft as Record<string, unknown>,
				content: [{ type: "text", text: JSON.stringify(draft) }],
			};
		},
	);
}
