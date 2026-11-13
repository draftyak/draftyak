import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createLinuxSuite, linuxCaseNames } from "../src/linux-store.ts";
import type { NativeContext } from "../src/native.ts";
import type { Outcome } from "../src/outcome.ts";
import type { Command } from "../src/run.ts";

const ok = (stdout = ""): Outcome => ({
	started: true,
	code: 0,
	signal: null,
	timedOut: false,
	overflow: false,
	processError: false,
	terminationFailed: false,
	stdout,
	stderr: "",
});
function fixture(change?: (command: Command, result: Outcome) => Outcome) {
	const calls: Command[] = [];
	const created = new Map<string, readonly string[]>();
	let owner = "";
	const context: NativeContext = {
		root: "/repo with space",
		docker: "/usr/bin/docker",
		cargo: "/usr/bin/cargo",
		node: "/selected/node",
		platform: "linux",
		environment: {
			PATH: "/usr/bin",
			HOME: "/disposable-home",
			DOCKER_HOST: "tcp://DYTEST.invalid",
			DOCKER_CONTEXT: "DYTEST-remote",
			NODE_OPTIONS: "DYTEST-options",
			RUSTFLAGS: "DYTEST-flags",
		},
		runner: async (command) => {
			calls.push(command);
			const args = command.args.slice(2);
			let result = ok();
			if (args.includes("--label"))
				owner = (args[args.indexOf("--label") + 1] ?? "").split("=")[1] ?? "";
			if (args[1] === "inspect") result = ok(`${owner}\n`);
			if (args[0] === "create") {
				const id = (created.size + 1).toString(16).padStart(64, "0");
				created.set(id, args);
				result = ok(`${id}\n`);
			}
			if (args[0] === "start") {
				const input = created.get(args.at(-1) as string);
				if (input === undefined) throw new Error("Unknown fake container");
				const script = input.indexOf(
					"/work/tools/transport-tests/fixtures/linux-store/linux-checks.sh",
				);
				const marker = script < 0 ? "" : `DYTEST linux-store verified state=${input[script + 1]}\n`;
				const separator = input.lastIndexOf("--");
				const test = input.includes("test") ? input[separator - 1] : undefined;
				result = ok(
					marker +
						(test === undefined
							? ""
							: `running 1 test\ntest ${test} ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out; finished in 0.01s\n`),
				);
			}
			return change?.(command, result) ?? result;
		},
	};
	return { calls, context, suite: createLinuxSuite(context) };
}

async function prepare(f: ReturnType<typeof fixture>): Promise<void> {
	await f.suite.cases[0]?.work();
	await f.suite.cases[1]?.work();
}

describe("disposable Linux native-store suite", () => {
	it("provisions every repository Rust component in the image before offline containers", () => {
		const toolchain = readFileSync(
			new URL("../../../rust-toolchain.toml", import.meta.url),
			"utf8",
		);
		const dockerfile = readFileSync(
			new URL("../fixtures/linux-store/Dockerfile", import.meta.url),
			"utf8",
		);
		const required = /components\s*=\s*\[([^\]]+)\]/.exec(toolchain)?.[1];
		const version = /channel\s*=\s*"([0-9.]+)"/.exec(toolchain)?.[1];
		const provisioned = /^RUN rustup component add (.+) --toolchain ([0-9.]+)$/m.exec(dockerfile);
		expect(required).toBeDefined();
		expect(version).toBeDefined();
		expect(provisioned).not.toBeNull();
		const components = [...(required ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
		expect(components.length).toBeGreaterThan(0);
		expect(provisioned?.[1]?.split(/\s+/)).toEqual(expect.arrayContaining(components));
		expect(provisioned?.[2]).toBe(version);
	});
	it("constructs without effects and registers every required case once", async () => {
		const f = fixture();
		expect(f.calls).toHaveLength(0);
		expect(f.suite.cases.map((value) => value.name)).toEqual(linuxCaseNames());
		expect(new Set(linuxCaseNames()).size).toBe(15);
		await f.suite.close();
		expect(f.calls).toHaveLength(0);
		await expect(f.suite.cases[0]?.work()).rejects.toThrow("closed");
	});
	it("runs locked preparation then only offline isolated commands and owned cleanup", async () => {
		const f = fixture();
		for (const step of f.suite.cases) await step.work();
		await f.suite.close();
		const count = f.calls.length;
		await f.suite.close();
		expect(f.calls).toHaveLength(count);
		for (const command of f.calls) {
			expect(command.executable).toBe("/usr/bin/docker");
			expect(command.args.slice(0, 2)).toEqual(["--host", "unix:///var/run/docker.sock"]);
			expect(command.env).toEqual({ PATH: "/usr/bin", HOME: "/disposable-home" });
			expect(command.timeoutMs).toBeLessThan(300_000);
			expect(command.args).not.toContain("prune");
		}
		const containers = f.calls.filter((call) => call.args[2] === "create");
		expect(containers).toHaveLength(14);
		const fetch = containers[0]?.args ?? [];
		expect(fetch).toContain("bridge");
		expect(fetch.slice(-5)).toEqual([
			"/usr/local/cargo/bin/cargo",
			"fetch",
			"--locked",
			"--manifest-path",
			"crates/Cargo.toml",
		]);
		for (const call of containers) {
			expect(call.args).toContain("type=bind,source=/repo with space,target=/work,readonly");
			expect(call.args).toContain("type=bind,source=/selected/node,target=/node/bin/node,readonly");
			expect(call.args).not.toContain("--privileged");
		}
		for (const call of containers.slice(1)) {
			expect(call.args).toContain("none");
			expect(call.args).toContain("CARGO_NET_OFFLINE=true");
			expect(call.args).toContain("--offline");
			expect(call.args).not.toContain("--all-features");
		}
		const failures = containers.slice(-4);
		expect(
			failures.map(
				(call) =>
					call.args[
						call.args.indexOf("/work/tools/transport-tests/fixtures/linux-store/linux-checks.sh") +
							1
					],
			),
		).toEqual(["no-bus", "no-service", "no-collection", "locked"]);
		for (const call of failures) {
			expect(call.args[call.args.indexOf("--features") + 1]).toBe("native-store");
			expect(call.args).toContain(
				"key_store::linux_environment::native_store_unavailable_has_no_fallback",
			);
			expect(call.args).toContain("--lib");
			expect(call.args).toContain("--exact");
			expect(call.args).toContain("--ignored");
		}
		expect(
			f.calls.filter((call) => call.args[2] === "container" && call.args[3] === "rm"),
		).toHaveLength(14);
		expect(
			f.calls.filter((call) => call.args[2] === "volume" && call.args[3] === "rm"),
		).toHaveLength(3);
		expect(
			f.calls.filter((call) => call.args[2] === "image" && call.args[3] === "rm"),
		).toHaveLength(1);
	});
	it("refuses a selected execution whose locked preparation never ran", async () => {
		const f = fixture();
		await expect(f.suite.cases[2]?.work()).rejects.toThrow("locked dependencies");
		expect(f.calls).toHaveLength(0);
		await f.suite.close();
	});
	it.each(["missing", "wrong", "duplicate"])(
		"refuses a %s verified-state marker despite a successful Rust test",
		async (mode) => {
			const f = fixture((command, result) => {
				if (command.args[2] !== "start") return result;
				if (!result.stdout.includes("verified state=")) return result;
				const stdout =
					mode === "missing"
						? result.stdout.replace(/^DYTEST[^\n]*\n/, "")
						: mode === "wrong"
							? result.stdout.replace("state=healthy", "state=locked")
							: `${result.stdout}DYTEST linux-store verified state=healthy\n`;
				return { ...result, stdout };
			});
			await prepare(f);
			await expect(f.suite.cases[10]?.work()).rejects.toThrow("state was not verified");
			await f.suite.close();
		},
	);
	it("never accepts a verified state whose required Rust selector ran zero tests", async () => {
		const f = fixture((command, result) =>
			command.args[2] === "start" && result.stdout.includes("verified state=")
				? {
						...result,
						stdout:
							"DYTEST linux-store verified state=no-bus\nrunning 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.01s\n",
					}
				: result,
		);
		await prepare(f);
		await expect(f.suite.cases[11]?.work()).rejects.toThrow("exactly once");
		await f.suite.close();
	});
	it.each(["code", "timeout", "overflow"])(
		"fails closed on process %s and still removes the owned container",
		async (mode) => {
			const f = fixture((command, result) =>
				command.args[2] === "start"
					? {
							...result,
							code: mode === "code" ? 1 : 0,
							timedOut: mode === "timeout",
							overflow: mode === "overflow",
						}
					: result,
			);
			await f.suite.cases[0]?.work();
			await expect(f.suite.cases[1]?.work()).rejects.toThrow("command failed");
			expect(f.calls.some((call) => call.args[2] === "container" && call.args[3] === "rm")).toBe(
				true,
			);
			const before = f.calls.length;
			await expect(f.suite.cases[2]?.work()).rejects.toThrow("failed");
			expect(f.calls).toHaveLength(before);
			await f.suite.close();
		},
	);
	it.each([
		[false, "collections"],
		[true, "collections"],
		[false, "collections-query"],
		[false, "collections-shape"],
		[false, "collections-empty"],
	] as const)(
		"reports only fixed failure metadata when the state marker is %s and stage is %s",
		async (verified, stage) => {
			const f = fixture((command, result) =>
				command.args[2] === "start" && result.stdout.includes("state=no-collection")
					? {
							...result,
							code: 3,
							stdout: verified
								? "DYTEST linux-store verified state=no-collection\nDYTEST-untrusted-output\n"
								: "DYTEST-untrusted-output\n",
							stderr: `DYTEST-untrusted-diagnostic\nDYTEST linux-store failed stage=${stage}\n`,
						}
					: result,
			);
			await prepare(f);
			await expect(f.suite.cases[13]?.work()).rejects.toMatchObject({
				message: `Native-store test command failed (state=no-collection; code=3; signal=none; started=true; timedOut=false; overflow=false; processError=false; terminationFailed=false; stateVerified=${verified}; stage=${stage})`,
			});
			await f.suite.close();
		},
	);
	it.each([
		"DYTEST linux-store failed stage=DYTEST-untrusted\n",
		"DYTEST linux-store failed stage=collections\nDYTEST linux-store failed stage=collections\n",
	])("refuses to project unknown or duplicate failure stages", async (stderr) => {
		const f = fixture((command, result) =>
			command.args[2] === "start" && result.stdout.includes("state=no-collection")
				? { ...result, code: 1, stderr }
				: result,
		);
		await prepare(f);
		await expect(f.suite.cases[13]?.work()).rejects.toMatchObject({
			message:
				"Native-store test command failed (state=no-collection; code=1; signal=none; started=true; timedOut=false; overflow=false; processError=false; terminationFailed=false; stateVerified=true; stage=unknown)",
		});
		await f.suite.close();
	});
	it("projects a fixed setup stage from attached stdout without exposing backend output", async () => {
		const f = fixture((command, result) =>
			command.args[2] === "start" && result.stdout.includes("state=no-collection")
				? {
						...result,
						code: 73,
						stdout: "DYTEST-untrusted-output\nDYTEST linux-store failed stage=collections-empty\n",
						stderr: "DYTEST-untrusted-diagnostic\n",
					}
				: result,
		);
		await prepare(f);
		await expect(f.suite.cases[13]?.work()).rejects.toMatchObject({
			message:
				"Native-store test command failed (state=no-collection; code=73; signal=none; started=true; timedOut=false; overflow=false; processError=false; terminationFailed=false; stateVerified=false; stage=collections-empty)",
		});
		await f.suite.close();
	});
	it("projects no ambiguous stage when the attached streams duplicate it", async () => {
		const marker = "DYTEST linux-store failed stage=collections-empty\n";
		const f = fixture((command, result) =>
			command.args[2] === "start" && result.stdout.includes("state=no-collection")
				? { ...result, code: 73, stdout: result.stdout + marker, stderr: marker }
				: result,
		);
		await prepare(f);
		await expect(f.suite.cases[13]?.work()).rejects.toMatchObject({
			message:
				"Native-store test command failed (state=no-collection; code=73; signal=none; started=true; timedOut=false; overflow=false; processError=false; terminationFailed=false; stateVerified=true; stage=unknown)",
		});
		await f.suite.close();
	});
	it("keeps failed outcome flags bounded without projecting arbitrary codes or signals", async () => {
		const f = fixture((command, result) =>
			command.args[2] === "start" && result.stdout.includes("state=no-collection")
				? {
						...result,
						code: 65_536,
						signal: "DYTEST-untrusted-signal",
						timedOut: true,
						overflow: true,
						processError: true,
						terminationFailed: true,
					}
				: result,
		);
		await prepare(f);
		await expect(f.suite.cases[13]?.work()).rejects.toMatchObject({
			message:
				"Native-store test command failed (state=no-collection; code=unknown; signal=unknown; started=true; timedOut=true; overflow=true; processError=true; terminationFailed=true; stateVerified=true; stage=unknown)",
		});
		await f.suite.close();
	});
	it("refuses foreign volume ownership and never deletes that volume while draining image cleanup", async () => {
		const f = fixture((command, result) =>
			command.args[2] === "volume" && command.args[3] === "inspect"
				? ok("DYTEST-foreign-owner\n")
				: result,
		);
		await expect(f.suite.cases[0]?.work()).rejects.toThrow("ownership differs");
		await expect(f.suite.close()).rejects.toThrow("cleanup did not complete");
		expect(f.calls.some((call) => call.args[2] === "volume" && call.args[3] === "rm")).toBe(false);
		expect(f.calls.some((call) => call.args[2] === "image" && call.args[3] === "rm")).toBe(true);
	});
	it("continues all owned cleanup after one container removal fails", async () => {
		const f = fixture((command, result) =>
			command.args[2] === "container" && command.args[3] === "rm" ? { ...result, code: 1 } : result,
		);
		await f.suite.cases[0]?.work();
		await expect(f.suite.cases[1]?.work()).rejects.toThrow("command failed");
		await expect(f.suite.close()).rejects.toThrow("cleanup did not complete");
		expect(
			f.calls.filter((call) => call.args[2] === "volume" && call.args[3] === "rm"),
		).toHaveLength(3);
		expect(f.calls.some((call) => call.args[2] === "image" && call.args[3] === "rm")).toBe(true);
	});
	it("stops exhausted work commands and gives owned cleanup its independent budget", async () => {
		let clock = 0;
		let cleanup = false;
		const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
		try {
			const f = fixture((command, result) => {
				if (command.args[2] === "start" && !cleanup) clock += 240_001;
				else if (cleanup) clock += 1_000;
				return result;
			});
			await f.suite.cases[0]?.work();
			await expect(f.suite.cases[1]?.work()).rejects.toThrow("budget exhausted");
			expect(f.calls.at(-1)?.args[2]).toBe("start");
			const before = f.calls.length;
			cleanup = true;
			await f.suite.close();
			expect(f.calls.slice(before).every((call) => call.timeoutMs <= 45_000)).toBe(true);
			expect(f.calls.some((call) => call.args[2] === "container" && call.args[3] === "rm")).toBe(
				true,
			);
			expect(
				f.calls.filter((call) => call.args[2] === "volume" && call.args[3] === "rm"),
			).toHaveLength(3);
			expect(f.calls.at(-1)?.args.slice(2, 4)).toEqual(["image", "rm"]);
		} finally {
			now.mockRestore();
		}
	});
	it("clamps every remaining setup command to the single monotonic work deadline", async () => {
		let clock = 0;
		const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
		try {
			const f = fixture((command, result) => {
				if (command.args[2] === "build") clock += 230_000;
				return result;
			});
			await f.suite.cases[0]?.work();
			expect(f.calls[0]?.timeoutMs).toBe(240_000);
			expect(f.calls.slice(1).every((call) => call.timeoutMs === 10_000)).toBe(true);
			await f.suite.close();
		} finally {
			now.mockRestore();
		}
	});
	it("issues no further command after its aggregate cleanup budget expires", async () => {
		let clock = 0;
		let cleanup = false;
		const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
		try {
			const f = fixture((_command, result) => {
				if (cleanup) clock += 45_001;
				return result;
			});
			await f.suite.cases[0]?.work();
			const before = f.calls.length;
			cleanup = true;
			await expect(f.suite.close()).rejects.toThrow("cleanup did not complete");
			expect(f.calls.length - before).toBe(1);
			expect(f.calls.at(-1)?.timeoutMs).toBe(30_000);
		} finally {
			now.mockRestore();
		}
	});
	it("retains an owned pending container name when create fails before returning an id", async () => {
		const f = fixture((command, result) =>
			command.args[2] === "create" ? { ...result, code: 1, stdout: "" } : result,
		);
		await f.suite.cases[0]?.work();
		await expect(f.suite.cases[1]?.work()).rejects.toThrow("command failed");
		const create = f.calls.find((call) => call.args[2] === "create");
		const name = create?.args[(create?.args.indexOf("--name") ?? -1) + 1];
		expect(name).toMatch(/^draftyak-native-store-[a-f0-9-]+-1$/);
		await f.suite.close();
		expect(
			f.calls.some(
				(call) =>
					call.args[2] === "container" && call.args[3] === "rm" && call.args.at(-1) === name,
			),
		).toBe(true);
	});
	it.each(["platform", "docker", "root", "node"])(
		"refuses invalid %s before any runner call",
		(field) => {
			const f = fixture();
			const invalid = {
				...f.context,
				[field]: field === "platform" ? "win32" : field === "docker" ? undefined : "/bad,mount",
			};
			expect(() => createLinuxSuite(invalid)).toThrow("absolute local paths");
			expect(f.calls).toHaveLength(0);
		},
	);
	it("pins the admitted image and checks real session, service and collection state before execution", () => {
		const dockerfile = readFileSync(
			new URL("../fixtures/linux-store/Dockerfile", import.meta.url),
			"utf8",
		);
		const script = readFileSync(
			new URL("../fixtures/linux-store/linux-checks.sh", import.meta.url),
			"utf8",
		);
		expect(dockerfile).toContain(
			"rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1",
		);
		expect(dockerfile).toContain("org.freedesktop.secrets.service");
		expect(script).toContain("org.freedesktop.DBus.ListNames");
		expect(script).toContain("org.freedesktop.DBus.NameHasOwner");
		expect(script).toContain("org.freedesktop.Secret.Service.ReadAlias");
		expect(script).toContain("org.freedesktop.Secret.Service.Lock");
		expect(script).toContain("string:org.freedesktop.Secret.Collection string:Locked");
		expect(script.indexOf("is_locked true || exit 1")).toBeLessThan(
			script.indexOf("DYTEST linux-store verified state="),
		);
		expect(script.indexOf("DYTEST linux-store verified state=")).toBeLessThan(
			script.indexOf('exec "$@"'),
		);
		expect(script).not.toContain("spike-keyring");
	});
});
