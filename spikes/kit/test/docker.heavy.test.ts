import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
	buildImage,
	type DockerVolume,
	dockerDesktop,
	findDocker,
	LABEL,
	namedVolume,
	needDocker,
	runInDocker,
	stageForDocker,
	startInDocker,
} from "../docker.ts";
import { exec, sleep } from "../exec.ts";
import { kitDir, repoRoot } from "../repo.ts";

// Pinned at first use (2026-10-17): the multi-arch OCI index of debian:bookworm-slim. It has no
// libatomic1, so containers that run Node use M0.5's node:<v>-bookworm-slim pin instead.
const DEBIAN =
	"debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587";
const options = { tags: ["requires:docker"], timeout: 420_000 };

// --rm removes a container shortly after it stops.
async function gone(id: string, tries = 40): Promise<boolean> {
	for (let tried = 0; tried < tries; tried++) {
		const listed = await exec(findDocker() ?? "docker", ["ps", "-aq", "--filter", `id=${id}`]);
		if (listed.code === 0 && listed.stdout.trim() === "") return true;
		await sleep(250);
	}
	return false;
}

it(
	"starts Docker if needed, then runs a pinned container in the sandbox on a read-only stage",
	options,
	async (ctx) => {
		const info = await needDocker(ctx);
		console.log(
			`docker ${info.serverVersion}: started ${info.started}, waited ${info.waitedMs} ms`,
		);
		const from = mkdtempSync(path.join(tmpdir(), "draftyak-kit-heavy-"));
		ctx.onTestFinished(() => rmSync(from, { recursive: true, force: true }));
		mkdirSync(path.join(from, "fixtures"));
		writeFileSync(path.join(from, "fixtures", "hello.txt"), "hello from the host\n");
		using stage = stageForDocker({ name: "kit-heavy", from, files: ["fixtures"] });
		const script = [
			"cat /stage/fixtures/hello.txt; id -u; ls /sys/class/net",
			"grep -E '^(CapEff|NoNewPrivs)' /proc/self/status",
			"touch /stage/x /x 2>&1 | sed 's/.*: //'; touch /tmp/ok && echo tmp ok",
		];
		const mounts = [{ source: stage.dir, target: "/stage" }];
		const run = { image: DEBIAN, network: "none", mounts, signal: ctx.signal } as const;
		const result = await runInDocker({ ...run, cmd: ["sh", "-c", script.join("; ")] });
		expect(result.stdout.split("\n")).toEqual([
			...["hello from the host", "65534", "lo", "CapEff:\t0000000000000000", "NoNewPrivs:\t1"],
			...["Read-only file system", "Read-only file system", "tmp ok", ""],
		]);
		expect(result.containerId).toMatch(/^[0-9a-f]{64}$/);
		expect(await gone(result.containerId)).toBe(true);

		const slow = await runInDocker({ ...run, cmd: ["sleep", "60"], timeoutMs: 3_000 });
		expect([slow.timedOut, await gone(slow.containerId)]).toEqual([true, true]);
	},
);

it(
	"gives each build of a Dockerfile its own image, keeps a named volume between runs, removes all",
	options,
	async (ctx) => {
		await needDocker(ctx);
		const docker = findDocker() ?? "docker";
		const inspect = (kind: "image" | "volume", name: string, format: string) =>
			exec(docker, [kind, "inspect", "--format", format, name]);
		const dockerfile = `FROM ${DEBIAN}\nRUN echo built > /built \\\n && chmod 0444 /built\n`;
		const build = () => buildImage({ dockerfile, network: "none", signal: ctx.signal });
		const suffix = `kit-heavy-${randomBytes(4).toString("hex")}`;
		const [name, bare] = [`draftyak-${suffix}`, `draftyak-${suffix}-bare`];
		const ids: string[] = [];
		let volume: DockerVolume | undefined;
		try {
			await using first = await build();
			await using second = await build();
			ids.push(first.id, second.id);
			expect(first.id).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(second.id).not.toBe(first.id);
			const label = `{{index .Config.Labels "${LABEL.split("=")[0]}"}}`;
			expect((await inspect("image", second.id, label)).stdout.trim()).toBe("1");
			volume = await namedVolume(suffix);
			expect(volume.name).toBe(name);
			const volumeLabel = await inspect("volume", name, "{{json .Labels}}");
			expect(JSON.parse(volumeLabel.stdout)).toEqual({ "org.draftyak.spike-kit": "1" });
			expect((await exec(docker, ["volume", "create", bare])).code).toBe(0);
			await expect(namedVolume(`${suffix}-bare`)).rejects.toThrow("without the kit's label");

			const run = { network: "none", signal: ctx.signal, user: "0:0" } as const;
			const mounts = [{ volume: name, target: "/shared" }];
			const cmd = ["sh", "-c", "cp /built /shared/x"];
			const write = await runInDocker({ ...run, image: first.id, mounts, cmd });
			await first.remove();
			// A later run finds the same volume, with what the first run left in it.
			expect((await namedVolume(suffix)).name).toBe(name);
			const read = await runInDocker({
				...run,
				image: second.id,
				mounts,
				cmd: ["cat", "/shared/x"],
			});
			expect([write.code, read.code, read.stdout]).toEqual([0, 0, "built\n"]);
			expect(await gone(read.containerId)).toBe(true);
		} finally {
			await exec(docker, ["volume", "rm", bare]);
			await volume?.remove();
			await volume?.remove();
		}
		const left = [
			...[name, bare].map((volume) => inspect("volume", volume, "{{.Name}}")),
			...ids.map((id) => inspect("image", id, "{{.Id}}")),
		];
		expect((await Promise.all(left)).map((result) => result.code)).not.toContain(0);
	},
);

// M0.5's pinned Alpine Node: the smallest image here that can serve HTTP.
const NODE = (
	JSON.parse(readFileSync(path.join(repoRoot, "tools", "fetch-node", "images.json"), "utf8")) as {
		musl: Record<string, string>;
	}
).musl["26.12.0"];

it(
	"starts a background container on a published loopback port, then stops and removes it",
	options,
	async (ctx) => {
		await needDocker(ctx);
		if (NODE === undefined) throw new Error("images.json has no musl 26.12.0 image");
		// Answers whether host.docker.internal resolves, which a Linux engine needs hostGateway for.
		const server = [
			'require("node:dns").lookup("host.docker.internal", (error) => {',
			'  require("node:http").createServer((_, res) => res.end(error ? "no host" : "host found"))',
			'    .listen(8080, () => console.log("listening on 8080"));',
			"});",
		].join("\n");
		const spec = { image: NODE, network: "bridge", signal: ctx.signal } as const;
		await using container = await startInDocker({
			...spec,
			publish: [8080],
			hostGateway: true,
			cmd: ["node", "-e", server],
		});
		expect(container.containerId).toMatch(/^[0-9a-f]{64}$/);
		expect(() => container.port(9090)).toThrow("isn't published");
		let body = "";
		for (let tries = 0; tries < 100 && body === ""; tries++) {
			body = await fetch(`http://127.0.0.1:${container.port(8080)}/`)
				.then((response) => response.text())
				.catch(() => sleep(100).then(() => ""));
		}
		expect(body).toBe("host found");
		expect(await container.logs()).toContain("listening on 8080");
		expect(await container.inspect(`{{index .Config.Labels "${LABEL.split("=")[0]}"}}`)).toBe("1");
		const bridge = await container.inspect(
			"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
		);
		expect(bridge).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
		await container.stop();
		expect(await gone(container.containerId)).toBe(true);
		await container.stop();
		const unpinned = { ...spec, image: NODE.split("@")[0] ?? "", cmd: ["true"] };
		await expect(startInDocker(unpinned)).rejects.toThrow("pin the image by digest");
		const desktop = await dockerDesktop();
		if (process.platform === "win32") expect(desktop).toBe(true);
		console.log(`engine: ${desktop ? "Docker Desktop" : "another engine"}`);
	},
);

it(
	"a started container ends itself after its lifetime, even when the process that started it is killed",
	options,
	async (ctx) => {
		await needDocker(ctx);
		if (NODE === undefined) throw new Error("images.json has no musl 26.12.0 image");
		const script = [
			`const { startInDocker } = await import(${JSON.stringify(pathToFileURL(path.join(kitDir, "docker.ts")).href)});`,
			`const container = await startInDocker(${JSON.stringify({
				image: NODE,
				network: "none",
				lifetimeMs: 6_000,
				cmd: ["node", "-e", "setInterval(() => {}, 1e6)"],
			})});`,
			"console.log(container.containerId);",
			"setInterval(() => {}, 1e6);",
		].join("\n");
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const exited = new Promise((done) => child.once("exit", done));
		let output = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
		});
		for (let waited = 0; !/^[0-9a-f]{64}$/m.test(output); waited += 100) {
			if (waited > 120_000 || child.exitCode !== null) throw new Error(`no container: ${output}`);
			await sleep(100);
		}
		const id = /^[0-9a-f]{64}$/m.exec(output)?.[0] ?? "";
		// Killed, so its exit hook never runs: only the lifetime can end the container.
		child.kill("SIGKILL");
		await exited;
		const listed = await exec(findDocker() ?? "docker", ["ps", "-q", "--filter", `id=${id}`]);
		expect(listed.stdout.trim()).not.toBe("");
		expect(await gone(id, 120)).toBe(true);
	},
);
