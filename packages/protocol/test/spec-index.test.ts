import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const spec = path.resolve(import.meta.dirname, "../../../spec");

function inventory(directory: string, prefix = ""): { files: string[]; directories: string[] } {
	const files: string[] = [];
	const directories: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const relative = prefix + entry.name;
		if (entry.isDirectory()) {
			directories.push(`${relative}/`);
			const nested = inventory(path.join(directory, entry.name), `${relative}/`);
			files.push(...nested.files);
			directories.push(...nested.directories);
		} else if (entry.isFile()) files.push(relative);
		else throw new Error(`Unexpected spec entry: ${relative}`);
	}
	return { files, directories };
}

function exactTarget(directory: string, target: string): string | undefined {
	if (target.includes("\\") || target.startsWith("/")) return;
	const parts = target.split("/");
	if (parts.includes("..")) return;
	const names: string[] = [];
	let current = directory;
	try {
		for (const part of parts) {
			if (part === "" || part === ".") continue;
			if (!readdirSync(current).includes(part)) return;
			current = path.join(current, part);
			names.push(part);
		}
		return names.join("/") + (statSync(current).isDirectory() ? "/" : "");
	} catch {
		return;
	}
}

function indexProblems(directory: string, markdown: string): string[] {
	const lines = markdown.split(/\r?\n/);
	const start = lines.indexOf("## Index");
	if (start < 0) return ["Index section is missing"];
	const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
	const section = lines.slice(start + 1, end < 0 ? undefined : end);
	const header = section.findIndex((line) =>
		/^\|\s*Contract\s*\|\s*Prose\s*\|\s*JSON Schema\s*\|\s*Vectors\s*\|$/.test(line),
	);
	if (header < 0) return ["Index table is missing"];
	const problems: string[] = [];
	const linked = new Set<string>();
	for (const line of section.slice(header + 2)) {
		if (!line.startsWith("|")) break;
		for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
			const target = match[1]?.split("#")[0];
			if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
			const resolved = exactTarget(directory, target);
			if (resolved === undefined) problems.push(`Unresolved relative link: ${target}`);
			else linked.add(resolved);
		}
	}
	const entries = inventory(directory);
	const required = [
		...entries.files.filter(
			(file) =>
				(file.endsWith(".md") && file !== "README.md" && file !== "vectors/README.md") ||
				(file.endsWith(".schema.json") && !file.startsWith("vectors/")),
		),
		...entries.directories.filter((directory) => /^vectors\/[^/]+\/$/.test(directory)),
	];
	for (const file of required) if (!linked.has(file)) problems.push(`Missing index link: ${file}`);
	return problems.sort();
}

const temporaryRoot = realpathSync(tmpdir());
const temporaryPrefix = "draftyak-spec-index-";
const temporary: string[] = [];
afterEach(() => {
	for (const directory of temporary) {
		const resolved = path.resolve(directory);
		const entry = lstatSync(resolved);
		if (
			!path.isAbsolute(directory) ||
			resolved !== directory ||
			path.dirname(resolved) !== temporaryRoot ||
			!path.basename(resolved).startsWith(temporaryPrefix) ||
			entry.isSymbolicLink() ||
			!entry.isDirectory() ||
			realpathSync(resolved) !== resolved
		) {
			throw new Error("Refusing unowned spec index fixture cleanup");
		}
		rmSync(resolved, { recursive: true, force: true });
	}
	temporary.length = 0;
});
const table =
	"## Index\n\n| Contract | Prose | JSON Schema | Vectors |\n|---|---|---|---|\n" +
	"| Existing | [Prose](existing-v1.md) | [Schema](schemas/existing-v1.schema.json) | [Vectors](vectors/existing/) |\n";
function fixture(): string {
	const directory = mkdtempSync(path.join(temporaryRoot, temporaryPrefix));
	temporary.push(directory);
	for (const file of [
		"README.md",
		"vectors/README.md",
		"existing-v1.md",
		"schemas/existing-v1.schema.json",
		"vectors/existing/cases.json",
	]) {
		mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
		writeFileSync(path.join(directory, file), "{}\n");
	}
	return directory;
}

describe("the specification index", () => {
	it("links every checked-in contract, schema and vector folder with exact case", () => {
		expect(indexProblems(spec, readFileSync(path.join(spec, "README.md"), "utf8"))).toEqual([]);
	});

	it.each([
		["nested/new-v1.md", "[Prose](nested/new-v1.md)"],
		["new-v1.schema.json", "[Schema](new-v1.schema.json)"],
		["vectors/new/cases.json", "[Vectors](vectors/new/)"],
	])("requires the index row when %s is added", (file, link) => {
		const directory = fixture();
		expect(indexProblems(directory, table)).toEqual([]);
		mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
		writeFileSync(path.join(directory, file), "{}\n");
		expect(indexProblems(directory, table)).toEqual([
			`Missing index link: ${file.startsWith("vectors/") ? "vectors/new/" : file}`,
		]);
		expect(indexProblems(directory, `${table}| Added | ${link} | — | — |\n`)).toEqual([]);
	});

	it("refuses a wrong-case link even on a case-insensitive filesystem", () => {
		const directory = fixture();
		expect(indexProblems(directory, table.replace("(existing-v1.md)", "(Existing-v1.md)"))).toEqual(
			["Missing index link: existing-v1.md", "Unresolved relative link: Existing-v1.md"],
		);
	});

	it("does not count a prose link outside the Index table as its row", () => {
		const directory = fixture();
		writeFileSync(path.join(directory, "new-v1.md"), "draft\n");
		expect(indexProblems(directory, `[New](new-v1.md)\n\n${table}`)).toEqual([
			"Missing index link: new-v1.md",
		]);
	});
});
