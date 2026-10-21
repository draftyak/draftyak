import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { EvidenceProvenance } from "../../kit/provenance.ts";

// Pure provenance controls: importing the recorder would also initialize native/matrix helpers.
it.each([40, 64])("preserves fingerprint fields for a %s-character commit", async (length) => {
	const print = { commit: "a".repeat(length), dirty: true, measurement: 7 };
	const provenance = new EvidenceProvenance(import.meta.dirname, () => ({ code: 0, stdout: "" }));
	expect(await provenance.fingerprint(async () => print)).toEqual({ ...print, dirty: false });
	expect(print.dirty).toBe(true);
});

it("retains null and dirty status from the current root-wide sample", async () => {
	for (const [code, stdout, dirty] of [
		[1, "", null],
		[0, "?? input.ts\n", true],
	] as const) {
		const provenance = new EvidenceProvenance(import.meta.dirname, () => ({ code, stdout }));
		expect((await provenance.fingerprint(async () => ({ commit: null, dirty: false }))).dirty).toBe(
			dirty,
		);
	}
});

it("routes S1 load, matrix and benchmark outputs through successful-write ownership", () => {
	const record = readFileSync(new URL("../src/record.ts", import.meta.url), "utf8");
	const bench = readFileSync(new URL("./bench.heavy.test.ts", import.meta.url), "utf8");
	expect(record).toContain("provenance.write(file,");
	expect(record).toContain("provenance.write(path.join(evidenceDir, MATRIX)");
	expect(record).toContain("await writeCodeEvidence(file, data, print)");
	expect(bench).toContain("await writeCodeEvidence(file, data)");
	expect(record).not.toContain("--untracked-files=no");
});

it("routes each S5 writer through the shared exact-output seam", () => {
	const app = readFileSync(new URL("../../s05-desktop/test/app.ts", import.meta.url), "utf8");
	expect(app).toContain("provenance.write(file,");
	for (const suite of ["shell", "ekm", "power", "sidecar"]) {
		const source = readFileSync(
			new URL(`../../s05-desktop/test/${suite}.heavy.test.ts`, import.meta.url),
			"utf8",
		);
		expect(source).toContain("writeCodeEvidence(file,");
		expect(source).not.toContain("--untracked-files=no");
	}
});
