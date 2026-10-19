import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import { tar, zip } from "../../fetch-node/test/archives.ts";
import { hash } from "../src/integrity.ts";
import {
	inspectScheduleEquivalence,
	type ScheduleOptions,
	type ScheduleTestDeps,
} from "../src/schedule.ts";

const worktree = path.resolve(import.meta.dirname, "../../..");
const cache = path.join(worktree, "tools/release-guard/.cache");
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(path.join(cache, "schedule-test-"));
afterAll(() => {
	if (path.dirname(scratch) !== cache || !path.basename(scratch).startsWith("schedule-test-"))
		throw new Error("unsafe fixture cleanup");
	rmSync(scratch, { recursive: true, force: true });
});
const platform = process.platform === "win32" ? "win" : process.platform;
const binary = process.platform === "win32" ? "node.exe" : "node";
const oracleBinary = `draftyak-schedule-oracle${process.platform === "win32" ? ".exe" : ""}`;
const modulePath = "apps/app/src-tauri/src/schedule.rs";
const nativeSource =
	"// fixture TimeZoneDatabase::bundled()\npub(crate) fn validate() {}\npub(crate) fn view() {}\n";
const transitions = [
	["America/New_York", "2026-03-08T07:00Z", "-05:00", "-04:00"],
	["America/New_York", "2026-11-01T06:00Z", "-04:00", "-05:00"],
	["America/New_York", "2027-03-14T07:00Z", "-05:00", "-04:00"],
	["America/New_York", "2027-11-07T06:00Z", "-04:00", "-05:00"],
	["Europe/London", "2026-03-29T01:00Z", "+00:00", "+01:00"],
	["Europe/London", "2026-10-25T01:00Z", "+01:00", "+00:00"],
	["Europe/London", "2027-03-28T01:00Z", "+00:00", "+01:00"],
	["Europe/London", "2027-10-31T01:00Z", "+01:00", "+00:00"],
	["Australia/Lord_Howe", "2026-04-04T15:00Z", "+11:00", "+10:30"],
	["Australia/Lord_Howe", "2026-10-03T15:30Z", "+10:30", "+11:00"],
	["Australia/Lord_Howe", "2027-04-03T15:00Z", "+11:00", "+10:30"],
	["Australia/Lord_Howe", "2027-10-02T15:30Z", "+10:30", "+11:00"],
].map(([zone, at, offsetBefore, offsetAfter]) => ({
	zone,
	epochMs: Date.parse(at ?? ""),
	offsetBefore,
	offsetAfter,
}));

function fixture() {
	const folder = mkdtempSync(path.join(scratch, "case-"));
	const repo = path.join(folder, "repo");
	const stage = path.join(folder, "stage");
	const official = "synthetic official Node bytes; never executed";
	const version = "26.12.0";
	const put = (root: string, file: string, body: string | Uint8Array) => {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), body);
	};
	put(repo, modulePath, nativeSource);
	put(
		repo,
		"apps/app/src-tauri/Cargo.toml",
		'jiff = { version = "=0.2.38", default-features = false, features = ["std", "tzdb-bundle-always"], optional = true }\n',
	);
	put(
		repo,
		"crates/Cargo.lock",
		readFileSync(path.join(worktree, "tools/release-guard/native-oracle/Cargo.lock")),
	);
	put(
		repo,
		"crates/draftyak-protocol/Cargo.toml",
		'[package]\nname="draftyak-protocol"\nversion="0.0.0"\n',
	);
	put(repo, "crates/draftyak-protocol/src/lib.rs", "// synthetic protocol source\n");
	put(repo, "rust-toolchain.toml", '[toolchain]\nchannel = "1.95.0"\n');
	put(repo, "tools/fetch-node/versions.json", JSON.stringify({ bundled: version }));
	put(
		repo,
		"spec/vectors/snapshot/snapshots.json",
		JSON.stringify({
			format: "draftyak.vectors.snapshot.v1",
			cases: [
				{ error: "SNAPSHOT_INVALID", snapshot: { schedule: { kind: "later" } } },
				{ snapshot: { schedule: { kind: "now" } } },
				{
					snapshot: {
						schedule: {
							kind: "at",
							notBefore: 1792338000000,
							zone: "America/Chicago",
							localWallTime: "2026-10-18T12:00-05:00",
							latenessSec: 900,
							holdIfNewInbound: true,
						},
					},
				},
			],
		}),
	);
	put(stage, binary, official);
	put(stage, "native-candidate.exe", "synthetic candidate identity; not executed");
	const source = path.join(folder, "node-source");
	const prefix = `node-v${version}-${platform}-${process.arch}`;
	const entry = `${prefix}/${platform === "win" ? binary : `bin/${binary}`}`;
	const archive =
		platform === "win"
			? zip([{ name: entry, data: official }])
			: gzipSync(tar([{ name: entry, data: official }]));
	put(source, `${prefix}.${platform === "win" ? "zip" : "tar.gz"}`, archive);
	put(
		source,
		"SHASUMS256.txt",
		`${hash(archive)}  ${prefix}.${platform === "win" ? "zip" : "tar.gz"}\n`,
	);
	put(source, "SHASUMS256.txt.sig", "fixture signature");
	const record = (file: string) => {
		const bytes = readFileSync(path.join(stage, file));
		return { path: file, bytes: bytes.length, sha256: hash(bytes) };
	};
	const options: ScheduleOptions = {
		repo,
		root: stage,
		nativeArtifact: record("native-candidate.exe"),
		node: { ...record(binary), version },
		nodeSource: {
			root: source,
			platform: platform as "win" | "linux" | "darwin",
			arch: process.arch as "x64" | "arm64",
		},
	};
	let compileEnv: NodeJS.ProcessEnv = {};
	let projectDirectory = "";
	const compile = vi.fn<NonNullable<ScheduleTestDeps["compile"]>>(async (project, target, env) => {
		compileEnv = env;
		projectDirectory = project;
		expect(readFileSync(path.join(project, "src/schedule.rs"), "utf8")).toBe(nativeSource);
		expect(readFileSync(path.join(project, "protocol/src/lib.rs"), "utf8")).toContain(
			"synthetic protocol",
		);
		expect(env.CARGO_NET_OFFLINE).toBe("true");
		expect(env.RUSTUP_AUTO_INSTALL).toBe("0");
		expect(env.CARGO_BUILD_JOBS).toBe("1");
		expect(env.RUSTFLAGS).toBeUndefined();
		expect(env.RUSTC_WRAPPER).toBeUndefined();
		put(target, `release/${oracleBinary}`, "synthetic compiled oracle; never executed");
	});
	const execute = vi.fn<NonNullable<ScheduleTestDeps["execute"]>>((kind, file, raw, cwd, env) => {
		expect(path.dirname(file)).toBe(cwd);
		for (const name of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "RUSTFLAGS"])
			expect(env[name]).toBeUndefined();
		const q = raw as {
			zones?: unknown;
			walls?: Record<string, unknown>[];
			instants?: { zone: string; epochMs: number }[];
			schedules?: { kind: string; localWallTime?: string }[];
		};
		const rendered = (q.instants ?? []).map((item) => ({
			...item,
			localWallTime: `${new Date(item.epochMs).toISOString().slice(0, 16)}+00:00`,
			offset: "+00:00",
		}));
		const schedules = (q.schedules ?? []).map((item) => {
			const accepted = item.kind === "now" || item.localWallTime?.endsWith("+00:00");
			return {
				accepted,
				canApprove: accepted,
				warning: !accepted,
				...(kind === "native" ? { text: "Native fixture display" } : {}),
			};
		});
		return {
			status: 0,
			stderr: "",
			stdout: JSON.stringify({
				version,
				temporal: "object",
				disabled: true,
				tzVersion: "2026a",
				tzdbVersion: "2026a",
				schemaVersion: 1,
				database: "bundled",
				jiffVersion: "0.2.38",
				jiffTzdbVersion: "0.1.9",
				sourceSha256: compileEnv.DRAFTYAK_SCHEDULE_SOURCE_SHA256,
				protocolSha256: compileEnv.DRAFTYAK_SCHEDULE_PROTOCOL_SHA256,
				lockSha256: compileEnv.DRAFTYAK_SCHEDULE_LOCK_SHA256,
				oracleSha256: compileEnv.DRAFTYAK_SCHEDULE_ORACLE_SHA256,
				transitions: q.zones ? transitions : [],
				walls: q.walls ?? [],
				instants: rendered,
				schedules,
			}),
		};
	});
	const signature = vi.fn(async (_sums: Buffer, sig: Buffer) => {
		if (sig.toString() !== "fixture signature") throw new Error("invalid fixture signature");
		return "fixture signer";
	});
	return {
		options,
		compile,
		execute,
		signature,
		put,
		repo,
		stage,
		source,
		deps: { compile, execute, signature },
		project: () => projectDirectory,
	};
}

describe("fresh native schedule / authenticated Temporal comparison", () => {
	it("measures source/oracle/artifact provenance and bounded DST/M1 cases, then removes private scratch", async () => {
		const f = fixture();
		const result = await inspectScheduleEquivalence(f.options, f.deps);
		expect(result.counts).toEqual({ transitions: 12, walls: 72, instants: 96, schedules: 386 });
		expect(result.warnings).toEqual([]);
		expect(result.nativeArtifact).toEqual(f.options.nativeArtifact);
		expect(result.sources.find((row) => row.path === modulePath)?.sha256).toBe(
			hash(Buffer.from(nativeSource)),
		);
		expect(result.oracle.sha256).toBe(
			hash(Buffer.from("synthetic compiled oracle; never executed")),
		);
		expect(result.boundary).toContain("separate native-build acceptance gates");
		expect(f.signature).toHaveBeenCalledOnce();
		expect(f.compile).toHaveBeenCalledOnce();
		expect(f.execute).toHaveBeenCalledTimes(5);
		expect(existsSync(path.dirname(f.project()))).toBe(false);
	});
	it("materializes the measured inert Cargo template only inside its private workspace", async () => {
		const oracle = path.join(worktree, "tools/release-guard/native-oracle");
		const template = readFileSync(path.join(oracle, "Cargo.toml.template"));
		expect(existsSync(path.join(oracle, "Cargo.toml"))).toBe(false);
		const f = fixture();
		const original = f.compile.getMockImplementation();
		f.compile.mockImplementation(async (project, target, env) => {
			expect(readFileSync(path.join(project, "Cargo.toml"))).toEqual(template);
			expect(existsSync(path.join(project, "Cargo.toml.template"))).toBe(false);
			await original?.(project, target, env);
		});
		await inspectScheduleEquivalence(f.options, f.deps);
		expect(f.compile).toHaveBeenCalledOnce();
		expect(existsSync(path.dirname(f.project()))).toBe(false);
	});
	it.each(["native-candidate.exe", binary])("rejects changed candidate %s", async (file) => {
		const f = fixture();
		f.put(f.stage, file, "changed candidate");
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			/integrity|staged Node/,
		);
		expect(f.execute).not.toHaveBeenCalled();
	});
	it("does not execute either runtime when Node signature authentication fails", async () => {
		const f = fixture();
		f.put(f.source, "SHASUMS256.txt.sig", "changed");
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"invalid fixture signature",
		);
		expect(f.execute).not.toHaveBeenCalled();
		expect(existsSync(path.dirname(f.project()))).toBe(false);
	});
	it("refuses source mutation during compilation before runtime execution", async () => {
		const f = fixture();
		const original = f.compile.getMockImplementation();
		f.compile.mockImplementation(async (...args) => {
			await original?.(...args);
			f.put(f.repo, modulePath, `${nativeSource}// changed\n`);
		});
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"schedule input integrity mismatch",
		);
		expect(f.execute).not.toHaveBeenCalled();
	});
	it.each(["walls", "instants", "schedules", "sourceSha256"])(
		"fails differing native %s instead of accepting version claims",
		async (field) => {
			const f = fixture();
			const original = f.execute.getMockImplementation();
			f.execute.mockImplementation((...args) => {
				const response = original?.(...args);
				if (!response) throw new Error("missing fixture executor");
				const row = JSON.parse(response.stdout);
				if (args[0] === "native") {
					if (field === "sourceSha256") row.sourceSha256 = hash(Buffer.from("different source"));
					else if (row[field].length)
						row[field][0] = { ...row[field][0], accepted: false, changed: true };
				}
				return { ...response, stdout: JSON.stringify(row) };
			});
			await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(/differ/);
		},
	);
	it("warns when tzdata versions differ but every bounded answer agrees", async () => {
		const f = fixture();
		const original = f.execute.getMockImplementation();
		f.execute.mockImplementation((...args) => {
			const response = original?.(...args);
			if (!response) throw new Error("missing fixture executor");
			const row = JSON.parse(response.stdout);
			if (args[0] === "node") row.tzVersion = "2026b";
			return { ...response, stdout: JSON.stringify(row) };
		});
		expect((await inspectScheduleEquivalence(f.options, f.deps)).warnings).toHaveLength(1);
	});
	it("refuses incomplete DST transition coverage", async () => {
		const f = fixture();
		const original = f.execute.getMockImplementation();
		f.execute.mockImplementation((...args) => {
			const response = original?.(...args);
			if (!response) throw new Error("missing fixture executor");
			const row = JSON.parse(response.stdout);
			if (row.transitions.length) row.transitions.pop();
			return { ...response, stdout: JSON.stringify(row) };
		});
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"transition coverage",
		);
	});
	it("removes scratch after failed offline compilation without touching sibling cache files", async () => {
		const f = fixture();
		const before = readdirSync(cache).sort();
		f.compile.mockRejectedValue(new Error("offline compiler fixture failure"));
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"offline compiler fixture failure",
		);
		expect(readdirSync(cache).sort()).toEqual(before);
		expect(f.execute).not.toHaveBeenCalled();
	});
	it("refuses an oracle dependency checksum absent from the product lock", async () => {
		const f = fixture();
		const lock = readFileSync(path.join(f.repo, "crates/Cargo.lock"), "utf8");
		f.put(
			f.repo,
			"crates/Cargo.lock",
			lock.replace(
				/checksum = "[a-f0-9]{64}"/,
				`checksum = "${hash(Buffer.from("different dependency"))}"`,
			),
		);
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"dependency pin differs",
		);
		expect(f.compile).not.toHaveBeenCalled();
	});
	it("copies Cargo's private hard-linked compiler output to a single-link clean probe", async () => {
		const f = fixture();
		const original = f.compile.getMockImplementation();
		f.compile.mockImplementation(async (...args) => {
			await original?.(...args);
			const file = path.join(args[1], `release/${oracleBinary}`);
			linkSync(file, `${file}.compiler-alias`);
		});
		expect((await inspectScheduleEquivalence(f.options, f.deps)).counts.transitions).toBe(12);
	});
	it("detects compiled-oracle mutation between bounded requests", async () => {
		const f = fixture();
		const original = f.execute.getMockImplementation();
		f.execute.mockImplementation((...args) => {
			const response = original?.(...args);
			if (!response) throw new Error("missing fixture executor");
			if (args[0] === "native") writeFileSync(args[1], "changed oracle bytes");
			return response;
		});
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"compiled schedule oracle changed",
		);
	});
	it("rechecks the app candidate after successful engine answers", async () => {
		const f = fixture();
		const original = f.execute.getMockImplementation();
		f.execute.mockImplementation((...args) => {
			const response = original?.(...args);
			if (!response) throw new Error("missing fixture executor");
			const q = args[2] as { schedules?: unknown[] };
			if (args[0] === "node" && q.schedules)
				f.put(f.stage, f.options.nativeArtifact.path, "changed after comparison");
			return response;
		});
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"schedule input integrity mismatch",
		);
	});
	it("treats timeout or nonzero runtime exit as failure", async () => {
		const f = fixture();
		f.execute.mockReturnValue({
			status: null,
			stdout: "",
			stderr: "",
			error: new Error("timed out"),
		});
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow("execution failed");
	});
});
