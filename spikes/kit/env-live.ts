import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { registerSecret } from "./evidence.ts";
import { git, gitPaths, isLinkedWorktree } from "./repo.ts";

// A .env.live value: printing, logging, JSON and snapshots show "[redacted]"; reveal() returns it.
export class Secret {
	readonly #value: string;

	constructor(value: string) {
		this.#value = value;
		registerSecret(value);
	}

	reveal(): string {
		return this.#value;
	}

	toString(): string {
		return "[redacted]";
	}

	toJSON(): string {
		return "[redacted]";
	}
}

Object.defineProperty(Secret.prototype, inspect.custom, { value: () => "Secret [redacted]" });

export interface EnvLiveOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
}

const LINE = /^\s*([A-Za-z_]\w*)\s*=(.*)$/;
const nameOf = (line: string): string | undefined => LINE.exec(line)?.[1];

function assertNames(names: readonly string[]): void {
	const bad = names.find((name) => !/^DY_LIVE_[A-Z0-9_]+$/.test(name));
	if (bad !== undefined) throw new Error(`.env.live names match DY_LIVE_*, not "${bad}"`);
}

function refuseWorktree(dir: string): void {
	const paths = gitPaths(dir);
	if (paths && isLinkedWorktree(paths)) {
		throw new Error(`refusing .env.live inside the worktree ${paths.toplevel}: delete it`);
	}
}

// The main checkout's .env.live (from the common git dir) or DRAFTYAK_ENV_LIVE, never a worktree's.
export function envLivePath(options: EnvLiveOptions = {}): string {
	const here = gitPaths(options.cwd ?? process.cwd());
	if (here && existsSync(path.join(here.toplevel, ".env.live"))) refuseWorktree(here.toplevel);
	const override = (options.env ?? process.env).DRAFTYAK_ENV_LIVE;
	if (override) {
		if (!path.isAbsolute(override)) throw new Error("DRAFTYAK_ENV_LIVE must be an absolute path");
		refuseWorktree(path.dirname(override));
		return path.resolve(override);
	}
	if (here === null || path.basename(here.commonDir) !== ".git") {
		throw new Error("no main checkout found: run inside the repo or set DRAFTYAK_ENV_LIVE");
	}
	return path.join(path.dirname(here.commonDir), ".env.live");
}

function readLines(file: string): string[] {
	const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
	return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

function writeLines(file: string, lines: readonly string[]): void {
	const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, lines.map((line) => `${line}\n`).join(""), { mode: 0o600 });
		renameSync(temp, file);
	} finally {
		rmSync(temp, { force: true });
	}
}

export function loadEnvLive<const N extends string>(
	names: readonly N[],
	options: EnvLiveOptions = {},
): Readonly<Record<N, Secret>> {
	assertNames(names);
	const file = envLivePath(options);
	const values = new Map<string, string>();
	for (const [, name, value] of readLines(file).map((line) => LINE.exec(line) ?? [])) {
		if (name !== undefined && value !== undefined && !values.has(name)) values.set(name, value);
	}
	const missing = names.filter((name) => !values.get(name));
	if (missing.length > 0) throw new Error(`not set in ${file}: ${missing.join(", ")}`);
	const entries = names.map((name) => [name, new Secret(values.get(name) ?? "")] as const);
	return Object.fromEntries(entries) as Record<N, Secret>;
}

export function saveEnvLive(
	name: string,
	value: string | Secret,
	options: EnvLiveOptions = {},
): void {
	assertNames([name]);
	const text = value instanceof Secret ? value.reveal() : value;
	if (!/^[^\r\n\0]+$/.test(text)) throw new Error(`${name}: the value must be one non-empty line`);
	const file = envLivePath(options);
	const [dir, base] = [path.dirname(file), path.basename(file)];
	if (git(dir, "check-ignore", "-q", base).code === 1) {
		throw new Error(`refusing to write ${file}: git doesn't ignore it`);
	}
	registerSecret(text);
	const lines = readLines(file);
	const at = lines.findIndex((line) => nameOf(line) === name);
	const others = lines.filter((line) => nameOf(line) !== name);
	others.splice(at === -1 ? others.length : at, 0, `${name}=${text}`);
	writeLines(file, others);
}

// Removes entries once a session's tokens are revoked; returns the names that were present.
export function deleteEnvLive(names: readonly string[], options: EnvLiveOptions = {}): string[] {
	assertNames(names);
	const file = envLivePath(options);
	const lines = readLines(file);
	const kept = lines.filter((line) => !names.includes(nameOf(line) ?? ""));
	if (kept.length < lines.length) writeLines(file, kept);
	return names.filter((name) => lines.some((line) => nameOf(line) === name));
}
