import { describe, expect, it } from "vitest";
import { unpack } from "../src/tar.ts";
import { archive } from "./helpers/entry-archive.ts";

describe("archive entry budget", () => {
	it("accepts a bounded archive at the total-header ceiling", () => {
		const files = unpack(archive(39_999));
		expect([...files.keys()]).toEqual(["package/value.txt"]);
		expect(files.get("package/value.txt")).toEqual(Buffer.alloc(0));
	});
	it("counts directories even though they produce no returned file", () => {
		expect(() => unpack(archive(40_000))).toThrow("tar entry limit exceeded");
	});
});
