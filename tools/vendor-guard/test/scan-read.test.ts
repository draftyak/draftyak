import { afterAll, describe, expect, it, vi } from "vitest";
import { scanFiles } from "../src/scan.ts";
import { unpack } from "../src/unpack.ts";
import { removeTemp, tempRepo } from "./helpers.ts";

vi.mock(import("../src/unpack.ts"), async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, unpack: vi.fn(actual.unpack) };
});

afterAll(removeTemp);

describe("reading a file", () => {
	it("skips only a file that is gone, never one whose unpacking fails with ENOENT", () => {
		const repo = tempRepo();
		repo.write("src/a.ts", "export const a = 1;\n");
		vi.mocked(unpack).mockImplementationOnce(() => {
			throw Object.assign(new Error("lost while unpacking"), { code: "ENOENT" });
		});
		expect(() => scanFiles(repo.dir, ["src/a.ts"])).toThrow("lost while unpacking");
		expect(scanFiles(repo.dir, ["src/a.ts"])).toEqual({ findings: [], files: 1 });
	});
});
