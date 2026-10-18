import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askSlack, hidden, type Terminal } from "../scripts/tokens.ts";
import { FakeSlack, fakeToken } from "./fake-slack.ts";

// scripts/tokens.ts, session 2's token step, against a temp .env.live (DRAFTYAK_ENV_LIVE). The
// CLI runs in a child process, which test/offline.ts doesn't guard: no test lets it reach Slack.
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

function run(args: readonly string[], input = "") {
	const result = spawnSync(process.execPath, [cli, ...args], {
		input,
		encoding: "utf8",
		env: { ...process.env, DRAFTYAK_ENV_LIVE: file },
		windowsHide: true,
	});
	return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe("tokens.ts", () => {
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
		const deleted = run(["--", "delete"]);
		expect(deleted.code).toBe(0);
		expect(deleted.out).toContain("deleted DY_LIVE_SLACK_USER_TOKEN and DY_LIVE_SLACK_APP_TOKEN");
		expect(readFileSync(file, "utf8")).toBe("");
		expect(run(["check"])).toEqual({ code: 1, out: expect.stringContaining("missing") });
		for (const { out } of [saved, checked, deleted]) {
			expect(out).not.toContain(user);
			expect(out).not.toContain(app);
		}
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
		const check = () =>
			spawnSync(process.execPath, [cli, "check"], {
				encoding: "utf8",
				env: { ...process.env, DRAFTYAK_ENV_LIVE: target },
				windowsHide: true,
			}).stdout;
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
