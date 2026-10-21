import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../../..");
const rulePath = "security/no-outbox-timers.grit";
const outboxGlob = "apps/hub/src/outbox/**";
const MAX_BYTES = 512 * 1024;
const MESSAGE =
	"Raw timer in outbox code: wait with clock.after(ms), which refuses anything over 15 s.";
const RAW = "// raw timer";
const SUPPRESSED = "// suppressed timer";

interface Hit {
	readonly file: string;
	readonly line: number;
}
interface LintResult {
	readonly status: number;
	readonly hits: readonly Hit[];
}
type Files = Readonly<Record<string, string>>;
type Scope = "production" | "relative-plugin" | "absolute-plugin";

function refuse(): never {
	throw new Error("Timer-rule control refused");
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
	return value as Record<string, unknown>;
}

function text(filename: string): string {
	const info = lstatSync(filename);
	if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) return refuse();
	const bytes = readFileSync(filename);
	if (bytes.length !== info.size) return refuse();
	return bytes.toString("utf8");
}

function fixture(name: string): string {
	return text(path.join(import.meta.dirname, "timer-rule-fixtures", `${name}.txt`));
}

function productionConfig(scope: Scope): Record<string, unknown> {
	const config = object(JSON.parse(text(path.join(root, "biome.json"))));
	const overrides = config.overrides;
	if (!Array.isArray(overrides)) return refuse();
	const target = overrides.filter((entry: unknown) => {
		const plugins = object(entry).plugins;
		return Array.isArray(plugins) && plugins.includes(`./${rulePath}`);
	});
	expect(target).toHaveLength(1);
	expect(object(target[0]).includes).toEqual([outboxGlob]);
	expect(object(target[0]).plugins).toEqual([`./${rulePath}`]);
	// Only the editor's schema URL is omitted. All actual runtime settings, including
	// recommended rules, file exclusions and VCS policy, remain the production ones.
	delete config.$schema;
	if (scope !== "production") {
		config.overrides = overrides.filter((entry: unknown) => entry !== target[0]);
		const plugins = config.plugins ?? [];
		if (!Array.isArray(plugins)) return refuse();
		config.plugins = [
			...plugins,
			{
				path: `./${rulePath}`,
				includes: [scope === "relative-plugin" ? outboxGlob : `**/${outboxGlob}`],
			},
		];
	}
	return config;
}

function biomeBinary(): string {
	const require = createRequire(path.join(root, "package.json"));
	const metadata = require.resolve("@biomejs/biome/package.json");
	const { name, version } = object(JSON.parse(text(metadata)));
	expect({ name, version }).toEqual({ name: "@biomejs/biome", version: "2.5.15" });
	const { header } = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
	const libc = process.platform === "linux" && !header?.glibcVersionRuntime ? "-musl" : "";
	const extension = process.platform === "win32" ? ".exe" : "";
	return createRequire(metadata).resolve(
		`@biomejs/cli-${process.platform}-${process.arch}${libc}/biome${extension}`,
	);
}

function diagnosticFile(directory: string, value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return refuse();
	const relative = path.isAbsolute(value) ? path.relative(directory, value) : value;
	const normalized = relative.replaceAll("\\", "/").replace(/^\.\//, "");
	if (
		path.isAbsolute(relative) ||
		normalized.split("/").some((part) => part === ".." || part === "") ||
		!normalized.startsWith("apps/hub/src/")
	)
		return refuse();
	return normalized;
}

function admit(
	directory: string,
	status: number | null,
	signal: string | null,
	error: unknown,
	stdout: string,
	stderr: string,
): LintResult {
	if (
		error ||
		signal ||
		(status !== 0 && status !== 1) ||
		Buffer.byteLength(stdout) > MAX_BYTES ||
		Buffer.byteLength(stderr) > MAX_BYTES
	)
		return refuse();
	const report = object(JSON.parse(stdout));
	if (!Array.isArray(report.diagnostics) || report.diagnostics.length > 256) return refuse();
	const hits: Hit[] = [];
	for (const value of report.diagnostics) {
		const diagnostic = object(value);
		if (diagnostic.category !== "plugin") {
			// Parser/configuration errors or unrelated lint errors cannot supply exit1.
			if (
				typeof diagnostic.category !== "string" ||
				!diagnostic.category.startsWith("lint/") ||
				(diagnostic.severity !== "warning" && diagnostic.severity !== "info")
			)
				return refuse();
			continue;
		}
		if (diagnostic.severity !== "error" || diagnostic.message !== MESSAGE) return refuse();
		const location = object(diagnostic.location);
		const line = object(location.start).line;
		if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) return refuse();
		hits.push({ file: diagnosticFile(directory, location.path), line });
	}
	if (status !== (hits.length > 0 ? 1 : 0)) return refuse();
	return { status, hits };
}

function lint(files: Files, scope: Scope = "production"): LintResult {
	const parent = realpathSync(os.tmpdir());
	const directory = realpathSync(mkdtempSync(path.join(parent, "draftyak-timer-rule-")));
	const identity = lstatSync(directory, { bigint: true });
	try {
		const config = productionConfig(scope);
		// A tiny owned Git root preserves production VCS settings without touching a
		// checkout or invoking Git. Fixture TypeScript is only ever parsed by Biome.
		mkdirSync(path.join(directory, ".git/objects"), { recursive: true });
		mkdirSync(path.join(directory, ".git/refs/heads"), { recursive: true });
		writeFileSync(path.join(directory, ".git/HEAD"), "ref: refs/heads/fixture\n");
		writeFileSync(
			path.join(directory, ".git/config"),
			"[core]\nrepositoryformatversion=0\nbare=false\n",
		);
		// Biome treats an empty ignore file as absent. A comment keeps VCS enabled
		// while ignoring no fixture path.
		writeFileSync(path.join(directory, ".gitignore"), "# Fixture: no paths ignored.\n");
		writeFileSync(path.join(directory, "biome.json"), JSON.stringify(config));
		mkdirSync(path.join(directory, "security"));
		writeFileSync(path.join(directory, rulePath), text(path.join(root, rulePath)));
		if (Object.keys(files).length > 8) return refuse();
		for (const [filename, source] of Object.entries(files)) {
			if (
				!/^apps\/hub\/src\/[a-z0-9/_-]+\.tsx?$/.test(filename) ||
				filename.split("/").includes("..") ||
				Buffer.byteLength(source) > 64 * 1024
			)
				return refuse();
			const target = path.join(directory, filename);
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, source);
		}
		const result = spawnSync(
			biomeBinary(),
			["lint", "--reporter=json", "--max-diagnostics=none", "--colors=off", "apps"],
			{
				cwd: directory,
				encoding: "utf8",
				windowsHide: true,
				shell: false,
				timeout: 10_000,
				maxBuffer: MAX_BYTES,
				killSignal: "SIGKILL",
			},
		);
		const resultData = admit(
			directory,
			result.status,
			result.signal,
			result.error,
			result.stdout,
			result.stderr,
		);
		for (const hit of resultData.hits) if (!(hit.file in files)) return refuse();
		return resultData;
	} finally {
		const current = lstatSync(directory, { bigint: true });
		const relative = path.relative(parent, directory);
		if (
			!relative.startsWith("draftyak-timer-rule-") ||
			relative.includes(path.sep) ||
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			realpathSync(directory) !== directory ||
			current.dev !== identity.dev ||
			current.ino !== identity.ino
		)
			refuse();
		rmSync(directory, { recursive: true, force: false });
		expect(existsSync(directory)).toBe(false);
	}
}

function lines(files: Files, marker: string): string[] {
	return Object.entries(files)
		.flatMap(([file, source]) =>
			source
				.split("\n")
				.flatMap((line, index) => (line.includes(marker) ? [`${file}:${index + 1}`] : [])),
		)
		.sort();
}

function hitLines(result: LintResult): string[] {
	return [...new Set(result.hits.map((hit) => `${hit.file}:${hit.line}`))].sort();
}

function keptFiles(unsuppress = false): Files {
	const suppression = (name: string): string => {
		// The kept data stays exact. Only the diagnostic rule-name suffix changes
		// in the temporary copy to match the production rule's renamed file.
		const source = fixture(name).replaceAll(
			"lint/plugin/no-raw-timers",
			"lint/plugin/no-outbox-timers",
		);
		return unsuppress ? source.replaceAll("biome-ignore", "an inert note") : source;
	};
	return {
		"apps/hub/src/outbox/nested/raw-timers.ts": fixture("raw-timers"),
		"apps/hub/src/outbox/suppressed.ts": suppression("suppressed"),
		"apps/hub/src/outbox/suppressed-all.ts": suppression("suppressed-all"),
		"apps/hub/src/outbox/clock.ts": fixture("clock"),
		"apps/hub/src/other/poller.ts": fixture("poller"),
	};
}

it("reports all26 kept raw forms as real errors through the production root scope", {
	timeout: 45_000,
}, () => {
	const files = keptFiles();
	expect(lines(files, RAW)).toHaveLength(26);
	expect(lines(files, SUPPRESSED)).toHaveLength(7);
	const result = lint(files);
	expect(result.status).toBe(1);
	expect(hitLines(result)).toEqual(lines(files, RAW));
});

it("witnesses every kept native suppression form and flags all seven when unsuppressed", {
	timeout: 45_000,
}, () => {
	const files = keptFiles(true);
	const result = lint(files);
	expect(result.status).toBe(1);
	expect(hitLines(result)).toEqual([...lines(files, RAW), ...lines(files, SUPPRESSED)].sort());
	expect(hitLines(result)).toHaveLength(33);
});

it("allows the sanctioned shape, near matches, non-timer module/process APIs and outside timers", {
	timeout: 45_000,
}, () => {
	const allowed = [
		'import * as moduleApi from "node:module";',
		'import processApi from "node:process";',
		"export { moduleApi, processApi };",
		'export const names = ["module", "node:module", "process", "node:process", "timers-extra", "node:timers/extra", "setTimeoutLike", `setIntervalLike`];',
		"export async function wait(clock: { after(ms: number, signal: AbortSignal): Promise<void> }, signal: AbortSignal) { await clock.after(15000, signal); }",
	].join("\n");
	const outside = "export function poll() { return setTimeout(() => Date.now(), 1); }\n";
	const result = lint({
		"apps/hub/src/outbox/allowed.ts": allowed,
		"apps/hub/src/kernel/clock.ts": outside,
		"apps/hub/src/outbox-other/poller.ts": outside,
	});
	expect(result).toEqual({ status: 0, hits: [] });
});

it("lints outbox folders whose names the root excludes elsewhere", { timeout: 45_000 }, () => {
	const raw = `export const t = setTimeout(() => undefined, 1); ${RAW}\n`;
	const files = {
		"apps/hub/src/outbox/vendor/a.ts": raw,
		"apps/hub/src/outbox/fixtures/a.ts": raw,
		"apps/hub/src/outbox/evidence/a.ts": raw,
		"apps/hub/src/outbox/nested/vendor/a.ts": raw,
	};
	const result = lint(files);
	expect(result.status).toBe(1);
	expect(hitLines(result)).toEqual(lines(files, RAW));
});

it("flags each banned name used as a string or plain template key", { timeout: 45_000 }, () => {
	const files = {
		"apps/hub/src/outbox/keys.ts": [
			`export const a = (h: Record<string, unknown>) => h["setInterval"]; ${RAW}`,
			`export const b = (h: Record<string, unknown>) => h[\`setInterval\`]; ${RAW}`,
			`export const c = (p: Record<string, unknown>) => p["getBuiltinModule"]; ${RAW}`,
			`export const d = (p: Record<string, unknown>) => p[\`getBuiltinModule\`]; ${RAW}`,
			`export const e = (m: Record<string, unknown>) => m["createRequire"]; ${RAW}`,
			`export const f = (m: Record<string, unknown>) => m[\`createRequire\`]; ${RAW}`,
			"",
		].join("\n"),
	};
	const result = lint(files);
	expect(result.status).toBe(1);
	expect(hitLines(result)).toEqual(lines(files, RAW));
	expect(hitLines(result)).toHaveLength(6);
});

it("has no nested Biome configuration on the path to the outbox", () => {
	for (const directory of ["apps", "apps/hub", "apps/hub/src"]) {
		const names = readdirSync(path.join(root, directory)).map((name) => name.toLowerCase());
		expect(names.filter((name) => /^biome\.jsonc?$/.test(name))).toEqual([]);
	}
});

it("exposes the absolute-path plugin-includes trap instead of accepting a silent scope loss", {
	timeout: 45_000,
}, () => {
	const files = { "apps/hub/src/outbox/nested/raw-timers.ts": fixture("raw-timers") };
	expect(lint(files, "relative-plugin")).toEqual({ status: 0, hits: [] });
	const absolute = lint(files, "absolute-plugin");
	expect(absolute.status).toBe(1);
	expect(hitLines(absolute)).toEqual(lines(files, RAW));
});

it("refuses launcher, output, severity, parser and unrelated-error false witnesses", () => {
	const diagnostic = {
		category: "plugin",
		severity: "error",
		message: MESSAGE,
		location: { path: "apps/hub/src/outbox/a.ts", start: { line: 1 } },
	};
	const report = JSON.stringify({ diagnostics: [diagnostic] });
	const here = path.resolve(os.tmpdir(), "draftyak-timer-rule-control");
	for (const [status, signal, error, stdout, stderr] of [
		[null, null, new Error("synthetic spawn failure"), report, ""],
		[null, "SIGTERM", undefined, report, ""],
		[2, null, undefined, report, ""],
		[1, null, undefined, "not JSON", ""],
		[1, null, undefined, report, "x".repeat(MAX_BYTES + 1)],
		[
			1,
			null,
			undefined,
			JSON.stringify({ diagnostics: [{ ...diagnostic, severity: "information" }] }),
			"",
		],
		// Each non-plugin error rides with a valid plugin hit, so only the non-plugin guard refuses it.
		[
			1,
			null,
			undefined,
			JSON.stringify({ diagnostics: [diagnostic, { ...diagnostic, category: "parse" }] }),
			"",
		],
		[
			1,
			null,
			undefined,
			JSON.stringify({
				diagnostics: [diagnostic, { ...diagnostic, category: "lint/correctness/example" }],
			}),
			"",
		],
		[
			1,
			null,
			undefined,
			JSON.stringify({
				diagnostics: [{ ...diagnostic, location: { path: "../a.ts", start: { line: 1 } } }],
			}),
			"",
		],
		[1, null, undefined, JSON.stringify({ diagnostics: [] }), ""],
	] as const)
		expect(() => admit(here, status, signal, error, stdout, stderr)).toThrow();
});
