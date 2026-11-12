// Isolated child for the sidecar stdin heavy test. It reads its real stdin pipe through the
// receiver and writes only fixed tokens, booleans, counts and fixed codes to stdout.
import { timingSafeEqual } from "node:crypto";

const mode = process.argv[2] ?? "";
const say = (line: string): void => {
	process.stdout.write(`${line}\n`);
};

if (mode === "import") {
	const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
	let touched = false;
	Object.defineProperty(process, "stdin", {
		configurable: true,
		enumerable: descriptor?.enumerable ?? true,
		get() {
			touched = true;
			return descriptor?.get?.call(process);
		},
	});
	await import("../../../src/kernel/sidecar-input.ts");
	say(JSON.stringify({ mode, stdinTouched: touched }));
} else {
	const { receiveSidecarInput, SidecarInputError } = await import(
		"../../../src/kernel/sidecar-input.ts"
	);
	const code = (error: unknown): string =>
		error instanceof SidecarInputError ? error.code : "unexpected";
	const controller = new AbortController();
	const input = receiveSidecarInput(process.stdin, { signal: controller.signal });
	const report = {
		mode,
		ready: false,
		refused: "",
		exact: false,
		resumes: 0,
		stop: "",
		code: "",
		closed: false,
		closedCode: "",
		inputDestroyed: false,
	};
	try {
		await input.initialReady;
		report.ready = true;
		say("ready");
	} catch (error) {
		report.refused = code(error);
	}
	if (report.ready) {
		try {
			const { masterKey, bootstrapSecret } = input.takeInitial();
			// The test derives the bootstrap secret from the key, so a match proves both arrived exactly.
			const check = masterKey.derive("ext/sidecar-check");
			report.exact =
				bootstrapSecret.length === 16 && timingSafeEqual(check.subarray(0, 16), bootstrapSecret);
			check.fill(0);
			bootstrapSecret.fill(0);
			masterKey.destroy();
		} catch (error) {
			report.refused = code(error);
		}
		if (mode === "cancel") controller.abort();
		if (mode === "dispose") void input.dispose();
		for (;;) {
			const control = await input.nextControl();
			if (control.kind === "stop") break;
			report.resumes++;
			say("resumed");
		}
	}
	const stop = await input.terminal;
	report.stop = stop.reason;
	report.code = stop.code ?? "";
	try {
		await input.closed;
		report.closed = true;
	} catch (error) {
		report.closedCode = code(error);
	}
	report.inputDestroyed = process.stdin.destroyed;
	say(JSON.stringify(report));
}
