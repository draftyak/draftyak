// M0.38's acceptance after session 3: one line per check from evidence/session1.json and
// session1-tls.json (test/device-session.ts), each matched against its acceptance line. The lines
// go straight to stdout, so they show whichever reporter Vitest picks; it hides a passing test's
// console output under some.
import { expect, it } from "vitest";
import { EVIDENCE_DIR } from "../src/receive-report.ts";
import { failures, sessionLines } from "./device-session.ts";

it("S12 session 3: the acceptance lines", () => {
	const lines = sessionLines(EVIDENCE_DIR);
	process.stdout.write(`${lines.join("\n")}\n`);
	expect(failures(lines), "lines that fail their acceptance line").toEqual([]);
});
