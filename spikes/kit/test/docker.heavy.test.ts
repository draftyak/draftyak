import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { findDocker, needDocker, runInDocker, stageForDocker } from "../docker.ts";
import { exec, sleep } from "../exec.ts";

// Pinned at first use (2026-10-17): the multi-arch OCI index of debian:bookworm-slim. It has no
// libatomic1, so containers that run Node use M0.5's node:<v>-bookworm-slim pin instead.
const DEBIAN =
	"debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587";
const options = { tags: ["requires:docker"], timeout: 420_000 };

// --rm removes a container shortly after it stops.
async function gone(id: string): Promise<boolean> {
	for (let tries = 0; tries < 40; tries++) {
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
