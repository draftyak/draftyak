// M0.23a, offline: the tray, autostart and approval-window wiring that the heavy tier runs. The
// autostart pins and the npm package's commands; the capabilities that keep the approval_* commands
// to the approval window; the main window's entry and CSP; the approval protocol's CSP; that
// neither page writes HTML or script from strings, uses storage or registers a service worker; and
// that the spike control's replies can't be mistaken for supervisor events.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const spikeDir = path.resolve(import.meta.dirname, "..");
const appDir = path.join(spikeDir, "tauri-app");
const tauriDir = path.join(appDir, "src-tauri");
const require = createRequire(path.join(spikeDir, "package.json"));
const read = (...parts: string[]): string => fs.readFileSync(path.join(...parts), "utf8");
const json = (...parts: string[]): Record<string, unknown> => JSON.parse(read(...parts));
const config = json(tauriDir, "tauri.conf.json") as {
	identifier: string;
	build: Record<string, unknown>;
	app: { windows: Record<string, unknown>[]; security: { csp: string } };
};

const lockedVersion = (crate: string): string | undefined =>
	read(tauriDir, "Cargo.lock")
		.split("[[package]]")
		.map((entry) => /name = "(.+)"\s+version = "(.+)"/.exec(entry))
		.find((match) => match?.[1] === crate)?.[2];

// A CSP as directive -> sources.
function directives(csp: string): Map<string, string[]> {
	const parsed = csp
		.split(";")
		.map((part) => part.trim().split(/\s+/))
		.filter((words) => words[0] !== "");
	return new Map(parsed.map(([name = "", ...sources]) => [name, sources]));
}

// What a strict policy must say, wherever it is served from.
function expectStrict(csp: string): void {
	const policy = directives(csp);
	for (const [name, sources] of [
		["default-src", ["'none'"]],
		["script-src", ["'self'"]],
		["connect-src", ["ipc:", "http://ipc.localhost"]],
		["worker-src", ["'none'"]],
		["frame-src", ["'none'"]],
		["object-src", ["'none'"]],
		["base-uri", ["'none'"]],
		["form-action", ["'none'"]],
		["require-trusted-types-for", ["'script'"]],
		["trusted-types", ["'none'"]],
	] as const) {
		expect(policy.get(name), name).toEqual(sources);
	}
	expect(csp).not.toMatch(/'unsafe-|\*|data:|blob:|https?:\/\/(?!ipc\.localhost)/);
}

// The approval protocol's CSP, as approval.rs sends it.
function approvalCsp(): string {
	const source = read(tauriDir, "src", "approval.rs");
	const literal = /pub const CSP: &str = "((?:[^"\\]|\\.)*)";/s.exec(source)?.[1];
	if (literal === undefined) throw new Error("approval.rs has no CSP constant");
	return literal.replace(/\\\r?\n\s*/g, "");
}

describe("autostart pins", () => {
	it("pins tauri-plugin-autostart 2.7.0 (auto-launch 0.6.0) and the tray icon, under the app feature", () => {
		const manifest = read(tauriDir, "Cargo.toml");
		expect(manifest).toMatch(
			/^tauri = \{ version = "=2\.12\.4", optional = true, features = \["tray-icon"\] \}$/m,
		);
		expect(manifest).toMatch(
			/^tauri-plugin-autostart = \{ version = "=2\.7\.0", optional = true \}$/m,
		);
		expect(manifest).toMatch(
			/^app = \["dep:tauri", "dep:tauri-build", "dep:tauri-plugin-autostart"\]$/m,
		);
		expect(lockedVersion("tauri-plugin-autostart")).toBe("2.7.0");
		expect(lockedVersion("auto-launch")).toBe("0.6.0");
	});

	it("pins @tauri-apps/plugin-autostart 2.7.0, whose commands are the Rust plugin's", () => {
		const manifest = json(spikeDir, "package.json") as { dependencies: Record<string, string> };
		expect(manifest.dependencies["@tauri-apps/plugin-autostart"]).toBe("2.7.0");
		const entry = require.resolve("@tauri-apps/plugin-autostart");
		const dir = path.dirname(entry);
		expect(json(dir, "..", "package.json").version).toBe("2.7.0");
		const module = read(dir, "index.js");
		const commands = [...module.matchAll(/invoke\('plugin:autostart\|(\w+)'\)/g)].map(
			(match) => match[1],
		);
		// tauri-plugin-autostart 2.7.0: generate_handler![enable, disable, is_enabled].
		expect(commands.toSorted()).toEqual(["disable", "enable", "is_enabled"]);
		expect(module).toMatch(/^import \{ invoke \} from '@tauri-apps\/api\/core';$/m);
	});
});

describe("capabilities", () => {
	const capabilities = fs
		.readdirSync(path.join(tauriDir, "capabilities"))
		.map((file) => ({ file, ...(json(tauriDir, "capabilities", file) as { identifier: string }) }));

	it("gives the approval window only allow-approval-ready, and the main window only the autostart read", () => {
		expect(capabilities.map(({ file }) => file).toSorted()).toEqual(["approval.json", "main.json"]);
		const byId = Object.fromEntries(
			capabilities.map((capability) => [capability.identifier, capability]),
		);
		expect(byId.approval).toMatchObject({
			windows: ["approval"],
			permissions: ["allow-approval-ready"],
		});
		expect(byId.main).toMatchObject({
			windows: ["main"],
			permissions: ["autostart:allow-is-enabled"],
		});
		for (const capability of capabilities) {
			expect(Object.keys(capability).toSorted()).toEqual([
				"description",
				"file",
				"identifier",
				"permissions",
				"windows",
			]);
		}
	});

	it("defines approval_ready, the app's only command, in one permission that names nothing else", () => {
		const permissions = fs.readdirSync(path.join(tauriDir, "permissions"));
		expect(permissions).toEqual(["approval.toml"]);
		const toml = read(tauriDir, "permissions", "approval.toml");
		expect([...toml.matchAll(/^identifier = "(.+)"$/gm)].map((match) => match[1])).toEqual([
			"allow-approval-ready",
		]);
		expect([...toml.matchAll(/^commands\.(\w+) = (.+)$/gm)].map((match) => match.slice(1))).toEqual(
			[["allow", '["approval_ready"]']],
		);
		const app = read(tauriDir, "src", "app.rs");
		expect(app).toContain("tauri::generate_handler![approval::approval_ready]");
		const commands = [
			...read(tauriDir, "src", "approval.rs").matchAll(/#\[tauri::command\]\s+pub fn (\w+)/g),
		];
		expect(commands.map((match) => match[1])).toEqual(["approval_ready"]);
	});
});

describe("windows", () => {
	it("declares the main window for Open, not for startup, with a strict CSP and Trusted Types", () => {
		expect(config.identifier).toBe("com.draftyak.spike.desktop");
		expect(config.build).toEqual({ frontendDist: "../ui" });
		expect(config.app.windows).toEqual([
			expect.objectContaining({ label: "main", create: false, url: "index.html" }),
		]);
		expectStrict(config.app.security.csp);
		expect(Object.keys(config.app)).not.toContain("withGlobalTauri");
	});

	it("serves the approval page under a strict CSP that also forbids framing", () => {
		const csp = approvalCsp();
		expectStrict(csp);
		expect(directives(csp).get("frame-ancestors")).toEqual(["'none'"]);
		expect(directives(csp).get("style-src")).toEqual(["'none'"]);
	});

	it("keeps both pages free of inline script, HTML sinks, eval, storage and service workers", () => {
		const forbidden =
			/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|localStorage|sessionStorage|indexedDB|\bcaches\b|document\.cookie|serviceWorker\.|\.register\(/;
		for (const file of [
			path.join(appDir, "approval", "approval.js"),
			path.join(appDir, "ui", "main.js"),
		]) {
			expect(read(file), file).not.toMatch(forbidden);
		}
		const page = read(appDir, "approval", "approval.html");
		expect([...page.matchAll(/<script\b[^>]*>/g)].map((match) => match[0])).toEqual([
			'<script type="module" src="./approval.js">',
		]);
		expect(page).not.toMatch(/\son\w+=|\sstyle=|<style|<meta http-equiv/i);
		const main = read(appDir, "ui", "index.html");
		const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(main)?.[1] ?? "{}";
		expect(JSON.parse(map)).toEqual({
			imports: {
				"@tauri-apps/api/core": "./vendor/api/core.js",
				"@tauri-apps/plugin-autostart": "./vendor/plugin-autostart/index.js",
			},
		});
		expect(read(appDir, ".gitignore")).toMatch(/^\/ui\/vendor\/$/m);
	});
});

describe("spike control", () => {
	it("tags every reply with event control, which no supervisor event uses", () => {
		const events = [...read(tauriDir, "src", "sidecar.rs").matchAll(/"event": "(\w+)"/g)].map(
			(match) => match[1],
		);
		expect(events).toEqual(expect.arrayContaining(["ready", "keepAwake", "log", "stopped"]));
		expect(events).not.toContain("control");
		const control = read(tauriDir, "src", "control.rs");
		expect(control).toContain('reply["event"] = json!("control");');
		expect(control.match(/reply\["event"\]/g)).toHaveLength(1);
	});
});
