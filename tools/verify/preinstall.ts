import path from "node:path";
import { parseArgs } from "node:util";
import type { listCheckout, packageDirs } from "./lib/listing.ts";
import type { Checkout } from "./lib/safe-fs.ts";

// The pre-install check, the last command before pnpm install: from one git listing of the
// checkout, the workspace file, .npmrc, the pnpmfile, binding.gyp and every workspace manifest's
// script names (lib/hooks.ts), by name and kind and through the checked reader, before an install
// can run a hook. It never runs pnpm, never reads the opt-in flag and needs no node_modules. Static
// imports are node: built-ins only: nothing else loads until the start check has passed.
// Exit 0: no problem; 1: a problem, or a failed start check; 2: usage.
const USAGE = "usage: node tools/verify/preinstall.ts [--names] [--root <dir>] [--help]";
const SAY = "pre-install check:";

export interface PreinstallDeps {
	readonly print: (line: string) => void;
	readonly listCheckout: typeof listCheckout;
	readonly packageDirs: typeof packageDirs;
	readonly checkout: (root: string) => Checkout;
}

export async function preinstallMain(
	argv: readonly string[],
	root: string,
	deps: PreinstallDeps,
): Promise<number> {
	let options: { names: boolean; root?: string | undefined; help: boolean };
	try {
		({ values: options } = parseArgs({
			// pnpm passes a leading `--` through from bash and cmd; PowerShell's pnpm.ps1 drops it.
			args: argv[0] === "--" ? argv.slice(1) : [...argv],
			options: {
				names: { type: "boolean", default: false },
				root: { type: "string" },
				help: { type: "boolean", short: "h", default: false },
			},
		}));
		if (options.root === "") throw new Error("--root needs a folder");
	} catch (error) {
		deps.print(`${SAY} ${error instanceof Error ? error.message : String(error)}`);
		deps.print(USAGE);
		return 2;
	}
	if (options.help) {
		deps.print(USAGE);
		return 0;
	}
	const { START_STOP_LINE } = await import("./lib/bootstrap.ts");
	const { listingLines } = await import("./lib/listing.ts");
	const { checkInstallInputs, INSTALL_STOP_LINE } = await import("./lib/hooks.ts");
	const { approvedWorkspace } = await import("./lib/workspace-policy.ts");
	const target = options.root === undefined ? root : path.resolve(options.root);
	let listed: Awaited<ReturnType<typeof listCheckout>>;
	try {
		listed = await deps.listCheckout(target);
	} catch {
		deps.print(`${SAY} the checkout couldn't be listed; nothing was checked`);
		deps.print(INSTALL_STOP_LINE);
		return 1;
	}
	const { listing, problems } = listed;
	if (listing === null || problems.length > 0) {
		for (const line of listingLines(problems, options.names)) deps.print(line);
		deps.print(START_STOP_LINE);
		return 1;
	}
	const checked = checkInstallInputs(
		{ checkout: deps.checkout(listing.root), listing, names: options.names },
		{ packageDirs: deps.packageDirs, approvedWorkspace },
	);
	for (const line of checked.lines) deps.print(line);
	return checked.ok ? 0 : 1;
}

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

if (import.meta.main) {
	const early = startCheckLines(path.resolve(import.meta.dirname, "..", ".."), {
		execArgv: process.execArgv,
		options: process.env.NODE_OPTIONS,
	});
	if (early.length > 0) {
		for (const line of early) console.log(line);
		process.exitCode = 1;
	} else {
		const { HELPERS, checkStart, realRoot, startLines } = await import("./lib/bootstrap.ts");
		const root = realRoot(import.meta.dirname, 2);
		const problems = checkStart(root, process.argv[1] ?? "", HELPERS.preinstall);
		if (problems.length > 0) {
			for (const line of startLines(problems)) console.log(line);
			process.exitCode = 1;
		} else {
			const listing = await import("./lib/listing.ts");
			const { Checkout } = await import("./lib/safe-fs.ts");
			process.exitCode = await preinstallMain(process.argv.slice(2), root, {
				print: (line) => console.log(line),
				listCheckout: listing.listCheckout,
				packageDirs: listing.packageDirs,
				checkout: (dir) => new Checkout(dir),
			});
		}
	}
}
