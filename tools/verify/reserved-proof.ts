import path from "node:path";
import type { GateResult } from "./lib/gate.ts";
import type * as Proof from "./lib/proof.ts";

// The execution proof (lib/proof.ts) behind the input gate. Static imports are node: built-ins
// only: nothing else loads until the start check has passed. Then the opt-in flag must be exactly 1,
// the gate (lib/gate.ts) must pass on this checkout, and only then does lib/proof.ts load, with the
// gate's result and listing, so the proof lists nothing of its own. Exit 0: proven, complete or
// partial; 1: not proven, an unset or bad flag, a gate stop or a failed start check; 2: usage, or a
// live or device tier.

export interface ProofEntryDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly print: (line: string) => void;
	readonly gate: () => Promise<GateResult>;
	readonly loadProof: () => Promise<Pick<typeof Proof, "main" | "defaults" | "GATE_STOPPED">>;
}

const say = (line: string): string => `reserved proof: ${line}`;
// lib/proof.ts's GATE_STOPPED, printed before that module may load; a test pins the two equal.
const GATE_STOPPED = "not proven: the reserved check stopped it before any run";

export async function proofEntry(argv: readonly string[], deps: ProofEntryDeps): Promise<number> {
	const { RESERVED_TESTS, reservedTestsOn } = await import("../../reserved-tests.ts");
	// In lib/proof.ts's words, which checks the flag again.
	try {
		if (!reservedTestsOn(deps.env)) {
			deps.print(say(`${RESERVED_TESTS} is unset: CI, the sync and the maintainer set it to 1`));
			return 1;
		}
	} catch (error) {
		deps.print(say(error instanceof Error ? error.message : String(error)));
		return 1;
	}
	let result: GateResult | null;
	try {
		result = await deps.gate();
	} catch {
		result = null;
	}
	const listing = result?.ok === true ? result.listing : null;
	if (result === null || listing === null) {
		const lines: readonly unknown[] = Array.isArray(result?.lines) ? result.lines : [];
		for (const line of lines) if (typeof line === "string") deps.print(line);
		deps.print(say(GATE_STOPPED));
		return 1;
	}
	const held = result;
	const { GATE_ROOT_ENV } = await import("./lib/bootstrap.ts");
	const proof = await deps.loadProof();
	return proof.main(argv, {
		...proof.defaults,
		print: deps.print,
		env: { ...deps.env, [GATE_ROOT_ENV]: listing.root },
		gate: async () => held,
		tracked: async () => held.tracked,
	});
}

// start check
function startCheckLines(root: string): string[] {
	const nodeFs = process.getBuiltinModule("node:fs");
	const nodePath = process.getBuiltinModule("node:path");
	const fold = (file: string): string => {
		const slashed = file.split(nodePath.sep).join("/");
		if (process.platform === "win32") return slashed.toLowerCase();
		return process.platform === "darwin" ? slashed.normalize("NFC").toLowerCase() : slashed;
	};
	const stopped = [
		"reserved tripwire: 1 start file(s) or folder(s) failed their kind check; nothing was loaded",
		"reserved tripwire: stopped before anything was built or tested. Reserved code may sit only in the allowed reserved roots, and no Rust or Cargo may use a reserved name or feature, until that code has its own reviewed gating design; every listed file, every file one of them names and every file a tool would pick up from a folder it scans must be a regular, listed file of this checkout, inside real folders. Don't open the files or follow the links: send this log's path to the reserved files' maintainer.",
	];
	// From the root's real path down: a link or 8.3 alias above the root changes nothing below it.
	let folder: string;
	try {
		folder = nodeFs.realpathSync.native(root);
	} catch {
		return stopped;
	}
	for (const [index, name] of ["tools", "verify", "lib", "bootstrap.ts"].entries()) {
		const at = nodePath.join(folder, name);
		let plain = false;
		try {
			const entry = nodeFs
				.readdirSync(folder, { withFileTypes: true })
				.find((item) => fold(item.name) === fold(name));
			const stat = nodeFs.lstatSync(at, { bigint: true });
			const kind = index === 3 ? stat.isFile() && stat.nlink === 1n : stat.isDirectory();
			plain =
				entry !== undefined &&
				!entry.isSymbolicLink() &&
				!stat.isSymbolicLink() &&
				kind &&
				fold(nodeFs.realpathSync.native(at)) === fold(at);
		} catch {
			plain = false;
		}
		if (!plain) return stopped;
		folder = at;
	}
	return [];
}
// end start check

if (import.meta.main) {
	const early = startCheckLines(path.resolve(import.meta.dirname, "..", ".."));
	if (early.length > 0) {
		for (const line of early) console.log(line);
		process.exitCode = 1;
	} else {
		const { HELPERS, checkStart, realRoot, startLines } = await import("./lib/bootstrap.ts");
		const root = realRoot(import.meta.dirname, 2);
		const problems = checkStart(root, process.argv[1] ?? "", HELPERS.proof);
		if (problems.length > 0) {
			for (const line of startLines(problems)) console.log(line);
			process.exitCode = 1;
		} else {
			process.exitCode = await proofEntry(process.argv.slice(2), {
				env: process.env,
				print: (line) => console.log(line),
				gate: async () => (await import("./lib/gate.ts")).runGate({ root }),
				loadProof: () => import("./lib/proof.ts"),
			});
		}
	}
}
