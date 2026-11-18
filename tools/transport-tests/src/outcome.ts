export interface Outcome {
	readonly started: boolean;
	readonly code: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
	readonly overflow: boolean;
	readonly processError: boolean;
	readonly terminationFailed: boolean;
	readonly stdout: string;
	readonly stderr: string;
}

/** Never include captured diagnostics in a public exception. */
export function requireSuccess(result: Outcome): void {
	if (
		!result.started ||
		result.code !== 0 ||
		result.signal !== null ||
		result.timedOut ||
		result.overflow ||
		result.processError ||
		result.terminationFailed
	)
		throw new Error("Native-store test command failed");
}

/** A successful process that filtered out its required case is still a failed acceptance run. */
export function requireOneTest(result: Outcome, expectedName: string): void {
	requireSuccess(result);
	if (!/^[a-zA-Z0-9_:]+$/.test(expectedName)) throw new Error("Invalid expected native-store test");
	const summaries = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("test result:"));
	const starts = result.stdout.split(/\r?\n/).filter((line) => /^running \d+ tests?$/.test(line));
	const tests = result.stdout
		.split(/\r?\n/)
		.filter((line) => line.startsWith("test ") && !line.startsWith("test result:"));
	if (
		summaries.length !== 1 ||
		starts.length !== 1 ||
		starts[0] !== "running 1 test" ||
		tests.length !== 1 ||
		tests[0] !== `test ${expectedName} ... ok` ||
		!/^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; \d+ filtered out; finished in [0-9.]+s$/.test(
			summaries[0] ?? "",
		)
	)
		throw new Error("Required native-store test did not run exactly once");
}
