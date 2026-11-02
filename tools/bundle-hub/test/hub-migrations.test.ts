import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { NATIVE_REQUIRED, parseSpec } from "../src/bundle.ts";
import { digest, type FileRecord } from "../src/inventory.ts";

const workspace = path.resolve(import.meta.dirname, "../../..");
const hub = path.join(workspace, "apps/hub");
const temporary = realpathSync.native(tmpdir());
const root = mkdtempSync(path.join(temporary, "draftyak-hub-migrations-"));
const built = path.join(root, "built-hub");
const expected = [
	"credentials/migrations/0001_credentials.sql",
	"credentials/migrations/0002_sealed_credentials.sql",
	"devices-migrations/0001_devices.sql",
	"drafts/migrations/0001_native_revisions.sql",
	"drafts/migrations/0002_immutable_revisions.sql",
	"events-migrations/0001_events.sql",
	"jobs-migrations/0001_jobs.sql",
	"outbox/migrations/0001_send_attempts.sql",
	"plugins/registry/migrations/0001_registry.sql",
	"store/migrations/audit/0001_chain.sql",
	"store/migrations/core/0001_identity.sql",
] as const;
let actual: FileRecord[] = [];

beforeAll(() => {
	const script = `import path from "node:path";
const { build } = await import("tsdown");
const { default: config } = await import(${JSON.stringify(pathToFileURL(path.join(hub, "tsdown.config.ts")).href)});
if (!Array.isArray(config.copy)) throw new Error("Hub copy configuration is missing");
const copy = config.copy.map(item => {
  if (typeof item.to !== "string" || !item.to.startsWith("dist/")) throw new Error("Unexpected Hub output root");
  return { ...item, to: path.join(${JSON.stringify(built)}, item.to.slice(5)) };
});
await build({ ...config, outDir: ${JSON.stringify(built)}, copy });`;
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		cwd: hub,
		encoding: "utf8",
		windowsHide: true,
		timeout: 60_000,
		maxBuffer: 1024 * 1024,
	});
	expect(result.error).toBeUndefined();
	expect(result.status, "the actual Hub producer must build before migration admission").toBe(0);
	expect(readFileSync(path.join(built, "index.mjs")).length).toBeGreaterThan(0);
	const files: string[] = [];
	const visit = (relative: string): void => {
		for (const item of readdirSync(path.join(built, relative), { withFileTypes: true })) {
			const child = relative ? `${relative}/${item.name}` : item.name;
			if (item.isDirectory()) visit(child);
			else if (item.isFile() && child.endsWith(".sql")) files.push(child);
		}
	};
	visit("");
	actual = files.sort().map((file) => {
		const bytes = readFileSync(path.join(built, file));
		return { path: file, sha256: digest(bytes), bytes: bytes.length };
	});
});

afterAll(() => {
	if (
		path.dirname(root) !== temporary ||
		!path.basename(root).startsWith("draftyak-hub-migrations-")
	)
		throw new Error("Unexpected migration test cleanup root");
	rmSync(root, { recursive: true, force: true });
});

function spec(migrations: readonly FileRecord[] = actual) {
	const structural = (file: string): FileRecord => ({
		path: file,
		sha256: "a".repeat(64),
		bytes: 1,
	});
	return {
		schemaVersion: 1,
		version: "0.1.0",
		target: { platform: "linux", arch: "x64" },
		hub: {
			root: built,
			// Only SQL is real producer output; these other sections remain structural unit inputs.
			files: ["hub.mjs", "spa/index.html", "plugins/fixture.mjs"]
				.map(structural)
				.concat(migrations),
		},
		native: { archive: "native.tgz", files: NATIVE_REQUIRED.map(structural) },
		node: { root: "node-input" },
	};
}

it("admits the actual built hub SQL inventory without flattening its runtime paths", () => {
	expect(
		actual.map((file) => file.path),
		"current Hub migration output drifted",
	).toEqual(expected);
	for (const file of actual) {
		const source = file.path.startsWith("devices-migrations/")
			? `identity/${file.path}`
			: file.path.startsWith("jobs-migrations/")
				? `jobs/${file.path}`
				: file.path.startsWith("events-migrations/")
					? `events/${file.path}`
					: file.path;
		expect(readFileSync(path.join(built, file.path))).toEqual(
			readFileSync(path.join(hub, "src", source)),
		);
	}
	expect(parseSpec(spec(), root).hub.files.filter((file) => file.path.endsWith(".sql"))).toEqual(
		actual,
	);
});

it.each(expected)("refuses omission of current Hub SQL %s", (missing) => {
	expect(() => parseSpec(spec(actual.filter((file) => file.path !== missing)), root)).toThrow(
		"hub migration inventory",
	);
});

it.each(expected)("refuses mislocation of current Hub SQL %s", (misplaced) => {
	const files = actual.map((file) =>
		file.path === misplaced
			? { ...file, path: `migrations/${file.path.replaceAll("/", "_")}` }
			: file,
	);
	expect(() => parseSpec(spec(files), root)).toThrow("hub migration inventory");
});

it.each(expected)("refuses empty current Hub SQL %s", (empty) => {
	const files = actual.map((file) => (file.path === empty ? { ...file, bytes: 0 } : file));
	expect(() => parseSpec(spec(files), root)).toThrow("hub migration inventory");
});
