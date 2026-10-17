// The outbox GritQL rule (plan section 3) on Biome 2.5.15, linted from grit-check/ with its own
// root biome.json: Biome refuses a nested root config given with --config-path from the repo root.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const spikeDir = path.resolve(import.meta.dirname, "..");
const gritDir = path.join(spikeDir, "grit-check");
const RAW = "// raw timer";
const SUPPRESSED = "// suppressed timer";
const { $schema: _, ...config } = JSON.parse(
	readFileSync(path.join(gritDir, "biome.json"), "utf8"),
) as Record<string, unknown>;

// The native binary from this package's @biomejs/biome, started without a shell.
function biomeBinary(): string {
	const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
	const libc = process.platform === "linux" && !report.header?.glibcVersionRuntime ? "-musl" : "";
	const exe = process.platform === "win32" ? ".exe" : "";
	const biome = createRequire(path.join(spikeDir, "package.json")).resolve(
		"@biomejs/biome/package.json",
	);
	return createRequire(biome).resolve(
		`@biomejs/cli-${process.platform}-${process.arch}${libc}/biome${exe}`,
	);
}

interface Diagnostic {
	readonly category: string;
	readonly message: string;
	readonly location: { readonly path: string; readonly start: { readonly line: number } };
}

// The lines with a plugin diagnostic, as file:line, from Biome's JSON reporter.
function lint(cwd: string): { readonly status: number | null; readonly hits: string[] } {
	const args = ["lint", "--reporter=json", "--max-diagnostics=none", "--colors=off", "fixtures"];
	const result = spawnSync(biomeBinary(), args, { cwd, encoding: "utf8", windowsHide: true });
	const { diagnostics } = JSON.parse(result.stdout) as { diagnostics: Diagnostic[] };
	const hits = diagnostics
		.filter(({ category }) => category === "plugin")
		.map(({ location }) => `${location.path.replaceAll("\\", "/")}:${location.start.line}`);
	return { status: result.status, hits: [...new Set(hits)].toSorted() };
}

// fixtures/<dir>/<file>:<line> for each line holding `needle`.
function linesWith(needle: string, dir = "fixtures"): string[] {
	return readdirSync(path.join(gritDir, dir), { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".ts"))
		.flatMap((file) =>
			readFileSync(path.join(gritDir, dir, file), "utf8")
				.split("\n")
				.flatMap((line, index) =>
					line.includes(needle) ? [`${dir}/${file.replaceAll("\\", "/")}:${index + 1}`] : [],
				),
		)
		.toSorted();
}

// The rule and fixtures in a temporary folder whose root biome.json is `rootConfig`.
function inCopy<T>(rootConfig: Record<string, unknown>, run: (dir: string) => T): T {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-grit-"));
	try {
		cpSync(path.join(gritDir, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
		cpSync(path.join(gritDir, "no-raw-timers.grit"), path.join(dir, "no-raw-timers.grit"));
		writeFileSync(path.join(dir, "biome.json"), JSON.stringify(rootConfig));
		return run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

it("flags every raw timer form in outbox code, and nothing outside it or in the sanctioned clock", () => {
	const { status, hits } = lint(gritDir);
	expect(hits).toEqual(linesWith(RAW));
	expect(hits).toHaveLength(26);
	expect(status).toBe(1);
});

// Line, block and doc comments, ranges and file-level -all forms all silence it, so the check M2a
// adds must refuse the token biome-ignore itself, in any comment.
it("is silenced by every form of biome-ignore comment, so outbox code must refuse that token", () => {
	expect(linesWith(SUPPRESSED, "fixtures/outbox")).toHaveLength(7);
	const unsuppressed = inCopy(config, (dir) => {
		const outbox = path.join(dir, "fixtures", "outbox");
		for (const file of readdirSync(outbox)) {
			const source = readFileSync(path.join(outbox, file), "utf8");
			writeFileSync(path.join(outbox, file), source.replaceAll("biome-ignore", "a note"));
		}
		return lint(dir).hits;
	});
	expect(unsuppressed).toEqual([...linesWith(RAW), ...linesWith(SUPPRESSED)].toSorted());
});

// Scoping: overrides[].includes is relative to the config, but a plugin entry's own includes is
// matched against the absolute path, so "fixtures/outbox/**" there silently matches nothing.
it("scopes through overrides; a plugin entry's includes needs a leading **/", () => {
	const { overrides: __, ...rest } = config;
	const scoped = (includes: string) => {
		const plugins = [{ path: "./no-raw-timers.grit", includes: [includes] }];
		return inCopy({ ...rest, plugins }, (dir) => lint(dir).hits);
	};
	expect(scoped("fixtures/outbox/**")).toEqual([]);
	expect(scoped("**/fixtures/outbox/**")).toEqual(linesWith(RAW));
});
