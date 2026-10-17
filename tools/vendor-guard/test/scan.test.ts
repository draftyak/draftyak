import { rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { glue } from "../src/rules.ts";
import {
	ALLOW_FILE,
	type AllowEntry,
	type Finding,
	listFiles,
	loadAllow,
	MAX_BYTES,
	scanFiles,
	sha256,
} from "../src/scan.ts";
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
