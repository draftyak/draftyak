import { spawn } from "node:child_process";
import path from "node:path";

export const cratesDir: string = path.resolve(import.meta.dirname, "../../../../crates");

export type Answer = Readonly<Record<string, unknown>>;

// crates/draftyak-protocol's xcheck example, started once per test file: each request is one JSON
// line on its stdin, answered in order by one line on its stdout.
export interface Xcheck {
	// The command's answer; a {fault} answer, or xcheck exiting, rejects.
	run(cmd: string, fields?: Readonly<Record<string, unknown>>): Promise<Answer>;
	close(): Promise<void>;
}

// turbo passes DRAFTYAK_* to test:heavy but drops CARGO_BUILD_JOBS, so the job count comes from
// DRAFTYAK_CARGO_JOBS when it is set.
export function cargoArgs(env: NodeJS.ProcessEnv = process.env): string[] {
	const jobs = env.DRAFTYAK_CARGO_JOBS ?? "";
	if (!/^(?:[1-9][0-9]*)?$/.test(jobs)) {
		throw new Error(`DRAFTYAK_CARGO_JOBS is a positive integer, not "${jobs}"`);
	}
	const manifest = ["--manifest-path", path.join(cratesDir, "Cargo.toml")];
	const build = jobs === "" ? [] : ["--jobs", jobs];
	return ["run", "--locked", "--quiet", ...manifest, ...build, "--example", "xcheck"];
}

// Builds xcheck if cargo needs to and resolves once it answers; cargo's own output goes to stderr.
export async function startXcheck(env: NodeJS.ProcessEnv = process.env): Promise<Xcheck> {
	const child = spawn("cargo", cargoArgs(env), {
		cwd: cratesDir,
		env: { ...env, CARGO_TERM_COLOR: "never" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const pending: { resolve: (answer: Answer) => void; reject: (error: Error) => void }[] = [];
	let stderr = "";
	let ended: Error | undefined;
	const fail = (error: Error): void => {
		ended ??= error;
		for (const waiter of pending.splice(0)) waiter.reject(ended);
	};
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	child.on("error", fail);
	child.on("close", (code) => fail(new Error(`xcheck exited (${code}):\n${stderr}`)));
	child.stdin.on("error", fail);
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-4000);
	});
	const answer = (line: string): void => {
		const waiter = pending.shift();
		let parsed: Answer | undefined;
		try {
			parsed = JSON.parse(line) as Answer;
		} catch {
			parsed = undefined;
		}
		if (waiter === undefined || parsed === undefined) {
			const error = new Error(`xcheck answered out of turn: ${line}`);
			fail(error);
			waiter?.reject(error);
		} else if (typeof parsed.fault === "string")
			waiter.reject(new Error(`xcheck: ${parsed.fault}`));
		else waiter.resolve(parsed);
	};
	// Lines end at \n only: readline would also end one at U+2028 or U+2029, which JSON leaves raw.
	let buffered = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		buffered += chunk;
		for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
			answer(buffered.slice(0, end));
			buffered = buffered.slice(end + 1);
		}
	});
	const run = (cmd: string, fields: Readonly<Record<string, unknown>> = {}): Promise<Answer> =>
		new Promise((resolve, reject) => {
			if (ended !== undefined) return reject(ended);
			pending.push({ resolve, reject });
			child.stdin.write(`${JSON.stringify({ ...fields, cmd })}\n`);
		});
	const close = async (): Promise<void> => {
		if (child.pid === undefined) return;
		child.stdin.end();
		await closed;
	};
	try {
		await run("sha256", { dataHex: "" });
	} catch (error) {
		await close();
		throw error;
	}
	return { run, close };
}
