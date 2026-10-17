// Shared by every hostile fixture. A fixture runs AS the sandboxed plugin (under the §4 argv),
// makes exactly one kind of escape attempt, and reports the outcome on fd 1 (exempt from the
// permission model) as one sentinel line. The harness parses the last such line.
import { writeSync } from "node:fs";

let emitted = false;
let fixtureName = "unknown";

// The one sentinel line the harness parses. Fixtures that report data (argv-report, controls) call
// send() directly; escape fixtures go through report().
export function send(result) {
	if (emitted) return;
	emitted = true;
	writeSync(1, `##DY##${JSON.stringify(result)}\n`);
}

export const config = () => JSON.parse(process.argv[2] ?? "{}");

// Call first. Names the fixture, and turns a denial that surfaces as an uncaught throw (some
// permission refusals crash the process instead of rejecting) into a "denied" result marked
// crashed:true, which the harness treats as a FAILURE: an escape fixture must deny cleanly with a
// known code, never crash, and an escape would have emitted "escaped" from report() first.
export function start(name) {
	fixtureName = name;
	const onCrash = (error) => {
		send({
			name: fixtureName,
			outcome: "denied",
			codes: [error?.code ?? error?.name ?? "CRASH"],
			crashed: true,
		});
		process.exit(0);
	};
	process.on("uncaughtException", onCrash);
	process.on("unhandledRejection", onCrash);
}

// Runs one attempt. ok:true (no throw) means it went through — a possible escape.
export async function attempt(fn) {
	try {
		return { ok: true, value: await fn() };
	} catch (error) {
		return { ok: false, code: error?.code ?? error?.name ?? "ERR" };
	}
}

// Emits "escaped" if any attempt went through, else "denied" with the refusal codes it collected.
// `extra` carries content-free side facts (codes, booleans; never a secret or a real path).
export function report(results, extra) {
	const escaped = results.find((r) => r.ok);
	send({
		name: fixtureName,
		outcome: escaped ? "escaped" : "denied",
		codes: results.filter((r) => !r.ok).map((r) => r.code),
		...(escaped ? { detail: String(escaped.value).slice(0, 40) } : {}),
		...(extra ?? {}),
	});
	process.exit(0);
}
