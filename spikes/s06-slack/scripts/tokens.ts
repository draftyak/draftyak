// node spikes/s06-slack/scripts/tokens.ts save [--stdin] | check | revoked | delete
// Session 2's token step (notes/session.md). `save` asks for the User OAuth Token and the App-Level
// Token at hidden prompts and stores both in the main checkout's .env.live through the kit's
// saveEnvLive(); with --stdin it reads them from a pipe, one per line, in either order. `check`
// says where .env.live is, whether git ignores it, and whether both tokens are stored and of the
// right kind. `revoked` asks Slack whether it still accepts each one (auth.test, and
// apps.connections.open). `delete` removes them once both are revoked. No token is ever printed.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { deleteEnvLive, envLivePath, loadEnvLive, saveEnvLive } from "@draftyak/spike-kit";
import {
	assertToken,
	type CallOptions,
	callSlack,
	type Method,
	SlackError,
	type TokenKind,
} from "../src/api.ts";

export const TOKEN_NAMES: Readonly<Record<TokenKind, string>> = {
	app: "DY_LIVE_SLACK_APP_TOKEN",
	user: "DY_LIVE_SLACK_USER_TOKEN",
};

// The codes Slack answers for a token it no longer accepts. Anything else (a rate limit, an outage,
// a proxy's own HTTP error, a request problem) says nothing about revocation.
const REFUSED: ReadonlySet<string> = new Set([
	"account_inactive",
	"invalid_auth",
	"not_authed",
	"token_expired",
	"token_revoked",
]);

export function refusal(error: SlackError | null): string | null {
	return error !== null && REFUSED.has(error.code) ? error.code : null;
}

// "still accepted", Slack's refusal code, or "unexpected (<code>)".
export function tokenState(error: SlackError | null): string {
	if (error === null) return "still accepted";
	return refusal(error) ?? `unexpected (${error.code})`;
}

const PROBES: Readonly<Record<TokenKind, Method>> = {
	user: "auth.test",
	app: "apps.connections.open",
};

// One call per token. apps.connections.open's socket URL is discarded unused.
export async function askSlack(
	tokens: Readonly<Record<TokenKind, string>>,
	options: CallOptions = {},
): Promise<Record<TokenKind, string>> {
	const state = async (kind: TokenKind): Promise<string> => {
		try {
			await callSlack(PROBES[kind], tokens[kind], {}, options);
			return tokenState(null);
		} catch (error) {
			if (error instanceof SlackError) return tokenState(error);
			throw error;
		}
	};
	return { user: await state("user"), app: await state("app") };
}

const usage =
	"usage: node spikes/s06-slack/scripts/tokens.ts save [--stdin] | check | revoked | delete";
const KINDS: readonly TokenKind[] = ["user", "app"];
const LABELS: Readonly<Record<TokenKind, string>> = {
	user: "the User OAuth Token (OAuth & Permissions; it starts with xoxp-)",
	app: "the App-Level Token (Basic Information, App-Level Tokens; it starts with xapp-)",
};
const NOUN: Readonly<Record<TokenKind, string>> = {
	user: "a user token",
	app: "an app-level token",
};
const SHAPE = /^[\w.-]{16,512}$/;

// Why `value` isn't a token of this kind, or null.
function problem(kind: TokenKind, value: string): string | null {
	try {
		assertToken(kind, value);
	} catch {
		return `that isn't ${NOUN[kind]}`;
	}
	return SHAPE.test(value) ? null : "that has characters a token doesn't have";
}

// The parts of process.stdin (a tty.ReadStream) and process.stdout the prompt uses.
export interface Terminal {
	readonly input: {
		setRawMode(mode: boolean): unknown;
		setEncoding(encoding: "utf8"): unknown;
		resume(): unknown;
		pause(): unknown;
		on(event: "data", listener: (chunk: string) => void): unknown;
		off(event: "data", listener: (chunk: string) => void): unknown;
	};
	readonly output: { write(text: string): unknown };
}

// One line typed or pasted at a terminal without echo. Ctrl+C or Ctrl+D cancels.
export function hidden(
	prompt: string,
	terminal: Terminal = { input: process.stdin, output: process.stdout },
): Promise<string> {
	const { input, output } = terminal;
	output.write(prompt);
	input.setRawMode(true);
	input.setEncoding("utf8");
	input.resume();
	return new Promise((resolve, reject) => {
		let value = "";
		const finish = (error?: Error): void => {
			input.off("data", onData);
			input.setRawMode(false);
			input.pause();
			output.write("\n");
			if (error) reject(error);
			// A terminal's bracketed paste leaves [200~ and [201~ once ESC is dropped.
			else resolve(value.replace(/\[20[01]~/g, "").trim());
		};
		const onData = (chunk: string): void => {
			for (const char of chunk) {
				if (char === "\r" || char === "\n" || char === "\u0003" || char === "\u0004") {
					finish(char === "\r" || char === "\n" ? undefined : new Error("cancelled"));
					return;
				}
				if (char === "\b" || char === "\u007f") value = value.slice(0, -1);
				else if (char >= " ") value += char;
			}
		};
		input.on("data", onData);
	});
}

async function piped(): Promise<string[]> {
	let text = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) text += chunk;
	return text
		.replace(/^\uFEFF/, "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

async function save(fromPipe: boolean): Promise<number> {
	const values = new Map<TokenKind, string>();
	if (fromPipe) {
		for (const line of await piped()) {
			const kind = KINDS.find((each) => problem(each, line) === null);
			if (kind === undefined || values.has(kind)) {
				console.error("tokens: each line must be one user token or one app-level token");
				return 1;
			}
			values.set(kind, line);
		}
	} else if (!process.stdin.isTTY) {
		console.error(
			"tokens: stdin isn't a terminal. Run this in PowerShell or Windows Terminal, or pipe both tokens with --stdin.",
		);
		return 1;
	} else {
		for (const kind of KINDS) {
			for (let attempt = 1; !values.has(kind); attempt++) {
				const value = await hidden(`Paste ${LABELS[kind]}, then press Enter (input hidden): `);
				const wrong = problem(kind, value);
				if (wrong === null) values.set(kind, value);
				else if (attempt === 3) {
					console.error(`tokens: ${wrong}; nothing was saved`);
					return 1;
				} else console.log(`${wrong}; try again`);
			}
		}
	}
	const user = values.get("user");
	const app = values.get("app");
	if (user === undefined || app === undefined) {
		console.error("tokens: --stdin needs a user token and an app-level token, one per line");
		return 1;
	}
	saveEnvLive(TOKEN_NAMES.user, user);
	saveEnvLive(TOKEN_NAMES.app, app);
	console.log(`saved ${TOKEN_NAMES.user} and ${TOKEN_NAMES.app} in ${envLivePath()}`);
	return 0;
}

// saveEnvLive() refuses a .env.live that git doesn't ignore, so this is said before any paste.
function where(): void {
	const file = envLivePath();
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
	);
	const args = ["-C", path.dirname(file), "check-ignore", "-q", path.basename(file)];
	const code = spawnSync("git", args, { env, windowsHide: true }).status;
	const status =
		code === 0
			? "git ignores it"
			: code === 1
				? "git doesn't ignore it, so save refuses: keep the main checkout on a branch whose .gitignore lists .env.live, such as m0"
				: "not in a git work tree";
	console.log(`.env.live: ${file} (${status})`);
}

function stored(): Record<TokenKind, string | null> {
	const read = (name: string): string | null => {
		try {
			return loadEnvLive([name])[name]?.reveal() ?? null;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("not set in ")) return null;
			throw error;
		}
	};
	return { user: read(TOKEN_NAMES.user), app: read(TOKEN_NAMES.app) };
}

function check(): number {
	where();
	const values = stored();
	let ready = true;
	for (const kind of KINDS) {
		const value = values[kind];
		const wrong = value === null ? "missing" : problem(kind, value);
		console.log(`${TOKEN_NAMES[kind]}: ${wrong ?? `set (${NOUN[kind]})`}`);
		ready &&= wrong === null;
	}
	return ready ? 0 : 1;
}

// Exit 0 only when Slack refuses both tokens with one of its auth codes.
async function revoked(): Promise<number> {
	const values = stored();
	const { user, app } = values;
	if (user === null || app === null) {
		for (const kind of KINDS) {
			console.log(`${TOKEN_NAMES[kind]}: ${values[kind] === null ? "missing" : "not asked"}`);
		}
		return 1;
	}
	const states = await askSlack({ user, app });
	let both = true;
	for (const kind of KINDS) {
		const state = states[kind];
		const refused = REFUSED.has(state);
		console.log(`${TOKEN_NAMES[kind]}: ${refused ? `refused by Slack (${state})` : state}`);
		both &&= refused;
	}
	return both ? 0 : 1;
}

function remove(): number {
	const removed = deleteEnvLive([TOKEN_NAMES.user, TOKEN_NAMES.app]);
	console.log(
		removed.length > 0
			? `deleted ${removed.join(" and ")} from ${envLivePath()}`
			: `neither was set in ${envLivePath()}`,
	);
	return 0;
}

if (import.meta.main) {
	const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
	try {
		if (command === "save" && rest.every((arg) => arg === "--stdin")) {
			process.exitCode = await save(rest.includes("--stdin"));
		} else if (command === "check" && rest.length === 0) {
			process.exitCode = check();
		} else if (command === "revoked" && rest.length === 0) {
			process.exitCode = await revoked();
		} else if (command === "delete" && rest.length === 0) {
			process.exitCode = remove();
		} else {
			console.error(usage);
			process.exitCode = 2;
		}
	} catch (error) {
		console.error(`tokens: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	}
}
