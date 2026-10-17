import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hostTarget, nodeBinary, nodeVersions } from "../node.ts";

// A stand-in for fetch-node's fixed CLI (M0.5): it records its argv and prints a path.
const stub = `import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
const options = { offline: { type: "boolean" }, "print-path": { type: "boolean" } };
for (const name of ["version", "platform", "arch"]) options[name] = { type: "string" };
const { values } = parseArgs({ options });
appendFileSync(import.meta.dirname + "/calls.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
if (values.version === "26.0.0") { console.error("SHA-256 mismatch"); process.exit(2); }
const other = import.meta.filename.replace(/fetch-node[.]mjs$/, "node-other");
const host = values.arch === process.arch && values.platform === process.platform.replace("32", "");
if (!host) writeFileSync(other, "");
console.log("fetching"); console.log(host ? process.execPath : other);
`;

describe("node.ts", () => {
	const root = mkdtempSync(path.join(tmpdir(), "draftyak-kit-node-"));
	const tool = path.join(root, "tools", "fetch-node");
	mkdirSync(tool, { recursive: true });
	writeFileSync(path.join(tool, "fetch-node.mjs"), stub);
	writeFileSync(path.join(tool, "versions.json"), '{ "minimum": "26.5.1", "bundled": "26.12.0" }');
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const lastCall = (): string[] => {
		const lines = readFileSync(path.join(tool, "calls.jsonl"), "utf8").trim().split("\n");
		return JSON.parse(lines.at(-1) ?? "[]");
	};
	const host = hostTarget();
	const current = process.versions.node;

	it("calls fetch-node --print-path and checks the binary's --version", async () => {
		expect(await nodeBinary(`v${current}`, host, { root })).toBe(process.execPath);
		const expected = ["--version", current, "--platform", host.platform, "--arch", host.arch];
		expect(lastCall()).toEqual([...expected, "--print-path"]);
		await expect(nodeBinary("26.5.1", host, { root })).rejects.toThrow(`reports v${current}`);
	});

	it("takes the last stdout line for other platforms without running it", async () => {
		const other = { platform: host.platform === "win" ? "linux" : "win", arch: "x64" } as const;
		expect(await nodeBinary("26.5.1", other, { root, offline: true })).toBe(
			path.join(tool, "node-other"),
		);
		expect(lastCall()).toContain("--offline");
	});

	it("reports fetch-node's failures and reads both Nodes from versions.json", async () => {
		await expect(nodeBinary("26.0.0", host, { root })).rejects.toThrow(
			"exited with 2: SHA-256 mismatch",
		);
		await expect(nodeBinary("latest", host, { root })).rejects.toThrow("not a Node version");
		await expect(nodeBinary(current, host, { root: tmpdir() })).rejects.toThrow("fetch-node, M0.5");
		expect(nodeVersions(root)).toEqual({ minimum: "26.5.1", bundled: "26.12.0" });
	});
});
