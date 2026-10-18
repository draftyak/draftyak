import { existsSync, readdirSync, rmSync } from "node:fs";
import {
	type ClientKind,
	deleteEntries,
	disclosure,
	liveSession,
	saveClient,
	sessionDir,
	setSendAt,
	statusLines,
} from "./live-session.ts";

// The S8b session's helpers outside the test run (notes/session.md), from the repository root:
//   node spikes/s08-gmail/test/live-cli.ts save-client standard|agent <downloaded client JSON>
//   node spikes/s08-gmail/test/live-cli.ts disclosure standard|agent
//   node spikes/s08-gmail/test/live-cli.ts send-at <HH:MM>
//   node spikes/s08-gmail/test/live-cli.ts status
//   node spikes/s08-gmail/test/live-cli.ts delete-entries
//   node spikes/s08-gmail/test/live-cli.ts forget
const usage = [
	"usage: node spikes/s08-gmail/test/live-cli.ts <command>",
	"  save-client standard|agent <file>  saves a Desktop client's ID and secret from the Cloud",
	"                                     console's Download JSON into .env.live, then deletes the file",
	"  disclosure standard|agent          the text the owner reads before that client's consent",
	"  send-at <HH:MM>                    the send time the owner picked for the scheduled mail",
	"  status                             the .env.live entries (set or missing) and the session's steps",
	"  delete-entries                     deletes every DY_LIVE_GMAIL_* entry from .env.live",
	"  forget                             deletes the session folder once the evidence is committed",
].join("\n");

const SESSION_FILES = new Set(["state.json", "input.json", "evidence"]);

const clientKind = (kind: string | undefined): ClientKind => {
	if (kind !== "standard" && kind !== "agent") throw new Error("the client is standard or agent");
	return kind;
};

export function main(
	argv: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
	log: (line: string) => void = (line) => console.log(line),
	fail: (line: string) => void = (line) => console.error(line),
): number {
	// pnpm.ps1 drops a leading `--`; Git Bash and cmd pass it through.
	const [command, ...args] = argv[0] === "--" ? argv.slice(1) : argv;
	try {
		if (command === "save-client" && args.length === 2) {
			const [kind, file = ""] = args;
			const names = saveClient(clientKind(kind), file, { env });
			log(`saved ${names.join(" and ")} in .env.live, and deleted the downloaded file`);
			return 0;
		}
		if (command === "disclosure" && args.length === 1) {
			for (const line of disclosure(clientKind(args[0]))) log(line);
			return 0;
		}
		if (command === "send-at" && args.length === 1) {
			log(setSendAt(sessionDir(env), args[0] ?? ""));
			return 0;
		}
		if (command === "status" && args.length === 0) {
			for (const line of statusLines({ ...liveSession(env, log), envLive: { env } })) log(line);
			return 0;
		}
		if (command === "delete-entries" && args.length === 0) {
			for (const line of deleteEntries({ env })) log(line);
			return 0;
		}
		if (command === "forget" && args.length === 0) {
			const dir = sessionDir(env);
			if (!existsSync(dir)) {
				log(`nothing to forget: ${dir} doesn't exist`);
			} else {
				const strangers = readdirSync(dir).filter((name) => !SESSION_FILES.has(name));
				if (strangers.length > 0) {
					throw new Error(`${dir} holds more than a session (${strangers.join(", ")}); left alone`);
				}
				rmSync(dir, { recursive: true, force: true });
				log(`deleted ${dir}`);
			}
			const session = { ...liveSession(env, log), envLive: { env } };
			const left = statusLines(session).filter((line) => /^\s*DY_LIVE_\w+: set$/.test(line));
			if (left.length > 0) {
				log(
					`still in .env.live: run s8 revoke while a grant is saved, else delete-entries:\n${left.join("\n")}`,
				);
			}
			return 0;
		}
		fail(usage);
		return 2;
	} catch (error) {
		fail(`live-cli: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
