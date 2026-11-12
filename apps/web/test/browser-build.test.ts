import { describe, expect, it } from "vitest";
import { verifyBrowserBundle } from "../scripts/verify-build.ts";

const runtimeImports = ["react/compiler-runtime", "react/jsx-runtime"];

describe("browser build verification", () => {
	it("accepts the actual compiler and JSX runtime edges independent of code formatting", () => {
		expect(() => verifyBrowserBundle("compiled code", runtimeImports, [])).not.toThrow();
	});
	it.each([
		["Node crypto", "import 'node:crypto';"],
		["hash implementation", "const createHash = () => 1;"],
		["browser external stub", "__vite-browser-external"],
	])("refuses %s in the output", (_name, source) => {
		expect(() => verifyBrowserBundle(source, runtimeImports, [])).toThrow();
	});
	it.each(["unexpected", "fs", "react", "./extra-chunk.js"])(
		"refuses an unexpected static edge to %s, including re-exports",
		(name) => {
			expect(() => verifyBrowserBundle("compiled code", [...runtimeImports, name], [])).toThrow();
		},
	);
	it("refuses dynamic imports", () => {
		expect(() => verifyBrowserBundle("compiled code", runtimeImports, ["unknown"])).toThrow();
	});
	it.each(runtimeImports)("requires the %s runtime edge", (missing) => {
		expect(() =>
			verifyBrowserBundle(
				"compiled code",
				runtimeImports.filter((name) => name !== missing),
				[],
			),
		).toThrow();
	});
});
