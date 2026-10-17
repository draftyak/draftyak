import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { writeEvidence } from "../evidence.ts";
import { exec } from "../exec.ts";
import { hostTarget, nodeVersions } from "../node.ts";
import { repoRoot } from "../repo.ts";

// spikes-run (M0.8) sets DRAFTYAK_NODES to both, minimum or bundled; unset means both.
function selected(env: NodeJS.ProcessEnv = process.env): ("minimum" | "bundled")[] {
	const value = env.DRAFTYAK_NODES || "both";
	if (value === "both") return ["minimum", "bundled"];
	if (value === "minimum" || value === "bundled") return [value];
	throw new Error(`DRAFTYAK_NODES is both, minimum or bundled, not "${value}"`);
}

const probe = `console.log(JSON.stringify({
	nodeVersion: process.version,
	platform: process.platform,
	arch: process.arch,
	v8Version: process.versions.v8,
	napiVersion: process.versions.napi,
	modulesVersion: process.versions.modules,
	opensslVersion: process.versions.openssl,
	temporal: typeof globalThis.Temporal,
}))`;

// fetch-node's CLI (M0.5) prints the binary's path, and logs the key that signed SHASUMS256.txt.
async function fetchNode(version: string): Promise<{ binary: string; signer: string | null }> {
	const { platform, arch } = hostTarget();
	const script = path.join(repoRoot, "tools", "fetch-node", "fetch-node.mjs");
	const args = ["--version", version, "--platform", platform, "--arch", arch, "--print-path"];
	const result = await exec(process.execPath, [script, ...args], { timeoutMs: 900_000 });
	expect(result.code, result.stderr).toBe(0);
	const signer = /is signed by ([0-9A-F]{40})\b/i.exec(result.stderr)?.[1]?.toLowerCase() ?? null;
	return { binary: result.stdout.trim().split(/\r?\n/).at(-1) ?? "", signer };
}

// The gpgv fetch-node runs: the first on PATH, then Git for Windows', then DRAFTYAK_GPG (M0.5).
async function gpgv(env: NodeJS.ProcessEnv = process.env) {
	const name = process.platform === "win32" ? "gpgv.exe" : "gpgv";
	const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
	const git = process.platform === "win32" ? ["C:/Program Files/Git/usr/bin/gpgv.exe"] : [];
	const found = [...dirs.map((dir) => path.join(dir, name)), ...git, env.DRAFTYAK_GPG ?? ""].find(
		(file) => file !== "" && statSync(file, { throwIfNoEntry: false })?.isFile(),
	);
	if (found === undefined) return null;
	const { stdout } = await exec(found, ["--version"], { timeoutMs: 30_000 });
	// Evidence refuses this machine's home folder, so a gpgv below it is recorded from ~.
	const inside = path.relative(os.homedir(), found);
	const shown = inside.startsWith("..") || path.isAbsolute(inside) ? found : path.join("~", inside);
	return { path: shown, version: stdout.split(/\r?\n/)[0]?.trim() ?? "" };
}

// No key or value may equal the account a runner uses: writeEvidence refuses the user name, and
// GitHub's Linux and macOS runners run as `runner` (Windows: `runneradmin`).
function envData(nodes: object[], gpg: object | null, env: NodeJS.ProcessEnv = process.env) {
	const github = env.GITHUB_ACTIONS === "true" ? env : {};
	const { platform, arch } = hostTarget();
	return {
		target: `${platform}-${arch}`,
		nodeSelection: env.DRAFTYAK_NODES || "both",
		nodes,
		gpgv: gpg,
		ci: {
			os: github.RUNNER_OS ?? null,
			arch: github.RUNNER_ARCH ?? null,
			image: github.ImageOS ?? null,
			imageVersion: github.ImageVersion ?? null,
		},
	};
}

it("fetches the selected Nodes through fetch-node, runs each and records them in evidence/env.json", {
	timeout: 600_000,
}, async () => {
	const versions = nodeVersions();
	const nodes = [];
	for (const role of selected()) {
		const { binary, signer } = await fetchNode(versions[role]);
		const result = await exec(binary, ["-e", probe], { timeoutMs: 60_000 });
		expect(result.code, result.stderr).toBe(0);
		const facts = JSON.parse(result.stdout) as Record<string, string>;
		expect(facts).toMatchObject({
			nodeVersion: `v${versions[role]}`,
			platform: process.platform,
			arch: process.arch,
		});
		expect(signer).toMatch(/^[0-9a-f]{40}$/);
		nodes.push({ role, version: versions[role], signer, ...facts });
	}
	const gpg = await gpgv();
	expect(gpg?.version).toMatch(/^gpgv \(GnuPG\) \d+\.\d+/);
	const file = await writeEvidence(
		new URL("../evidence/env.json", import.meta.url),
		envData(nodes, gpg),
	);
	const written = JSON.parse(readFileSync(file, "utf8"));
	expect(written.data.nodes.map((node: { version: string }) => node.version)).toEqual(
		selected().map((role) => versions[role]),
	);
	expect(written.fingerprint.os.platform).toBe(process.platform);
});

it("keeps env.json content-free under the accounts of GitHub's runners", async () => {
	const node = {
		role: "bundled",
		version: "26.12.0",
		signer: "c82fa3ae1cbedc6be46b9360c43cec45c17ab93c",
		nodeVersion: "v26.12.0",
		platform: "linux",
		arch: "x64",
		v8Version: "14.6.202.33-node.20",
		napiVersion: "10",
		modulesVersion: "147",
		opensslVersion: "3.5.4",
		temporal: "object",
	};
	const github = {
		GITHUB_ACTIONS: "true",
		RUNNER_OS: "Linux",
		RUNNER_ARCH: "X64",
		ImageOS: "ubuntu24",
		ImageVersion: "20261012.1.0",
		DRAFTYAK_NODES: "both",
	};
	const data = envData([node], { path: "/usr/bin/gpgv", version: "gpgv (GnuPG) 2.4.4" }, github);
	const accounts = [
		["runner", "/home/runner"],
		["runner", "/Users/runner"],
		["runneradmin", "C:\\Users\\runneradmin"],
	];
	for (const [username = "", homedir = ""] of accounts) {
		vi.spyOn(os, "userInfo").mockReturnValue({
			username,
			homedir,
			uid: 1001,
			gid: 1001,
			shell: "",
		});
		vi.spyOn(os, "homedir").mockReturnValue(homedir);
		vi.resetModules();
		try {
			// evidence.ts reads the account when it loads.
			const { assertContentFree } = await import("../evidence.ts");
			expect(() => assertContentFree({ [username]: 1 })).toThrow("(user)");
			expect(() => assertContentFree({ data }, username)).not.toThrow();
		} finally {
			vi.restoreAllMocks();
		}
	}
});
