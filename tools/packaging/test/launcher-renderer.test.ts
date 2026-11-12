import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CLI_PAYLOAD } from "@draftyak/cli/payload-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as readers from "../../bundle-hub/src/inventory.ts";
import { canonicalLauncher } from "../../bundle-hub/src/launcher.ts";
import { removeFixture } from "./temp.ts";

const policyFile = path.resolve(import.meta.dirname, "../../fetch-node/versions.json");
const templateFile = path.resolve(import.meta.dirname, "../templates/draftyak.mjs");
const originalRead = readers.regularBytes;
const parent = realpathSync.native(os.tmpdir());
const temporary: string[] = [];
const marker = '"__DRAFTYAK_NODE_MINIMUM__"';
const payloadMarker = '"__DRAFTYAK_CLI_PAYLOAD__"';
const payload = "DYTEST-rendered-payload";
const spawned = "DYTEST-renderer-spawn";
const replaced = "DYTEST-renderer-execve";

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of temporary.splice(0)) removeFixture(dir, parent, "draftyak-renderer-");
});

function run(bytes: Buffer, version?: string, protectedAlready = true, platform = "win32") {
	const dir = mkdtempSync(path.join(parent, "draftyak-renderer-"));
	temporary.push(dir);
	const launcher = path.join(dir, "draftyak.mjs");
	const harness = path.join(dir, "harness.mjs");
	writeFileSync(launcher, bytes);
	mkdirSync(path.join(dir, "cli"));
	writeFileSync(path.join(dir, "cli/package.json"), '{"type":"module"}');
	writeFileSync(
		path.join(dir, "cli/main.mjs"),
		`export function main() { process.stdout.write(${JSON.stringify(payload)}); return 0; }`,
	);
	writeFileSync(
		harness,
		`import cp from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
Object.defineProperty(process,"platform",{value:${JSON.stringify(platform)}});
${version === undefined ? "" : `Object.defineProperty(process.versions,"node",{value:${JSON.stringify(version)}});`}
cp.spawn=()=>{process.stderr.write(${JSON.stringify(spawned)});process.exit(73);};
process.execve=()=>{process.stderr.write(${JSON.stringify(replaced)});process.exit(74);};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(launcher).href)});
`,
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) =>
				!["NODE_OPTIONS", "NODE_PATH", "DRAFTYAK_MASTER_KEY"].includes(name.toUpperCase()),
		),
	);
	return spawnSync(
		process.execPath,
		[...(protectedAlready ? ["--disable-sigusr1"] : []), harness],
		{
			env,
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 4096,
			windowsHide: true,
			shell: false,
		},
	);
}

describe("canonical launcher rendering", () => {
	it("renders one canonical pin snapshot and the shared CLI payload contract", () => {
		let reads = 0;
		const template = originalRead(templateFile, 65_536);
		vi.spyOn(readers, "regularBytes").mockImplementation((file, maximum) => {
			if (path.resolve(file) !== policyFile) return originalRead(file, maximum);
			reads++;
			return Buffer.from(reads === 1 ? '{"minimum":"26.6.2","bundled":"26.12.0"}' : "null");
		});
		const rendered = canonicalLauncher();
		expect(reads).toBe(1);
		expect(rendered.policy).toEqual({ minimum: "26.6.2", bundled: "26.12.0" });
		for (const version of ["26.5.99", "25.99.99", "26.6.1"]) {
			const child = run(rendered.bytes, version);
			expect(child.status, child.stderr).toBe(1);
			expect(child.stdout).toBe("");
			expect(child.stderr).toContain("Node >=26.6.2 is required");
			expect(child.stderr).not.toContain(spawned);
		}
		const accepted = run(rendered.bytes, "26.6.2");
		expect(accepted.status, accepted.stderr).toBe(0);
		expect(accepted.stdout).toBe(payload);
		expect(accepted.stderr).toBe("");
		expect(rendered.bytes).toEqual(
			Buffer.from(
				template
					.toString("utf8")
					.replace(marker, "[26,6,2]")
					.replace(payloadMarker, JSON.stringify(CLI_PAYLOAD)),
			),
		);
		expect(rendered.bytes.toString("utf8")).not.toContain(marker);
		expect(rendered.bytes.toString("utf8")).not.toContain(payloadMarker);
	});
	it.each(["missing", "duplicate"])("refuses a %s CLI contract marker", (kind) => {
		const template = originalRead(templateFile, 65_536).toString("utf8");
		const changed =
			kind === "duplicate"
				? `${template}\n// ${payloadMarker}\n`
				: template.replace(payloadMarker, "null");
		vi.spyOn(readers, "regularBytes").mockImplementation((file, maximum) =>
			path.resolve(file) === templateFile ? Buffer.from(changed) : originalRead(file, maximum),
		);
		expect(() => canonicalLauncher()).toThrow(
			"canonical launcher template must contain exactly one CLI payload marker",
		);
	});

	it.each(["missing", "duplicate", "malformed"])(
		"refuses a %s canonical template marker",
		(kind) => {
			const template = originalRead(templateFile, 65_536).toString("utf8");
			const changed =
				kind === "duplicate"
					? `${template}\n// ${marker}\n`
					: template.replace(marker, kind === "missing" ? "[26,5,1]" : "__DRAFTYAK_NODE_MINIMUM__");
			vi.spyOn(readers, "regularBytes").mockImplementation((file, maximum) =>
				path.resolve(file) === templateFile ? Buffer.from(changed) : originalRead(file, maximum),
			);
			expect(() => canonicalLauncher()).toThrow(
				"canonical launcher template must contain exactly one Node policy marker",
			);
		},
	);

	it("refuses missing or invalid UTF-8 canonical templates without a fallback", () => {
		vi.spyOn(readers, "regularBytes").mockImplementation((file, maximum) => {
			if (path.resolve(file) === templateFile)
				throw new Error("Canonical fixture template unavailable");
			return originalRead(file, maximum);
		});
		expect(() => canonicalLauncher()).toThrow("Canonical fixture template unavailable");
		vi.restoreAllMocks();
		vi.spyOn(readers, "regularBytes").mockImplementation((file, maximum) =>
			path.resolve(file) === templateFile ? Buffer.from([255]) : originalRead(file, maximum),
		);
		expect(() => canonicalLauncher()).toThrow("canonical launcher template must be UTF-8");
	});

	it.each([false, true])(
		"raw template refuses before payload import or process creation, protected=%s",
		(protectedAlready) => {
			for (const platform of ["win32", "linux"]) {
				const child = run(readFileSync(templateFile), undefined, protectedAlready, platform);
				expect(child.status, child.stderr).toBe(1);
				expect(child.stdout).toBe("");
				expect(child.stderr).toContain(
					"launcher policy is unavailable; build the product before packaging",
				);
				expect(child.stderr).not.toContain(spawned);
				expect(child.stderr).not.toContain(replaced);
				expect(child.stderr).not.toContain(payload);
			}
		},
	);
});
