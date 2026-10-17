import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertSpawnable, capture, run, SpawnRefusedError } from "./spawn.ts";

describe("spawn guard", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "draftyak-verify-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it.each(["pnpm.cmd", "VITEST.CMD", "turbo.bat", "pnpm.ps1", "pnpm.cmd.", "pnpm.cmd "])(
		"refuses the shell shim %j",
		(name) => {
			expect(() => assertSpawnable(path.join(dir, name))).toThrow(SpawnRefusedError);
		},
	);

	it("refuses an existing .cmd target without spawning it", async () => {
		const shim = path.join(dir, "tool.cmd");
		writeFileSync(shim, "@exit /b 0\r\n");
		await expect(run({ command: shim, args: [] })).rejects.toThrow(SpawnRefusedError);
		await expect(capture({ command: shim, args: [] })).rejects.toThrow(SpawnRefusedError);
	});

	it("spawns process.execPath without a shell and returns its exit code", async () => {
		expect(await run({ command: process.execPath, args: ["-e", "process.exit(3)"] })).toBe(3);
	});

	it("passes arguments verbatim, with nothing for a shell to interpret", async () => {
		const text = 'a & b | c > d "e" %PATH% $HOME';
		const result = await capture({
			command: process.execPath,
			args: ["-e", "process.stdout.write(process.argv[1])", text],
		});
		expect(result).toMatchObject({ code: 0, stdout: text });
	});
});
