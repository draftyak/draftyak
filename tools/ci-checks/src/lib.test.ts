import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cliArgs, execAsync, revision, setOutputs, UsageError } from "./lib.ts";

describe("ci-checks", () => {
	it("imports only node: built-ins and relative files, so checks run before pnpm install", () => {
		const sources = readdirSync(import.meta.dirname).filter(
			(file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
		);
		const bare = sources.flatMap((file) =>
			[
				...readFileSync(path.join(import.meta.dirname, file), "utf8").matchAll(
					/\b(?:from|import)\s*\(?\s*["']([^"']+)/g,
				),
			]
				.map((match) => match[1] ?? "")
				.filter((specifier) => !/^(?:node:|\.\.?\/)/.test(specifier))
				.map((specifier) => `${file}: ${specifier}`),
		);
		expect(bare).toEqual([]);
	});

	it("accepts the leading -- that pnpm passes through, and refuses unknown options", () => {
		expect(cliArgs(["--", "--base", "origin/m0"], ["base"])).toEqual({ base: "origin/m0" });
		expect(() => cliArgs(["--bogus"], ["base"])).toThrow(UsageError);
	});

	it("refuses revisions that git could read as options", () => {
		expect(revision("origin/m0", "base")).toBe("origin/m0");
		for (const value of ["--output=x", "", undefined, "a b"]) {
			expect(() => revision(value, "base")).toThrow(UsageError);
		}
	});

	it("runs a command without blocking and rejects with its stderr or exit code", async () => {
		const node = (code: string): Promise<string> => execAsync(process.execPath, ["-e", code]);
		await expect(node("process.stdout.write('out')")).resolves.toBe("out");
		await expect(node("process.stderr.write('no access\\n'); process.exit(3)")).rejects.toThrow(
			/ -e .+: no access$/,
		);
		await expect(node("process.exit(4)")).rejects.toThrow(/: exit code 4$/);
		await expect(execAsync("draftyak-missing-command", [])).rejects.toThrow("ENOENT");
	});

	const dir = mkdtempSync(path.join(tmpdir(), "draftyak-outputs-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("writes multi-line step outputs with a delimiter", () => {
		const file = path.join(dir, "output");
		setOutputs({ one: "1", lines: "a\nb" }, file);
		expect(readFileSync(file, "utf8")).toMatch(/^one=1\nlines<<(EOF_[\w-]+)\na\nb\n\1\n$/);
	});
});
