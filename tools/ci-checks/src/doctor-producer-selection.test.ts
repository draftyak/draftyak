import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTurbo } from "../../verify/lib/tools.ts";
import { classify } from "./changes.ts";

const repository = path.resolve(import.meta.dirname, "../../..");

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected task-query metadata object");
	}
	return value as Record<string, unknown>;
}

function metadata(file: string): Record<string, unknown> {
	try {
		return record(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		throw new Error("Selected package metadata is unavailable");
	}
}

function heavyScript(folder: string, name: string): string {
	const manifest = metadata(path.join(repository, folder, "package.json"));
	expect(manifest.name).toBe(name);
	const script = record(manifest.scripts)["test:heavy"];
	if (typeof script !== "string" || script.trim() === "") {
		throw new Error("Selected package has no heavy task");
	}
	return script;
}

function removeQueryDirectory(
	directory: string,
	temporary: string,
	original: { readonly dev: bigint; readonly ino: bigint },
): void {
	const current = lstatSync(directory, { bigint: true });
	if (
		path.dirname(directory) !== temporary ||
		!path.basename(directory).startsWith("dq-") ||
		!current.isDirectory() ||
		current.isSymbolicLink() ||
		current.dev !== original.dev ||
		current.ino !== original.ino ||
		realpathSync.native(directory) !== directory
	)
		throw new Error("Invalid task-query cleanup scope");
	rmSync(directory, { recursive: true, force: true });
	expect(lstatSync(directory, { throwIfNoEntry: false })).toBeUndefined();
}

function dryHeavyTasks(filters: readonly string[]): readonly Record<string, unknown>[] {
	const workspace = metadata(path.join(repository, "package.json"));
	const fromRoot = createRequire(path.join(repository, "package.json"));
	const turbo = metadata(fromRoot.resolve("turbo/package.json"));
	expect(turbo.name).toBe("turbo");
	expect(turbo.version).toBe(record(workspace.devDependencies).turbo);

	const cache = path.join(repository, ".cache");
	mkdirSync(cache, { recursive: true });
	const parent = lstatSync(cache);
	if (!parent.isDirectory() || parent.isSymbolicLink())
		throw new Error("Invalid task-query scratch parent");
	const temporary = realpathSync.native(cache);
	const directory = mkdtempSync(path.join(temporary, "dq-"));
	const original = lstatSync(directory, { bigint: true });
	const failures: unknown[] = [];
	let tasks: readonly Record<string, unknown>[] = [];
	try {
		const createLocation = (name: string): string => {
			const location = path.join(directory, name);
			mkdirSync(location);
			return location;
		};
		const locations = {
			home: createLocation("home"),
			cache: createLocation("cache"),
			config: createLocation("config"),
			state: createLocation("state"),
			appdata: createLocation("appdata"),
			localappdata: createLocation("localappdata"),
		};
		const env: NodeJS.ProcessEnv = {
			CI: "true",
			DO_NOT_TRACK: "1",
			TURBO_TELEMETRY_DISABLED: "1",
			TURBO_CONFIG_DIR_PATH: locations.config,
			PATH: [
				path.dirname(process.execPath),
				path.dirname(resolveTurbo(repository)),
				process.env.PATH ?? process.env.Path ?? "",
			]
				.filter(Boolean)
				.join(path.delimiter),
			HOME: locations.home,
			USERPROFILE: locations.home,
			XDG_CACHE_HOME: locations.cache,
			XDG_CONFIG_HOME: locations.config,
			XDG_STATE_HOME: locations.state,
			APPDATA: locations.appdata,
			LOCALAPPDATA: locations.localappdata,
			TEMP: temporary,
			TMP: temporary,
		};
		for (const key of ["SystemRoot", "WINDIR"] as const) {
			if (process.env[key] !== undefined) env[key] = process.env[key];
		}
		// Query the real task graph through its normal launcher; no task is executed.
		const result = spawnSync(
			process.execPath,
			[
				path.join(repository, "tools/verify/turbo.ts"),
				"run",
				"test:heavy",
				"--dry=json",
				"--cache-dir",
				locations.cache,
				...filters.map((filter) => `--filter=${filter}`),
			],
			{
				cwd: repository,
				env,
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
				windowsHide: true,
				shell: false,
			},
		);
		if (result.error || result.signal !== null || result.status !== 0) {
			throw new Error("Real Turbo task query failed");
		}
		let report: Record<string, unknown>;
		try {
			report = record(JSON.parse(result.stdout));
		} catch {
			throw new Error("Real Turbo task query returned invalid metadata");
		}
		if (!Array.isArray(report.tasks)) throw new Error("Real Turbo task query omitted tasks");
		tasks = report.tasks.map(record);
	} catch (error) {
		failures.push(error);
	}
	try {
		removeQueryDirectory(directory, temporary, original);
	} catch (error) {
		failures.push(error);
	}
	if (failures.length !== 0)
		throw new AggregateError(failures, "Real Turbo task query or cleanup failed");
	return tasks;
}

describe("Doctor compiled-consumer producer selection", () => {
	it.each([
		["Doctor source", "tools/doctor/diagnostics.ts"],
		["CLI build producer", "apps/cli/scripts/build.ts"],
	] as const)("retains real Doctor and CLI heavy tasks for a %s change", (_name, changed) => {
		const selected = classify([changed], repository);
		expect(selected.docsOnly).toBe(false);
		expect(selected.heavy.length).toBeGreaterThan(0);
		const expected = [
			["@draftyak/doctor", heavyScript("tools/doctor", "@draftyak/doctor")],
			["@draftyak/cli", heavyScript("apps/cli", "@draftyak/cli")],
		] as const;
		const tasks = dryHeavyTasks(selected.heavy);
		for (const [name, command] of expected) {
			const matches = tasks.filter((task) => task.taskId === `${name}#test:heavy`);
			if (matches.length !== 1) throw new Error(`Expected one ${name} heavy task`);
			expect(matches[0]?.command).toBe(command);
		}
	});
});
