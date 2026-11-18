import { describe, expect, it } from "vitest";
import { findExecutable, preflight, selectStore } from "../src/capabilities.ts";

describe("native-store capability admission", () => {
	it.each([
		["win32", "windows"],
		["darwin", "macos"],
		["linux", "secret-service"],
	] as const)("requires its native host for %s", (platform, store) => {
		expect(selectStore(platform, {}).store).toBe(store);
		expect(selectStore(platform, { CI: "true", DRAFTYAK_STRICT_SKIPS: "0" }).strict).toBe(true);
		expect(selectStore(platform, { DRAFTYAK_STRICT_SKIPS: "1" }).strict).toBe(true);
	});
	it.each(["true", "false", "yes", " 1", "1\n"])(
		"refuses an ambiguous strict setting %j",
		(raw) => {
			expect(() => selectStore("win32", { DRAFTYAK_STRICT_SKIPS: raw })).toThrow();
		},
	);
	it("refuses unsupported hosts rather than silently omitting the native case", () => {
		expect(() => selectStore("freebsd", {})).toThrow("Unsupported");
	});
	it("preflights required capabilities before any case can be selected away", async () => {
		for (const missing of ["cargo", "node", "docker"] as const) {
			const probes = { cargo: () => true, node: () => true, docker: () => true };
			probes[missing] = () => false;
			await expect(preflight(selectStore("linux", {}), probes)).rejects.toThrow(missing);
		}
		await expect(
			preflight(selectStore("darwin", {}), {
				cargo: () => true,
				node: () => true,
				docker: () => {
					throw new Error("not required");
				},
			}),
		).resolves.toBeUndefined();
	});
	it("finds only an absolute native executable, never a relative path or shell shim", () => {
		const seen: string[] = [];
		const result = findExecutable("cargo", "win32", { PATH: "relative;C:\\native" }, (file) => {
			seen.push(file);
			return true;
		});
		expect(result).toBe("C:\\native\\cargo.exe");
		expect(seen).toEqual(["C:\\native\\cargo.exe"]);
		expect(
			findExecutable(
				"docker",
				"linux",
				{ PATH: "relative:/native" },
				(file) => file === "/native/docker.cmd",
			),
		).toBeUndefined();
	});
});
