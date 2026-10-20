import { describe, expect, it } from "vitest";
import { type CargoDenyInputs, parseCargoDenyReports } from "../src/cargo-deny.ts";
import { InputError } from "../src/strict-json.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const stats = (errors = 0, warnings = 0, notes = 0, helps = 0) => ({
	errors,
	warnings,
	notes,
	helps,
});
function advisory() {
	return {
		id: "RUSTSEC-2026-9999",
		package: "invented-crate",
		informational: "unsound",
		categories: ["memory-corruption"],
		collection: "crates",
		source: null,
		date: "2026-01-01",
		withdrawn: null,
		aliases: [],
		cvss: null,
		description: "invented prose",
		"expect-deleted": false,
		keywords: [],
		license: "CC0-1.0",
		references: [],
		related: [],
		title: "invented title",
		url: "https://example.invalid/advisory",
	};
}
function diagnostic() {
	return {
		type: "diagnostic",
		fields: {
			code: "unsound",
			severity: "error",
			message: "do not return this prose",
			notes: ["private diagnostic text"],
			labels: [{ line: 1, column: 2, message: "private label", span: "private path" }],
			advisory: advisory(),
			graphs: [
				{
					Krate: { name: "invented-crate", version: "1.0.0" },
					parents: [{ Krate: { name: "invented-root", version: "0.0.0" }, repeat: true }],
				},
			],
		},
	};
}
function finding() {
	return {
		advisory: advisory(),
		kind: "unsound",
		affected: {
			arch: ["x86_64"],
			os: ["linux"],
			functions: { "invented_crate::method": [">=1.0.0, <2.0.0"] },
		},
		package: {
			checksum: null,
			dependencies: [],
			name: "invented-crate",
			replace: null,
			source: "registry+https://github.com/rust-lang/crates.io-index",
			version: "1.0.0",
		},
		versions: { patched: [">=2.0.0"], unaffected: ["<1.0.0"] },
	};
}
function fixture() {
	const counts = {
		advisories: stats(1),
		bans: stats(0, 1, 2),
		licenses: stats(0, 0, 0, 3),
		sources: stats(),
	};
	const fullRows = [
		diagnostic(),
		{
			type: "diagnostic",
			fields: {
				code: "duplicate",
				severity: "warning",
				message: "duplicate invented crate",
				graphs: [{ Krate: { name: "another-crate", version: "0.1.0" } }],
			},
		},
		{ type: "summary", fields: counts },
	];
	const advisoryRows = [diagnostic(), { type: "summary", fields: { advisories: stats(1) } }];
	const audit = {
		lockfile: { "dependency-count": 3 },
		settings: {
			ignore: [],
			informational_warnings: ["notice", "unmaintained", "unsound"],
			severity: null,
			target_arch: [],
			target_os: [],
		},
		vulnerabilities: [] as unknown[],
		warnings: { unsound: [finding()] },
	};
	return { fullRows, advisoryRows, audit };
}
type Fixture = ReturnType<typeof fixture>;
function input(f: Fixture = fixture(), exitCode = 1): CargoDenyInputs {
	const jsonl = (v: unknown[]) => bytes(v.map((x) => JSON.stringify(x)).join("\n") + "\n");
	return {
		full: { stdout: bytes(""), stderr: jsonl(f.fullRows), exitCode, signal: null },
		advisory: {
			stdout: bytes(JSON.stringify(f.audit) + "\n"),
			stderr: jsonl(f.advisoryRows),
			exitCode: 1,
			signal: null,
		},
		denyWarnings: false,
	};
}
function refuses(value: CargoDenyInputs): void {
	expect(() => parseCargoDenyReports(value)).toThrow(InputError);
}
function edit(
	path: "full" | "advisory",
	channel: "stdout" | "stderr",
	change: (s: string) => string,
): CargoDenyInputs {
	const v = input();
	return {
		...v,
		[path]: { ...v[path], [channel]: bytes(change(new TextDecoder().decode(v[path][channel]))) },
	};
}

describe("complete Cargo-deny captures", () => {
	it("retains every error, warning and all four summary categories without returning prose", () => {
		const result = parseCargoDenyReports(input());
		expect(result.complete).toBe(true);
		expect(result.fullExitCode).toBe(1);
		expect(result.advisoryExitCode).toBe(1);
		expect(result.diagnostics.map((d) => [d.category, d.code, d.severity])).toEqual([
			["advisories", "unsound", "error"],
			["bans", "duplicate", "warning"],
		]);
		expect(result.counts.licenses.helps).toBe(3);
		expect(result.counts.bans.notes).toBe(2);
		expect(result.findings[0]).toMatchObject({
			name: "invented-crate",
			version: "1.0.0",
			classification: "unsound",
			patched: [">=2.0.0"],
			unaffected: ["<1.0.0"],
			affected: { functions: [["invented_crate::method", [">=1.0.0, <2.0.0"]]] },
		});
		expect(result.diagnostics[0]?.graphs[0]?.parents[0]?.repeat).toBe(true);
		expect(JSON.stringify(result)).not.toMatch(/private|prose|example.invalid|invented title/);
	});
	it("accepts a genuine empty pass and preserves zero exits", () => {
		const f = fixture();
		f.fullRows.splice(0, 2);
		f.fullRows[0] = {
			type: "summary",
			fields: { advisories: stats(), bans: stats(), licenses: stats(0, 0, 0, 3), sources: stats() },
		} as never;
		f.advisoryRows.splice(0, 1);
		f.advisoryRows[0] = { type: "summary", fields: { advisories: stats() } } as never;
		f.audit.warnings.unsound = [];
		const v = input(f, 0);
		expect(
			parseCargoDenyReports({ ...v, advisory: { ...v.advisory, exitCode: 0 } }).findings,
		).toEqual([]);
	});
	it("preserves additional non-advisory errors instead of treating them as scoped advisories", () => {
		const f = fixture();
		f.fullRows.splice(1, 0, {
			type: "diagnostic",
			fields: { code: "unlicensed", severity: "error", message: "invented licence refusal" },
		} as never);
		const summary = f.fullRows.at(-1)?.fields as { licenses: ReturnType<typeof stats> };
		summary.licenses = stats(1, 0, 0, 3);
		const result = parseCargoDenyReports(input(f, 5));
		expect(result.fullExitCode).toBe(5);
		expect(
			result.diagnostics.filter((d) => d.severity === "error" && d.category !== "advisories"),
		).toHaveLength(1);
		refuses(input(f, 0));
	});
	it("allows order differences between the full and advisory records", () => {
		const f = fixture();
		f.audit.settings.informational_warnings.reverse();
		expect(parseCargoDenyReports(input(f)).complete).toBe(true);
	});
	it("retains duplicate warnings with their crate identities", () => {
		const result = parseCargoDenyReports(input());
		expect(result.diagnostics[1]?.graphs[0]).toEqual({
			name: "another-crate",
			version: "0.1.0",
			kind: null,
			repeat: false,
			parents: [],
		});
	});

	it("retains advisory CVSS classification and detects cross-report changes", () => {
		const f = fixture();
		f.audit.warnings.unsound[0]!.advisory.cvss =
			"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" as never;
		refuses(input(f));
	});
	it("retains emitted build/dev graph-kind markers", () => {
		const f = fixture();
		const fields = f.fullRows[1]?.fields as { graphs: { Krate: { kind?: string } }[] };
		Object.assign(fields.graphs[0]?.Krate ?? {}, { kind: "build" });
		expect(parseCargoDenyReports(input(f)).diagnostics[1]?.graphs[0]?.kind).toBe("build");
	});
	it("retains a changed registry source for the graph-authority mapper to refuse", () => {
		const f = fixture();
		f.audit.warnings.unsound[0]!.package.source = "registry+https://example.invalid/index";
		expect(parseCargoDenyReports(input(f)).findings[0]?.source).toBe(
			"registry+https://example.invalid/index",
		);
	});
	for (const classification of ["notice", "unmaintained"]) {
		it(`preserves the ${classification} classification`, () => {
			const v = input();
			const replace = (b: Uint8Array) =>
				bytes(new TextDecoder().decode(b).replaceAll('"unsound"', JSON.stringify(classification)));
			const report = JSON.parse(new TextDecoder().decode(replace(v.advisory.stdout)));
			report.settings.informational_warnings = ["notice", "unmaintained", "unsound"];
			const result = parseCargoDenyReports({
				...v,
				full: { ...v.full, stderr: replace(v.full.stderr) },
				advisory: {
					...v.advisory,
					stdout: bytes(JSON.stringify(report)),
					stderr: replace(v.advisory.stderr),
				},
			});
			expect(result.findings[0]?.classification).toBe(classification);
		});
	}
	it("preserves non-informational vulnerability records", () => {
		const v = input();
		const change = (b: Uint8Array) =>
			bytes(
				new TextDecoder()
					.decode(b)
					.replaceAll('"code":"unsound"', '"code":"vulnerability"')
					.replaceAll('"informational":"unsound"', '"informational":null'),
			);
		const report = JSON.parse(new TextDecoder().decode(v.advisory.stdout));
		const vulnerability = report.warnings.unsound[0];
		delete vulnerability.kind;
		vulnerability.advisory.informational = null;
		report.vulnerabilities = [vulnerability];
		report.warnings = {};
		const result = parseCargoDenyReports({
			...v,
			full: { ...v.full, stderr: change(v.full.stderr) },
			advisory: {
				...v.advisory,
				stdout: bytes(JSON.stringify(report)),
				stderr: change(v.advisory.stderr),
			},
		});
		expect(result.findings[0]?.classification).toBe("vulnerability");
		expect(result.findings[0]?.advisory.informational).toBeNull();
	});
});

describe("report refusal boundaries", () => {
	for (const suffix of ["\r", "\n", "\u2028", "\u2029"]) {
		it(`refuses a crate identifier with final terminator ${JSON.stringify(suffix)}`, () => {
			refuses(
				edit("full", "stderr", (s) =>
					s.replace('"invented-root"', JSON.stringify(`invented-root${suffix}`)),
				),
			);
		});
	}
	for (const category of ["advisories", "bans", "licenses", "sources"]) {
		it(`requires ${category} summary accounting`, () =>
			refuses(
				edit("full", "stderr", (s) => s.replace(new RegExp(`"${category}":\\{[^}]+\\},?`), "")),
			));
		it(`refuses an unreported ${category} error`, () => {
			const f = fixture();
			const summary = f.fullRows.at(-1)?.fields as Record<string, ReturnType<typeof stats>>;
			const current = summary[category];
			if (!current) throw Error("fixture");
			current.errors++;
			refuses(input(f));
		});
	}
	for (const [name, change] of [
		["missing final summary", (s: string) => s.split("\n").slice(0, -2).join("\n")],
		["duplicate summary", (s: string) => s + s.split("\n").at(-2) + "\n"],
		["truncated record", (s: string) => s.slice(0, -4)],
		["trailing non-JSON", (s: string) => s + "unexpected text\n"],
		["unknown record type", (s: string) => s.replace('"diagnostic"', '"log"')],
		["unknown diagnostic code", (s: string) => s.replace('"unsound"', '"ignored-advisory"')],
		["unknown severity", (s: string) => s.replace('"error"', '"fatal"')],
		["unknown category", (s: string) => s.replace('"sources":', '"future":')],
		[
			"duplicate decoded field",
			(s: string) => s.replace('"type":', '"type":"diagnostic","t\\u0079pe":'),
		],
		["unknown top field", (s: string) => s.replace('"type":', '"newField":false,"type":')],
		["unknown diagnostic field", (s: string) => s.replace('"code":', '"ignored":true,"code":')],
		["unsafe counter", (s: string) => s.replace('"helps":3', '"helps":9007199254740992')],
		["nonfinite counter", (s: string) => s.replace('"helps":3', '"helps":1e999')],
		["negative counter", (s: string) => s.replace('"helps":3', '"helps":-1')],
		["fractional counter", (s: string) => s.replace('"helps":3', '"helps":0.5')],
		["missing error diagnostic", (s: string) => s.split("\n").slice(1).join("\n")],
		[
			"missing warning diagnostic",
			(s: string) => {
				const l = s.split("\n");
				l.splice(1, 1);
				return l.join("\n");
			},
		],
		["severity downgrade", (s: string) => s.replace('"error"', '"note"')],
		[
			"graph-name mismatch",
			(s: string) => s.replace('"Krate":{"name":"invented-crate"', '"Krate":{"name":"other-crate"'),
		],
		[
			"classification mismatch",
			(s: string) => s.replace('"informational":"unsound"', '"informational":"unmaintained"'),
		],
		["invalid repeat marker", (s: string) => s.replace('"repeat":true', '"repeat":false')],
	] as const)
		it(name, () => refuses(edit("full", "stderr", change)));
	it("refuses records after the summary", () =>
		refuses(edit("full", "stderr", (s) => s + JSON.stringify(diagnostic()) + "\n")));
	it("refuses a smaller full summary than the observed diagnostics", () =>
		refuses(edit("full", "stderr", (s) => s.replace('"errors":1', '"errors":0'))));
	it("requires the advisory-only summary to agree", () =>
		refuses(edit("advisory", "stderr", (s) => s.replace('"errors":1', '"errors":0'))));
	it("requires full and advisory diagnostic graphs to agree", () =>
		refuses(edit("advisory", "stderr", (s) => s.replace('"invented-root"', '"different-root"'))));
	it("refuses an extra finding absent from diagnostics", () => {
		const f = fixture();
		f.audit.warnings.unsound.push({
			...finding(),
			package: { ...finding().package, version: "1.1.0" },
		});
		refuses(input(f));
	});
	it("refuses duplicate audit findings", () => {
		const f = fixture();
		f.audit.warnings.unsound.push(finding());
		refuses(input(f));
	});
	it("refuses duplicate findings even when every diagnostic and counter is duplicated consistently", () => {
		const f = fixture();
		f.fullRows.unshift(diagnostic());
		f.advisoryRows.unshift(diagnostic());
		const fullSummary = f.fullRows.at(-1)?.fields as { advisories: ReturnType<typeof stats> };
		const advisorySummary = f.advisoryRows.at(-1)?.fields as {
			advisories: ReturnType<typeof stats>;
		};
		fullSummary.advisories = stats(2);
		advisorySummary.advisories = stats(2);
		f.audit.warnings.unsound.push(finding());
		refuses(input(f));
	});
	it("refuses CVSS prose consistently copied into both report forms", () => {
		const v = input();
		const change = (b: Uint8Array) =>
			bytes(new TextDecoder().decode(b).replaceAll('"cvss":null', '"cvss":"arbitrary prose"'));
		refuses({
			...v,
			full: { ...v.full, stderr: change(v.full.stderr) },
			advisory: {
				...v.advisory,
				stdout: change(v.advisory.stdout),
				stderr: change(v.advisory.stderr),
			},
		});
	});
	it("refuses a missing audit finding", () => {
		const f = fixture();
		f.audit.warnings.unsound = [];
		refuses(input(f));
	});
	for (const [name, mutate] of [
		[
			"dependency count smaller than findings",
			(f: Fixture) => {
				f.audit.lockfile["dependency-count"] = 0;
			},
		],
		[
			"arbitrary prose version range",
			(f: Fixture) => {
				f.audit.warnings.unsound[0]!.versions.patched = ["arbitrary prose"];
			},
		],
		[
			"arbitrary prose CVSS",
			(f: Fixture) => {
				f.audit.warnings.unsound[0]!.advisory.cvss = "arbitrary prose" as never;
			},
		],
		[
			"ignore list",
			(f: Fixture) => {
				f.audit.settings.ignore = ["RUSTSEC-2026-9999"] as never;
			},
		],
		[
			"severity filter",
			(f: Fixture) => {
				f.audit.settings.severity = "high" as never;
			},
		],
		[
			"platform filter",
			(f: Fixture) => {
				f.audit.settings.target_os = ["linux"] as never;
			},
		],
		[
			"architecture filter",
			(f: Fixture) => {
				f.audit.settings.target_arch = ["x86_64"] as never;
			},
		],
		[
			"missing informational class",
			(f: Fixture) => {
				f.audit.settings.informational_warnings.pop();
			},
		],
		[
			"unknown warning class",
			(f: Fixture) => {
				Object.assign(f.audit.warnings, { future: [] });
			},
		],
		[
			"withdrawn finding",
			(f: Fixture) => {
				f.audit.warnings.unsound[0]!.advisory.withdrawn = "2026-02-01" as never;
			},
		],
		[
			"replacement package",
			(f: Fixture) => {
				f.audit.warnings.unsound[0]!.package.replace = "other" as never;
			},
		],
		[
			"package source",
			(f: Fixture) => {
				f.audit.warnings.unsound[0]!.package.source = "git+https://example.invalid/repo";
			},
		],
		[
			"unknown affected field",
			(f: Fixture) => {
				Object.assign(f.audit.warnings.unsound[0]!.affected, { newField: [] });
			},
		],
		[
			"unknown version field",
			(f: Fixture) => {
				Object.assign(f.audit.warnings.unsound[0]!.versions, { vulnerable: [] });
			},
		],
	] as const)
		it(name, () => {
			const f = fixture();
			mutate(f);
			refuses(input(f));
		});
	for (const exitCode of [null, -1, 16, 1.5, 0, 2, 4])
		it(`refuses inconsistent advisory exit ${exitCode}`, () => {
			const v = input();
			refuses({ ...v, advisory: { ...v.advisory, exitCode } });
		});
	it("refuses signal termination", () => {
		const v = input();
		refuses({ ...v, full: { ...v.full, signal: "SIGTERM" } });
	});
	it("refuses stdout diagnostics in full mode", () => {
		const v = input();
		refuses({ ...v, full: { ...v.full, stdout: bytes("{}\n") } });
	});
	it("refuses additional audit databases", () => refuses(edit("advisory", "stdout", (s) => s + s)));
	it("refuses invalid UTF-8", () => {
		const v = input();
		const b = new Uint8Array(v.full.stderr);
		b[new TextDecoder().decode(b).indexOf("do not return")] = 0xff;
		refuses({ ...v, full: { ...v.full, stderr: b } });
	});
	it("refuses a UTF-8 BOM", () => refuses(edit("full", "stderr", (s) => "\ufeff" + s)));
	it("does not hide a non-JSON blank separator", () =>
		refuses(edit("full", "stderr", (s) => "\u2028\n" + s)));
	it("bounds received bytes using actual typed-array storage", () => {
		const v = input();
		const b = new Uint8Array(32 * 1024 * 1024 + 1);
		b.fill(32);
		Object.defineProperty(b, "byteLength", { value: 0 });
		refuses({ ...v, full: { ...v.full, stdout: b } });
	});
	it("bounds JSONL records", () => {
		const v = input();
		refuses({ ...v, full: { ...v.full, stdout: bytes("\n".repeat(100_001)) } });
	});
	it("rejects accessor input captures", () => {
		const v = input();
		Object.defineProperty(v, "full", {
			get() {
				throw Error("accessor evaluated");
			},
		});
		refuses(v);
	});
	it("exposes a fixed error without echoing input", () => {
		try {
			parseCargoDenyReports(edit("full", "stderr", (s) => s + "private secret prose"));
		} catch (e) {
			expect(e).toBeInstanceOf(InputError);
			expect((e as InputError).code).toBe("INVALID_INPUT");
			expect((e as Error).message).toBe("invalid JSON input");
		}
	});
});
