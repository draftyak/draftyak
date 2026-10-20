import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const STDIO_FIXTURE_READY = "DRAFTYAK_TEST_STDIO_READY";
export const STDIO_FIXTURE_STARTUP_MS = 10_000;
export const STDIO_FIXTURE_REQUEST_MS = 3_000;
const DIAGNOSTIC_CHARS = 65_536;

/** Imports/bootstrap finished; the default serving transport has its input handlers installed.
 * The pinned MCP server still constructs its instance lazily on the first request. */
export function markStdioFixtureReady(): void {
	process.stderr.write(`${STDIO_FIXTURE_READY}\n`);
}

interface StdioFixture {
	readonly stopped: Promise<void>;
	stderrText(): string;
	describe(method: string, id: unknown): string;
	ready(): Promise<void>;
	nextLine(
		iterator: AsyncIterator<string>,
		method: string,
		id: unknown,
		deadline?: number,
	): Promise<string>;
	checkId(actual: unknown, expected: unknown, method: string): void;
}

export function observeStdioFixture(child: ChildProcessWithoutNullStreams): StdioFixture {
	const started = Date.now();
	const startupDeadline = started + STDIO_FIXTURE_STARTUP_MS;
	const changes = new Set<() => void>();
	const stopped = Promise.withResolvers<void>();
	let ready = false,
		closed = false,
		stdoutEOF = false,
		frames = 0,
		stderr = "",
		partial = "",
		failure = "";
	let readyAt: number | undefined;
	let exited = child.exitCode !== null || child.signalCode !== null;
	const changed = () => {
		for (const listener of [...changes]) listener();
	};
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		partial += chunk;
		let newline = partial.indexOf("\n");
		while (newline !== -1) {
			const line = partial.slice(0, newline);
			partial = partial.slice(newline + 1);
			if (line === STDIO_FIXTURE_READY) {
				ready = true;
				readyAt ??= Date.now();
			} else stderr = `${stderr}${line}\n`.slice(0, DIAGNOSTIC_CHARS);
			newline = partial.indexOf("\n");
		}
		partial = partial.slice(0, DIAGNOSTIC_CHARS);
		changed();
	});
	child.stdout.on("data", (chunk: Buffer) => {
		for (const byte of chunk) if (byte === 10) frames++;
	});
	child.stdout.once("end", () => {
		stdoutEOF = true;
		changed();
	});
	const recordFailure = (error: Error) => {
		failure = error.message.slice(0, 1024);
		changed();
	};
	child.on("error", recordFailure);
	child.stdin.on("error", recordFailure);
	child.once("close", () => {
		closed = true;
		stopped.resolve();
		changed();
	});
	child.once("exit", () => {
		exited = true;
		changed();
	});
	const unavailable = () =>
		Boolean(
			failure ||
				closed ||
				stdoutEOF ||
				exited ||
				child.exitCode !== null ||
				child.signalCode !== null,
		);
	const stderrText = () => (stderr + partial).slice(0, DIAGNOSTIC_CHARS);
	const describe = (method: string, id: unknown) =>
		`method=${method}; id=${String(id).slice(0, 128)}; elapsedMs=${Math.max(0, Date.now() - started)}; ready=${ready}; frames=${frames}; stdoutEOF=${stdoutEOF}; closed=${closed}; exit=${child.exitCode}; signal=${child.signalCode}; stderr=${stderrText()}`;
	const error = (reason: string, method: string, id: unknown) =>
		new Error(
			`Fixture ${reason}; ${describe(method, id)}${failure ? `; childError=${failure}` : ""}`,
		);
	return {
		stopped: stopped.promise,
		stderrText,
		describe,
		async ready(): Promise<void> {
			if (unavailable()) throw error("startup closed", "startup", "none");
			if (readyAt !== undefined) {
				if (readyAt >= startupDeadline) throw error("startup timeout", "startup", "none");
				return;
			}
			if (Date.now() >= startupDeadline) throw error("startup timeout", "startup", "none");
			await new Promise<void>((resolve, reject) => {
				const finish = (reason?: string) => {
					clearTimeout(timer);
					changes.delete(check);
					if (reason) reject(error(reason, "startup", "none"));
					else resolve();
				};
				const check = () => {
					if (unavailable()) finish("startup closed");
					else if (readyAt !== undefined && readyAt < startupDeadline) finish();
					else if (Date.now() >= startupDeadline) finish("startup timeout");
				};
				const timer = setTimeout(
					() => finish("startup timeout"),
					Math.max(0, startupDeadline - Date.now()),
				);
				changes.add(check);
				check();
			});
			if (unavailable()) throw error("startup closed", "startup", "none");
		},
		async nextLine(
			iterator: AsyncIterator<string>,
			method: string,
			id: unknown,
			deadline = Date.now() + STDIO_FIXTURE_REQUEST_MS,
		): Promise<string> {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let failed: (() => void) | undefined;
			try {
				const childFailure = new Promise<never>((_, reject) => {
					failed = () => {
						if (failure) reject(error("child error", method, id));
					};
					changes.add(failed);
					failed();
				});
				const line = await Promise.race([
					iterator.next(),
					childFailure,
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(error("response timeout", method, id)),
							Math.max(0, deadline - Date.now()),
						);
					}),
				]);
				if (failure) throw error("child error", method, id);
				if (Date.now() >= deadline) throw error("response timeout", method, id);
				if (line.done) throw error("stdout EOF", method, id);
				return line.value;
			} finally {
				if (failed) changes.delete(failed);
				clearTimeout(timer);
			}
		},
		checkId(actual: unknown, expected: unknown, method: string): void {
			if (actual !== expected) throw error("reply correlation mismatch", method, expected);
		},
	};
}
