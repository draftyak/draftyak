export class CliRefusal extends Error {
	constructor() {
		super("Command refused.");
	}
}

export function diagnostic(): void {
	try {
		process.stderr.write("Command refused.\n");
	} catch {
		// The exit code still reports refusal when the diagnostic stream is unavailable.
	}
}
