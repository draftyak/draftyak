import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exec } from "../exec.ts";
import { freePorts } from "../ports.ts";
import { kitDir } from "../repo.ts";
import { parseRunArgs, resolveVitest } from "../run.ts";

describe("run.ts", () => {
	it("maps tier flags to vitest --mode, the same with or without pnpm's `--`", () => {
		expect(parseRunArgs([]).args).toEqual(["run"]);
		expect(parseRunArgs(["--device"]).args).toEqual(["run", "--mode", "device"]);
		const heavy = { tier: "heavy", strict: false, args: ["run", "--mode", "heavy", "-t", "x"] };
		expect(parseRunArgs(["--heavy", "--", "-t", "x"])).toEqual(heavy);
		expect(parseRunArgs(["--heavy", "-t", "x"])).toEqual(heavy);
		const strict = { tier: "heavy", strict: true, args: ["run", "--mode", "heavy"] };
		expect(parseRunArgs(["--heavy", "--", "--strict"])).toEqual(strict);
		expect(parseRunArgs(["--heavy", "--strict"])).toEqual(strict);
		expect(parseRunArgs(["--", "--heavy"])).toEqual({ ...strict, strict: false });
		expect(parseRunArgs(["--live", "--strict"])).toMatchObject({ tier: "live", strict: true });
	});

	it("refuses two tiers, a hand-written --mode, or a folder without a Vitest config", async () => {
		expect(() => parseRunArgs(["--heavy", "--live"])).toThrow("one tier at a time");
		expect(() => parseRunArgs(["--", "--mode=live"])).toThrow("not --mode");
		const bare = mkdtempSync(path.join(tmpdir(), "draftyak-kit-bare-"));
		try {
			const result = await exec(process.execPath, [path.join(kitDir, "run.ts"), "--live"], {
				cwd: bare,
			});
			expect([result.code, result.stderr]).toEqual([
				2,
				expect.stringContaining("no vitest.config.ts"),
			]);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it("runs vitest.mjs with process.execPath, never a .cmd shim", () => {
		const vitest = resolveVitest();
		expect(path.basename(vitest)).toBe("vitest.mjs");
		expect(existsSync(vitest)).toBe(true);
	});
});

describe("ports.ts", () => {
	it("hands out distinct bindable ports, never the reserved ones", async () => {
		const ports = await freePorts(6);
		expect(new Set(ports).size).toBe(6);
		expect(ports.filter((port) => [1455, 9229, 47613, 47614, 47615].includes(port))).toEqual([]);
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(ports[0], "127.0.0.1", resolve));
		await new Promise((resolve) => server.close(resolve));
	});
});
