// node views/build.ts (pnpm build:views): each view as one HTML file in views/dist with a meta CSP
// pinning its inline script by hash, plus views.manifest.json (URI, file, SHA-256, size, CSP).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import {
	CHARSET,
	cspFor,
	cspMeta,
	DRAFT_VIEW,
	inlineScriptHashes,
	MAX_VIEW_BYTES,
	pinProblem,
	VIEWS_MANIFEST,
	type ViewEntry,
} from "../src/apps.ts";

export const VIEWS: Readonly<Record<string, string>> = { "draft-v1": DRAFT_VIEW };

// Hashes every inline script and puts the CSP right after the charset, ahead of any script or
// style, as loadViews requires. A script that loads from a URL fails the build.
export function pinCsp(html: string): { readonly html: string; readonly csp: string } {
	const hashes = inlineScriptHashes(html);
	if (hashes.length === 0) throw new Error("the view has no inline script to pin");
	if (html.split(CHARSET).length !== 2) throw new Error(`the view needs one ${CHARSET}`);
	const csp = cspFor(hashes);
	const pinned = html.replace(CHARSET, `${CHARSET}${cspMeta(csp)}`);
	const problem = pinProblem(pinned, csp);
	if (problem !== undefined) throw new Error(`the built view ${problem}`);
	return { html: pinned, csp };
}

// One view folder (index.html and its TypeScript) as a single pinned HTML file.
export async function buildView(
	root: string,
	plugins: readonly Plugin[] = [],
): Promise<{ readonly html: string; readonly csp: string }> {
	const stage = mkdtempSync(path.join(os.tmpdir(), "draftyak-view-"));
	try {
		await build({
			root,
			configFile: false,
			envDir: false,
			publicDir: false,
			cacheDir: path.join(stage, "cache"),
			logLevel: "warn",
			mode: "production",
			plugins: [...plugins, viteSingleFile()],
			build: {
				outDir: path.join(stage, "out"),
				emptyOutDir: true,
				target: "es2022",
				modulePreload: { polyfill: false },
				reportCompressedSize: false,
				rolldownOptions: { input: path.join(root, "index.html") },
			},
		});
		return pinCsp(readFileSync(path.join(stage, "out", "index.html"), "utf8"));
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

export async function buildViews(outDir: string): Promise<ViewEntry[]> {
	mkdirSync(outDir, { recursive: true });
	const views: ViewEntry[] = [];
	for (const [name, uri] of Object.entries(VIEWS)) {
		const { html, csp } = await buildView(path.join(import.meta.dirname, name));
		const bytes = Buffer.from(html, "utf8");
		if (bytes.length > MAX_VIEW_BYTES) {
			throw new Error(`${name} is ${bytes.length} bytes, over the ${MAX_VIEW_BYTES}-byte cap`);
		}
		const file = `${name}.html`;
		writeFileSync(path.join(outDir, file), bytes);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		views.push({ uri, file, sha256, size: bytes.length, csp });
	}
	writeFileSync(path.join(outDir, VIEWS_MANIFEST), `${JSON.stringify({ views }, null, 2)}\n`);
	return views;
}

if (import.meta.main) {
	for (const view of await buildViews(path.join(import.meta.dirname, "dist"))) {
		console.log(`${view.uri}: ${view.file}, ${view.size} bytes, sha256 ${view.sha256}`);
	}
}
