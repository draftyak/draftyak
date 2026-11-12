import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tar, zip } from "../../fetch-node/test/archives.ts";
import { guardRelease, manifest } from "../src/guard.ts";
import { hash, inventory } from "../src/integrity.ts";
import * as schedule from "../src/schedule.ts";
import {
	authenticatedNodeProbe,
	authenticateNodeBytes,
	type NodeSource,
	type NodeTestDeps,
} from "../src/trusted-node.ts";

const parent = fs.realpathSync.native(path.resolve(import.meta.dirname, ".."));
const roots: { readonly root: string; readonly dev: number; readonly ino: number }[] = [];
const defaultTarget = { platform: "win", arch: "x64" } as const;
const targets: readonly Pick<NodeSource, "platform" | "arch">[] = [
	defaultTarget,
	{ platform: "win", arch: "arm64" },
	{ platform: "linux", arch: "x64" },
	{ platform: "linux", arch: "arm64" },
	{ platform: "darwin", arch: "x64" },
	{ platform: "darwin", arch: "arm64" },
];

afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const fixture of roots.splice(0)) {
		const current = fs.lstatSync(fixture.root);
		if (
			path.dirname(fixture.root) !== parent ||
			!path.basename(fixture.root).startsWith(".node-auth-test-") ||
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			current.dev !== fixture.dev ||
			current.ino !== fixture.ino ||
			fs.realpathSync.native(fixture.root) !== fixture.root
		)
			throw new Error("Unsafe Node authentication fixture cleanup");
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

function fixture(target: Pick<NodeSource, "platform" | "arch"> = defaultTarget) {
	const root = fs.mkdtempSync(path.join(parent, ".node-auth-test-"));
	const identity = fs.lstatSync(root);
	roots.push({ root, dev: identity.dev, ino: identity.ino });
	const stage = path.join(root, "stage");
	const cache = path.join(root, "cache");
	const repo = path.join(root, "repo");
	fs.mkdirSync(stage);
	fs.mkdirSync(cache);
	fs.mkdirSync(path.join(repo, "tools/fetch-node"), { recursive: true });
	const version = "26.12.0";
	fs.writeFileSync(
		path.join(repo, "tools/fetch-node/versions.json"),
		JSON.stringify({ bundled: version }),
	);
	const folder = `node-v${version}-${target.platform}-${target.arch}`;
	const binary = target.platform === "win" ? "node.exe" : "node";
	const member = `${folder}/${target.platform === "win" ? binary : `bin/${binary}`}`;
	const official = Buffer.from(`synthetic ${target.platform}-${target.arch}; never executed`);
	const archiveName = `${folder}.${target.platform === "win" ? "zip" : "tar.gz"}`;
	const writeArchive = (selectedMember: string) => {
		const packed =
			target.platform === "win"
				? zip([{ name: selectedMember, data: official.toString("utf8") }])
				: gzipSync(tar([{ name: selectedMember, data: official.toString("utf8") }]));
		fs.writeFileSync(path.join(cache, archiveName), packed);
		fs.writeFileSync(path.join(cache, "SHASUMS256.txt"), `${hash(packed)}  ${archiveName}\n`);
	};
	writeArchive(member);
	fs.writeFileSync(path.join(cache, "SHASUMS256.txt.sig"), "synthetic signature");
	const node = {
		path: "candidate-runtime.bin",
		version,
		sha256: hash(official),
		bytes: official.length,
	};
	fs.writeFileSync(path.join(stage, node.path), official);
	const signature = vi.fn(async (_sums: Buffer, signature: Buffer) => {
		if (signature.toString() !== "synthetic signature") throw new Error("untrusted signature");
		return "synthetic signer";
	});
	const probe = vi.fn<NonNullable<NodeTestDeps["probe"]>>(() => ({
		status: 0,
		stdout: JSON.stringify({ version, temporal: "object", disabled: true }),
		stderr: "",
	}));
	return {
		stage,
		repo,
		source: { root: cache, ...target },
		node,
		official,
		member,
		archive: path.join(cache, archiveName),
		writeArchive,
		deps: { signature, probe },
	};
}

function denyExecutionAndTemporaryOutput() {
	const denied = (): never => {
		throw new Error("Byte authentication must not execute or stage a candidate");
	};
	const spawn = vi.spyOn(childProcess, "spawnSync").mockImplementation(denied);
	const temp = vi.spyOn(os, "tmpdir").mockImplementation(denied);
	const scratch = vi.spyOn(fs, "mkdtempSync").mockImplementation(denied);
	const writes = vi.spyOn(fs, "writeFileSync").mockImplementation(denied);
	syncBuiltinESMExports();
	return [spawn, temp, scratch, writes];
}

describe("official Node byte authentication", () => {
	it.each(targets)(
		"authenticates $platform-$arch without host execution or temp access",
		async (target) => {
			const f = fixture(target);
			const forbidden = denyExecutionAndTemporaryOutput();
			await expect(authenticateNodeBytes(f.stage, f.node, f.source, f.deps)).resolves.toEqual(
				f.official,
			);
			expect(f.deps.signature).toHaveBeenCalledOnce();
			expect(f.deps.probe).not.toHaveBeenCalled();
			for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
		},
	);

	it.each([
		"signature",
		"archive",
		"candidate-self-hash",
		"digest",
		"length",
		"platform",
		"architecture",
		"member",
		"selected-archive",
	])("refuses bad %s without any probe", async (kind) => {
		const f = fixture();
		if (kind === "signature")
			fs.writeFileSync(path.join(f.source.root, "SHASUMS256.txt.sig"), "invalid signature");
		if (kind === "archive") fs.writeFileSync(f.archive, "altered archive");
		if (kind === "candidate-self-hash") {
			const changed = Buffer.from("altered candidate with its own matching hash");
			fs.writeFileSync(path.join(f.stage, f.node.path), changed);
			f.node.sha256 = hash(changed);
			f.node.bytes = changed.length;
		}
		if (kind === "digest") f.node.sha256 = "0".repeat(64);
		if (kind === "length") f.node.bytes++;
		if (kind === "member") f.writeArchive(`${f.member}.wrong`);
		if (kind === "selected-archive")
			fs.writeFileSync(
				path.join(f.source.root, "SHASUMS256.txt"),
				`${hash(Buffer.alloc(0))}  other.zip\n`,
			);
		const source =
			kind === "platform"
				? { ...f.source, platform: "other" as NodeSource["platform"] }
				: kind === "architecture"
					? { ...f.source, arch: "other" as NodeSource["arch"] }
					: f.source;
		const forbidden = denyExecutionAndTemporaryOutput();
		await expect(authenticateNodeBytes(f.stage, f.node, source, f.deps)).rejects.toThrow();
		expect(f.deps.probe).not.toHaveBeenCalled();
		for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
	});

	it("keeps wrong-host runtime probing refused after successful byte authentication", async () => {
		const platform = process.platform === "win32" ? "linux" : "win";
		const f = fixture({ platform, arch: "x64" });
		await expect(authenticateNodeBytes(f.stage, f.node, f.source, f.deps)).resolves.toEqual(
			f.official,
		);
		const created = vi.spyOn(fs, "mkdtempSync");
		syncBuiltinESMExports();
		await expect(authenticatedNodeProbe(f.stage, f.node, f.source, f.deps)).rejects.toThrow(
			"Node runtime probe requires a matching build host",
		);
		expect(f.deps.signature).toHaveBeenCalledTimes(2);
		expect(f.deps.probe).not.toHaveBeenCalled();
		expect(created).not.toHaveBeenCalled();
	});

	it("authenticates probe inputs again instead of trusting previously returned bytes", async () => {
		const f = fixture();
		const returned = await authenticateNodeBytes(f.stage, f.node, f.source, f.deps);
		returned.fill(0);
		const changed = Buffer.from("changed after byte authentication");
		fs.writeFileSync(path.join(f.stage, f.node.path), changed);
		f.node.sha256 = hash(changed);
		f.node.bytes = changed.length;
		await expect(authenticatedNodeProbe(f.stage, f.node, f.source, f.deps)).rejects.toThrow(
			"staged Node differs from independently authenticated official bytes",
		);
		expect(f.deps.signature).toHaveBeenCalledTimes(2);
		expect(f.deps.probe).not.toHaveBeenCalled();
	});
});

const hostTarget: Pick<NodeSource, "platform" | "arch"> = {
	platform: process.platform === "win32" ? "win" : (process.platform as NodeSource["platform"]),
	arch: process.arch as NodeSource["arch"],
};

function releaseInput(f: ReturnType<typeof fixture>) {
	return {
		schemaVersion: 1,
		version: "0.1.0",
		artifacts: inventory(f.stage),
		npm: [],
		nodes: [{ ...f.node, source: f.source }],
	};
}

// Orchestration only: the genuine oracle/crypto path has a separate strict heavy witness.
function scheduleResult(f: ReturnType<typeof fixture>, warnings: readonly string[] = []) {
	return {
		node: f.node,
		sources: [],
		oracle: {
			sha256: "0".repeat(64),
			bytes: 1,
			lockSha256: "0".repeat(64),
			sourceSha256: "0".repeat(64),
			scopedInputsSha256: "0".repeat(64),
		},
		versions: {
			jiff: "unit",
			jiffTzdb: "unit",
			jiffTzdata: null,
			node: f.node.version,
			nodeTzdata: "unit",
		},
		counts: { resolutions: 0, renderings: 0, snapshots: 0 },
		warnings,
		boundary: "Unit orchestration result, not a scheduling or authentication proof",
	} satisfies schedule.ScheduleReport;
}

describe("full release schedule orchestration", () => {
	it("executes the canonical inspector after authenticated host probing and preserves other gates", async () => {
		const f = fixture(hostTarget);
		const inspector = vi
			.spyOn(schedule, "inspectScheduleEquivalence")
			.mockImplementation(async () => {
				expect(f.deps.signature).toHaveBeenCalledTimes(2);
				expect(f.deps.probe).toHaveBeenCalledOnce();
				return scheduleResult(f);
			});
		const report = await guardRelease(
			releaseInput(f),
			{ root: f.stage, repo: f.repo, scope: "full" },
			f.deps,
		);
		expect(inspector, "canonical schedule inspector must execute").toHaveBeenCalledExactlyOnceWith({
			repo: f.repo,
			root: f.stage,
			node: { ...f.node, source: f.source },
			nodeSource: f.source,
		});
		expect(report.checks).toContain(`schedule-equivalence:${f.node.path}`);
		expect(report.checks).toContain("schedule-equivalence");
		expect(
			report.findings.filter((finding) => finding.check.startsWith("schedule-equivalence")),
		).toEqual([]);
		expect(report.findings.some((finding) => finding.check === "native-features")).toBe(true);
	});

	it("keeps genuine inspector failures as findings instead of crediting equivalence", async () => {
		const f = fixture(hostTarget);
		vi.spyOn(schedule, "inspectScheduleEquivalence").mockRejectedValue(
			new Error("canonical schedule answers differ"),
		);
		const report = await guardRelease(
			releaseInput(f),
			{ root: f.stage, repo: f.repo, scope: "full" },
			f.deps,
		);
		expect(report.findings).toContainEqual({
			check: `schedule-equivalence:${f.node.path}`,
			reason: "canonical schedule answers differ",
		});
		expect(report.checks).not.toContain("schedule-equivalence");
		expect(report.findings.some((finding) => finding.check === "schedule-equivalence")).toBe(true);
	});

	it.each(["authentication", "runtime"])(
		"does not run the inspector after %s failure",
		async (failure) => {
			const f = fixture(hostTarget);
			const inspector = vi.spyOn(schedule, "inspectScheduleEquivalence");
			if (failure === "authentication")
				fs.writeFileSync(path.join(f.source.root, "SHASUMS256.txt.sig"), "invalid signature");
			else f.deps.probe.mockReturnValue({ status: 1, stdout: "", stderr: "" });
			const report = await guardRelease(
				releaseInput(f),
				{ root: f.stage, repo: f.repo, scope: "full" },
				f.deps,
			);
			expect(inspector).not.toHaveBeenCalled();
			expect(report.checks).not.toContain("schedule-equivalence");
			expect(report.findings.some((finding) => finding.check === "schedule-equivalence")).toBe(
				true,
			);
		},
	);

	it("retains an explicit off-host comparison gap even when the host comparison passed", async () => {
		const f = fixture(hostTarget);
		const other = fixture({
			platform: hostTarget.platform === "win" ? "linux" : "win",
			arch: "x64",
		});
		const file = "other-runtime.bin";
		fs.copyFileSync(path.join(other.stage, other.node.path), path.join(f.stage, file));
		const inspector = vi
			.spyOn(schedule, "inspectScheduleEquivalence")
			.mockResolvedValue(scheduleResult(f));
		const report = await guardRelease(
			{
				...releaseInput(f),
				artifacts: inventory(f.stage),
				nodes: [
					{ ...f.node, source: f.source },
					{ ...other.node, path: file, source: other.source },
				],
			},
			{ root: f.stage, repo: f.repo, scope: "full" },
			f.deps,
		);
		expect(inspector).toHaveBeenCalledOnce();
		expect(report.checks).toContain(`schedule-equivalence:${f.node.path}`);
		expect(report.checks).not.toContain("schedule-equivalence");
		expect(report.findings).toContainEqual({
			check: `schedule-equivalence:${file}`,
			reason: expect.stringContaining("does not match this host"),
		});
	});

	it("reports tzdata differences as warnings while retaining unrelated failures", async () => {
		const f = fixture(hostTarget);
		const reason = "Node and jiff tzdata versions differ; all canonical schedule answers agree";
		vi.spyOn(schedule, "inspectScheduleEquivalence").mockResolvedValue(scheduleResult(f, [reason]));
		const report = await guardRelease(
			releaseInput(f),
			{ root: f.stage, repo: f.repo, scope: "full" },
			f.deps,
		);
		expect(report.warnings).toEqual([{ check: `schedule-equivalence:${f.node.path}`, reason }]);
		expect(report.checks).toContain("schedule-equivalence");
		expect(
			report.findings.filter((finding) => finding.check.startsWith("schedule-equivalence")),
		).toEqual([]);
		expect(report.findings.some((finding) => finding.check === "native-features")).toBe(true);
	});

	it("keeps artifact-only inspection free of schedule execution", async () => {
		const f = fixture(hostTarget);
		const inspector = vi.spyOn(schedule, "inspectScheduleEquivalence");
		const report = await guardRelease(
			releaseInput(f),
			{ root: f.stage, repo: f.repo, scope: "artifacts" },
			f.deps,
		);
		expect(inspector).not.toHaveBeenCalled();
		expect(report.findings).toEqual([]);
	});

	it("does not credit equivalence after post-inspection artifact tampering", async () => {
		const f = fixture(hostTarget);
		vi.spyOn(schedule, "inspectScheduleEquivalence").mockImplementation(async () => {
			fs.writeFileSync(path.join(f.stage, f.node.path), "changed after comparison");
			return scheduleResult(f);
		});
		const report = await guardRelease(
			releaseInput(f),
			{ root: f.stage, repo: f.repo, scope: "full" },
			f.deps,
		);
		expect(report.checks).not.toContain("schedule-equivalence");
		expect(
			report.findings.some((finding) => finding.check === `bundled-node-integrity:${f.node.path}`),
		).toBe(true);
	});
});

describe("per-artifact Node coverage", () => {
	it("authenticates every selected target while probing only the host executable", async () => {
		const f = fixture(hostTarget);
		const nodes = [{ ...f.node, source: f.source }];
		for (const target of targets) {
			if (target.platform === hostTarget.platform && target.arch === hostTarget.arch) continue;
			const other = fixture(target);
			const file = `${target.platform}-${target.arch}/${target.platform === "win" ? "node.exe" : "node"}`;
			fs.mkdirSync(path.dirname(path.join(f.stage, file)), { recursive: true });
			fs.copyFileSync(path.join(other.stage, other.node.path), path.join(f.stage, file));
			nodes.push({ ...other.node, path: file, source: other.source });
		}
		const report = await guardRelease(
			{ ...releaseInput(f), nodes, artifacts: inventory(f.stage) },
			{ root: f.stage, repo: f.repo, scope: "artifacts" },
			f.deps,
		);
		expect(report.findings).toEqual([]);
		expect(
			report.checks.filter((check) => check.startsWith("bundled-node-authentication:")),
		).toHaveLength(targets.length);
		expect(
			report.checks.filter((check) => check.startsWith("bundled-node-byte-equality:")),
		).toHaveLength(targets.length - 1);
		expect(f.deps.signature).toHaveBeenCalledTimes(targets.length + 1);
		expect(f.deps.probe).toHaveBeenCalledOnce();
	});
	it("accepts equivalent unambiguous legacy host input", async () => {
		const f = fixture(hostTarget);
		const report = await guardRelease(
			{
				schemaVersion: 1,
				version: "0.1.0",
				npm: [],
				artifacts: inventory(f.stage),
				node: f.node,
				nodeSource: f.source,
			},
			{ root: f.stage, repo: f.repo, scope: "artifacts" },
			f.deps,
		);
		expect(report.findings).toEqual([]);
		expect(f.deps.signature).toHaveBeenCalledTimes(2);
		expect(f.deps.probe).toHaveBeenCalledOnce();
	});
	it("authenticates an off-host-only artifact without temporary executable output or probe", async () => {
		const f = fixture({ platform: hostTarget.platform === "win" ? "linux" : "win", arch: "x64" });
		const input = releaseInput(f);
		const forbidden = denyExecutionAndTemporaryOutput();
		const report = await guardRelease(
			input,
			{ root: f.stage, repo: f.repo, scope: "artifacts" },
			f.deps,
		);
		expect(report.findings).toEqual([]);
		expect(report.checks).toContain(`bundled-node-byte-equality:${f.node.path}`);
		expect(report.checks).not.toContain("bundled-node-runtime");
		expect(f.deps.signature).toHaveBeenCalledOnce();
		expect(f.deps.probe).not.toHaveBeenCalled();
		for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
	});
	it.each(["node", "node.exe", "nested/NODE.EXE", "bin/draftyak-node-aarch64-apple-darwin"])(
		"refuses an unrecorded known executable %s before any authentication or execution",
		async (file) => {
			const f = fixture(hostTarget);
			fs.mkdirSync(path.dirname(path.join(f.stage, file)), { recursive: true });
			fs.writeFileSync(path.join(f.stage, file), f.official);
			const report = await guardRelease(
				releaseInput(f),
				{ root: f.stage, repo: f.repo, scope: "artifacts" },
				f.deps,
			);
			expect(report.findings).toContainEqual({
				check: "bundled-node-coverage",
				reason: `Node executable has no exact target/source record: ${file}`,
			});
			expect(f.deps.signature).not.toHaveBeenCalled();
			expect(f.deps.probe).not.toHaveBeenCalled();
		},
	);
	it.each([
		"duplicate",
		"case alias",
		"mixed",
		"empty",
		"unknown artifact",
		"digest",
		"length",
		"missing source",
		"target",
		"target coercion",
	])("refuses %s Node metadata before artifact work", (failure) => {
		const f = fixture(hostTarget);
		const input: Record<string, unknown> = releaseInput(f);
		const record: Record<string, unknown> = { ...f.node, source: f.source };
		if (failure === "duplicate") input.nodes = [record, record];
		if (failure === "case alias")
			input.nodes = [record, { ...record, path: f.node.path.toUpperCase() }];
		if (failure === "mixed") input.node = f.node;
		if (failure === "empty") input.nodes = [];
		if (failure === "unknown artifact") input.nodes = [{ ...record, path: "absent/node" }];
		if (failure === "digest") input.nodes = [{ ...record, sha256: "0".repeat(64) }];
		if (failure === "length") input.nodes = [{ ...record, bytes: f.node.bytes + 1 }];
		if (failure === "missing source") {
			delete record.source;
			input.nodes = [record];
		}
		if (failure === "target") input.nodes = [{ ...record, source: { ...f.source, arch: "ia32" } }];
		if (failure === "target coercion")
			input.nodes = [{ ...record, source: { ...f.source, arch: ["x64"] } }];
		expect(() => manifest(input)).toThrow();
		expect(f.deps.signature).not.toHaveBeenCalled();
		expect(f.deps.probe).not.toHaveBeenCalled();
	});
	it("does not let a changed non-host payload authorize any host probe through its matching self-hash", async () => {
		const f = fixture(hostTarget);
		const other = fixture({
			platform: hostTarget.platform === "win" ? "linux" : "win",
			arch: "x64",
		});
		const file = "other/node";
		fs.mkdirSync(path.dirname(path.join(f.stage, file)));
		const changed = Buffer.from("substituted candidate with self-consistent metadata");
		fs.writeFileSync(path.join(f.stage, file), changed);
		const report = await guardRelease(
			{
				...releaseInput(f),
				artifacts: inventory(f.stage),
				nodes: [
					{ ...f.node, source: f.source },
					{
						...other.node,
						path: file,
						sha256: hash(changed),
						bytes: changed.length,
						source: other.source,
					},
				],
			},
			{ root: f.stage, repo: f.repo, scope: "artifacts" },
			f.deps,
		);
		expect(report.findings).toContainEqual({
			check: `bundled-node-authentication:${file}`,
			reason: "staged Node differs from independently authenticated official bytes",
		});
		expect(f.deps.probe).not.toHaveBeenCalled();
	});
	it("rechecks staged coverage after asynchronous host probing", async () => {
		const f = fixture(hostTarget);
		const original = f.deps.probe.getMockImplementation();
		f.deps.probe.mockImplementation((...args) => {
			const answer = original?.(...args);
			if (!answer) throw new Error("missing test probe");
			fs.writeFileSync(path.join(f.stage, "node.exe"), "unrecorded late executable");
			return answer;
		});
		const report = await guardRelease(
			releaseInput(f),
			{ root: f.stage, repo: f.repo, scope: "artifacts" },
			f.deps,
		);
		expect(report.findings.some((finding) => finding.check === "artifact-integrity")).toBe(true);
	});
	it("refuses same-length staged Node changes after authenticated host probing", async () => {
		const f = fixture(hostTarget);
		const changed = Buffer.from(f.official);
		changed.writeUInt8(changed.readUInt8(0) ^ 0xff, 0);
		expect(changed).toHaveLength(f.node.bytes);
		expect(hash(changed)).not.toBe(f.node.sha256);
		const original = f.deps.probe.getMockImplementation();
		f.deps.probe.mockImplementation((...args) => {
			const answer = original?.(...args);
			if (!answer) throw new Error("missing test probe");
			fs.writeFileSync(path.join(f.stage, f.node.path), changed);
			return answer;
		});
		const report = await guardRelease(
			releaseInput(f),
			{ root: f.stage, repo: f.repo, scope: "artifacts" },
			f.deps,
		);
		expect(f.deps.signature).toHaveBeenCalledTimes(2);
		expect(f.deps.probe).toHaveBeenCalledOnce();
		expect(report.findings.some((finding) => finding.reason.includes("integrity mismatch"))).toBe(
			true,
		);
	});
});
