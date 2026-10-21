import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askSlack, hidden, type Terminal } from "../scripts/tokens.ts";
import { FakeSlack, fakeToken } from "./fake-slack.ts";

// scripts/tokens.ts, session 2's token step, against a temp .env.live (DRAFTYAK_ENV_LIVE). The
// CLI children install their own fake fetch/DNS/TCP boundary before importing the real entry.
// Node's network permission is also left denied. Only synthetic scratch stores are writable.
const cli = fileURLToPath(new URL("../scripts/tokens.ts", import.meta.url));
let dir = "";
let file = "";

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-s06-tokens-"));
	file = path.join(dir, ".env.live");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface Reply {
	readonly status?: number;
	readonly error?: string;
	readonly ok?: boolean;
	readonly network?: boolean;
	readonly malformed?: boolean;
	readonly message?: string;
}

interface Scenario {
	readonly replies?: readonly Reply[];
	readonly replaceAfter?: number;
	readonly replacement?: string;
}

const boundary = String.raw`
import fs from "node:fs";
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
const config = JSON.parse(fs.readFileSync(process.env.DY_TOKEN_TEST_CONFIG, "utf8"));
const log = (name) => fs.appendFileSync(config.trace, name + "\n");
const deny = (name) => () => { log("blocked:" + name); throw new Error("offline network boundary"); };
for (const name of Object.keys(dns).filter((name) => /^(lookup|resolve|reverse)/.test(name))) {
  dns[name] = deny("dns." + name);
  if (name in dns.promises) dns.promises[name] = deny("dns.promises." + name);
}
for (const [prefix, Resolver] of [["dns.Resolver", dns.Resolver], ["dns.promises.Resolver", dns.promises.Resolver]]) {
  for (const name of Object.getOwnPropertyNames(Resolver.prototype).filter((name) => /^(resolve|reverse)/.test(name))) {
    Resolver.prototype[name] = deny(prefix + "." + name);
  }
}
net.connect = deny("net.connect");
net.createConnection = deny("net.createConnection");
net.Socket.prototype.connect = deny("net.Socket.connect");
tls.connect = deny("tls.connect");
http.request = deny("http.request");
http.get = deny("http.get");
https.request = deny("https.request");
https.get = deny("https.get");
dgram.createSocket = deny("dgram.createSocket");
globalThis.WebSocket = class { constructor() { deny("WebSocket")(); } };
syncBuiltinESMExports();
let count = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = url.pathname.slice("/api/".length);
  const kind = method === "auth.test" ? "user" : method === "apps.connections.open" ? "app" : "";
  const reply = config.replies[count];
  if (url.origin !== "https://slack.com" || url.pathname !== "/api/" + method ||
      url.search !== "" || !kind || !reply || init?.method !== "POST" ||
      init.redirect !== "error" ||
      new Headers(init.headers).get("authorization") !== "Bearer " + config.expected[kind]) {
    return deny("fetch")();
  }
  count++;
  log("fetch:" + method);
  if (count === config.replaceAfter) {
    await new Promise((resolve) => setImmediate(resolve));
    fs.writeFileSync(config.store, config.replacement);
  }
  if (reply.network) throw new Error(reply.message ?? "network response canary");
  if (reply.malformed) return new Response("not an API response", { status: reply.status ?? 403 });
  return Response.json({ ok: reply.ok ?? false, error: reply.error, message: reply.message }, { status: reply.status ?? 200 });
};
log("ready");
`;

function trace(): string[] {
	return readFileSync(path.join(dir, "trace"), "utf8").trim().split("\n");
}

function child(args: readonly string[], input = "", scenario: Scenario = {}, target = file) {
	const preload = path.join(dir, "boundary.mjs");
	const config = path.join(dir, "scenario.json");
	const journal = path.join(dir, "trace");
	const text = existsSync(target) ? readFileSync(target, "utf8") : "";
	const selected = (name: string): string | null =>
		new RegExp(`^${name}=([^\\r\\n]*)`, "m").exec(text)?.[1] ?? null;
	writeFileSync(preload, boundary);
	writeFileSync(journal, "");
	writeFileSync(
		config,
		JSON.stringify({
			...scenario,
			replies: scenario.replies ?? [],
			store: target,
			trace: journal,
			expected: {
				user: selected("DY_LIVE_SLACK_USER_TOKEN"),
				app: selected("DY_LIVE_SLACK_APP_TOKEN"),
			},
		}),
	);
	const result = spawnSync(
		process.execPath,
		[
			"--permission",
			"--allow-fs-read=*",
			`--allow-fs-write=${dir}`,
			"--allow-child-process",
			"--import",
			pathToFileURL(preload).href,
			...args,
		],
		{
			input,
			encoding: "utf8",
			env: {
				...process.env,
				NODE_OPTIONS: "",
				DRAFTYAK_ENV_LIVE: target,
				DY_TOKEN_TEST_CONFIG: config,
			},
			timeout: 10000,
			windowsHide: true,
		},
	);
	expect(result.error).toBeUndefined();
	expect(trace()[0]).toBe("ready");
	return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function run(args: readonly string[], input = "", scenario: Scenario = {}, target = file) {
	return child([cli, ...args], input, scenario, target);
}

function savedPair() {
	const user = fakeToken("xoxp");
	const app = fakeToken("xapp");
	const bytes = Buffer.from(
		"# keep exact bytes\r\nDY_LIVE_SLACK_USER_TOKEN=" +
			user +
			"\r\nUNCHANGED=fixture\r\nDY_LIVE_SLACK_APP_TOKEN=" +
			app +
			"\r\n",
	);
	writeFileSync(file, bytes);
	return { user, app, bytes };
}

function verifiedCalls(): void {
	expect(trace()).toEqual(["ready", "fetch:auth.test", "fetch:apps.connections.open"]);
}

function noValues(out: string, values: readonly string[]): void {
	for (const value of values) expect(out).not.toContain(value);
}

describe("tokens.ts", () => {
	it("installs a default-denied child boundary before any CLI import", () => {
		const probe = `
const dns = await import("node:dns");
const net = await import("node:net");
const tls = await import("node:tls");
const http = await import("node:http");
const https = await import("node:https");
const dgram = await import("node:dgram");
const probes = [
  () => fetch("https://example.invalid/"),
  () => dns.lookup("example.invalid", () => {}),
  () => dns.promises.resolve4("example.invalid"),
  () => new dns.Resolver().resolveTxt("example.invalid", () => {}),
  () => new dns.promises.Resolver().resolveMx("example.invalid"),
  () => net.connect({ host: "example.invalid", port: 443 }),
  () => new net.Socket().connect(443, "example.invalid"),
  () => tls.connect({ host: "example.invalid", port: 443 }),
  () => http.request("http://example.invalid/"),
  () => https.get("https://example.invalid/"),
  () => dgram.createSocket("udp4"),
  () => new WebSocket("wss://example.invalid/")
];
for (const probe of probes) {
  try { await probe(); throw new Error("boundary allowed a network operation"); }
  catch (error) { if (error.message !== "offline network boundary") throw error; }
}
`;
		expect(child(["--input-type=module", "--eval", probe]).code).toBe(0);
		expect(trace()).toEqual([
			"ready",
			"blocked:fetch",
			"blocked:dns.lookup",
			"blocked:dns.promises.resolve4",
			"blocked:dns.Resolver.resolveTxt",
			"blocked:dns.promises.Resolver.resolveMx",
			"blocked:net.connect",
			"blocked:net.Socket.connect",
			"blocked:tls.connect",
			"blocked:http.request",
			"blocked:https.get",
			"blocked:dgram.createSocket",
			"blocked:WebSocket",
		]);
	});
	it("saves both tokens from a pipe in either order, checks and deletes them, printing neither", () => {
		const user = fakeToken("xoxp");
		const app = fakeToken("xapp");
		const saved = run(["save", "--stdin"], `\uFEFF${app}\r\n\r\n${user}\r\n`);
		expect(saved).toEqual({
			code: 0,
			out: expect.stringContaining("saved DY_LIVE_SLACK_USER_TOKEN"),
		});
		expect(readFileSync(file, "utf8")).toBe(
			`DY_LIVE_SLACK_USER_TOKEN=${user}\nDY_LIVE_SLACK_APP_TOKEN=${app}\n`,
		);
		const checked = run(["check"]);
		expect(checked.code).toBe(0);
		expect(checked.out).toContain(`.env.live: ${file} (not in a git work tree)`);
		expect(checked.out).toContain("DY_LIVE_SLACK_USER_TOKEN: set (a user token)");
		expect(checked.out).toContain("DY_LIVE_SLACK_APP_TOKEN: set (an app-level token)");
		const deleted = run(["--", "delete"], "", {
			replies: [{ error: "token_revoked" }, { error: "invalid_auth" }],
		});
		verifiedCalls();
		expect(deleted.code).toBe(0);
		expect(deleted.out).toContain("deleted DY_LIVE_SLACK_USER_TOKEN and DY_LIVE_SLACK_APP_TOKEN");
		expect(readFileSync(file, "utf8")).toBe("");
		expect(run(["check"])).toEqual({ code: 1, out: expect.stringContaining("missing") });
		for (const { out } of [saved, checked, deleted]) {
			expect(out).not.toContain(user);
			expect(out).not.toContain(app);
		}
	});

	it.each([
		["token_revoked", "invalid_auth"],
		["not_authed", "token_expired"],
		["account_inactive", "invalid_auth"],
	])(
		"deletes only after both normal API responses refuse the saved pair (%s/%s)",
		(userCode, appCode) => {
			const pair = savedPair();
			const result = run(["delete"], "", { replies: [{ error: userCode }, { error: appCode }] });
			expect(result.code).toBe(0);
			expect(result.out).toContain("deleted DY_LIVE_SLACK_USER_TOKEN and DY_LIVE_SLACK_APP_TOKEN");
			verifiedCalls();
			expect(readFileSync(file, "utf8")).toBe("# keep exact bytes\nUNCHANGED=fixture\n");
			noValues(result.out, [pair.user, pair.app]);
		},
	);

	const uncertain: ReadonlyArray<readonly [string, Reply]> = [
		["accepted", { ok: true }],
		["unknown", { error: "unknown_refusal" }],
		["network", { network: true }],
		["proxy HTML", { status: 403, malformed: true }],
		["proxy auth-looking body", { status: 403, error: "invalid_auth" }],
		["authentication HTTP status", { status: 401, error: "invalid_auth" }],
		["non200 success status", { status: 201, error: "invalid_auth" }],
		["rate limit auth-looking body", { status: 429, error: "token_revoked" }],
		["server error auth-looking body", { status: 503, error: "invalid_auth" }],
		["malformed success", { status: 200, malformed: true }],
	];
	it.each(uncertain)(
		"preserves exact bytes after %s for either token and checks both once",
		(_case, reply) => {
			for (const at of [0, 1]) {
				const pair = savedPair();
				const replies: Reply[] = [{ error: "token_revoked" }, { error: "invalid_auth" }];
				replies[at] = { ...reply, message: pair.user + pair.app };
				const result = run(["delete"], "", { replies });
				expect(result.code).toBe(1);
				expect(result.out).toContain("tokens: deletion refused:");
				verifiedCalls();
				expect(readFileSync(file)).toEqual(pair.bytes);
				noValues(result.out, [pair.user, pair.app]);
			}
		},
	);

	it.each([
		{ changed: "user", replaceAfter: 1 },
		{ changed: "user", replaceAfter: 2 },
		{ changed: "app", replaceAfter: 1 },
		{ changed: "app", replaceAfter: 2 },
		{ changed: "both", replaceAfter: 1 },
		{ changed: "both", replaceAfter: 2 },
	])(
		"preserves $changed replacement while verification request $replaceAfter awaits",
		({ changed, replaceAfter }) => {
			const before = savedPair();
			const user = changed === "app" ? before.user : fakeToken("xoxp");
			const app = changed === "user" ? before.app : fakeToken("xapp");
			const replacement = Buffer.from(
				before.bytes.toString("utf8").replace(before.user, user).replace(before.app, app),
			);
			const result = run(["delete"], "", {
				replies: [{ error: "token_revoked" }, { error: "invalid_auth" }],
				replaceAfter,
				replacement: replacement.toString("utf8"),
			});
			expect(result.code).toBe(1);
			expect(result.out).toContain("the saved token pair changed during verification");
			verifiedCalls();
			expect(readFileSync(file)).toEqual(replacement);
			noValues(result.out, [before.user, before.app, user, app]);
		},
	);

	it("preserves an invalid complete pair without verification requests", () => {
		const pair = savedPair();
		const invalid = fakeToken("xoxb");
		const bytes = Buffer.from(pair.bytes.toString("utf8").replace(pair.user, invalid));
		writeFileSync(file, bytes);
		const result = run(["delete"]);
		expect(result.code).toBe(1);
		expect(trace()).toEqual(["ready"]);
		expect(readFileSync(file)).toEqual(bytes);
		noValues(result.out, [invalid, pair.app]);
	});

	it("preserves either partial store without a verification request", () => {
		for (const name of ["USER", "APP"]) {
			const value = fakeToken(name === "USER" ? "xoxp" : "xapp");
			const bytes = Buffer.from(`# partial\r\nDY_LIVE_SLACK_${name}_TOKEN=${value}\r\n`);
			writeFileSync(file, bytes);
			const result = run(["delete"]);
			expect(result.code).toBe(1);
			expect(result.out).toContain("a complete valid saved token pair is required");
			expect(trace()).toEqual(["ready"]);
			expect(readFileSync(file)).toEqual(bytes);
			noValues(result.out, [value]);
		}
	});

	it("leaves an absent pair idempotent without requests or rewriting unrelated bytes", () => {
		expect(run(["delete"]).code).toBe(0);
		expect(trace()).toEqual(["ready"]);
		expect(existsSync(file)).toBe(false);
		const bytes = Buffer.from("# unrelated\r\nUNCHANGED=fixture\r\n");
		writeFileSync(file, bytes);
		expect(run(["delete"]).code).toBe(0);
		expect(trace()).toEqual(["ready"]);
		expect(readFileSync(file)).toEqual(bytes);
	});

	it("has no force bypass and defaults unexpected fetch to denial", () => {
		const pair = savedPair();
		expect(run(["delete", "--force"]).code).toBe(2);
		expect(trace()).toEqual(["ready"]);
		expect(readFileSync(file)).toEqual(pair.bytes);
		const result = run(["delete"]);
		expect(result.code).toBe(1);
		expect(trace()).toEqual(["ready", "blocked:fetch", "blocked:fetch"]);
		expect(readFileSync(file)).toEqual(pair.bytes);
		noValues(result.out, [pair.user, pair.app]);
	});

	it("refuses a wrong or repeated token kind, and a terminal-less save without --stdin", () => {
		const bot = fakeToken("xoxb");
		const user = fakeToken("xoxp");
		const refused = [
			run(["save", "--stdin"], `${bot}\n${fakeToken("xapp")}\n`),
			run(["save", "--stdin"], `${user}\n${user}\n`),
			run(["save", "--stdin"], `${user}\n`),
			run(["save"], `${user}\n`),
		];
		expect(refused.map(({ code }) => code)).toEqual([1, 1, 1, 1]);
		expect(refused[3]?.out).toContain("stdin isn't a terminal");
		for (const { out } of refused) {
			expect(out).not.toContain(bot);
			expect(out).not.toContain(user);
		}
		expect(() => readFileSync(file)).toThrow();
		writeFileSync(file, `DY_LIVE_SLACK_USER_TOKEN=${bot}\n`);
		const checked = run(["check"]);
		expect(checked.code).toBe(1);
		expect(checked.out).toContain("DY_LIVE_SLACK_USER_TOKEN: that isn't a user token");
		expect(checked.out).not.toContain(bot);
		expect(run(["save", "--now"]).code).toBe(2);
	});

	it("says whether git ignores .env.live, since save refuses one it doesn't", () => {
		const repo = path.join(dir, "repo");
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
		);
		for (const args of [
			["init", "-q", repo],
			["-C", repo, "config", "maintenance.auto", "false"],
		]) {
			expect(spawnSync("git", args, { env, windowsHide: true }).status).toBe(0);
		}
		const target = path.join(repo, ".env.live");
		const check = () => run(["check"], "", {}, target).out;
		expect(check()).toContain(`.env.live: ${target} (git doesn't ignore it, so save refuses:`);
		writeFileSync(path.join(repo, ".gitignore"), ".env.live\n");
		expect(check()).toContain(`.env.live: ${target} (git ignores it)`);
	});

	it("asks Slack about each token without a call when one is missing, and reads Slack's answers", async () => {
		const missing = run(["revoked"]);
		expect(missing.code).toBe(1);
		expect(missing.out).toContain("DY_LIVE_SLACK_USER_TOKEN: missing");
		const slack = await new FakeSlack().start();
		try {
			const tokens = { user: slack.userToken, app: slack.appToken };
			const options = { base: slack.apiBase };
			expect(await askSlack(tokens, options)).toEqual({
				user: "still accepted",
				app: "still accepted",
			});
			slack.fail("auth.test", 1, "token_revoked");
			slack.fail("apps.connections.open", 1, "service_unavailable", 503);
			expect(await askSlack(tokens, options)).toEqual({
				user: "token_revoked",
				app: "unexpected (service_unavailable)",
			});
		} finally {
			await slack.close();
		}
	});

	it("reads a pasted token at a raw-mode terminal without echoing it", async () => {
		const input = Object.assign(new EventEmitter(), {
			modes: [] as boolean[],
			setRawMode(mode: boolean) {
				this.modes.push(mode);
			},
			setEncoding() {},
			resume() {},
			pause() {},
		});
		let shown = "";
		const terminal: Terminal = {
			input,
			output: {
				write: (text: string) => {
					shown += text;
				},
			},
		};
		const token = fakeToken("xoxp");
		const pasted = hidden("Paste: ", terminal);
		// A bracketed paste after a stray key and its backspace, then Enter.
		input.emit("data", `x\u007f\u001b[200~${token.slice(0, 9)}`);
		input.emit("data", `${token.slice(9)}\u001b[201~\r`);
		expect(await pasted).toBe(token);
		expect(input.modes).toEqual([true, false]);
		expect(shown).toBe("Paste: \n");
		expect(input.listenerCount("data")).toBe(0);
		const cancelled = hidden("Paste: ", terminal);
		input.emit("data", "xox\u0003");
		await expect(cancelled).rejects.toThrow("cancelled");
		expect(input.modes).toEqual([true, false, true, false]);
	});
});
