// The macOS audit watcher's reading of lsof (host.ts). lsof ORs its selection options unless -a is
// given, so the plugin's files come from -p alone: -p with -i would add other processes' sockets.
// -F prints one field per line: a process set starts at its p line and each of its file sets at an
// f line (the descriptor); t is the file's type and P its protocol.
export const WATCHER_INCONCLUSIVE = -1;

// lsof's directory and program-text entries, which are never sockets.
const NOT_SOCKETS = new Set(["cwd", "rtd", "twd", "txt"]);

export function lsofArgs(pid: number): string[] {
	return ["-nP", "-w", "-p", String(pid), "-F", "ftP"];
}

interface FileSet {
	readonly fd: string;
	type: string;
	protocol: string;
}

// The plugin's TCP sockets in any state, LISTEN included. -1 unless the listing holds the plugin's
// process set with its descriptors 0, 1 and 2, and a type for each file that can be a socket: lsof
// leaves out the type of a file it couldn't read, as when the process exits mid-listing. So an
// exited or unlisted process never reads as 0.
export function pluginTcpSockets(listing: string, pid: number): number {
	const files: FileSet[] = [];
	let current: FileSet | undefined;
	let plugin = false;
	for (const line of listing.split(/\r?\n/)) {
		const field = line.charAt(0);
		const value = line.slice(1);
		if (field === "p") {
			plugin = value === String(pid);
			current = undefined;
		} else if (field === "f" && plugin) {
			current = { fd: value, type: "", protocol: "" };
			files.push(current);
		} else if (field === "t" && current !== undefined) {
			current.type = value;
		} else if (field === "P" && current !== undefined) {
			current.protocol = value;
		}
	}
	const fds = new Set(files.map((file) => file.fd));
	if (!["0", "1", "2"].every((fd) => fds.has(fd))) return WATCHER_INCONCLUSIVE;
	if (files.some((file) => file.type === "" && !NOT_SOCKETS.has(file.fd))) {
		return WATCHER_INCONCLUSIVE;
	}
	return files.filter((file) => file.protocol === "TCP").length;
}

export interface LsofRun {
	readonly status: number | null;
	readonly signal: string | null;
	readonly error?: NodeJS.ErrnoException | undefined;
	readonly stdout: string | null;
	readonly stderr: string | null;
}

// The log line for a reading other than 0: lsof's exit and its output, flattened and capped. With no
// name field selected, the listing holds only descriptors, types and protocols.
export function lsofReport(pid: number, count: number, run: LsofRun): string {
	const flat = (text: string | null, max: number): string =>
		(text ?? "")
			.trim()
			.replace(/\s*\r?\n\s*/g, " ")
			.slice(0, max);
	const error = run.error === undefined ? "none" : (run.error.code ?? run.error.message);
	return (
		`TCP watcher (pid ${pid}) read ${count}: lsof status ${run.status}, signal ${run.signal}, ` +
		`error ${error}; stdout: ${flat(run.stdout, 2000)}; stderr: ${flat(run.stderr, 300)}`
	);
}
