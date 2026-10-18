import { describe, expect, it } from "vitest";
import { lsofArgs, lsofReport, pluginTcpSockets } from "./lsof.ts";

const PID = 4242;

// Field output as macOS lsof prints it for a clean plugin: its cwd, the node binary and a dylib, stdio
// and the fd-3 host channel as unix socketpairs, libuv's kqueue and pipes. The NAME field, which isn't
// selected, reads '->0x...' for those sockets and pipes.
const CLEAN = `p${PID}
fcwd
tDIR
ftxt
tREG
ftxt
tREG
f0
tunix
f1
tunix
f2
tunix
f3
tunix
f4
tKQUEUE
f5
tPIPE
f6
tPIPE
`;

// The field list has no TCP state, so a listener reads like a connection: fd 21 listens, fd 22 is
// connected.
const TCP = `f21
tIPv4
PTCP
f22
tIPv6
PTCP
`;

const UDP = `f23
tIPv4
PUDP
`;

// Another process's TCP sockets, which -p with -iTCP added to the listing.
const OTHER = `p501
f17
tIPv4
PTCP
f18
tIPv6
PTCP
`;

const crlf = (text: string): string => text.replaceAll("\n", "\r\n");
const withoutFd = (fd: string): string => CLEAN.replace(`f${fd}\ntunix\n`, "");

describe("the macOS TCP watcher's lsof listing", () => {
	it("asks for the plugin's own files only, in field form", () => {
		expect(lsofArgs(PID)).toEqual(["-nP", "-w", "-p", "4242", "-F", "ftP"]);
	});

	it("reads 0 for pipes, unix sockets and the cwd and txt entries", () => {
		expect(pluginTcpSockets(CLEAN, PID)).toBe(0);
	});

	it("counts IPv4 and IPv6 TCP sockets in any state", () => {
		expect(pluginTcpSockets(CLEAN + TCP, PID)).toBe(2);
	});

	it("doesn't count UDP", () => {
		expect(pluginTcpSockets(CLEAN + UDP, PID)).toBe(0);
		expect(pluginTcpSockets(CLEAN + TCP + UDP, PID)).toBe(2);
	});

	it("counts only the plugin's process set", () => {
		expect(pluginTcpSockets(CLEAN + OTHER, PID)).toBe(0);
		expect(pluginTcpSockets(OTHER + CLEAN, PID)).toBe(0);
		expect(pluginTcpSockets(CLEAN + TCP + OTHER, PID)).toBe(2);
	});

	it("is inconclusive unless the plugin and its descriptors 0, 1 and 2 are listed", () => {
		expect(pluginTcpSockets(CLEAN, PID + 1)).toBe(-1);
		expect(pluginTcpSockets(OTHER, PID)).toBe(-1);
		for (const fd of ["0", "1", "2"]) {
			expect(pluginTcpSockets(withoutFd(fd) + TCP, PID), `without f${fd}`).toBe(-1);
		}
		expect(pluginTcpSockets(`p${PID}\n${TCP}`, PID)).toBe(-1);
		const stdioElsewhere = `p${PID}\nfcwd\ntDIR\n${TCP}p501\nf0\ntunix\nf1\ntunix\nf2\ntunix\n`;
		expect(pluginTcpSockets(stdioElsewhere, PID)).toBe(-1);
	});

	it("matches the plugin's pid exactly", () => {
		for (const other of [`${PID}0`, `1${PID}`, "424"]) {
			expect(pluginTcpSockets(CLEAN.replace(`p${PID}`, `p${other}`), PID), other).toBe(-1);
		}
	});

	// lsof prints a file it couldn't read, such as a socket of a process that exited mid-listing, as
	// its f line alone.
	it("is inconclusive when lsof couldn't read a file that can be a socket", () => {
		expect(pluginTcpSockets(`${CLEAN}f9\n`, PID)).toBe(-1);
		expect(pluginTcpSockets(`${CLEAN}${TCP}f9\n`, PID)).toBe(-1);
		expect(pluginTcpSockets(`p${PID}\nf0\nf1\nf2\n`, PID)).toBe(-1);
		// A fileport, a listing error and a descriptor from 10000 up.
		for (const fd of ["fp.", "err", "*010"]) {
			expect(pluginTcpSockets(`${CLEAN}f${fd}\n`, PID), fd).toBe(-1);
		}
		// Directory and program-text entries are never sockets, and other processes' files don't count.
		expect(pluginTcpSockets(`${CLEAN}fcwd\nfrtd\nftwd\nftxt\n`, PID)).toBe(0);
		expect(pluginTcpSockets(`${CLEAN}${OTHER}f9\n`, PID)).toBe(0);
	});

	it("is inconclusive for empty output", () => {
		expect(pluginTcpSockets("", PID)).toBe(-1);
		expect(pluginTcpSockets("\n", PID)).toBe(-1);
	});

	it("reads CRLF line ends and a missing final newline", () => {
		expect(pluginTcpSockets(crlf(CLEAN), PID)).toBe(0);
		expect(pluginTcpSockets(crlf(CLEAN + TCP + UDP + OTHER), PID)).toBe(2);
		expect(pluginTcpSockets((CLEAN + TCP).trimEnd(), PID)).toBe(2);
	});

	it("reports lsof's exit and output on one capped line", () => {
		const error = Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
		const missing = { status: null, signal: null, error, stdout: null, stderr: null };
		expect(lsofReport(PID, -1, missing)).toBe(
			"TCP watcher (pid 4242) read -1: lsof status null, signal null, error ENOENT; stdout: ; stderr: ",
		);
		const found = { status: 0, signal: null, stdout: crlf(CLEAN + TCP), stderr: "" };
		const listed = (CLEAN + TCP).trim().replaceAll("\n", " ");
		expect(lsofReport(PID, 2, found)).toBe(
			`TCP watcher (pid 4242) read 2: lsof status 0, signal null, error none; stdout: ${listed}; stderr: `,
		);
		const flood = {
			status: 1,
			signal: "SIGTERM",
			stdout: "f0\n".repeat(5000),
			stderr: "x\n".repeat(500),
		};
		expect(lsofReport(PID, -1, flood).length).toBeLessThan(2500);
	});
});
