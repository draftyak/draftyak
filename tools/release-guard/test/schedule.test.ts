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
const oracleBinary = `xcheck${process.platform === "win32" ? ".exe" : ""}`;
const modulePath = "crates/draftyak-protocol/src/schedule.rs";
const nativeSource = "// synthetic shared schedule source; never compiled\n";
const vectorsPath = "spec/vectors/schedule/dst.json";
const display = "1970-01-01T00:00+00:00";
const versions = { jiffVersion: "0.2.38", jiffTzdbVersion: "0.1.9", tzdataVersion: "2026a" };

function fixture() {
	const folder = mkdtempSync(path.join(scratch, "case-"));
	const repo = path.join(folder, "repo");
	const stage = path.join(folder, "stage");
	const version = "26.12.0";
	const official = "synthetic official Node bytes; never executed";
	const put = (root: string, file: string, body: string | Uint8Array) => {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), body);
	};
	put(repo, modulePath, nativeSource);
	for (const file of [
		"crates/draftyak-protocol/src/snapshot.rs",
		"crates/draftyak-protocol/examples/xcheck/main.rs",
		"crates/draftyak-protocol/examples/xcheck/schedule.rs",
		"crates/draftyak-protocol/examples/xcheck/snapshot.rs",
		"packages/protocol/src/schedule.ts",
		"packages/protocol/src/snapshot.ts",
	])
		put(repo, file, "// synthetic source; never executed\n");
	put(repo, "crates/Cargo.toml", '[workspace]\nmembers = ["draftyak-protocol"]\n');
	put(
		repo,
		"crates/draftyak-protocol/Cargo.toml",
		'[package]\nname="draftyak-protocol"\nversion="0.0.0"\n[dependencies]\njiff = { version = "=0.2.38", default-features = false, features = ["std", "tzdb-bundle-always"] }\n',
	);
	put(
		repo,
		"crates/Cargo.lock",
		'[[package]]\nname = "jiff"\nversion = "0.2.38"\n[[package]]\nname = "jiff-tzdb"\nversion = "0.1.9"\n',
	);
	put(repo, "packages/protocol/package.json", '{"name":"@draftyak/protocol"}\n');
	put(repo, "pnpm-lock.yaml", "lockfileVersion: 9\n");
	put(repo, "rust-toolchain.toml", '[toolchain]\nchannel = "1.95.0"\n');
	put(repo, "tools/fetch-node/versions.json", JSON.stringify({ bundled: version }));
	const document = {
		format: "draftyak.vectors.schedule.v1",
		resolutionCases: [
			{ id: "unique", wall: "1970-01-01T00:00", zone: "UTC", notBefore: 0 },
			{
				id: "gap",
				wall: "2026-03-08T02:30",
				zone: "America/New_York",
				error: "NONEXISTENT_LOCAL_TIME",
			},
		],
		renderingCases: [
			{
				id: "epoch",
				notBefore: 0,
				zone: "UTC",
				localWallTime: display,
				mismatchedWallTime: "1970-01-01T00:01+00:00",
			},
			{ id: "milliseconds", notBefore: 59_999, zone: "UTC", localWallTime: display },
			{ id: "refused", notBefore: Number.MAX_SAFE_INTEGER, zone: "UTC", error: "INVALID_INPUT" },
		],
		snapshots: [
			{ id: "window", snapshot: { fixture: "window" }, iat: 0, window: { deliverBy: 900_000 } },
			{
				id: "overflow",
				snapshot: { fixture: "overflow" },
				iat: Number.MAX_SAFE_INTEGER,
				error: "SNAPSHOT_WINDOW_OVERFLOW",
			},
		],
	};
	put(repo, vectorsPath, JSON.stringify(document));
	put(stage, binary, official);
	put(stage, "native-candidate.exe", "synthetic candidate identity; never executed");
	const source = path.join(folder, "node-source");
	const prefix = `node-v${version}-${platform}-${process.arch}`;
	const entry = `${prefix}/${platform === "win" ? binary : `bin/${binary}`}`;
	const archive =
		platform === "win"
			? zip([{ name: entry, data: official }])
			: gzipSync(tar([{ name: entry, data: official }]));
	const archiveName = `${prefix}.${platform === "win" ? "zip" : "tar.gz"}`;
	put(source, archiveName, archive);
	put(source, "SHASUMS256.txt", `${hash(archive)}  ${archiveName}\n`);
	put(source, "SHASUMS256.txt.sig", "fixture signature");
	const record = (file: string) => {
		const bytes = readFileSync(path.join(stage, file));
		return { path: file, bytes: bytes.length, sha256: hash(bytes) };
	};
	const options = {
		repo,
		root: stage,
		nativeArtifact: record("native-candidate.exe"),
		node: { ...record(binary), version },
		nodeSource: {
			root: source,
			platform: platform as "win" | "linux" | "darwin",
			arch: process.arch as "x64" | "arm64",
		},
	} satisfies ScheduleOptions;
	let targetDirectory = "";
	const compile = vi.fn<NonNullable<ScheduleTestDeps["compile"]>>(async (project, target, env) => {
		targetDirectory = target;
		expect(project).toBe(repo);
		expect(readFileSync(path.join(project, modulePath), "utf8")).toBe(nativeSource);
		expect(existsSync(path.join(project, "protocol"))).toBe(false);
		expect(env.CARGO_NET_OFFLINE).toBe("true");
		expect(env.CARGO_BUILD_JOBS).toBe("1");
		expect(env.RUSTUP_AUTO_INSTALL).toBe("0");
		expect(env.RUSTFLAGS).toBeUndefined();
		expect(env.RUSTC_WRAPPER).toBeUndefined();
		put(target, `release/examples/${oracleBinary}`, "synthetic compiled oracle; never executed");
	});
	const execute = vi.fn<NonNullable<ScheduleTestDeps["execute"]>>((kind, file, input, cwd, env) => {
		expect(path.dirname(file)).toBe(cwd);
		for (const key of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "RUSTFLAGS"])
			expect(env[key]).toBeUndefined();
		if (kind === "native") {
			const queries = input as Record<string, unknown>[];
			expect(queries[0]).toEqual({ cmd: "schedule", notBefore: 0, zone: "UTC" });
			const rows = queries.map((query) => {
				if (query.cmd === "scheduleResolve")
					return query.zone === "UTC"
						? { ...versions, kind: "unique", compatible: 0, earlier: 0, later: 0, reject: 0 }
						: { ...versions, kind: "gap", compatible: 2, earlier: 1, later: 2, reject: null };
				if (query.cmd === "snapshot")
					return JSON.parse(String(query.snapshotJson)).fixture === "overflow"
						? { error: "SNAPSHOT_WINDOW_OVERFLOW" }
						: { window: { deliverBy: 900_000 } };
				expect(query.cmd).toBe("schedule");
				if (query.notBefore === Number.MAX_SAFE_INTEGER) return { error: "INVALID_INPUT" };
				return {
					...versions,
					localWallTime: display,
					...(query.localWallTime === undefined
						? {}
						: { matches: query.localWallTime === display }),
				};
			});
			return {
				status: 0,
				stderr: "",
				stdout: rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
			};
		}
		const request = input as { scheduleModule: string; snapshotModule: string };
		expect(request.scheduleModule).toMatch(/\/packages\/protocol\/src\/schedule\.ts$/);
		expect(request.snapshotModule).toMatch(/\/packages\/protocol\/src\/snapshot\.ts$/);
		return {
			status: 0,
			stderr: "",
			stdout: JSON.stringify({
				version,
				temporal: "object",
				disabled: true,
				tzVersion: "2026a",
				resolutions: [{ notBefore: 0 }, { error: "NONEXISTENT_LOCAL_TIME" }],
				renderings: [
					{ localWallTime: display, matches: true, mismatched: false },
					{ localWallTime: display, matches: true },
					{ error: "INVALID_INPUT" },
				],
				snapshots: [{ window: { deliverBy: 900_000 } }, { error: "SNAPSHOT_WINDOW_OVERFLOW" }],
			}),
		};
	});
	const signature = vi.fn(async (_sums: Buffer, sig: Buffer) => {
		if (sig.toString() !== "fixture signature") throw new Error("invalid fixture signature");
		return "fixture signer";
	});
	return {
		repo,
		stage,
		source,
		put,
		document,
		options,
		compile,
		execute,
		signature,
		deps: { compile, execute, signature },
		target: () => targetDirectory,
	};
}

describe("shared M1 canonical schedule comparison", () => {
	it("measures actual workspace inputs and compares canonical rendering, refusal and window outcomes", async () => {
		const f = fixture();
		const report = await inspectScheduleEquivalence(f.options, f.deps);
		expect(report.counts).toEqual({ resolutions: 2, renderings: 3, snapshots: 2 });
		expect(report.warnings).toEqual([]);
		expect(report.oracle.sha256).toBe(
			hash(Buffer.from("synthetic compiled oracle; never executed")),
		);
		expect(report.sources.find((row) => row.path === modulePath)?.sha256).toBe(
			hash(Buffer.from(nativeSource)),
		);
		expect(report.boundary).toContain("M4 approval-window validation");
		expect(f.compile).toHaveBeenCalledOnce();
		expect(f.signature).toHaveBeenCalledOnce();
		expect(f.execute).toHaveBeenCalledTimes(2);
		expect(existsSync(path.dirname(f.target()))).toBe(false);
	});
	it.each(["native-candidate.exe", binary])("refuses changed artifact %s", async (file) => {
		const f = fixture();
		f.put(f.stage, file, "changed");
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			/integrity|staged Node/,
		);
		expect(f.execute).not.toHaveBeenCalled();
	});
	it("does not execute either runtime on failed Node authentication", async () => {
		const f = fixture();
		f.put(f.source, "SHASUMS256.txt.sig", "changed");
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"invalid fixture signature",
		);
		expect(f.execute).not.toHaveBeenCalled();
	});
	it("detects source or vector mutation during compilation before any runtime", async () => {
		const f = fixture();
		const original = f.compile.getMockImplementation();
		f.compile.mockImplementation(async (...args) => {
			await original?.(...args);
			f.put(f.repo, modulePath, "changed source");
		});
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"input integrity mismatch",
		);
		expect(f.execute).not.toHaveBeenCalled();
	});
	it.each(["resolution", "rendering", "mismatch", "window", "version"])(
		"fails a differing native %s against both Temporal and canonical expected values",
		async (field) => {
			const f = fixture();
			const original = f.execute.getMockImplementation();
			f.execute.mockImplementation((...args) => {
				const reply = original?.(...args);
				if (!reply) throw new Error("missing fixture executor");
				if (args[0] !== "native") return reply;
				const commands = args[2] as Record<string, unknown>[];
				const rows = reply.stdout
					.trimEnd()
					.split("\n")
					.map((line) => JSON.parse(line));
				if (field === "version") rows[0].jiffVersion = "different";
				else if (field === "resolution")
					rows[commands.findIndex((row) => row.cmd === "scheduleResolve")].reject = 60_000;
				else if (field === "window")
					rows[commands.findIndex((row) => row.cmd === "snapshot")].window.deliverBy++;
				else if (field === "mismatch")
					rows[
						commands.findIndex((row) => row.localWallTime === "1970-01-01T00:01+00:00")
					].matches = true;
				else rows[1 + f.document.resolutionCases.length].localWallTime = "1970-01-01T00:01+00:00";
				return { ...reply, stdout: rows.map((row) => JSON.stringify(row)).join("\n") + "\n" };
			});
			await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(/differ/);
		},
	);
	it("fails a changed shared TypeScript outcome even when native answers match the vectors", async () => {
		const f = fixture();
		const original = f.execute.getMockImplementation();
		f.execute.mockImplementation((...args) => {
			const reply = original?.(...args);
			if (!reply) throw new Error("missing fixture executor");
			if (args[0] !== "node") return reply;
			const row = JSON.parse(reply.stdout);
			row.snapshots[1] = { window: { deliverBy: 0 } };
			return { ...reply, stdout: JSON.stringify(row) };
		});
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"canonical schedule vectors differ",
		);
	});
	it.each(["2026b", null])(
		"only warns for native tzdata %s when all answers agree",
		async (version) => {
			const f = fixture();
			const original = f.execute.getMockImplementation();
			f.execute.mockImplementation((...args) => {
				const reply = original?.(...args);
				if (!reply) throw new Error("missing fixture executor");
				if (args[0] !== "native") return reply;
				const rows = reply.stdout
					.trimEnd()
					.split("\n")
					.map((line) => JSON.parse(line));
				for (const row of rows) if (row.jiffVersion) row.tzdataVersion = version;
				return { ...reply, stdout: rows.map((row) => JSON.stringify(row)).join("\n") + "\n" };
			});
			expect((await inspectScheduleEquivalence(f.options, f.deps)).warnings).toHaveLength(1);
		},
	);
	it("preserves sibling cache files after failed offline compilation", async () => {
		const f = fixture();
		const before = readdirSync(cache).sort();
		f.compile.mockRejectedValue(new Error("offline compiler fixture failure"));
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"offline compiler fixture failure",
		);
		expect(readdirSync(cache).sort()).toEqual(before);
		expect(f.execute).not.toHaveBeenCalled();
	});
	it("refuses a changed shared dependency pin before compiling", async () => {
		const f = fixture();
		const file = "crates/draftyak-protocol/Cargo.toml";
		f.put(
			f.repo,
			file,
			readFileSync(path.join(f.repo, file), "utf8").replace("=0.2.38", "=0.2.37"),
		);
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"reviewed bundled jiff",
		);
		expect(f.compile).not.toHaveBeenCalled();
	});
	it("copies a hard-linked Cargo output into its own single-link probe", async () => {
		const f = fixture();
		const original = f.compile.getMockImplementation();
		f.compile.mockImplementation(async (...args) => {
			await original?.(...args);
			const file = path.join(args[1], `release/examples/${oracleBinary}`);
			linkSync(file, `${file}.compiler-alias`);
		});
		expect((await inspectScheduleEquivalence(f.options, f.deps)).counts.renderings).toBe(3);
	});
	it("detects compiled-oracle mutation after execution", async () => {
		const f = fixture();
		const original = f.execute.getMockImplementation();
		f.execute.mockImplementation((...args) => {
			const reply = original?.(...args);
			if (!reply) throw new Error("missing fixture executor");
			if (args[0] === "native") writeFileSync(args[1], "changed oracle");
			return reply;
		});
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"compiled schedule oracle changed",
		);
	});
	it("rechecks the staged artifact after the shared comparison", async () => {
		const f = fixture();
		const original = f.execute.getMockImplementation();
		f.execute.mockImplementation((...args) => {
			const reply = original?.(...args);
			if (!reply) throw new Error("missing fixture executor");
			if (args[0] === "node") f.put(f.stage, f.options.nativeArtifact.path, "changed");
			return reply;
		});
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"input integrity mismatch",
		);
	});
	it.each(["exit", "timeout", "extra answer", "missing newline", "overflow", "fault"])(
		"refuses %s without accepting partial oracle results",
		async (failure) => {
			const f = fixture();
			const original = f.execute.getMockImplementation();
			f.execute.mockImplementation((...args) => {
				const reply = original?.(...args);
				if (!reply) throw new Error("missing fixture executor");
				if (args[0] !== "native") return reply;
				if (failure === "exit") return { status: 1, stdout: reply.stdout, stderr: "fixed refusal" };
				if (failure === "timeout")
					return { status: null, error: new Error("timed out"), stdout: "", stderr: "" };
				const stdout =
					failure === "extra answer"
						? reply.stdout + "{}\n"
						: failure === "missing newline"
							? reply.stdout.trimEnd()
							: failure === "overflow"
								? "x".repeat(1_048_577)
								: reply.stdout.replace(/^[^\n]+/, '{"fault":"PRIVATE_CANARY"}');
				return { ...reply, stdout };
			});
			await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
				/failed|differs|refused/,
			);
		},
	);
	it("bounds canonical request bytes before invoking either runtime", async () => {
		const f = fixture();
		f.document.snapshots[0]!.snapshot = { fixture: "x".repeat(1_048_577) };
		f.put(f.repo, vectorsPath, JSON.stringify(f.document));
		await expect(inspectScheduleEquivalence(f.options, f.deps)).rejects.toThrow(
			"request exceeds bounds",
		);
		expect(f.execute).not.toHaveBeenCalled();
	});
});
