import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	DockerUnavailableError,
	dockerRunArgs,
	type EngineState,
	ensure,
	linuxContainers,
	stageForDocker,
} from "../docker.ts";
import { repoRoot } from "../repo.ts";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "draftyak-kit-docker-")));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const image = `debian:bookworm-slim@sha256:${"a".repeat(64)}`;

describe("dockerRunArgs", () => {
	it("runs an unnamed --rm container in the sandbox, with read-only binds", () => {
		const mounts = [
			{ source: dir, target: "/stage" },
			{ volume: "draftyak-cargo", target: "/cargo" },
		];
		const env = { CARGO_HOME: "/cargo" };
		const spec = { image, network: "none", platform: "linux/arm64", mounts, env } as const;
		expect(dockerRunArgs({ ...spec, workdir: "/stage", cmd: ["node", "a.mjs"] }, "cid")).toEqual([
			...["run", "--rm", "--cidfile", "cid", "--label", "org.draftyak.spike-kit=1"],
			...["--network", "none", "--user", "65534:65534", "--cap-drop=ALL"],
			...["--security-opt=no-new-privileges", "--pids-limit=1024", "--memory=4g"],
			...["--read-only", "--tmpfs", "/tmp", "--platform", "linux/arm64", "--workdir", "/stage"],
			...["--env", "CARGO_HOME=/cargo"],
			...["--mount", `type=bind,source=${dir},target=/stage,readonly`],
			...["--mount", "type=volume,source=draftyak-cargo,target=/cargo"],
			...[image, "node", "a.mjs"],
		]);
		const root = { image, network: "bridge", cmd: [], user: "0:0", writableRoot: true } as const;
		expect(dockerRunArgs({ ...root, memory: "8g" }, "c").join(" ")).toContain(
			"--user 0:0 --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=1024 --memory=8g",
		);
		expect(dockerRunArgs(root, "c")).not.toContain("--read-only");
	});

	it("refuses unpinned images, other networks and unsafe mounts", () => {
		const run = (change: object) => () =>
			dockerRunArgs({ image, network: "bridge", cmd: [], ...change }, "c");
		const bind = (source: string, target = "/x") => run({ mounts: [{ source, target }] });
		expect(run({ image: "debian:bookworm-slim" })).toThrow("pin the image by digest");
		expect(run({ network: "host" })).toThrow("none or bridge");
		expect(run({ user: "0 --privileged" })).toThrow("bad user");
		expect(bind("relative")).toThrow("absolute paths");
		expect(bind(`${dir},x`)).toThrow("without commas");
		expect(bind(`${dir}\nx`)).toThrow("control characters");
		expect(bind(dir, "x")).toThrow("bad container path");
		expect(bind(dir, "/stage\n")).toThrow("bad container path");
		expect(bind(dir, "/stage\r,readonly=false")).toThrow("bad container path");
		fs.mkdirSync(path.join(dir, "real", "inner"), { recursive: true });
		fs.symlinkSync(path.join(dir, "real"), path.join(dir, "via-junction"), "junction");
		expect(bind(path.join(dir, "via-junction", "inner"))).toThrow("runs through a link");
	});
});

describe("ensure", () => {
	const up: EngineState = { serverVersion: "29.4.0", osType: "linux" };
	const down: EngineState = { error: "open //./pipe/dockerDesktopLinuxEngine: not found" };
	const after = (failures: number) => async () => (failures-- > 0 ? down : up);
	const never = async () => down;
	const desktop = process.execPath;

	it("leaves a running daemon alone, or starts Docker Desktop once and waits", async () => {
		const started: string[] = [];
		const start = (exe: string) => started.push(exe);
		expect(await ensure({ probe: after(0), start })).toEqual({
			serverVersion: "29.4.0",
			started: false,
			waitedMs: 0,
		});
		const info = await ensure({ probe: after(3), start, desktop, pollMs: 10, env: {} });
		expect([info.started, started]).toEqual([true, [desktop]]);
	});

	it("says why it gives up, and starts nothing it shouldn't", async () => {
		const start = () => {
			throw new Error("must not start");
		};
		const fail = (options: object) =>
			expect(ensure({ probe: never, start, desktop, pollMs: 10, env: {}, ...options })).rejects;
		await fail({ timeoutMs: 100, start: () => {} }).toThrow(
			new DockerUnavailableError(
				`docker info failed (${down.error}); Docker Desktop didn't start within 0 s`,
			),
		);
		await fail({ desktop: null }).toThrow("there is no Docker Desktop to start");
		await fail({ env: { TURBO_HASH: "1" } }).toThrow("doesn't start Docker Desktop inside turbo");
		await fail({ env: { DOCKER_HOST: "tcp://elsewhere:2375" } }).toThrow("another engine");
		await fail({ env: { DOCKER_CONTEXT: "remote" } }).toThrow("another engine");
		await fail({ desktop: path.join(dir, "missing.exe") }).toThrow(DockerUnavailableError);
		const windows: EngineState = { serverVersion: "29.7.2", osType: "windows" };
		await fail({ probe: async () => windows }).toThrow("switch it to Linux containers");
	});

	it("turns a failed launch into DockerUnavailableError", async () => {
		const notAProgram = path.join(dir, "not-a-program.txt");
		fs.writeFileSync(notAProgram, "");
		const options = { probe: never, desktop: notAProgram, pollMs: 20, timeoutMs: 5_000, env: {} };
		await expect(ensure(options)).rejects.toThrow("starting Docker Desktop failed");
	});
});

describe("linuxContainers", () => {
	const cliDir = path.join(dir, "bin");
	fs.mkdirSync(cliDir);
	fs.writeFileSync(path.join(cliDir, process.platform === "win32" ? "docker.exe" : "docker"), "");
	const fake = { env: { PATH: cliDir }, desktop: path.join(dir, "no-desktop.exe") };

	it("routes Docker cases away from engines that only run Windows containers", () => {
		const windows = { ...fake, platform: "win32" as const };
		expect(linuxContainers({ ...windows, engineOs: () => "windows" })).toBe(false);
		expect(linuxContainers({ ...windows, engineOs: () => "linux" })).toBe(true);
		expect(linuxContainers({ ...windows, desktop: process.execPath, engineOs: () => "" })).toBe(
			true,
		);
		expect(linuxContainers({ ...fake, platform: "linux", engineOs: () => "windows" })).toBe(true);
	});
});

describe("stageForDocker", () => {
	// A spike as pnpm lays it out on Windows: its dependency is a junction into the store.
	const from = path.join(dir, "spike");
	fs.mkdirSync(path.join(from, "fixtures"), { recursive: true });
	fs.mkdirSync(path.join(from, "node_modules", "@types"), { recursive: true });
	fs.mkdirSync(path.join(dir, "outside"));
	fs.writeFileSync(path.join(dir, "outside", "inner.txt"), "through a link\n");
	fs.symlinkSync(path.join(dir, "outside"), path.join(from, "fixtures", "linked"), "junction");
	const typesNode = fs.realpathSync(path.join(repoRoot, "node_modules", "@types", "node"));
	fs.symlinkSync(typesNode, path.join(from, "node_modules", "@types", "node"), "junction");

	it("copies realpath-resolved packages and fixtures into a link-free folder", () => {
		using stage = stageForDocker(
			{ name: "kit-test", from, packages: ["@types/node"], files: ["fixtures"] },
			{ cacheDir: dir },
		);
		expect(path.dirname(stage.dir)).toBe(path.join(dir, "docker-stage"));
		const manifest = fs.readFileSync(
			path.join(stage.dir, "node_modules", "@types", "node", "package.json"),
			"utf8",
		);
		expect(JSON.parse(manifest)).toMatchObject({ name: "@types/node" });
		expect(fs.readFileSync(path.join(stage.dir, "fixtures", "linked", "inner.txt"), "utf8")).toBe(
			"through a link\n",
		);
		for (const entry of ["fixtures/linked", "node_modules/@types/node"]) {
			expect(fs.lstatSync(path.join(stage.dir, entry)).isSymbolicLink()).toBe(false);
		}
		if (process.platform !== "win32") expect(fs.statSync(stage.dir).mode & 0o777).toBe(0o755);
		stage.remove();
		expect(fs.existsSync(stage.dir)).toBe(false);
	});

	it("refuses bad names, paths outside the spike and missing packages", () => {
		const stage = (change: object) => () =>
			stageForDocker({ name: "kit-test", from, ...change }, { cacheDir: dir });
		expect(stage({ name: "Kit Test" })).toThrow("kebab-case");
		expect(stage({ files: ["../outside"] })).toThrow("paths inside");
		expect(stage({ packages: ["../../outside"] })).toThrow("not a package name");
		expect(stage({ packages: ["not-installed-anywhere"] })).toThrow("isn't installed");
	});
});
