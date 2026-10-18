// The test's host page, built around the vendored basic host's own code: it connects, lists and calls
// tools and renders views through vendor/basic-host/src/implementation.ts. ?mode=sandbox takes the
// basic host's path (its sandbox proxy on a second origin, as src/index.tsx's AppIFramePanel does);
// ?mode=direct renders the view in a plain same-origin srcdoc frame, with no sandbox and no host
// CSP, as a host that skips the sandbox would. ?structured=<JSON> hands the view that
// structuredContent instead of the server's, from the host side: on the 2025 leg this host uses,
// the server SDK drops own __proto__ keys.
import {
	getToolUiResourceUri,
	PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import {
	callTool,
	connectToServer,
	hasAppHtml,
	initializeApp,
	loadSandboxProxy,
	newAppBridge,
} from "../../vendor/basic-host/src/implementation.ts";

declare global {
	interface Window {
		harness?: Record<string, unknown>;
	}
}

const params = new URLSearchParams(location.search);
const mode = params.get("mode");
const tool = params.get("tool") ?? "";
const args = JSON.parse(params.get("args") ?? "{}") as Record<string, unknown>;
const structured = params.get("structured");
const options = { containerDimensions: { maxHeight: 6000 }, displayMode: "inline" } as const;

async function run(): Promise<Record<string, unknown>> {
	const server = await connectToServer(new URL("/mcp", location.href));
	const listed = [...server.tools.values()].map((entry) => ({
		name: entry.name,
		ui: entry._meta?.ui ?? null,
		resourceUri: getToolUiResourceUri(entry) ?? null,
	}));
	const resources = [...server.resources.keys()];
	const called = callTool(server, tool, args);
	if (!hasAppHtml(called)) {
		return { listed, resources, app: false, result: await called.resultPromise };
	}
	const resultPromise =
		structured === null
			? called.resultPromise
			: called.resultPromise.then((real) => ({
					...real,
					structuredContent: JSON.parse(structured),
				}));
	const info = { ...called, resultPromise };
	const iframe = document.createElement("iframe");
	document.body.append(iframe);
	if (mode === "sandbox") {
		const { csp, permissions } = await info.appResourcePromise;
		await loadSandboxProxy(iframe, csp, permissions);
		await initializeApp(iframe, newAppBridge(server, iframe, {}, options), info);
		return { listed, resources, app: true };
	}
	const bridge = newAppBridge(server, iframe, {}, options);
	const initialized = new Promise<void>((resolve) => {
		bridge.oninitialized = () => resolve();
	});
	const view = iframe.contentWindow;
	if (view === null) throw new Error("the frame has no window");
	await bridge.connect(new PostMessageTransport(view, view));
	iframe.srcdoc = (await info.appResourcePromise).html;
	await initialized;
	await bridge.sendToolInput({ arguments: args });
	await bridge.sendToolResult(await info.resultPromise);
	return { listed, resources, app: true };
}

run().then(
	(outcome) => {
		window.harness = { state: "done", ...outcome };
	},
	(error: unknown) => {
		window.harness = {
			state: "error",
			detail: String(error instanceof Error ? error.stack : error),
		};
	},
);
