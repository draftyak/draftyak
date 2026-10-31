import path from "node:path";
import type { reservedTurboArgs } from "../../reserved-tests.ts";
import type { StartProblem } from "./lib/bootstrap.ts";
import type { GateResult } from "./lib/gate.ts";
import type { run } from "./lib/spawn.ts";

// The root typecheck, test and build scripts run turbo through here: from the repository root, with
// telemetry off, and with every reserved package left out unless DRAFTYAK_RESERVED_TESTS=1.
// Static imports are node: built-ins and types only. turboMain runs the start check, the flag check
// and the input gate on this checkout, in that order, and only then launch(), which gives turbo's
// tasks DRAFTYAK_GATE_ROOT. A refusal, anything but `turbo run` or a refused flag value exits 2
// before turbo is resolved.

export async function launch(
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
	deps: {
		readonly root: string;
		readonly run: typeof run;
		readonly resolveTurbo: (root: string) => string;
		// The reserved filter, reservedTurboArgs unless a test passes another.
		readonly args?: typeof reservedTurboArgs;
	},
): Promise<number> {
	const args = [...argv];
	// pnpm passes the `--` of `pnpm test -- <flags>` through from bash and cmd, but not from PowerShell.
	if (args[0] === "run" && args[2] === "--") args.splice(2, 1);
	try {
		const filter = deps.args ?? (await import("../../reserved-tests.ts")).reservedTurboArgs;
		const { telemetryOff } = await import("./lib/tools.ts");
		const filtered = filter(args, env, deps.root);
		const turbo = { command: deps.resolveTurbo(deps.root), args: filtered };
		return await deps.run(turbo, { cwd: deps.root, env: { ...env, ...telemetryOff } });
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
}

export interface TurboDeps {
	readonly print: (line: string) => void;
	// checkStart on this entry and HELPERS.turbo, after the inline start check has passed.
	readonly startCheck: () => readonly StartProblem[];
	readonly gate: () => Promise<GateResult>;
	readonly launch: (argv: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>;
}

export async function turboMain(
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
	deps: TurboDeps,
): Promise<number> {
	const { GATE_FAILED, GATE_ROOT_ENV, START_STOP_LINE, startLines } = await import(
		"./lib/bootstrap.ts"
	);
	const problems = deps.startCheck();
	if (problems.length > 0) {
		for (const line of startLines(problems)) deps.print(line);
		return 2;
	}
	const { reservedTestsOn } = await import("../../reserved-tests.ts");
	try {
		reservedTestsOn(env);
	} catch (error) {
		deps.print(error instanceof Error ? error.message : String(error));
		return 2;
	}
	let result: GateResult | null;
	try {
		result = await deps.gate();
	} catch {
		result = null;
	}
	for (const line of result?.lines ?? [GATE_FAILED, START_STOP_LINE]) deps.print(line);
	const listing = result?.ok === true ? result.listing : null;
	if (listing === null) return 2;
	return deps.launch(argv, { ...env, [GATE_ROOT_ENV]: listing.root });
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
	// turbo gets Ctrl+C from the console itself; stay alive until it has shut its tasks down.
	process.on("SIGINT", () => {});
	const print = (line: string): void => console.log(line);
	const early = startCheckLines(path.resolve(import.meta.dirname, "..", ".."));
	if (early.length > 0) {
		for (const line of early) print(line);
		process.exitCode = 2;
	} else {
		const { checkStart, HELPERS, realRoot } = await import("./lib/bootstrap.ts");
		const root = realRoot(import.meta.dirname, 2);
		process.exitCode = await turboMain(process.argv.slice(2), process.env, {
			print,
			startCheck: () => checkStart(root, process.argv[1] ?? "", HELPERS.turbo),
			gate: async () => (await import("./lib/gate.ts")).runGate({ root }),
			launch: async (argv, env) => {
				const [{ run }, { resolveTurbo }] = await Promise.all([
					import("./lib/spawn.ts"),
					import("./lib/tools.ts"),
				]);
				return launch(argv, env, { root, run, resolveTurbo });
			},
		});
	}
}
