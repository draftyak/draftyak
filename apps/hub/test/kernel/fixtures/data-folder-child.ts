import { setTimeout as sleep } from "node:timers/promises";
import { admitDataFolder, type DataFolder } from "../../../src/kernel/data-directory.ts";
import { StartupRefusal } from "../../../src/lifecycle/preflight.ts";

// try: admit, release and exit. hold: keep the handle until stdin ends. drop: discard the handle,
// collect garbage and stay alive until stdin ends. One JSON line reports the admission.
const [mode, folderArgument, bindingArgument] = process.argv.slice(2);
if ((mode !== "try" && mode !== "hold" && mode !== "drop") || !folderArgument || !bindingArgument)
	throw new Error("Data folder fixture arguments missing");
const folder = folderArgument,
	nativeBinding = bindingArgument;
const collect = globalThis.gc;
if (mode === "drop" && !collect) throw new Error("Data folder fixture needs --expose-gc");

interface Outcome {
	readonly result: string;
	readonly ms: number;
}

function admit(): Outcome & { readonly handle?: DataFolder } {
	const started = performance.now();
	try {
		const handle = admitDataFolder(folder, { nativeBinding });
		return { result: "admitted", ms: performance.now() - started, handle };
	} catch (error) {
		const result = error instanceof StartupRefusal ? error.code : "error";
		return { result, ms: performance.now() - started };
	}
}

// Returns only the outcome, so no reference to the handle outlives this frame.
function admitAndDrop(): Outcome {
	const { result, ms } = admit();
	return { result, ms };
}

const report = ({ result, ms }: Outcome): void => {
	process.stdout.write(`${JSON.stringify({ result, ms })}\n`);
};

if (mode === "drop") {
	const outcome = admitAndDrop();
	for (let round = 0; round < 5; round++) {
		collect?.();
		await sleep(20);
	}
	process.stdin.resume();
	report(outcome);
} else {
	const { handle, ...outcome } = admit();
	if (handle && mode === "hold") {
		process.stdin.once("end", () => handle.release());
		process.stdin.resume();
	} else handle?.release();
	report(outcome);
}
