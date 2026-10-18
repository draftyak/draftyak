import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	checkDockerfile,
	DockerUnavailableError,
	dockerBuildArgs,
	dockerRunArgs,
	dockerStartArgs,
	type EngineState,
	ensure,
	linuxContainers,
	namedVolume,
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

describe("dockerStartArgs", () => {
	it("runs the same sandbox detached under Docker's init, publishing only on the host's loopback, and ends cmd after its lifetime", () => {
		const spec = {
			image,
			network: "bridge",
			cmd: ["caddy", "run"],
			publish: [8080, 9090],
		} as const;
		const args = dockerStartArgs({ ...spec, hostGateway: true }, "cid");
		const sandbox = dockerRunArgs(spec, "cid");
		expect(args.slice(0, sandbox.indexOf(image))).toEqual(sandbox.slice(0, sandbox.indexOf(image)));
		expect(args.slice(sandbox.indexOf(image))).toEqual([
			...["--detach", "--init", "--publish", "127.0.0.1::8080/tcp"],
			...["--publish", "127.0.0.1::9090/tcp", "--add-host", "host.docker.internal:host-gateway"],
			...[image, "timeout", "-s", "KILL", "600", "caddy", "run"],
		]);
		const short = dockerStartArgs(
			{ image, network: "none", cmd: ["true"], lifetimeMs: 2_500 },
			"c",
		);
		expect(short.slice(short.indexOf(image))).toEqual([
			image,
			"timeout",
			"-s",
			"KILL",
			"3",
			"true",
		]);
		expect(short).toContain("--detach");
	});

	it("refuses ports and host.docker.internal off the bridge network, bad ports and lifetimes, and no cmd", () => {
		const start = (change: object) => () =>
			dockerStartArgs({ image, network: "bridge", cmd: ["true"], ...change }, "c");
		expect(start({ network: "none", publish: [80] })).toThrow("need the bridge network");
		expect(start({ network: "none", hostGateway: true })).toThrow("need the bridge network");
		for (const port of [0, 65_536, 80.5, Number.NaN]) {
			expect(start({ publish: [port] })).toThrow("bad container port");
		}
		for (const lifetimeMs of [0, 999, 1_500.5, Number.POSITIVE_INFINITY]) {
			expect(start({ lifetimeMs })).toThrow("bad lifetime");
		}
		expect(start({ cmd: [] })).toThrow("needs a cmd");
		expect(start({ image: "caddy:2" })).toThrow("pin the image by digest");
		expect(start({ user: "0 --privileged" })).toThrow("bad user");
	});
});

describe("dockerBuildArgs", () => {
	const dockerfile = `FROM ${image}\nRUN apt-get update \\\n && apt-get install -y dbus\n`;
	const build = "0123456789ab";

	it("builds an untagged image with the kit's label and its own, on the given network", () => {
		const spec = { dockerfile, network: "bridge" } as const;
		expect(dockerBuildArgs(spec, "ctx", "meta.json", build)).toEqual([
			...["build", "--metadata-file", "meta.json", "--label", "org.draftyak.spike-kit=1"],
			...["--label", "org.draftyak.spike-kit.build=0123456789ab", "--network", "default"],
			...["--provenance=false", "--progress=plain", "ctx"],
		]);
		const offline = { dockerfile, network: "none", platform: "linux/arm64" } as const;
		expect(dockerBuildArgs(offline, "ctx", "m", build).join(" ")).toContain(
			"--network none --provenance=false --progress=plain --platform linux/arm64 ctx",
		);
		expect(dockerBuildArgs(spec, "ctx", "m", build)).not.toContain("--tag");
		expect(() => dockerBuildArgs(spec, "ctx", "m", "x --tag y")).toThrow("12 hex digits");
	});

	it("takes only digest-pinned bases (or earlier stages), and no context", () => {
		const args =
			(text: string, network = "none") =>
			() =>
				dockerBuildArgs({ dockerfile: text, network: network as "none" }, "ctx", "m", build);
		const pinned = `# syntax=docker/dockerfile:1@sha256:${"b".repeat(64)}\n`;
		expect(args(`${pinned}FROM --platform=linux/amd64 ${image} AS base\nfrom base`)).not.toThrow();
		expect(args("FROM debian:bookworm-slim")).toThrow("pin the image by digest");
		expect(args(`ARG BASE=${image}\nFROM \${BASE}`)).toThrow("pin the image by digest");
		expect(args(`FROM ${image} AS base\nFROM other`)).toThrow("FROM other");
		expect(args(`# syntax=docker/dockerfile:1\nFROM ${image}`)).toThrow("syntax directive");
		expect(args(`FROM ${image}\nCOPY a /a`)).toThrow("COPY needs a build context");
		expect(args(`FROM ${image}\nadd https://example.com/x /x`)).toThrow("ADD needs");
		expect(args("RUN true")).toThrow("no FROM");
		expect(args(dockerfile, "host")).toThrow("none or bridge");
		expect(() => checkDockerfile(`FROM ${image}`)).not.toThrow();
	});

	it("refuses an escape directive and RUN --mount, which could hide an unpinned image", () => {
		const args = (text: string) => () =>
			dockerBuildArgs({ dockerfile: text, network: "none" }, "ctx", "m", build);
		// With escape=`, Docker reads the FROM below as a new stage, not as part of the RUN line.
		const escaped = `# escape=\`\nFROM ${image}\nRUN echo ok \\\nFROM debian:bookworm\n`;
		expect(args(escaped)).toThrow("no escape directive");
		expect(args(`#ESCAPE = \\\nFROM ${image}`)).toThrow("no escape directive");
		const mount = "--mount=type=bind,from=alpine:latest,target=/a";
		expect(args(`FROM ${image}\nRUN ${mount} true`)).toThrow("RUN --mount");
		expect(args(`FROM ${image}\nrun --network=none ${mount} true`)).toThrow("RUN --mount");
		expect(args(`FROM ${image}\nRUN --mount=type=cache,target=/c true`)).toThrow("RUN --mount");
		expect(args(`FROM ${image}\nRUN mount --mount=x || true`)).not.toThrow();
	});

	it("names volumes in kebab-case only", async () => {
		await expect(namedVolume("S05 Cargo")).rejects.toThrow("kebab-case");
		await expect(namedVolume("../x")).rejects.toThrow("kebab-case");
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
