import path from "node:path";
import type { StartProblem } from "./lib/bootstrap.ts";
import type { GateResult } from "./lib/gate.ts";

// pnpm m0:prefetch: both Nodes, pinned images, then each spike's prefetch.ts (prefetch.ts).
// Static imports are node: built-ins and types only. After its usage check it runs the start check,
// the flag check and the input gate on this checkout, in that order, and only then loads prefetch.ts.
// Exit 0: done; 1: a failed prefetch, start check or gate; 2: usage or a refused flag value.
export const USAGE =
	"usage: pnpm m0:prefetch   (both Nodes, pinned images, then each spike's prefetch.ts)";

export interface PrefetchDeps {
	readonly root: string;
	readonly print: (line: string) => void;
	readonly error: (line: string) => void;
	// checkStart on this entry and HELPERS.prefetch; by default the inline start check, then that.
	readonly startCheck?: () => readonly StartProblem[];
	readonly gate: () => Promise<GateResult>;
	readonly prefetch: (root: string, env: NodeJS.ProcessEnv) => Promise<number>;
}

export async function prefetchEntry(
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
	deps: PrefetchDeps,
): Promise<number> {
	// pnpm passes a leading `--` through from bash and cmd; PowerShell's pnpm.ps1 drops it.
	const args = argv.filter((arg, index) => index > 0 || arg !== "--");
	const unknown = args.find((arg) => arg !== "--help" && arg !== "-h");
	if (unknown !== undefined) {
		deps.error(`m0:prefetch: unknown argument ${unknown}`);
		deps.error(USAGE);
		return 2;
	}
	if (args.length > 0) {
		deps.print(USAGE);
		return 0;
	}
	if (deps.startCheck === undefined) {
		const early = startCheckLines(deps.root);
		if (early.length > 0) {
			for (const line of early) deps.error(line);
			return 1;
		}
	}
	const bootstrap = await import("./lib/bootstrap.ts");
	const startCheck =
		deps.startCheck ??
		(() =>
			bootstrap.checkStart(
				bootstrap.realRoot(deps.root, 0),
				process.argv[1] ?? "",
				bootstrap.HELPERS.prefetch,
			));
	const problems = startCheck();
	if (problems.length > 0) {
		for (const line of bootstrap.startLines(problems)) deps.error(line);
		return 1;
	}
	const { reservedTestsOn } = await import("../../reserved-tests.ts");
	try {
		reservedTestsOn(env);
	} catch (error) {
		deps.error(`m0:prefetch: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
	let result: GateResult | null;
	try {
		result = await deps.gate();
	} catch {
		result = null;
	}
	if (result === null || !result.ok) {
		const lines = result?.lines ?? [bootstrap.GATE_FAILED, bootstrap.START_STOP_LINE];
		for (const line of lines) deps.error(line);
		return 1;
	}
	for (const line of result.lines) deps.print(line);
	return deps.prefetch(deps.root, env);
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
	const root = path.resolve(import.meta.dirname, "..", "..");
	process.exitCode = await prefetchEntry(process.argv.slice(2), process.env, {
		root,
		print: (line) => console.log(line),
		error: (line) => console.error(line),
		gate: async () => (await import("./lib/gate.ts")).runGate({ root }),
		prefetch: async (at, env) => (await import("./prefetch.ts")).prefetchMain(at, env),
	});
}
