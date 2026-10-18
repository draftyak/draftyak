import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { build, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const spike = path.resolve(import.meta.dirname, "..");
export const VENDOR_HOST: string = path.join(spike, "vendor", "basic-host");

// The CSP vendor/basic-host/serve.ts puts on sandbox.html when the view declares no ui.csp; the
// inner frame inherits it through document.write.
export const BASIC_HOST_CSP: string = [
	"default-src 'self' 'unsafe-inline'",
	"script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:",
	"style-src 'self' 'unsafe-inline' blob: data:",
	"img-src 'self' data: blob:",
	"font-src 'self' data: blob:",
	"media-src 'self' data: blob:",
	"connect-src 'self'",
	"worker-src 'self' blob:",
	"frame-src 'none'",
	"object-src 'none'",
	"base-uri 'none'",
].join("; ");

async function singleFile(root: string, page: string, outDir: string, plugins: Plugin[]) {
	await build({
		root,
		configFile: false,
		envDir: false,
		publicDir: false,
		cacheDir: path.join(outDir, "cache"),
		logLevel: "warn",
		mode: "production",
		plugins: [...plugins, viteSingleFile()],
		build: {
			outDir,
			emptyOutDir: true,
			target: "es2022",
			modulePreload: { polyfill: false },
			reportCompressedSize: false,
			rolldownOptions: { input: path.join(root, page) },
		},
	});
	return readFileSync(path.join(outDir, page), "utf8");
}

// The vendored basic host fixes its sandbox at http://localhost:8081; this run's build points it at
// a free port instead and leaves the vendored file as it is.
function sandboxAt(url: string): Plugin {
	const fixed = '"http://localhost:8081/sandbox.html"';
	return {
		name: "draftyak:sandbox-url",
		transform(code, id) {
			if (!id.endsWith("/basic-host/src/implementation.ts")) return null;
			if (!code.includes(fixed)) this.error(`implementation.ts no longer fixes ${fixed}`);
			return code.replace(fixed, JSON.stringify(url));
		},
	};
}

export interface HostPages {
	readonly host: string;
	readonly sandbox: string;
}

// The harness page (test/apps-host) and the basic host's sandbox page, each as one HTML file.
export async function buildHost(sandboxUrl: string, work: string): Promise<HostPages> {
	const harness = path.join(spike, "test", "apps-host");
	return {
		host: await singleFile(harness, "index.html", path.join(work, "host"), [sandboxAt(sandboxUrl)]),
		sandbox: await singleFile(VENDOR_HOST, "sandbox.html", path.join(work, "sandbox"), []),
	};
}

export interface Fetcher {
	fetch(request: Request): Response | Promise<Response>;
}

export interface Sites {
	readonly host: string;
	readonly sandbox: string;
	readonly canary: string;
	// Paths requested from the canary origin, which only an injected payload would ask for.
	readonly canaryHits: string[];
	// Each request the MCP endpoint got: its method, and the tool name for tools/call.
	readonly mcpCalls: string[];
	serve(pages: HostPages): void;
	// A page served as it is at <host>/views/<name>, for loading a view as the top document.
	put(name: string, html: string): string;
	close(): Promise<void>;
}

function listen(app: Hono): Promise<{ origin: string; close: () => Promise<void> }> {
	return new Promise((resolve, reject) => {
		const server = serve(
			{ fetch: app.fetch, hostname: "127.0.0.1", port: 0, overrideGlobalObjects: false },
			(info) => {
				const close = (): Promise<void> =>
					new Promise((done) => {
						server.close(() => done());
						server.closeAllConnections();
					});
				resolve({ origin: `http://127.0.0.1:${info.port}`, close });
			},
		) as Server;
		server.once("error", reject);
	});
}

// Three loopback origins on free ports: the host page with the MCP endpoint on its own origin (the
// hub sends no CORS headers), the sandbox proxy with the basic host's CSP header, and a canary.
export async function startSites(mcp: Fetcher): Promise<Sites> {
	let pages: HostPages = { host: "", sandbox: "" };
	const canaryHits: string[] = [];
	const mcpCalls: string[] = [];
	const views = new Map<string, string>();
	const site = new Hono();
	site.all("/mcp", async (c) => {
		const body = (await c.req.raw
			.clone()
			.json()
			.catch(() => undefined)) as { method?: unknown; params?: { name?: unknown } } | undefined;
		if (typeof body?.method === "string") {
			mcpCalls.push(
				body.method === "tools/call" ? `tools/call ${String(body.params?.name)}` : body.method,
			);
		}
		return mcp.fetch(c.req.raw);
	});
	site.get("/", (c) => c.html(pages.host));
	site.get("/views/:name", (c) => {
		const html = views.get(c.req.param("name"));
		return html === undefined ? c.notFound() : c.html(html);
	});
	const proxy = new Hono();
	proxy.get("/sandbox.html", () => {
		const headers = {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": BASIC_HOST_CSP,
			"cache-control": "no-cache, no-store, must-revalidate",
		};
		return new Response(pages.sandbox, { headers });
	});
	const canary = new Hono();
	canary.all("*", (c) => {
		canaryHits.push(new URL(c.req.url).pathname);
		return c.body(null, 204);
	});
	const [host, sandbox, trap] = await Promise.all([listen(site), listen(proxy), listen(canary)]);
	return {
		host: host.origin,
		sandbox: sandbox.origin,
		canary: trap.origin,
		canaryHits,
		mcpCalls,
		serve: (built) => {
			pages = built;
		},
		put: (name, html) => {
			views.set(name, html);
			return `${host.origin}/views/${name}`;
		},
		close: async () => {
			await Promise.all([host.close(), sandbox.close(), trap.close()]);
		},
	};
}

// Runs in every frame before its scripts:
// - securitypolicyviolation events go to __violations (again after document.open, which drops
//   listeners);
// - __codegen counts code made from strings where it starts (calls of the global Function and
//   eval, and timers given a string), because WebKit dispatches no eval violation in a frame
//   written through srcdoc or document.write. Playwright evaluates in the page through
//   this.global.eval(expression), with the window as receiver, so eval calls made that way (a
//   page's own window.eval(...) too) aren't counted; for those there are Chromium's violation
//   events and WebKit's in a top-level document;
// - a framed window keeps the own keys of each tool result's structuredContent in __toolResults;
// - the top window keeps every message a frame posts to it in __messages, the recorder.
export const RECORDER = `(() => {
	if ("__violations" in window) return;
	const violations = [];
	const codegen = { function: 0, eval: 0, stringTimer: 0 };
	const toolResults = [];
	Object.defineProperty(window, "__violations", { value: violations });
	Object.defineProperty(window, "__codegen", { value: codegen });
	Object.defineProperty(window, "__toolResults", { value: toolResults });
	const record = (event) => violations.push({
		directive: event.effectiveDirective,
		blockedURI: String(event.blockedURI).slice(0, 64),
		disposition: event.disposition,
	});
	const toolResult = (event) => {
		const data = event.data;
		if (data && data.method === "ui/notifications/tool-result") {
			const content = data.params && data.params.structuredContent;
			toolResults.push(content && typeof content === "object" ? Object.keys(content) : []);
		}
	};
	const listen = () => {
		window.addEventListener("securitypolicyviolation", record, true);
		if (window !== window.top) window.addEventListener("message", toolResult, true);
	};
	listen();
	const open = Document.prototype.open;
	Document.prototype.open = function (...args) {
		const result = open.apply(this, args);
		listen();
		return result;
	};
	const RealFunction = window.Function;
	const countedFunction = new Proxy(RealFunction, {
		apply(target, self, args) {
			codegen.function++;
			return Reflect.apply(target, self, args);
		},
		construct(target, args, newTarget) {
			codegen.function++;
			return Reflect.construct(target, args, newTarget === countedFunction ? target : newTarget);
		},
	});
	Object.defineProperty(window, "Function", {
		value: countedFunction,
		writable: true,
		configurable: true,
	});
	window.eval = new Proxy(window.eval, {
		apply(target, self, args) {
			if (self !== window) codegen.eval++;
			return Reflect.apply(target, self, args);
		},
	});
	for (const name of ["setTimeout", "setInterval"]) {
		const timer = window[name];
		window[name] = function (handler, ...rest) {
			if (typeof handler !== "function") codegen.stringTimer++;
			return timer.call(window, handler, ...rest);
		};
	}
	if (window === window.top) {
		const messages = [];
		Object.defineProperty(window, "__messages", { value: messages });
		window.addEventListener("message", (event) => {
			if (event.source !== window) messages.push(event.data);
		}, true);
	}
})();`;
