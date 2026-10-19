// Dry runs of device-session.ts, the code test/inventory.device.test.ts runs: fixture reports as
// session 3's evidence files in temp folders, written the way receive-report writes them. No phone
// and no adb.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Fingerprint, writeEvidence } from "@draftyak/spike-kit";
import { afterAll, describe, expect, it } from "vitest";
import { failures, sessionLines } from "./device-session.ts";

type Json = Record<string, unknown>;

const fixture = (name: string): Buffer =>
	readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const report = (name: string): Json => JSON.parse(fixture(name).toString("utf8")) as Json;
const full = report("report-full.json");
const bare = report("report-bare.json");
const failing = report("report-failing.json");
const section = (name: string): Json => full[name] as Json;
const resultsOf = (name: string): Json[] => section(name).results as Json[];
// report-full.json with some fields of one section replaced.
const changed = (name: string, fields: Json): Json => ({
	...full,
	[name]: { ...section(name), ...fields },
});

const FULL_LINES = [
	"inventory: ok",
	"mtls: fallback(keystore-signing)",
	"ekm equal: yes",
	"vectors: 3/34 match",
	"multipart: 2 parts sent, 2 delivered, sent row once: yes",
	"rcs id method: mms-transaction-id (tr_id)",
	"outgoing rcs written: unknown",
];
const MISSING_SESSION =
	"evidence/session1.json is missing: receive-report --from-adb --name session1 writes it";
const MISSING_TLS =
	"evidence/session1-tls.json is missing: the stand-in writes it, started with --report-name session1-tls";
const NOT_EVIDENCE = "isn't evidence as receive-report writes it ({recordedAt, fingerprint, data})";

// A fixed fingerprint, so writeEvidence doesn't sample the machine or run git.
const print: Fingerprint = {
	os: { platform: "linux", arch: "x64", osName: "test", osVersion: "1" },
	node: { nodeVersion: "26.12.0", v8Version: "14.6" },
	commit: null,
	dirty: null,
	load: { cpuPercent: 0, cpuCount: 1, cpuModel: "test", memoryUsedPercent: 0, concurrentBuilds: 0 },
};
// report-full.json as receive-report writes it, with some of the wrapper's fields replaced.
function wrapped(fields: Json, encoding: BufferEncoding = "utf8"): Buffer {
	const document = { recordedAt: "2026-10-24T15:05:00.000Z", fingerprint: print, data: full };
	return Buffer.from(JSON.stringify({ ...document, ...fields }), encoding);
}
const temp = mkdtempSync(path.join(tmpdir(), "draftyak-s12-device-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let folders = 0;

// A new evidence folder with session1.json and session1-tls.json: a report written as
// receive-report writes it, bytes as given, or no file.
async function evidence(session?: Json | Buffer, tls?: Json | Buffer): Promise<string> {
	folders += 1;
	const dir = path.join(temp, String(folders), "evidence");
	mkdirSync(dir, { recursive: true });
	const files = [
		["session1.json", session],
		["session1-tls.json", tls],
	] as const;
	for (const [name, file] of files) {
		if (Buffer.isBuffer(file)) {
			writeFileSync(path.join(dir, name), file);
		} else if (file !== undefined) {
			await writeEvidence(path.join(dir, name), file, { fingerprint: print });
		}
	}
	return dir;
}

function refusal(dir: string): string {
	try {
		sessionLines(dir);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("sessionLines took the folder");
}

describe("the device test's lines", () => {
	it("are all accepted for report-full.json as both reports", async () => {
		const lines = sessionLines(await evidence(full, full));
		expect(lines).toEqual(FULL_LINES);
		expect(failures(lines)).toEqual([]);
		expect(lines.join("\n")).not.toContain("DYTEST-");
	});

	it("fail as a whole when one is missing", () => {
		expect(failures(FULL_LINES.slice(1))).toEqual(["6 lines for 7 acceptance lines"]);
	});

	it("all fail for a valid report without the sections they read", async () => {
		const lines = sessionLines(await evidence(bare, bare));
		expect(lines).toEqual([
			"inventory: not in session1.json ($.inventory)",
			"mtls: not in session1-tls.json ($.tls)",
			"ekm equal: not in session1-tls.json ($.tls.ekmEqual)",
			"vectors: not in session1.json ($.vectors)",
			"multipart: no sends in session1.json ($.sends.results)",
			"rcs id method: not in session1.json ($.inventory.rcs.idMethod)",
			"outgoing rcs written: not in session1.json ($.inventory.rcs.outgoingWritten)",
		]);
		expect(failures(lines)).toEqual(lines);
	});

	it("take inventory, vectors, sends and RCS from session1.json", async () => {
		const lines = sessionLines(await evidence(failing, full));
		expect(lines).toEqual([
			"inventory: sms not readable (security), mms not readable (security), Google Messages isn't the default SMS app",
			"mtls: fallback(keystore-signing)",
			"ekm equal: yes",
			"vectors: 0/34 match",
			"multipart: 2 parts sent, 1 delivered, sent row once: no",
			"rcs id method: unknown",
			"outgoing rcs written: not in session1.json ($.inventory.rcs.outgoingWritten)",
		]);
		// Unmatched vectors, a missing delivery and no sent row found are results, not failures.
		expect(failures(lines)).toEqual([lines[0], lines[6]]);
	});

	it("take mtls and ekm from session1-tls.json", async () => {
		const lines = sessionLines(await evidence(full, failing));
		expect(lines).toEqual([
			"inventory: ok",
			"mtls: failed",
			"ekm equal: not in session1-tls.json ($.tls.ekmEqual)",
			...FULL_LINES.slice(3),
		]);
		expect(failures(lines)).toEqual([lines[1], lines[2]]);
	});

	it("fail on an unequal EKM", async () => {
		const tls = { result: "ok", ekmEqual: false };
		const lines = sessionLines(await evidence(full, { ...full, tls }));
		expect(lines.slice(1, 3)).toEqual(["mtls: ok", "ekm equal: no"]);
		expect(failures(lines)).toEqual(["ekm equal: no"]);
	});

	it("fail on a fallback without its reason", async () => {
		const tls = { result: "fallback", ekmEqual: true };
		const lines = sessionLines(await evidence(full, { ...full, tls }));
		const line = "mtls: fallback, with no reason ($.tls.fallbackReason)";
		expect(lines.slice(1, 3)).toEqual([line, "ekm equal: yes"]);
		expect(failures(lines)).toEqual([line]);
	});

	it("fail without an mms table", async () => {
		const providers = (section("inventory").providers as Json[]).filter(
			(entry) => entry.table !== "mms",
		);
		const lines = sessionLines(await evidence(changed("inventory", { providers }), full));
		expect(lines[0]).toBe("inventory: no mms table");
		expect(failures(lines)).toEqual([lines[0]]);
	});

	it("count a vector reported twice once", async () => {
		const results = [...resultsOf("vectors"), ...resultsOf("vectors")];
		const lines = sessionLines(await evidence(changed("vectors", { results }), full));
		expect(lines[3]).toBe("vectors: 3/34 match");
	});

	const [send] = resultsOf("sends");
	it.each([
		["a second sent row", [{ ...send, sentRows: 2 }], 2],
		["a sent row without the whole body", [{ ...send, sentRowBodyEqual: false }], 2],
		["one of two sends without its sent row", [send, { ...send, sentRows: 0 }], 4],
	])("say sent row once: no for %s", async (_, results, parts) => {
		const lines = sessionLines(await evidence(changed("sends", { results }), full));
		expect(lines[4]).toBe(`multipart: ${parts} parts sent, ${parts} delivered, sent row once: no`);
	});
});

describe("the device test's evidence files", () => {
	it("are named when missing", async () => {
		expect(refusal(await evidence())).toBe(`${MISSING_SESSION}\n${MISSING_TLS}`);
		expect(refusal(await evidence(full))).toBe(MISSING_TLS);
		expect(refusal(await evidence(undefined, full))).toBe(MISSING_SESSION);
	});

	it("are read when written the way receive-report writes them", async () => {
		expect(sessionLines(await evidence(wrapped({}), full))).toEqual(FULL_LINES);
	});

	const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture("report-full.json")]);
	it.each([
		["a truncated report", fixture("report-truncated.json"), "isn't UTF-8 JSON"],
		["an empty file", Buffer.alloc(0), "isn't UTF-8 JSON"],
		["a Latin-1 re-save", wrapped({}, "latin1"), "isn't UTF-8 JSON"],
		["a byte order mark", bom, "starts with a byte order mark: something re-encoded it"],
		["null", Buffer.from("null\n"), NOT_EVIDENCE],
		["a report without the evidence wrapper", fixture("report-full.json"), NOT_EVIDENCE],
		["an extra wrapper field", wrapped({ note: "re-saved" }), NOT_EVIDENCE],
		["a recordedAt that isn't a string", wrapped({ recordedAt: 0 }), NOT_EVIDENCE],
		["a fingerprint that isn't an object", wrapped({ fingerprint: null }), NOT_EVIDENCE],
		["data that isn't an object", wrapped({ data: [full] }), NOT_EVIDENCE],
	])("are refused when session1.json holds %s", async (_, bytes, problem) => {
		expect(refusal(await evidence(bytes, full))).toBe(`evidence/session1.json ${problem}`);
	});

	it("are refused when receive-report refuses the data, naming paths and rules only", async () => {
		const message = refusal(await evidence(full, report("report-refused.json")));
		expect(message).toBe(
			"evidence/session1-tls.json: receive-report refuses its data " +
				"($.device.sdkLevel: expected type integer; $.testMessages[0].body: outside the allowed pattern)",
		);
		expect(message).not.toContain("noon");
	});
});
