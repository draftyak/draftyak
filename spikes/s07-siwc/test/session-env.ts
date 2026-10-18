import { spawnSync } from "node:child_process";
import path from "node:path";
import {
	deleteEnvLive,
	type EnvLiveOptions,
	envLivePath,
	loadEnvLive,
	saveEnvLive,
} from "@draftyak/spike-kit";

// M0.27's .env.live names, and the commands notes/session.md runs from the repository root:
// node spikes/s07-siwc/test/session-env.ts opt-in [--again] | stop | status | forget api-key|tokens
// They print names and states, never a value.

export const OPT_IN = "DY_LIVE_SIWC_SESSION";
export const SAVED = {
	access: "DY_LIVE_SIWC_ACCESS_TOKEN",
	refresh: "DY_LIVE_SIWC_REFRESH_TOKEN",
	client: "DY_LIVE_SIWC_CLIENT_ID",
} as const;
export const API_KEY = "DY_LIVE_RESPONSES_API_KEY";
export const SIWC_NAMES: readonly string[] = [OPT_IN, SAVED.access, SAVED.refresh, SAVED.client];

// A new run, a run that may replace evidence/live.json, and a stop request for a waiting sign-in.
// Each is under 6 characters, so the kit doesn't treat it as a secret that evidence must not hold.
export const OPT_IN_VALUES = { run: "yes", again: "again", stop: "stop" } as const;

// An entry's value, or undefined when .env.live or the entry is missing. A misplaced .env.live, such
// as one inside a worktree, still throws.
export function readEntry(entry: string, options: EnvLiveOptions = {}): string | undefined {
	try {
		return loadEnvLive([entry], options)[entry]?.reveal();
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("not set in ")) return undefined;
		throw error;
	}
}

const usage =
	"usage: node spikes/s07-siwc/test/session-env.ts opt-in [--again] | stop | status | forget api-key|tokens";

// forget api-key: after the owner deleted the key at OpenAI. forget tokens: after the owner removed
// DraftYak in ChatGPT's settings, for a run that died holding tokens and won't be run again.
const FORGET: ReadonlyMap<string, readonly string[]> = new Map([
	["api-key", [API_KEY]],
	["tokens", SIWC_NAMES],
]);

function ignoredByGit(file: string): string {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) => !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/i.test(key),
		),
	);
	const dir = path.dirname(file);
	const result = spawnSync("git", ["-C", dir, "check-ignore", "-q", path.basename(file)], {
		env,
		windowsHide: true,
	});
	if (result.status === 0) return "git ignores it";
	return result.status === 1
		? "git does NOT ignore it: stop and fix this first"
		: "not in a repository";
}

export function main(args: readonly string[], options: EnvLiveOptions = {}): number {
	const [command, ...rest] = args[0] === "--" ? args.slice(1) : args;
	const file = envLivePath(options);
	const known = Object.values(OPT_IN_VALUES) as string[];
	if (command === "opt-in" && rest.every((arg) => arg === "--again")) {
		const value = rest.length > 0 ? OPT_IN_VALUES.again : OPT_IN_VALUES.run;
		saveEnvLive(OPT_IN, value, options);
		const replace = rest.length > 0 ? ", replacing evidence/live.json" : "";
		console.log(`${OPT_IN}=${value} saved in ${file}: the next S7b test:live run starts${replace}`);
		return 0;
	}
	if (command === "stop" && rest.length === 0) {
		saveEnvLive(OPT_IN, OPT_IN_VALUES.stop, options);
		console.log(`${OPT_IN}=stop saved: a waiting sign-in ends within seconds as blocked(stopped)`);
		return 0;
	}
	if (command === "status" && rest.length === 0) {
		console.log(`.env.live: ${file} (${ignoredByGit(file)})`);
		for (const entry of [...SIWC_NAMES, API_KEY]) {
			const value = readEntry(entry, options);
			const shown =
				value === undefined ? "not set" : entry === OPT_IN && known.includes(value) ? value : "set";
			console.log(`${entry}: ${shown}`);
		}
		return 0;
	}
	const forget = command === "forget" && rest.length === 1 ? FORGET.get(rest[0] ?? "") : undefined;
	if (forget) {
		const deleted = deleteEnvLive(forget, options);
		console.log(
			deleted.length > 0 ? `deleted from ${file}: ${deleted.join(", ")}` : "none was set",
		);
		return 0;
	}
	console.error(usage);
	return 2;
}

if (import.meta.main) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(`session-env: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	}
}
