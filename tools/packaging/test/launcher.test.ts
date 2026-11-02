import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalLauncher } from "../../bundle-hub/src/launcher.ts";
import { removeFixture } from "./temp.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const parent = realpathSync.native(os.tmpdir());
const temporary: string[] = [];
function cleanEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.NODE_OPTIONS;
	delete env.NODE_PATH;
	return env;
}
function fixture(): string {
	const dir = mkdtempSync(path.join(parent, "draftyak-packaging-"));
	temporary.push(dir);
	return dir;
}
function put(dir: string, file: string, value: string): void {
	const target = path.join(dir, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, value);
}
afterEach(() => {
	for (const dir of temporary.splice(0)) removeFixture(dir, parent, "draftyak-packaging-");
});

describe("production launcher", () => {
	function run(
		args: readonly string[],
		body: string,
		alreadyProtected = false,
	): ReturnType<typeof spawnSync> {
		const dir = fixture();
		writeFileSync(path.join(dir, "draftyak.mjs"), canonicalLauncher().bytes);
		put(dir, "cli/package.json", '{"type":"module"}');
		put(dir, "cli/main.mjs", body);
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
				"let calls=0; export async function main(argv) { calls++; console.log(JSON.stringify({flags:process.execArgv,args:argv,calls})); return 0; }",
				protectedAlready,
			);
			expect(child.status, String(child.stderr)).toBe(0);
			expect(JSON.parse(String(child.stdout))).toEqual({
				flags: ["--disable-sigusr1"],
				args,
				calls: 1,
			});
			expect(child.stderr).toBe("");
		},
	);
	it("preserves a failing payload's status through the Windows parent", () => {
		expect(run([], "export async function main() { return 23; }").status).toBe(23);
	});
	it.each(["undefined", "null", "NaN", "Infinity", "-1", "256", "1.5", '"0"'])(
		"refuses the invalid main return %s",
		(value) => {
			const child = run([], `export function main() { return ${value}; }`, true);
			expect(child.status).toBe(1);
			expect(child.stdout).toBe("");
			expect(child.stderr).toContain("invalid exit code");
		},
	);
	it("refuses a payload without the exported main function", () => {
		const child = run([], "export const fixture = true;", true);
		expect(child.status).toBe(1);
		expect(child.stdout).toBe("");
		expect(child.stderr).toContain("does not export its main function");
	});
	it("keeps a dependency import failure distinct from an absent payload", () => {
		const child = run(
			[],
			'import "./missing-dependency.mjs"; export function main() { return 0; }',
			true,
		);
		expect(child.status).toBe(1);
		expect(child.stdout).toBe("");
		expect(child.stderr).toContain("missing-dependency.mjs");
		expect(child.stderr).not.toContain("built CLI payload is missing");
	});
	it.each([false, true])(
		"keeps the compiled CLI catalogue sealed, extra launcher inside cli=%s",
		(extra) => {
			const dir = fixture();
			const main = `import {readFileSync,readdirSync} from "node:fs";
import {createHash} from "node:crypto";
export function main(argv) {
  const root = new URL(".", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("catalog.json",root),"utf8"));
  const names = readdirSync(root).sort();
  if (JSON.stringify(names)!==JSON.stringify(Object.keys(catalog).sort()) ||
      names.some(name=>catalog[name]!==null && createHash("sha256").update(readFileSync(new URL(name,root))).digest("hex")!==catalog[name])) {
    process.stderr.write("DYTEST sealed catalogue refused\\n"); return 47;
  }
  process.stdout.write(JSON.stringify({argv,flags:process.execArgv})); return 0;
}`;
			const boundary = '{"type":"module"}\n';
			writeFileSync(path.join(dir, "draftyak.mjs"), canonicalLauncher().bytes);
			put(dir, "cli/main.mjs", main);
			put(dir, "cli/package.json", boundary);
			put(
				dir,
				"cli/catalog.json",
				JSON.stringify({
					"main.mjs": createHash("sha256").update(main).digest("hex"),
					"package.json": createHash("sha256").update(boundary).digest("hex"),
					"catalog.json": null,
				}),
			);
			if (extra) put(dir, "cli/draftyak.mjs", "// extra file inside the sealed payload\n");
			const argv = ["mcp", "--client", "DYTEST-client", "literal;$(fixture)&`text`"];
			const child = spawnSync(
				process.execPath,
				["--disable-sigusr1", path.join(dir, "draftyak.mjs"), ...argv],
				{ encoding: "utf8", timeout: 10_000, windowsHide: true, shell: false, env: cleanEnv() },
			);
			expect(child.status, child.stderr).toBe(extra ? 47 : 0);
			if (extra) {
				expect(child.stdout).toBe("");
				expect(child.stderr).toBe("DYTEST sealed catalogue refused\n");
			} else {
				expect(JSON.parse(child.stdout)).toEqual({ argv, flags: ["--disable-sigusr1"] });
				expect(child.stderr).toBe("");
			}
		},
	);
	it.each([
		["--no-warnings"],
		["--inspect"],
		["--inspect=127.0.0.1:0"],
		["--inspect-brk"],
		["--inspect-brk=127.0.0.1:0"],
		["--inspect-port"],
		["--inspect-port=0"],
		["--inspect-port", "0"],
	])("refuses synthetic Node flags %j before importing a valid payload", (...flags) => {
		const dir = fixture();
		const imported = "DYTEST-payload-imported";
		writeFileSync(path.join(dir, "draftyak.mjs"), canonicalLauncher().bytes);
		put(dir, "cli/package.json", '{"type":"module"}');
		put(
			dir,
			"cli/main.mjs",
			`process.stdout.write(${JSON.stringify(imported)}); export function main() { return 0; }`,
		);
		const invoke = (synthetic: readonly string[]) => {
			// Inspector flags are data: Node receives only the safe preload and signal guard.
			put(
				dir,
				"preload.mjs",
				`process.execArgv.splice(0, process.execArgv.length, ...${JSON.stringify(synthetic)});`,
			);
			return spawnSync(
				process.execPath,
				[
					"--disable-sigusr1",
					"--import",
					pathToFileURL(path.join(dir, "preload.mjs")).href,
					path.join(dir, "draftyak.mjs"),
				],
				{ encoding: "utf8", timeout: 10_000, windowsHide: true, shell: false, env: cleanEnv() },
			);
		};
		const clean = invoke(["--disable-sigusr1"]);
		expect(clean.status, clean.stderr).toBe(0);
		expect(clean.stdout).toBe(imported);
		expect(clean.stderr).toBe("");
		const denied = invoke(["--disable-sigusr1", ...flags]);
		expect(denied.error).toBeUndefined();
		expect({ status: denied.status, imported: denied.stdout }).toEqual({ status: 1, imported: "" });
		expect(denied.stderr).toBe(
			"draftyak: start without extra Node flags, NODE_OPTIONS or NODE_PATH\n",
		);
	});
	it.each(["NODE_OPTIONS", "NODE_PATH"] as const)(
		"refuses inherited %s before importing a valid payload",
		(name) => {
			const dir = fixture();
			const imported = "DYTEST-payload-imported";
			writeFileSync(path.join(dir, "draftyak.mjs"), canonicalLauncher().bytes);
			put(dir, "cli/package.json", '{"type":"module"}');
			put(
				dir,
				"cli/main.mjs",
				`process.stdout.write(${JSON.stringify(imported)}); export function main() { return 0; }`,
			);
			const invoke = (env: NodeJS.ProcessEnv) =>
				spawnSync(process.execPath, ["--disable-sigusr1", path.join(dir, "draftyak.mjs")], {
					encoding: "utf8",
					timeout: 10_000,
					windowsHide: true,
					shell: false,
					env,
				});
			const clean = invoke(cleanEnv());
			expect(clean.status, clean.stderr).toBe(0);
			expect(clean.stdout).toBe(imported);
			expect(clean.stderr).toBe("");
			const denied = invoke({
				...cleanEnv(),
				[name]: name === "NODE_OPTIONS" ? "--no-warnings" : path.join(dir, "node-path"),
			});
			expect(denied.status, denied.stderr).toBe(1);
			expect(denied.stdout).toBe("");
			expect(denied.stderr).toBe(
				"draftyak: start without extra Node flags, NODE_OPTIONS or NODE_PATH\n",
			);
		},
	);
	it("refuses an absent product rather than returning successful help", () => {
		const dir = fixture();
		writeFileSync(path.join(dir, "draftyak.mjs"), canonicalLauncher().bytes);
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
