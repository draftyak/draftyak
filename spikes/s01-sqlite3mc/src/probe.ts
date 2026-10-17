// node src/probe.ts <prebuild.node>: one load and keyed round trip as a JSON line, for Node binaries
// other than the test's.
import { type KeyedResult, keyedCheck } from "./keyed.ts";
import { type LoadReport, loadReport } from "./open.ts";
import { hostTarget } from "./prebuilds.ts";

// A run that never reached the probe has no N-API version.
export type ProbeResult =
	| ({ readonly loaded: true; readonly keyed: KeyedResult } & LoadReport)
	| {
			readonly loaded: false;
			readonly error: string;
			readonly target: string;
			readonly nodeVersion: string;
			readonly napiVersion: number | null;
	  };

function probe(nativeBinding: string): ProbeResult {
	try {
		const report = loadReport(nativeBinding);
		return { loaded: true, ...report, keyed: keyedCheck(nativeBinding) };
	} catch (error) {
		const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };
		const id = String(typeof code === "string" ? code : name);
		// The evidence keeps the code; the message, which may name paths, goes only to the log.
		process.stderr.write(`probe: ${id}: ${String(message)}\n`);
		return {
			loaded: false,
			error: id,
			target: hostTarget(),
			nodeVersion: process.versions.node,
			napiVersion: Number(process.versions.napi),
		};
	}
}

if (import.meta.main) {
	const result = probe(process.argv[2] ?? "");
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exitCode = result.loaded ? 0 : 1;
}
