import path from "node:path";
import type { GateOptions, GateResult } from "./lib/gate.ts";

// The input gate as a command: the first step of every CI job, and of each gated entry's run.
// Static imports are node: built-ins and types only: it checks its own helpers before loading
// them. Exit 0 prints one "reserved check:" line; 1 prints "reserved tripwire:" count lines and the
// stop line once (a start check, the listing, the tree rules or the gate's own checks); 2 is usage.
// Its output names no path or reserved word unless --names.

export const USAGE = "usage: node tools/verify/gate.ts [--names] [--root <dir>] [--help]";

// start check
function startCheckLines(
	root: string,
	node: { readonly execArgv: readonly string[]; readonly options: string | undefined },
): string[] {
	const nodeFs = process.getBuiltinModule("node:fs");
	const nodePath = process.getBuiltinModule("node:path");
	const fold = (file: string): string => {
		const slashed = file.split(nodePath.sep).join("/");
		if (process.platform === "win32") return slashed.toLowerCase();
		return process.platform === "darwin" ? slashed.normalize("NFC").toLowerCase() : slashed;
	};
	const stop =
		"reserved tripwire: stopped before anything was built or tested. Reserved code may sit only in the allowed reserved roots, and no Rust or Cargo may use a reserved name or feature, until that code has its own reviewed gating design; every listed file, every file one of them names and every file a tool would pick up from a folder it scans must be a regular, listed file of this checkout, inside real folders. Don't open the files or follow the links: send this log's path to the reserved files' maintainer.";
	// Node runs these before an entry's first line: a module to preload, a loader, a startup
	// snapshot, or a config file that may name them. No check after that code can tell what it
	// reached, so the entry stops. NODE_OPTIONS splits as Node splits it: at spaces outside double
	// quotes, which it drops, and a backslash inside quotes takes the next character as it is. One
	// string, so no scan for import specifiers reads an option's name as one.
	const preloads = [
		"--require -r --import --loader --experimental-loader --snapshot-blob --config-file",
		"--experimental-config-file --experimental-default-config-file",
	]
		.join(" ")
		.split(" ");
	const words: string[] = [];
	const options = node.options ?? "";
	let quoted = false;
	let fresh = true;
	for (let index = 0; index < options.length; index++) {
		let char = options.charAt(index);
		if (char === String.fromCharCode(92) && quoted) char = options.charAt(++index);
		else if (char === " " && !quoted) {
			fresh = true;
			continue;
		} else if (char === '"') {
			quoted = !quoted;
			continue;
		}
		if (fresh) words.push(char);
		else words[words.length - 1] += char;
		fresh = false;
	}
	const loads = (arg: string): boolean =>
		preloads.includes((arg.split("=")[0] ?? "").replaceAll("_", "-"));
	if ([...node.execArgv, ...words].some(loads)) {
		return [
			"reserved tripwire: Node loaded code or options before this entry's first line (--require, --import, --loader, a startup snapshot or a config file, on its command line or in NODE_OPTIONS); nothing was checked",
			stop,
		];
	}
	const stopped = [
		"reserved tripwire: 1 start file(s) or folder(s) failed their kind check; nothing was loaded",
		stop,
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

// The command after its start checks: --names, --root <dir> (from the working folder; that tree is
// checked with this checkout's own helpers) and --help. gate defaults to lib/gate.ts's runGate,
// loaded only now.
export async function gateCli(
	argv: readonly string[],
	deps: {
		root: string;
		print: (line: string) => void;
		gate?: (options: GateOptions) => Promise<GateResult>;
	},
): Promise<number> {
	let names = false;
	let root: string | null = null;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" && argv.length === 1) {
			deps.print(USAGE);
			return 0;
		}
		if (arg === "--names" && !names) names = true;
		else if (arg === "--root" && root === null && argv[index + 1] !== undefined) {
			root = path.resolve(argv[index + 1] ?? "");
			index++;
		} else {
			deps.print(USAGE);
			return 2;
		}
	}
	const gate = deps.gate ?? (await import("./lib/gate.ts")).runGate;
	const result = await gate({ root: root ?? deps.root, names });
	for (const line of result.lines) deps.print(line);
	return result.ok ? 0 : 1;
}

if (import.meta.main) {
	const print = (line: string): void => console.log(line);
	const names = process.argv.includes("--names");
	const early = startCheckLines(path.resolve(import.meta.dirname, "..", ".."), {
		execArgv: process.execArgv,
		options: process.env.NODE_OPTIONS,
	});
	if (early.length > 0) {
		for (const line of early) print(line);
		process.exitCode = 1;
	} else {
		const { checkStart, HELPERS, realRoot, startLines } = await import("./lib/bootstrap.ts");
		const root = realRoot(import.meta.dirname, 2);
		const problems = checkStart(root, process.argv[1] ?? "", HELPERS.gate);
		if (problems.length > 0) {
			for (const line of startLines(problems, names)) print(line);
			process.exitCode = 1;
		} else process.exitCode = await gateCli(process.argv.slice(2), { root, print });
	}
}

// The inline start check, for the tests.
export { startCheckLines };
