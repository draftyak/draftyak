import { realpathSync } from "node:fs";
import path from "node:path";
import type { StartProblem } from "../../tools/verify/lib/bootstrap.ts";

// Every script of a spike starts here: its test tiers, and its typecheck as --typecheck. This
// file imports only node: built-ins up front. Before the rest of the kit loads (runner.ts and its
// imports), kitMain checks its own helper files, refuses a working folder reached through an alias,
// and stops a reserved folder's run at the off notice unless DRAFTYAK_RESERVED_TESTS=1 (off.ts), so a
// fault elsewhere in the kit can't fail such a folder's scripts. Then the input gate: trusted from a
// gated launcher (turbo.ts, verify.ts, reserved-proof.ts), which sets DRAFTYAK_GATE_ROOT to this
// checkout's real root, and otherwise run here as node tools/verify/gate.ts.

export const CWD_REFUSED =
	"reserved tripwire: the working folder is reached through a link, junction or other alias; nothing was run";

const fold = (file: string): string => (process.platform === "win32" ? file.toLowerCase() : file);

function below(file: string, root: string): string | null {
	const rel = path.relative(root, file);
	if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) return null;
	return rel;
}

// Whether a working folder, given as a path below the checkout at `root`, really is another folder:
// a link, a junction or an 8.3 alias below the root makes its real path differ from the same path
// below the real root. The off decision reads only the given path below the root (reservedPath), so
// such a folder could hide a reserved name. A folder whose given path isn't below the root is judged
// by its real path there, and one that can't be resolved counts as aliased.
export function aliasedCwd(root: string, cwd: string): boolean {
	const rel = below(path.resolve(cwd), root);
	if (rel === null) return false;
	try {
		const expected = path.join(realpathSync.native(root), rel);
		return fold(realpathSync.native(cwd)) !== fold(expected);
	} catch {
		return true;
	}
}

// Whether a gated launcher already ran the input gate on this checkout: its marker (lib/bootstrap.ts's
// GATE_ROOT_ENV) names the real root. The threat model is accidental reach, not a hostile local user,
// who can set it by hand.
export function gatedLauncher(root: string, marker: string | undefined): boolean {
	if (marker === undefined || marker === "") return false;
	try {
		return fold(path.resolve(marker)) === fold(realpathSync.native(root));
	} catch {
		return false;
	}
}

export interface KitDeps {
	// The checkout's root, and the folder the script runs in.
	readonly root: string;
	readonly cwd: string;
	readonly print: (line: string) => void;
	readonly error: (line: string) => void;
	// checkStart on this entry and one of its HELPERS sets, after the inline start check has passed.
	readonly startCheck: (set: "kitOff" | "kitGate" | "kitRun") => readonly StartProblem[];
	// node tools/verify/gate.ts on this checkout: its lines are printed and its exit code returned.
	readonly gate: () => Promise<number>;
	readonly runner: () => Promise<{
		main: (argv: readonly string[], env?: NodeJS.ProcessEnv) => void;
	}>;
}

// The kit up to the runner. It returns the exit code of a run it stopped, and undefined once
// runner.main has the run.
export async function kitMain(
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
	deps: KitDeps,
): Promise<number | undefined> {
	const { GATE_ROOT_ENV, START_STOP_LINE, startLines } = await import(
		"../../tools/verify/lib/bootstrap.ts"
	);
	const refused = (problems: readonly StartProblem[]): boolean => {
		for (const line of startLines(problems)) deps.error(line);
		return problems.length > 0;
	};
	if (refused(deps.startCheck("kitOff"))) return 2;
	if (aliasedCwd(deps.root, deps.cwd)) {
		deps.error(CWD_REFUSED);
		deps.error(START_STOP_LINE);
		return 2;
	}
	const [{ reservedSpikeOff }, { OFF_NOTICE }] = await Promise.all([
		import("./off.ts"),
		import("../../reserved-tests.ts"),
	]);
	if (reservedSpikeOff(deps.cwd, env)) {
		deps.print(OFF_NOTICE);
		return 0;
	}
	if (!gatedLauncher(deps.root, env[GATE_ROOT_ENV])) {
		if (refused(deps.startCheck("kitGate"))) return 2;
		const code = await deps.gate();
		if (code !== 0) return code;
	}
	// Under a gated launcher too: runner.ts and its imports are checked before they load.
	if (refused(deps.startCheck("kitRun"))) return 2;
	const runner = await deps.runner();
	runner.main(argv, { ...env, [GATE_ROOT_ENV]: realpathSync.native(deps.root) });
	return undefined;
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
	try {
		const lexical = path.resolve(import.meta.dirname, "..", "..");
		const early = startCheckLines(lexical);
		if (early.length > 0) {
			for (const line of early) console.error(line);
			process.exitCode = 2;
		} else {
			const { checkStart, HELPERS, realRoot } = await import("../../tools/verify/lib/bootstrap.ts");
			const root = realRoot(import.meta.dirname, 2);
			const code = await kitMain(process.argv.slice(2), process.env, {
				root: lexical,
				cwd: process.cwd(),
				print: (line) => console.log(line),
				error: (line) => console.error(line),
				startCheck: (set) => checkStart(root, process.argv[1] ?? "", HELPERS[set]),
				gate: async () => {
					const { spawnSync } = await import("node:child_process");
					const gate = path.join(root, "tools", "verify", "gate.ts");
					const result = spawnSync(process.execPath, [gate], {
						cwd: root,
						stdio: ["ignore", "inherit", "inherit"],
						windowsHide: true,
					});
					return result.error === undefined ? (result.status ?? 1) : 2;
				},
				runner: () => import("./runner.ts"),
			});
			if (code !== undefined) process.exitCode = code;
		}
	} catch (error) {
		console.error(`run: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	}
}
