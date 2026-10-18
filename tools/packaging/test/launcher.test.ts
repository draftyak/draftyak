import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { removeFixture } from "./temp.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const temporary: string[] = [];
function cleanEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.NODE_OPTIONS;
	delete env.NODE_PATH;
	return env;
}
function fixture(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-packaging-"));
	temporary.push(dir);
	return dir;
}
function put(dir: string, file: string, value: string): void {
	const target = path.join(dir, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, value);
}
afterEach(() => {
	for (const dir of temporary.splice(0)) removeFixture(dir, os.tmpdir(), "draftyak-packaging-");
});

describe("production launcher", () => {
	function run(
		args: readonly string[],
		body: string,
		alreadyProtected = false,
	): ReturnType<typeof spawnSync> {
		const dir = fixture();
		copyFileSync(
			path.join(root, "tools/packaging/templates/draftyak.mjs"),
			path.join(dir, "draftyak.mjs"),
		);
		put(dir, "package.json", '{"type":"module"}');
		put(dir, "main.js", body);
		const env = { ...process.env };
		delete env.NODE_OPTIONS;
		delete env.NODE_PATH;
		return spawnSync(
			process.execPath,
			[...(alreadyProtected ? ["--disable-sigusr1"] : []), path.join(dir, "draftyak.mjs"), ...args],
			{ env, encoding: "utf8", timeout: 10_000, windowsHide: true },
		);
	}
	it.each([false, true])(
		"starts the payload once, protected=%s, preserving shell-looking arguments",
		(protectedAlready) => {
			const args = ["outbox", "cancel", "literal;$(payload)&`text`", "two words"];
			const child = run(
				args,
				"console.log(JSON.stringify({flags:process.execArgv,args:process.argv.slice(2)}));",
				protectedAlready,
			);
			expect(child.status, String(child.stderr)).toBe(0);
			expect(JSON.parse(String(child.stdout))).toEqual({ flags: ["--disable-sigusr1"], args });
		},
	);
	it("preserves a failing payload's status through the Windows parent", () => {
		expect(run([], "process.exitCode=23;").status).toBe(23);
	});
	it("refuses extra Node flags before importing the payload", () => {
		const dir = fixture();
		copyFileSync(
			path.join(root, "tools/packaging/templates/draftyak.mjs"),
			path.join(dir, "draftyak.mjs"),
		);
		const result = spawnSync(process.execPath, ["--no-warnings", path.join(dir, "draftyak.mjs")], {
			encoding: "utf8",
			timeout: 10_000,
			env: cleanEnv(),
		});
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("start without extra Node flags");
	});
	it("refuses an absent product rather than returning successful help", () => {
		const dir = fixture();
		copyFileSync(
			path.join(root, "tools/packaging/templates/draftyak.mjs"),
			path.join(dir, "draftyak.mjs"),
		);
		const result = spawnSync(
			process.execPath,
			["--disable-sigusr1", path.join(dir, "draftyak.mjs"), "serve"],
			{ encoding: "utf8", timeout: 10_000, env: cleanEnv() },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("built CLI payload is missing");
	});
});

describe("container health", () => {
	it("sends no bytes and reports both a live listener and a refused connection", async () => {
		const source = pathToFileURL(path.join(root, "docker/healthcheck.mjs")).href;
		const { probe } = (await import(source)) as { probe(port: number): Promise<boolean> };
		let received = 0;
		const server = createServer((socket) =>
			socket.on("data", (data) => {
				received += data.length;
			}),
		);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("missing test listener");
		try {
			expect(await probe(address.port)).toBe(true);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
		expect(received).toBe(0);
		expect(await probe(address.port)).toBe(false);
	});
});
