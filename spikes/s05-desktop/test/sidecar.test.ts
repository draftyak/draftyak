// Offline checks: the Tauri config against the installed CLI's schema and the pinned versions, and
// the stub hub's framing and stdout before an unlock (which needs no staged files).
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const spikeDir = path.resolve(import.meta.dirname, "..");
const tauriDir = path.join(spikeDir, "tauri-app", "src-tauri");
const require = createRequire(path.join(spikeDir, "package.json"));
const read = (file: string): string => fs.readFileSync(file, "utf8");
const json = (file: string): Record<string, unknown> => JSON.parse(read(file));
const config = json(path.join(tauriDir, "tauri.conf.json"));

interface Schema {
	readonly $ref?: string;
	readonly properties?: Readonly<Record<string, Schema>>;
	readonly allOf?: readonly Schema[];
	readonly anyOf?: readonly Schema[];
	readonly oneOf?: readonly Schema[];
	readonly definitions?: Readonly<Record<string, Schema>>;
}

// The JSON paths of keys that no schema for their object declares, following $ref and *Of.
function unknownKeys(value: unknown, schema: Schema, root: Schema, at = "$"): string[] {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
	const expand = (node: Schema): Schema[] => {
		const ref = node.$ref?.replace("#/definitions/", "");
		if (ref !== undefined) return expand(root.definitions?.[ref] ?? {});
		const alternatives = [...(node.allOf ?? []), ...(node.anyOf ?? []), ...(node.oneOf ?? [])];
		return [node, ...alternatives.flatMap(expand)];
	};
	const known: Record<string, Schema> = Object.assign(
		{},
		...expand(schema).map((node) => node.properties ?? {}),
	);
	return Object.entries(value).flatMap(([key, item]) => {
		const child = known[key];
		return child ? unknownKeys(item, child, root, `${at}.${key}`) : [`${at}.${key}`];
	});
}

const lockedVersion = (crate: string): string | undefined =>
	read(path.join(tauriDir, "Cargo.lock"))
		.split("[[package]]")
		.map((entry) => /name = "(.+)"\s+version = "(.+)"/.exec(entry))
		.find((match) => match?.[1] === crate)?.[2];

describe("tauri-app config", () => {
	it("uses only keys that @tauri-apps/cli 2.12.3's config schema declares", () => {
		const cli = path.dirname(require.resolve("@tauri-apps/cli/package.json"));
		expect(json(path.join(cli, "package.json")).version).toBe("2.12.3");
		const schema = json(path.join(cli, "config.schema.json")) as Schema;
		expect(unknownKeys(config, schema, schema)).toEqual([]);
		expect(unknownKeys({ app: { windowz: [] } }, schema, schema)).toEqual(["$.app.windowz"]);
	});

	it("bundles draftyak-node and the hub under the spike's own identifier, with no shell plugin", () => {
		expect(config.identifier).toBe("com.draftyak.spike.desktop");
		expect(config.bundle).toMatchObject({
			externalBin: ["binaries/draftyak-node"],
			resources: ["resources/"],
		});
		expect(Object.keys((config.plugins ?? {}) as object)).not.toContain("shell");
	});

	it("pins tauri 2.12.4, tauri-build 2.7.3 and @tauri-apps/api 2.12.4, without the shell plugin", () => {
		const manifest = read(path.join(tauriDir, "Cargo.toml"));
		expect(manifest).toMatch(/^tauri = \{ version = "=2\.12\.4", optional = true(?:,| \})/m);
		expect(manifest).toMatch(/^tauri-build = \{ version = "=2\.7\.3", optional = true \}$/m);
		expect(manifest).toMatch(/^default = \["app"\]\napp = \["dep:tauri", "dep:tauri-build"[,\]]/m);
		expect([lockedVersion("tauri"), lockedVersion("tauri-build")]).toEqual(["2.12.4", "2.7.3"]);
		expect(lockedVersion("tauri-plugin-shell")).toBeUndefined();
		expect(json(require.resolve("@tauri-apps/api/package.json")).version).toBe("2.12.4");
	});
});

function frame(value: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(value));
	const head = Buffer.alloc(4);
	head.writeUInt32BE(body.length);
	return Buffer.concat([head, body]);
}

const hubScript = path.join(tauriDir, "resources", "hub.mjs");

// Runs the stub hub on this Node, by default as the supervisor does, writes input to its stdin
// once stderr shows `after` (waiting at most 10 s), closes stdin and waits for the exit.
async function hub(
	input: Buffer,
	args: readonly string[] = ["--disable-sigusr1", hubScript],
	after?: string,
): Promise<{ code: number | null; stdout: number; stderr: string }> {
	const child = spawn(process.execPath, args, { windowsHide: true });
	let stdout = 0;
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.length;
	});
	const stderr: string[] = [];
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
	const exited = once(child, "exit");
	const deadline = Date.now() + 10_000;
	while (after !== undefined && !stderr.join("").includes(after) && Date.now() < deadline) {
		await sleep(20);
	}
	child.stdin.end(input);
	const [code] = (await exited) as [number | null];
	return { code, stdout, stderr: stderr.join("") };
}

describe("stub hub framing before an unlock", () => {
	it("stops on stdin EOF with nothing on stdout", async () => {
		const run = await hub(Buffer.alloc(0));
		expect(run).toMatchObject({ code: 0, stdout: 0 });
		expect(run.stderr).toMatch(/^hub: stopping \(stdin closed\)$/m);
	});

	it("logs a resumed frame and stops on the shutdown frame", async () => {
		const run = await hub(Buffer.concat([frame({ power: "resumed" }), frame({ shutdown: true })]));
		expect(run).toMatchObject({ code: 0, stdout: 0 });
		expect(run.stderr).toMatch(/^hub: resumed$/m);
		expect(run.stderr).toMatch(/^hub: stopping \(shutdown frame\)$/m);
	});

	it("refuses an oversized frame, a frame that isn't JSON and a malformed unlock frame", async () => {
		const oversized = Buffer.alloc(4);
		oversized.writeUInt32BE((1 << 20) + 1);
		const notJson = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from("{x}")]);
		const badUnlock = frame({ masterKey: "zz", bootstrapSecret: "00" });
		const runs = await Promise.all([hub(oversized), hub(notJson), hub(badUnlock)]);
		expect(runs.map((run) => [run.code, run.stdout])).toEqual([
			[2, 0],
			[2, 0],
			[1, 0],
		]);
		expect(runs[2]?.stderr).toMatch(/^hub: stopping \(the unlock frame needs/m);
	});

	it("sends console output and other stray stdout writes to stderr", async () => {
		const writes = [
			`await import(${JSON.stringify(pathToFileURL(hubScript).href)});`,
			'console.log("log line");',
			"console.dir({ dir: 1 });",
			"console.table([{ table: 1 }]);",
			'process.stdout.write("direct write\\n");',
		];
		const args = ["--disable-sigusr1", "--input-type=module", "-e", writes.join("\n")];
		const run = await hub(Buffer.alloc(0), args, "direct write");
		expect(run).toMatchObject({ code: 0, stdout: 0 });
		for (const written of ["log line", "{ dir: 1 }", "table", "direct write"]) {
			expect(run.stderr).toContain(written);
		}
		expect(run.stderr).toMatch(/^hub: stopping \(stdin closed\)$/m);
	});
});
