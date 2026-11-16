import { rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { rules } from "../rules/index.ts";
import { find, glue, lines, type PatternRule } from "../src/rules.ts";
import {
	ALLOW_FILE,
	type AllowEntry,
	type Finding,
	fileHits,
	listFiles,
	loadAllow,
	MAX_BYTES,
	scanFiles,
	sha256,
} from "../src/scan.ts";
import { CAPS, unpack } from "../src/unpack.ts";
import { afterData, noise, pdf, repeated, tar, zip } from "./archives.ts";
import { removeTemp, sample, tempDir, tempRepo, write } from "./helpers.ts";

afterAll(removeTemp);

const login = sample("anthropic-login");
const backend = sample("openai-backend");
const secret = sample("secret-anthropic");
// Folder names that rules flag in any path.
const claudeDir = glue(".cl", "aude");
const codexDir = glue(".co", "dex");

function scan(dir: string, allow: readonly AllowEntry[] = loadAllow(dir)): Finding[] {
	return scanFiles(dir, listFiles(dir), allow).findings;
}

const where = (findings: readonly Finding[]): string[] =>
	findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule}`);

// As where(), with what a finding's reason adds to its rule's: the reading it was found in.
const reasons = new Map(rules.map((rule) => [rule.id, rule.reason]));
const within = (findings: readonly Finding[]): string[] =>
	findings.map(({ file, line, rule, reason }) => {
		const added = reason.slice(reasons.get(rule)?.length ?? reason.length);
		return `${file}:${line} ${rule}${added.replace(/^ \((.+)\)$/, " $1")}`;
	});

// The value a rule's first positive case quotes, as in `const key = "<value>";`.
function quoted(id: string): string {
	const line = sample(id);
	return line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));
}

const utf16 = (text: string, order: "le" | "be", bom: boolean): Buffer => {
	const units = Buffer.from(text, "utf16le");
	const body = order === "be" ? units.swap16() : units;
	return bom
		? Buffer.concat([Buffer.from(order === "le" ? [0xff, 0xfe] : [0xfe, 0xff]), body])
		: body;
};
// A PNG signature and header: NUL bytes and bytes that aren't UTF-8.
const binary = (text: string): Buffer =>
	Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0xd]),
		Buffer.from(text),
	]);

describe("the walk", () => {
	it("covers tracked and untracked files, skipping ignored ones", () => {
		const repo = tempRepo();
		repo.write(".gitignore", "ignored/\n");
		repo.write("src/tracked.ts", login);
		repo.commit("chore: start");
		repo.write("src/new.ts", login);
		repo.write("ignored/old.ts", login);
		expect(where(scan(repo.dir))).toEqual([
			"src/new.ts:1 anthropic-login",
			"src/tracked.ts:1 anthropic-login",
		]);
	});

	it("reads UTF-8, UTF-16, text with NUL bytes and binaries", () => {
		const repo = tempRepo();
		const text = `ok\n${secret}\n`;
		repo.write("notes/le.txt", utf16(text, "le", true));
		repo.write("notes/be.txt", utf16(text, "be", true));
		repo.write("notes/bare.txt", utf16(text, "le", false));
		// No NUL byte in the first 8000: only the BOM says it is UTF-16.
		repo.write("notes/cjk.txt", utf16(`${"\u4e2d".repeat(4000)}\n${secret}\n`, "le", true));
		repo.write(
			"notes/bom.txt",
			Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
		);
		repo.write("src/nul.ts", `// \0\n${secret}\n`);
		repo.write("blob.bin", binary(text));
		const { findings, files } = scanFiles(repo.dir, listFiles(repo.dir));
		expect(where(findings)).toEqual([
			"blob.bin:5 secret-anthropic",
			"notes/bare.txt:2 secret-anthropic",
			"notes/be.txt:2 secret-anthropic",
			"notes/bom.txt:2 secret-anthropic",
			"notes/cjk.txt:2 secret-anthropic",
			"notes/le.txt:2 secret-anthropic",
			"src/nul.ts:2 secret-anthropic",
		]);
		expect(files).toBe(7);
	});

	it("checks every file's path, which allow.json can't excuse, and reports a file too large to read", () => {
		const repo = tempRepo();
		repo.write(`fixtures/${claudeDir}/settings.json`, "{}\n");
		repo.write(`${codexDir}/blob.bin`, binary(""));
		repo.write(`docs/${claudeDir}.md`, "# Notes\n");
		repo.write("big.bin", Buffer.concat([binary(""), Buffer.alloc(MAX_BYTES)]));
		repo.write("big.log", Buffer.alloc(MAX_BYTES, "a"));
		const found = scan(repo.dir);
		expect(where(found)).toEqual([
			`${codexDir}/blob.bin:0 openai-codex-auth`,
			"big.bin:1 too-large",
			`docs/${claudeDir}.md:0 anthropic-config`,
			`fixtures/${claudeDir}/settings.json:0 anthropic-config`,
		]);
		expect(found[3]).toMatchObject({
			column: 10,
			reason: expect.stringMatching(/\(in the file's path\)$/),
		});
		expect(found.map((finding) => finding.lineSha256)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	it("skips a listed file that is gone, and names any other file it can't read", () => {
		const repo = tempRepo();
		repo.write("src/gone.ts", login);
		repo.commit("chore: start");
		rmSync(path.join(repo.dir, "src", "gone.ts"));
		expect(listFiles(repo.dir)).toEqual(["src/gone.ts"]);
		expect(scanFiles(repo.dir, ["src/gone.ts"])).toEqual({ findings: [], files: 0 });
		expect(() => scanFiles(repo.dir, ["src/a\0b.ts"])).toThrow(/^src\/a\0b\.ts: /);
	});

	it("applies only the secret and attribution rules in tools/vendor-guard/rules/", () => {
		const repo = tempRepo();
		const text = `${login}\n${secret}\n${sample("attribution")}\n`;
		for (const file of [
			"rules/x.ts",
			"rules/notes.txt",
			"src/x.ts",
			"test/x.test.ts",
			"rules.ts",
		]) {
			repo.write(`tools/vendor-guard/${file}`, text);
		}
		expect(where(scan(repo.dir))).toEqual([
			"tools/vendor-guard/rules.ts:1 anthropic-login",
			"tools/vendor-guard/rules.ts:2 secret-anthropic",
			"tools/vendor-guard/rules.ts:5 attribution",
			"tools/vendor-guard/rules/notes.txt:2 secret-anthropic",
			"tools/vendor-guard/rules/notes.txt:5 attribution",
			"tools/vendor-guard/rules/x.ts:2 secret-anthropic",
			"tools/vendor-guard/rules/x.ts:5 attribution",
			"tools/vendor-guard/src/x.ts:1 anthropic-login",
			"tools/vendor-guard/src/x.ts:2 secret-anthropic",
			"tools/vendor-guard/src/x.ts:5 attribution",
			"tools/vendor-guard/test/x.test.ts:1 anthropic-login",
			"tools/vendor-guard/test/x.test.ts:2 secret-anthropic",
			"tools/vendor-guard/test/x.test.ts:5 attribution",
		]);
	});

	it("reads a symlink's target path, never the file it points to", (ctx) => {
		const repo = tempRepo();
		const outside = tempDir();
		write(outside, `${claudeDir}/leak.ts`, `${secret}\n`);
		try {
			symlinkSync(path.join(outside, claudeDir, "leak.ts"), path.join(repo.dir, "link.ts"));
		} catch {
			ctx.skip("no symlink privilege");
		}
		expect(where(scan(repo.dir))).toEqual(["link.ts:1 anthropic-config"]);
	});

	it("reports the line and column, never the matched text", () => {
		const repo = tempRepo();
		repo.write("src/a.ts", `// ok\r\n  ${secret}\r\n`);
		const [finding, ...rest] = scan(repo.dir);
		expect(rest).toEqual([]);
		expect(finding).toEqual({
			file: "src/a.ts",
			line: 2,
			column: 2 + secret.indexOf("sk-") + 1,
			rule: "secret-anthropic",
			reason: expect.any(String),
		});
		expect(JSON.stringify(finding)).not.toContain(secret.slice(secret.indexOf("sk-")));
	});

	it("ends a line at a lone CR, as pr-meta does", () => {
		const repo = tempRepo();
		repo.write("README.md", sample("attribution", "bad", 3));
		expect(where(scan(repo.dir))).toEqual(["README.md:4 attribution"]);
	});

	it("checks identifiers whatever their case, and in a package.json with a BOM", () => {
		const repo = tempRepo();
		repo.write("apps/app/src-tauri/tauri.conf.json", '{ "productName": "DraftYak for Claude" }\n');
		repo.write("apps/cli/package.json", '\uFEFF{ "name": "@draftyak/gpt-cli" }\n');
		expect(where(scan(repo.dir))).toEqual([
			"apps/app/src-tauri/tauri.conf.json:1 vendor-mark",
			"apps/cli/package.json:1 vendor-mark",
		]);
	});
});

describe("prose *.md files", () => {
	const line = `- The hub never calls ${backend}`;

	it("pass a vendor match only through an allow.json entry whose line hash matches", () => {
		const repo = tempRepo();
		repo.write("docs/notes.md", `# Notes\r\n\r\n${line}\r\n`);
		const hash = sha256(line);
		expect(scan(repo.dir)).toEqual([
			expect.objectContaining({
				file: "docs/notes.md",
				line: 3,
				rule: "openai-backend",
				lineSha256: hash,
			}),
		]);

		const entry = {
			path: "docs/notes.md",
			rule: "openai-backend",
			sha256: hash,
			reason: "quotes the rule",
		};
		repo.write(ALLOW_FILE, `\uFEFF${JSON.stringify([entry], null, 2)}\n`);
		expect(scan(repo.dir)).toEqual([]);

		repo.write("docs/notes.md", `# Notes\n\n${line}.\n`);
		expect(where(scan(repo.dir))).toEqual([
			"docs/notes.md:3 openai-backend",
			`${ALLOW_FILE}:5 allow-json`,
		]);
	});

	it("never pass a vendor match that only a decompressed or UTF-16 reading shows", () => {
		const repo = tempRepo();
		repo.write("docs/packed.md", gzipSync(`# Notes\n\n${line}\n`));
		// Too few NUL bytes to tell: read as UTF-8, and as UTF-16LE too.
		repo.write("docs/wide.md", utf16(`${"\u4e2d".repeat(5000)}\n${line}\n`, "le", false));
		const entries = ["docs/packed.md", "docs/wide.md"].map((file) => ({
			path: file,
			rule: "openai-backend",
			sha256: sha256(line),
			reason: "why",
		}));
		repo.write(ALLOW_FILE, JSON.stringify(entries));
		const found = scan(repo.dir);
		expect(within(found)).toEqual([
			"docs/packed.md:3 openai-backend in the gzip stream",
			"docs/wide.md:2 openai-backend read as UTF-16LE",
			`${ALLOW_FILE}:1 allow-json`,
			`${ALLOW_FILE}:1 allow-json`,
		]);
		expect(found.map((finding) => finding.lineSha256)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	it("still fail secret and attribution rules, which allow.json can't name, even on an allowed line", () => {
		const repo = tempRepo();
		const allowed = `- ${backend} and ${secret}`;
		repo.write("docs/notes.md", `${secret}\n\n${sample("attribution")}\n\n${allowed}\n`);
		const entry = {
			path: "docs/notes.md",
			rule: "openai-backend",
			sha256: sha256(allowed),
			reason: "why",
		};
		repo.write(ALLOW_FILE, JSON.stringify([entry]));
		const found = scan(repo.dir);
		expect(where(found)).toEqual([
			"docs/notes.md:1 secret-anthropic",
			"docs/notes.md:5 attribution",
			"docs/notes.md:7 secret-anthropic",
		]);
		expect(found.map((finding) => finding.lineSha256)).toEqual([undefined, undefined, undefined]);
	});

	it("are the only files allow.json covers, and it holds only well-formed, reviewed entries", () => {
		const repo = tempRepo();
		const entry = {
			path: "docs/a.md",
			rule: "openai-backend",
			sha256: sha256(line),
			reason: "why",
		};
		const refused: [unknown, string][] = [
			[{ ...entry, path: "src/a.ts" }, "*.md file"],
			[{ ...entry, path: "docs\\a.md" }, "forward slashes"],
			[{ ...entry, rule: "secret-anthropic" }, "vendor rules"],
			[{ ...entry, rule: "attribution" }, "vendor rules"],
			[{ ...entry, sha256: sha256(line).toUpperCase() }, "lower-case hex"],
			[{ ...entry, reason: " " }, "why it may stay"],
			[{ ...entry, extra: true }, "exactly path, rule, sha256 and reason"],
			["docs/a.md", "not an object"],
		];
		for (const [value, problem] of refused) {
			repo.write(ALLOW_FILE, JSON.stringify([value]));
			expect(() => loadAllow(repo.dir), problem).toThrow(problem);
		}
		repo.write(ALLOW_FILE, JSON.stringify([entry, entry]));
		expect(() => loadAllow(repo.dir)).toThrow("entry 2 repeats an earlier one");
		repo.write(ALLOW_FILE, JSON.stringify({ entries: [entry] }));
		expect(() => loadAllow(repo.dir)).toThrow("must be a JSON array");
		repo.write(ALLOW_FILE, "[");
		expect(() => loadAllow(repo.dir)).toThrow(ALLOW_FILE);
	});
});

describe("data-only paths", () => {
	it("skip vendor rules for recorded documents, but not secret rules or the same text elsewhere", () => {
		const repo = tempRepo();
		const recorded = `${JSON.stringify({ client_id: login, jwks_uri: backend }, null, 2)}\n`;
		repo.write("spikes/s04-oauth-as/fixtures/cimd/client.json", recorded);
		repo.write("spikes/s07-siwc/notes/sources.md", `- ${login}\n- ${backend}\n`);
		repo.write("spikes/s04-oauth-as/fixtures/cimd/leak.json", `${secret}\n`);
		repo.write("spikes/s04-oauth-as/src/cimd.ts", recorded);
		repo.write("spikes/s07-siwc/src/sources.ts", `${login}\n${backend}\n`);
		repo.write("spikes/s07-siwc/notes/other.md", `${login}\n`);
		repo.write("spikes/s07-siwc/notes/sources.md.bak", `${login}\n`);
		repo.write("src/cimd.json", recorded);
		expect(where(scan(repo.dir))).toEqual([
			"spikes/s04-oauth-as/fixtures/cimd/leak.json:1 secret-anthropic",
			"spikes/s04-oauth-as/src/cimd.ts:2 anthropic-login",
			"spikes/s04-oauth-as/src/cimd.ts:3 openai-backend",
			"spikes/s07-siwc/notes/other.md:1 anthropic-login",
			"spikes/s07-siwc/notes/sources.md.bak:1 anthropic-login",
			"spikes/s07-siwc/src/sources.ts:1 anthropic-login",
			"spikes/s07-siwc/src/sources.ts:2 openai-backend",
			"src/cimd.json:2 anthropic-login",
			"src/cimd.json:3 openai-backend",
		]);
	});
});

describe("evidence", () => {
	const email = sample("evidence-email");
	const address = JSON.parse(email).data.value;

	it("checks JSON strings and keys at their lines, and refuses anything else in evidence/", () => {
		const repo = tempRepo();
		const document = JSON.stringify(
			{ a: [1, "content-type", { nested: address }], [address]: 2 },
			null,
			2,
		);
		repo.write("spikes/s01-sqlite3mc/evidence/run.json", document);
		repo.write("spikes/s01-sqlite3mc/fixtures/run.json", document);
		repo.write("spikes/s01-sqlite3mc/evidence/raw.log", "ok\n");
		repo.write("spikes/s01-sqlite3mc/evidence/cut.json", document.slice(0, -2));
		repo.write("spikes/s01-sqlite3mc/evidence/shot.png", binary(""));
		repo.write("spikes/s01-sqlite3mc/evidence/wide.json", utf16(document, "le", true));
		repo.write(
			"spikes/s01-sqlite3mc/evidence/latin1.json",
			Buffer.from('{ "a": "caf\xe9" }', "latin1"),
		);
		repo.write("spikes/s01-sqlite3mc/evidence/.gitkeep", "");
		repo.write("spikes/s05-desktop/rust/evidence/run.json", document);
		repo.write("spikes/s05-desktop/rust/src/evidence/mod.rs", "pub mod run;\n");
		expect(where(scan(repo.dir))).toEqual([
			"spikes/s01-sqlite3mc/evidence/cut.json:1 evidence-json",
			"spikes/s01-sqlite3mc/evidence/latin1.json:1 evidence-json",
			"spikes/s01-sqlite3mc/evidence/raw.log:1 evidence-json",
			"spikes/s01-sqlite3mc/evidence/run.json:6 evidence-email",
			"spikes/s01-sqlite3mc/evidence/run.json:9 evidence-email",
			"spikes/s01-sqlite3mc/evidence/shot.png:1 evidence-json",
			"spikes/s01-sqlite3mc/evidence/wide.json:1 evidence-json",
			"spikes/s05-desktop/rust/evidence/run.json:6 evidence-email",
			"spikes/s05-desktop/rust/evidence/run.json:9 evidence-email",
		]);
	});

	it("passes what writeEvidence writes", () => {
		const repo = tempRepo();
		repo.write("spikes/kit/evidence/env.json", sample("evidence-json", "good"));
		expect(scan(repo.dir)).toEqual([]);
	});

	it("counts a lone CR as a line break in evidence JSON", () => {
		const repo = tempRepo();
		repo.write(
			"spikes/s01-sqlite3mc/evidence/run.json",
			`{\r"value":\r${JSON.stringify(address)}\r}`,
		);
		expect(where(scan(repo.dir))).toEqual([
			"spikes/s01-sqlite3mc/evidence/run.json:3 evidence-email",
		]);
	});
});

describe("string escapes", () => {
	// Each escape the decoder reads, then a \n escaped twice, three and four times, as in JSON inside
	// a JSON string: the decoder reads four levels deep.
	const escapes = [
		...["\\n", "\\t", "\\r", "\\b", "\\f", "\\v", "\\0", "\\a", "\\e", "\\N", "\\_", "\\L", "\\P"],
		...["\\012", "\\11", "\\x0a", "\\x{a}", "\\u0020", "\\u00e9", "\\u{a}", "\\U0000000a"],
		...[2, 4, 8].map((count) => `${"\\".repeat(count)}n`),
	];
	// The same file in each format, holding each value in a double-quoted string on lines 2 onward.
	const yaml = (values: readonly string[]): string =>
		`run:\n${values.map((value, i) => `  log${i}: "${value}"`).join("\n")}\n`;
	const formats: Readonly<Record<string, (values: readonly string[]) => string>> = {
		json: (values) => `{\n${values.map((value, i) => `  "log${i}": "${value}"`).join(",\n")}\n}\n`,
		yaml,
		toml: (values) => `[run]\n${values.map((value, i) => `log${i} = "${value}"`).join("\n")}\n`,
	};
	const ofKind = (kind: PatternRule["kind"]): PatternRule[] =>
		rules.filter((rule): rule is PatternRule => rule.kind === kind);
	const at = (findings: readonly Finding[]): string[] =>
		findings.map(({ file, line, column, rule }) => `${file}:${line}:${column} ${rule}`).sort();

	it("hide no secret right after an escape, or that starts with one, even escaped four times", () => {
		const repo = tempRepo();
		const expected: string[] = [];
		for (const rule of ofKind("secret")) {
			const token = quoted(rule.id);
			const code = token.codePointAt(0) ?? 0;
			const hex = code.toString(16);
			const unicode = `\\u${hex.padStart(4, "0")}`;
			const firsts = [
				unicode,
				`\\u{${hex}}`,
				`\\U${hex.padStart(8, "0")}`,
				`\\x${hex.padStart(2, "0")}`,
				`\\x{${hex}}`,
				`\\${code.toString(8).padStart(3, "0")}`,
			];
			// Each value, and where its finding points when the line as written doesn't show the token.
			const values: [string, string][] = [
				...escapes.map((sequence): [string, string] => [`ok${sequence}${token}`, token]),
				...firsts.map((first): [string, string] => [`ok ${first}${token.slice(1)}`, first]),
				[`ok \\${unicode}${token.slice(1)}`, `\\${unicode}`],
			];
			for (const [extension, format] of Object.entries(formats)) {
				const file = `fixtures/${rule.id}.${extension}`;
				const text = format(values.map(([value]) => value));
				repo.write(file, text);
				for (const [index, [, start]] of values.entries()) {
					const line = lines(text)[index + 1] ?? "";
					const column = (find(rule, line) ?? line.indexOf(start)) + 1;
					expected.push(`${file}:${index + 2}:${column} ${rule.id}`);
				}
			}
		}
		const found = scan(repo.dir);
		expect(at(found)).toEqual(expected.sort());
		for (const { id } of ofKind("secret")) expect(JSON.stringify(found)).not.toContain(quoted(id));
	});

	it("stop after four levels: a \\n escaped five times still hides what follows", () => {
		const repo = tempRepo();
		const values = ofKind("secret").map(({ id }) => `ok${"\\".repeat(16)}n${quoted(id)}`);
		for (const [extension, format] of Object.entries(formats)) {
			repo.write(`fixtures/deep.${extension}`, format(values));
		}
		expect(scan(repo.dir)).toEqual([]);
	});

	it("read \\0 before an octal digit both as C does, an octal escape, and as YAML does, NUL", () => {
		const repo = tempRepo();
		const written = sample("secret-google", "bad", 2);
		const token = written.slice(written.indexOf('"') + 1, written.lastIndexOf('"'));
		// YAML's NUL, also with its backslash escaped in two ways, and C's backspace, before a token
		// that starts with 1.
		const prefixes = ["ok\\0", "ok\\\\0", "ok\\u005c0", "ok\\010"];
		const text = yaml(prefixes.map((prefix) => `${prefix}${token}`));
		repo.write("fixtures/nul.yaml", text);
		const columns = lines(text).map((line) => line.indexOf(token) + 1);
		expect(at(scan(repo.dir))).toEqual(
			[2, 3, 4, 5].map((line) => `fixtures/nul.yaml:${line}:${columns[line - 1]} secret-google`),
		);
	});

	it("hide no vendor reference right after an escape, or written with \\/, escaped quotes or escaped spaces", () => {
		const repo = tempRepo();
		const expected = new Set<string>();
		// The match in a single-quoted or template string, its double quotes made that quote.
		const inQuotes = (match: string, quote: string): string =>
			`${quote}${match.replaceAll('"', quote).replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`)}${quote}`;
		for (const rule of ofKind("vendor")) {
			for (const [index, { text }] of rule.bad.entries()) {
				const whole = `fixtures/${rule.id}-${index}.json`;
				repo.write(whole, `{"code": ${JSON.stringify(text).replaceAll("/", "\\/")}}\n`);
				expected.add(`${whole}:1 ${rule.id}`);
				const match =
					lines(text)
						.flatMap((line) => rule.patterns.map((pattern) => pattern.exec(line)?.[0] ?? ""))
						.find((found) => found !== "") ?? "";
				const json = JSON.stringify(match).slice(1, -1);
				// After each escape, and with its spaces escaped as YAML may write them.
				const values = [
					...escapes.map((sequence) => `ok${sequence}${json}`),
					json.replaceAll(" ", "\\ "),
					json.replaceAll(" ", "\\\t"),
				];
				for (const [extension, format] of Object.entries(formats)) {
					const file = `fixtures/${rule.id}-${index}-escaped.${extension}`;
					repo.write(file, format(values));
					for (const line of values.keys()) expected.add(`${file}:${line + 2} ${rule.id}`);
				}
				const code = `fixtures/${rule.id}-${index}-quoted.ts`;
				repo.write(
					code,
					`const a = ${inQuotes(match, "'")};\nconst b = ${inQuotes(match, "`")};\n`,
				);
				expected.add(`${code}:1 ${rule.id}`);
				expected.add(`${code}:2 ${rule.id}`);
			}
		}
		const found = new Set(scan(repo.dir).map(({ file, line, rule }) => `${file}:${line} ${rule}`));
		expect(found).toEqual(expected);
	});

	it("are decoded in text passed in alone, without other readings", () => {
		const token = quoted("secret-anthropic");
		const text = `{"log": "ok\\n${token}"}\n`;
		const hits = fileHits("fixtures/run.json", { text, plain: true });
		expect(hits.map(({ rule, line, column }) => `${line}:${column} ${rule.id}`)).toEqual([
			`1:${text.indexOf(token) + 1} secret-anthropic`,
		]);
	});

	it("still need an allow.json entry, for the line as written, in a *.md file", () => {
		const repo = tempRepo();
		const line = `- The hub never calls ${backend}`.replaceAll("/", "\\/");
		repo.write("docs/notes.md", `# Notes\n\n${line}\n`);
		expect(scan(repo.dir)).toEqual([
			expect.objectContaining({ line: 3, rule: "openai-backend", lineSha256: sha256(line) }),
		]);
		const entry = {
			path: "docs/notes.md",
			rule: "openai-backend",
			sha256: sha256(line),
			reason: "why",
		};
		repo.write(ALLOW_FILE, JSON.stringify([entry]));
		expect(scan(repo.dir)).toEqual([]);
	});

	it("leave ordinary escaped text, and every rule's negative cases in escaped strings, alone", () => {
		const repo = tempRepo();
		repo.write(
			"fixtures/escapes.yaml",
			[
				'lines: "line one\\nline two\\r\\n\\ttabbed \\u00e9t\\u00e9 \\u4e2d\\u6587 \\U0001F600 \\x41"',
				'path: "C:\\\\Users\\\\someone\\\\AppData\\\\Local\\\\Temp"',
				'quoted: "say \\"hi\\" at https:\\/\\/example.com\\/a\\/b"',
				'pattern: "^\\\\d+-[0-9a-z]+\\\\.example\\\\.com$ \\\\bword\\\\b"',
				'broken: "\\u12 \\x4 \\u{} \\u{1234567} \\U0011FFFF \\q \\"',
				`nested: ${JSON.stringify(JSON.stringify({ a: 'line\nnext \u00e9 "q" C:\\Users\\x' }))}`,
			].join("\n"),
		);
		for (const rule of [...ofKind("vendor"), ...ofKind("secret")]) {
			for (const [index, { text }] of rule.good.entries()) {
				const json = JSON.stringify(text).replaceAll("/", "\\/");
				repo.write(`fixtures/${rule.id}-${index}.json`, `{"code": ${json}}\n`);
				const nested = JSON.stringify(JSON.stringify({ code: text }));
				repo.write(`fixtures/${rule.id}-${index}-nested.json`, `{"body": ${nested}}\n`);
			}
		}
		expect(scan(repo.dir)).toEqual([]);
	});
});

describe("UTF-16", () => {
	it("without a BOM is read in each byte order its NUL bytes fit, so non-Latin text first can't hide a token", () => {
		const repo = tempRepo();
		// No NUL byte in the first 10,000 bytes, and too few in all to tell UTF-16 by them.
		const text = `${"\u4e2d".repeat(5000)}\n${secret}\n`;
		repo.write("notes/le.txt", utf16(text, "le", false));
		repo.write("notes/be.txt", utf16(text, "be", false));
		// Its NUL bytes say UTF-16LE, and the UTF-8 in it is read too.
		const mixed = Buffer.concat([utf16("ok\n".repeat(200), "le", false), Buffer.from(secret)]);
		repo.write("notes/mixed.txt", mixed);
		expect(within(scan(repo.dir))).toEqual([
			"notes/be.txt:2 secret-anthropic read as UTF-16BE",
			"notes/le.txt:2 secret-anthropic read as UTF-16LE",
			"notes/mixed.txt:201 secret-anthropic read as UTF-8",
		]);
	});

	it("with a BOM is read as UTF-8 too, so a BOM can't hide a token", () => {
		const repo = tempRepo();
		const text = Buffer.from(`ok\n${secret}\n`);
		repo.write("notes/le.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), text]));
		repo.write("notes/be.txt", Buffer.concat([Buffer.from([0xfe, 0xff]), text]));
		expect(within(scan(repo.dir))).toEqual([
			"notes/be.txt:2 secret-anthropic read as UTF-8",
			"notes/le.txt:2 secret-anthropic read as UTF-8",
		]);
	});

	it("finds nothing in binaries, however they are read", () => {
		const repo = tempRepo();
		repo.write("assets/icon.png", binary("ok\n"));
		repo.write("assets/noise.bin", noise(64 * 1024));
		repo.write("assets/noise.gz", gzipSync(noise(64 * 1024)));
		repo.write(
			"assets/bundle.zip",
			zip([
				{ name: "a.bin", data: noise(4096) },
				{ name: "b.png", data: binary("") },
			]),
		);
		repo.write("assets/clean.pdf", pdf("Hello"));
		repo.write("assets/clean.tar.gz", gzipSync(tar([{ name: "a.txt", data: "hello\n" }])));
		expect(scan(repo.dir)).toEqual([]);
	});
});

describe("compressed content", () => {
	const token = quoted("secret-anthropic");
	const text = `ok\n${secret}\n`;
	const types = { name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types/>' };
	const docx = zip([
		types,
		{ name: "word/document.xml", data: `<w:p><w:r><w:t>${token}</w:t></w:r></w:p>` },
	]);
	const xlsx = zip([
		types,
		{ name: "xl/sharedStrings.xml", data: `<sst><si><t>${token}</t></si></sst>` },
	]);

	it("is read decompressed: gzip, zstd, zip, .docx and .xlsx entries, PDF streams and what they nest", () => {
		const repo = tempRepo();
		repo.write("logs/run.log.gz", gzipSync(text));
		repo.write("logs/run.log.zst", zstdCompressSync(text));
		repo.write(
			"dist/bundle.zip",
			zip([
				{ name: "a.txt", data: "hello\n" },
				{ name: "b.txt", data: text },
			]),
		);
		repo.write("dist/stored.zip", zip([{ name: "logs.gz", data: gzipSync(text), method: 0 }]));
		const wide = utf16(`${"\u4e2d".repeat(5000)}\n${secret}\n`, "le", false);
		repo.write("dist/wide.zip", zip([{ name: "notes.txt", data: wide }]));
		repo.write("docs/report.docx", docx);
		repo.write("docs/sheet.xlsx", xlsx);
		repo.write("docs/scan.pdf", pdf(token));
		const nested = zip([{ name: "report.docx", data: docx }]);
		const app = [
			{ name: "app/notes.txt", data: text },
			{ name: "app/docs.zip", data: nested },
		];
		repo.write("dist/app.tar.gz", gzipSync(tar(app)));
		// Other data first, as in a self-extractor, whether the zip's offsets count it or not.
		const archive = zip([{ name: "a.txt", data: text }]);
		const stub = Buffer.concat([Buffer.from("MZ"), noise(1000)]);
		repo.write("dist/setup.exe", afterData(stub, archive, true));
		repo.write("dist/joined.bin", afterData(stub, archive, false));
		repo.write("docs/saved.pdf", Buffer.concat([noise(100), pdf(token)]));
		// Still a tar, though a PDF header comes early and a zip ends it.
		const docs = [
			{ name: "a.pdf", data: pdf("hello") },
			{ name: "b.log.gz", data: gzipSync(text) },
			{ name: "c.zip", data: zip([{ name: "c.txt", data: "hello\n" }]) },
		];
		repo.write("dist/docs.tar", tar(docs));
		const found = scan(repo.dir);
		// zstd may keep a short text as it is, where the raw bytes show it too.
		const all = within(found);
		const zstd = all.filter((line) => line.startsWith("logs/run.log.zst:"));
		expect(zstd).toContain("logs/run.log.zst:2 secret-anthropic in the zstd stream");
		expect(all.filter((line) => !zstd.includes(line))).toEqual([
			"dist/app.tar.gz:1 secret-anthropic in zip entry 2 in zip entry 1 in tar entry 2 in the gzip stream",
			"dist/app.tar.gz:2 secret-anthropic in the gzip stream",
			"dist/bundle.zip:2 secret-anthropic in zip entry 2",
			"dist/docs.tar:2 secret-anthropic in the gzip stream in tar entry 2",
			"dist/joined.bin:2 secret-anthropic in zip entry 1",
			"dist/setup.exe:2 secret-anthropic in zip entry 1",
			"dist/stored.zip:2 secret-anthropic in the gzip stream in zip entry 1",
			"dist/wide.zip:2 secret-anthropic in zip entry 1, read as UTF-16LE",
			"docs/report.docx:1 secret-anthropic in zip entry 2",
			"docs/saved.pdf:1 secret-anthropic in PDF stream 1",
			"docs/scan.pdf:1 secret-anthropic in PDF stream 1",
			"docs/sheet.xlsx:1 secret-anthropic in zip entry 2",
			"logs/run.log.gz:2 secret-anthropic in the gzip stream",
		]);
		expect(found.find(({ file }) => file === "docs/scan.pdf")?.column).toBe(
			"BT /F1 12 Tf 72 712 Td (".length + 1,
		);
		expect(JSON.stringify(found)).not.toContain(token);
	});

	it("fails closed past the caps, nested too deep, or where it can't be decompressed", () => {
		const repo = tempRepo();
		const zeros = Buffer.alloc(2 * 2 ** 20);
		repo.write("bomb.gz", gzipSync(zeros));
		repo.write("bomb.zst", zstdCompressSync(zeros));
		repo.write("bomb.zip", zip([{ name: "a.bin", data: zeros }]));
		repo.write("bomb.pdf", pdf("\0".repeat(zeros.length)));
		// Two listings of one entry: each would inflate the same data again.
		repo.write("shared.zip", repeated({ name: "a.bin", data: noise(4096) }, 2));
		const locked = pdf("hello").toString("latin1").replace("/Root 1 0 R", "$& /Encrypt 5 0 R");
		repo.write("locked.pdf", Buffer.from(locked, "latin1"));
		let deep = Buffer.from(text);
		for (let level = 0; level <= CAPS.depth; level++) deep = gzipSync(deep);
		repo.write("deep.gz", deep);
		const damaged = gzipSync(text);
		damaged.writeUInt8(damaged.readUInt8(damaged.length - 5) ^ 0xff, damaged.length - 5);
		repo.write("damaged.gz", damaged);
		repo.write("cut.zip", zip([{ name: "a.txt", data: "hello\n" }]).subarray(0, -22));
		repo.write("odd.zip", zip([{ name: "a.txt", data: "hello\n", method: 12 }]));
		// Entries under the cap one by one, but not together.
		const part = Buffer.alloc(600 * 2 ** 10);
		repo.write("part.zip", zip([{ name: "a.bin", data: part }]));
		repo.write(
			"parts.zip",
			zip(["a", "b", "c"].map((name) => ({ name: `${name}.bin`, data: part }))),
		);
		// Named as a PDF, though all text.
		repo.write("plain.pdf", "%PDF-1.4\ntrailer << /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF\n");
		// What comes before the entry it can't read is still checked.
		repo.write(
			"locked.zip",
			zip([
				{ name: "a.txt", data: text },
				{ name: "b.txt", data: "x", flags: 1 },
			]),
		);
		const found = scan(repo.dir);
		expect(within(found)).toEqual([
			"bomb.gz:1 compressed",
			"bomb.pdf:1 compressed",
			"bomb.zip:1 compressed",
			"bomb.zst:1 compressed",
			"cut.zip:1 compressed",
			"damaged.gz:1 compressed",
			"deep.gz:1 compressed",
			"locked.pdf:1 compressed",
			"locked.zip:1 compressed",
			"locked.zip:2 secret-anthropic in zip entry 1",
			"odd.zip:1 compressed",
			"parts.zip:1 compressed",
			"plain.pdf:1 compressed",
			"shared.zip:1 compressed",
		]);
		const keep = "keep it out of the repository";
		const large = `decompresses to over 1 MiB (100 times the file's size, at least 1 MiB, at most 64 MiB), too large to scan; ${keep}`;
		const encrypted = `can't decompress the PDF (encrypted) to scan it; ${keep}`;
		expect(found.filter(({ rule }) => rule === "compressed").map(({ reason }) => reason)).toEqual([
			large,
			large,
			large,
			large,
			`can't decompress the zip archive (no end record at its end) to scan it; ${keep}`,
			`can't decompress the gzip stream (incorrect data check) to scan it; ${keep}`,
			`nested over 8 levels deep, too deep to scan; ${keep}`,
			encrypted,
			`can't decompress zip entry 2 (encrypted) to scan it; ${keep}`,
			`can't decompress zip entry 1 (compression method 12) to scan it; ${keep}`,
			large,
			encrypted,
			`can't decompress the zip archive (entries that share data) to scan it; ${keep}`,
		]);
	});

	it("reads a zip by the end record that ends the file, never one that lists nothing after data", () => {
		const repo = tempRepo();
		const entry = { name: "a.txt", data: text };
		// A second end record, listing nothing: in the comment, at the end, or before more data.
		const empty = zip([]);
		repo.write("commented.zip", zip([entry], Buffer.concat([empty, Buffer.from(" ok")])));
		repo.write("appended.zip", Buffer.concat([zip([entry]), empty]));
		repo.write("trailing.zip", Buffer.concat([zip([entry]), empty, Buffer.from("\n")]));
		const stub = Buffer.concat([Buffer.from("MZ"), noise(1000)]);
		repo.write("setup.exe", Buffer.concat([afterData(stub, zip([entry]), true), empty]));
		repo.write("empty.zip", zip([], Buffer.from("no files")));
		const found = scan(repo.dir);
		expect(within(found)).toEqual([
			"appended.zip:1 compressed",
			"commented.zip:2 secret-anthropic in zip entry 1",
			"setup.exe:1 compressed",
			"trailing.zip:1 compressed",
		]);
		const keep = "keep it out of the repository";
		const unlisted = `can't decompress the zip archive (lists no entries but holds data) to scan it; ${keep}`;
		expect(found.filter(({ rule }) => rule === "compressed").map(({ reason }) => reason)).toEqual([
			unlisted,
			unlisted,
			`can't decompress the zip archive (no end record at its end) to scan it; ${keep}`,
		]);
	});

	it("caps a file's expansion at a ratio to its size, between a floor and a ceiling", () => {
		const caps = { ratio: 10, min: 1000, max: 5000, depth: 2, parts: 3 };
		const refused = (input: Buffer): boolean => unpack(gzipSync(input), caps).problem !== undefined;
		// The floor: any ratio up to 1000 bytes.
		expect(refused(Buffer.alloc(1000))).toBe(false);
		expect(refused(Buffer.alloc(1001))).toBe(true);
		// The ratio: about 2,000 and 3,400 bytes for about 200 and 340 compressed.
		expect(refused(Buffer.concat([noise(150), Buffer.alloc(3000)]))).toBe(true);
		expect(refused(Buffer.concat([noise(300), Buffer.alloc(2500)]))).toBe(false);
		// The ceiling, whatever the ratio.
		expect(refused(noise(4900))).toBe(false);
		expect(refused(noise(5001))).toBe(true);
		// The depth: two levels pass, a third doesn't.
		expect(unpack(gzipSync(gzipSync("ok")), caps)).toEqual({
			parts: [expect.anything(), expect.anything()],
		});
		expect(unpack(gzipSync(gzipSync(gzipSync("ok"))), caps).problem).toMatch(/over 2 levels deep/);
		// The parts: three pass, a fourth doesn't, stored or compressed, nested or not.
		const files = (count: number, method = 8) =>
			Array.from({ length: count }, (_, index) => ({ name: `${index}.txt`, data: "ok", method }));
		expect(unpack(zip(files(3)), caps)).toEqual({ parts: files(3).map(() => expect.anything()) });
		expect(unpack(gzipSync(zip(files(2, 0))), caps).problem).toBeUndefined();
		for (const many of [zip(files(4)), zip(files(4, 0)), gzipSync(zip(files(3)))]) {
			expect(unpack(many, caps).problem).toBe(
				"holds over 3 compressed streams and archive entries, too many to scan; keep it out of the repository",
			);
		}
		expect(CAPS.parts).toBe(50_000);
	});

	it("leaves alone what only looks like an archive or a PDF", () => {
		const repo = tempRepo();
		// A zip's end record that names no central directory, after other data.
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(1, 10);
		repo.write("assets/data.bin", Buffer.concat([noise(4096), end]));
		// A PDF header without its version, in code that names what a PDF holds.
		repo.write("src/pdf.ts", 'const header = "%PDF-";\nconst lock = "/Encrypt";\n');
		// With its version too, or a stream that starts as a zlib one would: text isn't a PDF, which
		// holds binary data.
		repo.write("src/versioned.ts", 'const header = "%PDF-1.4";\nconst lock = "/Encrypt";\n');
		repo.write(
			"notes/pdf.txt",
			"%PDF-1.7 objects keep their data in a stream\nx^2 then endstream\n",
		);
		expect(scan(repo.dir)).toEqual([]);
	});
});
