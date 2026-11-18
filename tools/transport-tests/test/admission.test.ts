import path from "node:path";
import { describe, expect, it } from "vitest";
import { admitNative } from "../src/admission.ts";
import type { Outcome } from "../src/outcome.ts";
import type { Command } from "../src/run.ts";

const success = (): Outcome => ({
	started: true,
	code: 0,
	signal: null,
	timedOut: false,
	overflow: false,
	processError: false,
	terminationFailed: false,
	stdout: "DYTEST-version",
	stderr: "",
});

describe("native-store admission before filtering", () => {
	it("queries the real selected capabilities through fixed commands without constructing a store", async () => {
		const calls: Command[] = [];
		const result = await admitNative(
			path.resolve("repo"),
			"linux",
			{ CI: "true", NODE_OPTIONS: "DYTEST-unrelated" },
			"/node",
			async (command) => {
				calls.push(command);
				return success();
			},
			(name) => path.resolve(name),
		);
		expect(result.selection.store).toBe("secret-service");
		expect(calls.map((row) => row.args)).toEqual([
			["--version"],
			["--version"],
			["--host", "unix:///var/run/docker.sock", "info", "--format", "{{.ServerVersion}}"],
		]);
		expect(calls.every((row) => row.timeoutMs === 15_000)).toBe(true);
		expect(calls.every((row) => row.env.NODE_OPTIONS === undefined)).toBe(true);
	});
	it.each(["cargo", "node", "docker"] as const)(
		"refuses missing %s before returning any suite",
		async (missing) => {
			const cargo = path.resolve("cargo"),
				docker = path.resolve("docker");
			await expect(
				admitNative(
					path.resolve("repo"),
					"linux",
					{},
					"/node",
					async (command) =>
						command.executable ===
						(missing === "node" ? "/node" : missing === "cargo" ? cargo : docker)
							? { ...success(), code: 1 }
							: success(),
					(name) => (name === "cargo" ? cargo : docker),
				),
			).rejects.toThrow(`unavailable: ${missing}`);
		},
	);
	it("does not query Docker for a host that uses its own native store", async () => {
		const calls: Command[] = [];
		await admitNative(
			path.resolve("repo"),
			"darwin",
			{},
			"/node",
			async (command) => {
				calls.push(command);
				return success();
			},
			(name) => {
				if (name === "docker") throw Error("unexpected Docker");
				return path.resolve(name);
			},
		);
		expect(calls).toHaveLength(2);
	});
	it("does not turn timeout or spawn failure into an available resource", async () => {
		await expect(
			admitNative(
				path.resolve("repo"),
				"linux",
				{},
				"/node",
				async () => ({ ...success(), timedOut: true }),
				(name) => path.resolve(name),
			),
		).rejects.toThrow("cargo");
	});
});
