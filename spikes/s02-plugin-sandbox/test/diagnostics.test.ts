import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeFds, explainFds, fdChange, parseLsof } from "./hub-probes.ts";
import { busiestProcesses } from "./memory.ts";
import {
	type Fallback1Result,
	type Fds,
	type FuzzResult,
	fallback1Problem,
	fuzzProblem,
	type HubRun,
} from "./s2b.ts";

// What `lsof -F ftdn` prints on macOS for a hub holding both ends of the plugin's stdout pipe.
const LSOF = [
	"p4242",
	"f14",
	"tunix",
	"d0x5a1c0e9f3b7d2a01",
	"n->0x5a1c0e9f3b7d2b88",
	"f15",
	"tunix",
	"d0x5a1c0e9f3b7d2b88",
	"n->0x5a1c0e9f3b7d2a01",
	"f16",
	"tREG",
	"d0x1000011",
	"n/private/tmp/dy-plugin/data.bin",
	"",
].join("\n");

const fuzzRun = (fds: Fds, closed = true, exitMs = 41): HubRun<FuzzResult> => ({
	survived: true,
	exitCode: 0,
	signal: null,
	timedOut: false,
	crash: null,
	result: {
		mode: "handle-send",
		violations: [{ kind: "handle", detail: "NODE_HANDLE" }],
		killed: true,
		pluginEnded: { code: null, signal: "SIGKILL", closed },
		exitMs,
		auditCount: 0,
		fds,
		plugin: [],
	},
});

describe("the stand-in hub's descriptor diagnostics", () => {
	it("parses lsof's field output per descriptor", () => {
		expect(parseLsof(LSOF)).toEqual([
			{ fd: 14, type: "unix", device: "0x5a1c0e9f3b7d2a01", name: "->0x5a1c0e9f3b7d2b88" },
			{ fd: 15, type: "unix", device: "0x5a1c0e9f3b7d2b88", name: "->0x5a1c0e9f3b7d2a01" },
			{ fd: 16, type: "REG", device: "0x1000011", name: "/private/tmp/dy-plugin/data.bin" },
		]);
		expect(parseLsof("p1\nfcwd\ntDIR\nn/\nf3\ntunix\n")).toEqual([{ fd: 3, type: "unix" }]);
	});

	it("names a new socket whose peer is the hub's own end of a pipe to the plugin", () => {
		const labels = new Map([[15, "the hub's end of the plugin's stdout"]]);
		expect(explainFds([14, 15, 16, 17], parseLsof(LSOF), labels)).toEqual([
			"fd 14: unix 0x5a1c0e9f3b7d2a01 ->0x5a1c0e9f3b7d2b88, peer fd 15 (the hub's end of the plugin's stdout)",
			"fd 15 (the hub's end of the plugin's stdout): unix 0x5a1c0e9f3b7d2b88 ->0x5a1c0e9f3b7d2a01, peer fd 14",
			"fd 16: REG 0x1000011 /private/tmp/dy-plugin/data.bin",
			"fd 17: not listed by lsof",
		]);
	});

	it("fails on any change in the hub's count, as before, and says what is new", () => {
		expect(fuzzProblem("handle-send", "darwin", fuzzRun({ before: 13, after: 13 }))).toBeNull();
		const added = ["fd 14: unix 0x1 ->0x2, peer fd 15", "fd 15: unix 0x2 ->0x1, peer fd 14"];
		expect(
			fuzzProblem("handle-send", "darwin", fuzzRun({ before: 13, after: 15, added }, false, 10012)),
		).toBe(
			"the hub's open fds went from 13 to 15 (violation handle, ended by SIGKILL, 'close' never fired, 10012 ms); new: fd 14: unix 0x1 ->0x2, peer fd 15; fd 15: unix 0x2 ->0x1, peer fd 14",
		);
		expect(fuzzProblem("handle-send", "linux", fuzzRun({ before: 24, after: 23 }))).toBe(
			"the hub's open fds went from 24 to 23 (violation handle, ended by SIGKILL, 'close' fired, 41 ms)",
		);
		expect(fuzzProblem("handle-send", "linux", fuzzRun({ before: 24, after: null }))).toMatch(
			/^the hub's open fds went from 24 to null/,
		);
	});

	it("describes only the descriptors a changed count added", () => {
		const before = { count: 4, open: [0, 1, 2] };
		expect(fdChange(before, { count: 4, open: [0, 1, 2] }, new Map())).toEqual({
			before: 4,
			after: 4,
		});
		expect(fdChange(before, null, new Map())).toEqual({ before: 4, after: null });
		const grown = fdChange(before, { count: 6, open: [0, 1, 2, 7, 9] }, new Map([[9, "x"]]));
		expect(grown).toMatchObject({ before: 4, after: 6 });
		expect(grown.added?.map((line) => line.split(":")[0])).toEqual(["fd 7", "fd 9 (x)"]);
	});

	it("passes Fallback 1 when the hub's count holds, and names new descriptors when it grows", () => {
		const run = (fds: Fds | null, reinstated = true): HubRun<Fallback1Result> => ({
			survived: true,
			exitCode: 0,
			signal: null,
			timedOut: false,
			crash: null,
			result: {
				reinstated,
				pluginReport: null,
				pluginEnded: { code: 0, signal: null, closed: true },
				exitMs: 3200,
				fds,
			},
		});
		// Windows: no /dev/fd, so fds is null and only hub survival is checked.
		expect(fallback1Problem(run(null))).toBeNull();
		// Linux: the plugin reinstated process.send but the count held.
		expect(fallback1Problem(run({ before: 19, after: 19 }))).toBeNull();
		const added = ["fd 14: unix 0x1 ->0x2, peer fd 15", "fd 15: unix 0x2 ->0x1, peer fd 14"];
		expect(fallback1Problem(run({ before: 13, after: 15, added }))).toBe(
			"the hub's open fds went from 13 to 15 without an IPC channel (reinstated true, ended by exit 0, 3200 ms); new: fd 14: unix 0x1 ->0x2, peer fd 15; fd 15: unix 0x2 ->0x1, peer fd 14",
		);
		const died: HubRun<Fallback1Result> = {
			...run(null),
			survived: false,
			exitCode: 1,
			result: null,
		};
		expect(fallback1Problem(died)).toMatch(/^the hub died/);
	});

	it("describes a live descriptor on this host (its /proc link in Linux)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dy-s02-fds-"));
		const fd = fs.openSync(path.join(dir, "held.txt"), "w");
		try {
			const [line = ""] = describeFds([fd], new Map([[fd, "held"]]));
			expect(line.startsWith(`fd ${fd} (held): `)).toBe(true);
			if (process.platform === "linux") expect(line.endsWith("held.txt")).toBe(true);
		} finally {
			fs.closeSync(fd);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the bench lock's busy report", () => {
	it("lists the busiest processes by name with the share of them all", () => {
		const ps = [
			"  0.0 /sbin/launchd",
			" 85.5 /System/Library/Frameworks/CoreServices.framework/Versions/A/Support/mds_stores",
			"  3,5 /usr/libexec/logd",
			" 41.0 kernel_task",
			"100.2 /opt/node/bin/node",
			"",
			"garbage",
		].join("\n");
		expect(busiestProcesses(ps, 3)).toBe(
			"230.2% in all; node 100.2%, mds_stores 85.5%, kernel_task 41%",
		);
	});
});
