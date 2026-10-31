import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";

const hub = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const header = (
	process.report.getReport() as unknown as { header: { glibcVersionRuntime?: string } }
).header;
const platform =
	process.platform === "linux" && !header.glibcVersionRuntime ? "linuxmusl" : process.platform;
const nativeBinding = realpathSync(
	path.join(
		path.dirname(require.resolve("better-sqlite3-multiple-ciphers/package.json")),
		"prebuilds",
		`${platform}-${process.arch}.node`,
	),
);
const assets = [
	["store/migrations/audit/0001_chain.sql", "store/migrations/audit/0001_chain.sql"],
	["store/migrations/core/0001_identity.sql", "store/migrations/core/0001_identity.sql"],
	["jobs/jobs-migrations/0001_jobs.sql", "jobs-migrations/0001_jobs.sql"],
	["events/events-migrations/0001_events.sql", "events-migrations/0001_events.sql"],
	["drafts/migrations/0001_native_revisions.sql", "drafts/migrations/0001_native_revisions.sql"],
	[
		"drafts/migrations/0002_immutable_revisions.sql",
		"drafts/migrations/0002_immutable_revisions.sql",
	],
	["credentials/migrations/0001_credentials.sql", "credentials/migrations/0001_credentials.sql"],
	["outbox/migrations/0001_send_attempts.sql", "outbox/migrations/0001_send_attempts.sql"],
] as const;

function checkRuntimeNames(directory: string): void {
	let files = 0;
	const visit = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			expect(entry.name).toMatch(/^[a-zA-Z0-9._-]+$/);
			expect(entry.name).not.toMatch(/siwc|dynamic-agent|dynamic_agent/i);
			expect(entry.isSymbolicLink()).toBe(false);
			if (entry.isDirectory()) visit(path.join(current, entry.name));
			else {
				expect(entry.isFile()).toBe(true);
				expect(++files).toBeLessThanOrEqual(1000);
			}
		}
	};
	visit(directory);
}

function stageRuntimePackage(
	stage: string,
	name: "protocol" | "bounded-files" | "extensions",
): void {
	const runtimePackage = path.resolve(hub, "../../packages", name);
	const manifest = JSON.parse(readFileSync(path.join(runtimePackage, "package.json"), "utf8"));
	expect(manifest.name).toBe(`@draftyak/${name}`);
	expect(manifest.publishConfig.exports).toBeDefined();
	expect(manifest.dependencies).toEqual(
		name === "protocol"
			? { zod: "4.6.7" }
			: name === "extensions"
				? { "@draftyak/protocol": "workspace:*", hono: "4.13.13" }
				: undefined,
	);
	const target = path.join(stage, "node_modules/@draftyak", name);
	mkdirSync(target, { recursive: true });
	let files = 0;
	const copy = (source: string, destination: string): void => {
		mkdirSync(destination);
		for (const entry of readdirSync(source, { withFileTypes: true })) {
			expect(entry.name).toMatch(/^[a-zA-Z0-9._-]+$/);
			expect(entry.name).not.toMatch(/siwc|dynamic-agent|dynamic_agent/i);
			expect(entry.isSymbolicLink()).toBe(false);
			const from = path.join(source, entry.name),
				to = path.join(destination, entry.name);
			if (entry.isDirectory()) copy(from, to);
			else {
				expect(entry.isFile()).toBe(true);
				expect(++files).toBeLessThanOrEqual(1000);
				copyFileSync(from, to);
			}
		}
	};
	copy(path.join(runtimePackage, "dist"), path.join(target, "dist"));
	expect(files).toBeGreaterThan(0);
	// Use the actual published runtime mapping, never the workspace's source exports.
	writeFileSync(
		path.join(target, "package.json"),
		JSON.stringify({
			name: manifest.name,
			version: manifest.version,
			type: manifest.type,
			exports: manifest.publishConfig.exports,
			dependencies: manifest.dependencies,
		}),
	);
	// The unchanged declared external runtime dependency resolves to this install's exact pin.
	if (name === "protocol")
		symlinkSync(
			realpathSync(path.join(runtimePackage, "node_modules/zod")),
			path.join(stage, "node_modules/zod"),
			"junction",
		);
	if (name === "extensions")
		symlinkSync(
			realpathSync(path.join(runtimePackage, "node_modules/hono")),
			path.join(stage, "node_modules/hono"),
			"junction",
		);
}

function compiled(mode: "healthy" | "missing-asset" | "invalid-sql"): void {
	const parent = realpathSync(path.join(hub, "node_modules"));
	const stage = realpathSync(mkdtempSync(path.join(parent, ".native-storage-compiled-")));
	const cleanup = (): void => {
		if (
			path.dirname(stage) !== parent ||
			!path.basename(stage).startsWith(".native-storage-compiled-") ||
			lstatSync(stage).isSymbolicLink() ||
			realpathSync(stage) !== stage
		)
			throw new Error("Compiled native storage cleanup target refused");
		rmSync(stage, { recursive: true, force: true });
		expect(existsSync(stage)).toBe(false);
	};
	try {
		// Admit every staged runtime filename before copying any runtime bytes.
		checkRuntimeNames(path.join(hub, "dist"));
		for (const name of ["protocol", "bounded-files", "extensions"])
			checkRuntimeNames(path.resolve(hub, "../../packages", name, "dist"));
		for (const entry of readdirSync(path.join(hub, "dist"), { withFileTypes: true })) {
			if (!entry.name.endsWith(".mjs")) continue;
			expect(entry.isFile()).toBe(true);
			expect(entry.isSymbolicLink()).toBe(false);
			copyFileSync(path.join(hub, "dist", entry.name), path.join(stage, entry.name));
		}
		expect(existsSync(path.join(stage, "index.mjs"))).toBe(true);
		copyFileSync(
			path.join(import.meta.dirname, "fixtures/compiled-native-storage.mjs"),
			path.join(stage, "fixture.mjs"),
		);
		for (const [source, built] of assets) {
			const file = path.join(hub, "dist", built);
			expect(lstatSync(file).isFile()).toBe(true);
			expect(lstatSync(file).isSymbolicLink()).toBe(false);
			expect(readFileSync(file)).toEqual(readFileSync(path.join(hub, "src", source)));
			const target = path.join(stage, built);
			mkdirSync(path.dirname(target), { recursive: true });
			copyFileSync(file, target);
		}
		stageRuntimePackage(stage, "protocol");
		stageRuntimePackage(stage, "bounded-files");
		stageRuntimePackage(stage, "extensions");
		const child = spawnSync(
			process.execPath,
			[
				"--permission",
				"--allow-addons",
				`--allow-fs-read=${stage}`,
				`--allow-fs-write=${stage}`,
				`--allow-fs-read=${realpathSync(path.resolve(hub, "../../node_modules"))}`,
				`--allow-fs-read=${parent}`,
				path.join(stage, "fixture.mjs"),
				nativeBinding,
				mode,
				path.join(hub, "src"),
				path.resolve(hub, "../../packages/protocol/src"),
				path.resolve(hub, "../../packages/bounded-files/src"),
				path.resolve(hub, "../../packages/extensions/src"),
			],
			{
				cwd: stage,
				env: {
					NODE_ENV: "test",
					SystemRoot: "C:\\Windows",
					WINDIR: "C:\\Windows",
					TEMP: stage,
					TMP: stage,
				},
				encoding: "utf8",
				maxBuffer: 16_384,
				timeout: 30_000,
				windowsHide: true,
			},
		);
		let receipt: Record<string, unknown> | undefined;
		if (typeof child.stdout === "string" && child.stdout.length <= 512) {
			try {
				const parsed: unknown = JSON.parse(child.stdout);
				if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
					receipt = parsed as Record<string, unknown>;
			} catch {
				// An absent or malformed receipt fails without echoing process output.
			}
		}
		const checkpoint =
			receipt?.ok === false &&
			Object.keys(receipt).sort().join() === "checkpoint,ok" &&
			[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 90].includes(receipt.checkpoint as number)
				? (receipt.checkpoint as number)
				: 0;
		expect(child.error === undefined, "Native fixture process start").toBe(true);
		expect(child.signal === null, "Native fixture process completion").toBe(true);
		expect(child.status, `Native fixture checkpoint ${checkpoint}`).toBe(0);
		expect(
			receipt !== undefined &&
				Object.keys(receipt).sort().join() ===
					"mode,nativeAddonPermission,networkAllowed,ok,schemas" &&
				receipt.ok === true &&
				receipt.mode === mode &&
				receipt.networkAllowed === false &&
				receipt.nativeAddonPermission === true &&
				receipt.schemas === 7,
			"Native fixture success receipt",
		).toBe(true);
		// Stderr stays opaque. Allowing native addons does not establish OS isolation.
	} finally {
		cleanup();
	}
}

it("opens the built native storage export with delivered SQL, audit first and idempotent reopen", () => {
	compiled("healthy");
});

it("closes genuine compiled native storage when a delivered migration asset is missing", () => {
	compiled("missing-asset");
});

it("closes genuine compiled native storage when a migration transaction fails", () => {
	compiled("invalid-sql");
});
