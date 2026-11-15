import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	opendirSync,
	openSync,
	readSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { cliArgs, runCli, setOutputs, UsageError } from "./lib.ts";
import type { Source } from "./verification-receipt.ts";

export interface HeavyShard {
	readonly id: string;
	readonly spike: string;
}

export interface HeavyShardPlan {
	readonly selected: boolean;
	readonly count: number;
	readonly shards: readonly HeavyShard[];
	readonly matrix: { readonly include: readonly HeavyShard[] };
}

export interface HeavyShardRun {
	readonly id: string;
	readonly attempt: string;
}

export interface HeavyShardReceipt {
	readonly version: 1;
	readonly run: HeavyShardRun;
	readonly id: string;
	readonly spike: string;
	readonly source: Source;
	readonly completed: true;
}

export interface HeavyShardSummary {
	readonly source: Source;
	readonly completed: readonly HeavyShard[];
}

const MAX_SELECTION_BYTES = 16 * 1024;
const MAX_RECEIPT_BYTES = 4096;
const segment = "(?!\\.{1,2}(?:/|$))[a-z0-9._-]+";
const spikePath = new RegExp(`^${segment}(?:/${segment})*$`);
const sha40 = /^[a-f0-9]{40}$/;
const sha64 = /^[a-f0-9]{64}$/;

function refuse(): never {
	throw new UsageError("invalid heavy-shard metadata");
}

function bounded(value: unknown, pattern: RegExp, maximum: number): string {
	if (typeof value !== "string" || value.length > maximum || pattern.exec(value)?.[0] !== value)
		refuse();
	return value;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) refuse();
	const row = value as Record<string, unknown>;
	if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
		refuse();
	return row;
}

/** Partition the complete existing selection; this does not classify changed files. */
export function planHeavyShards(spikes: unknown): HeavyShardPlan {
	if (spikes === undefined) spikes = "";
	if (typeof spikes !== "string" || spikes.length > MAX_SELECTION_BYTES) refuse();
	const selected = spikes === "" ? [] : spikes.split(/\r?\n/);
	if (selected.length > 100) refuse();
	for (const spike of selected) bounded(spike, spikePath, 200);
	if (new Set(selected).size !== selected.length) refuse();
	selected.sort();
	const shards = Object.freeze(
		selected.map((spike, index) =>
			Object.freeze({ id: `spike-${String(index + 1).padStart(3, "0")}`, spike }),
		),
	);
	const include = shards.length
		? shards
		: Object.freeze([Object.freeze({ id: "spike-empty", spike: "" })]);
	return Object.freeze({
		selected: shards.length > 0,
		count: shards.length,
		shards,
		matrix: Object.freeze({ include }),
	});
}

export function validateHeavyShard(spikes: unknown, id: unknown, spike: unknown): HeavyShard {
	const plan = planHeavyShards(spikes);
	const expected = plan.shards.find((entry) => entry.id === id);
	if (!expected || expected.spike !== spike) refuse();
	return expected;
}

function source(value: unknown): Source {
	const row = object(value, [
		"checkoutSha",
		"treeSha",
		"lockfileSha256",
		"nodeVersion",
		"platform",
		"architecture",
	]);
	return Object.freeze({
		checkoutSha: bounded(row.checkoutSha, sha40, 40),
		treeSha: bounded(row.treeSha, sha40, 40),
		lockfileSha256: bounded(row.lockfileSha256, sha64, 64),
		nodeVersion: bounded(row.nodeVersion, /^\d+\.\d+\.\d+$/, 32),
		platform: bounded(row.platform, /^linux$/, 5),
		architecture: bounded(row.architecture, /^x64$/, 3),
	});
}

function run(value: unknown): HeavyShardRun {
	const row = object(value, ["id", "attempt"]);
	return Object.freeze({
		id: bounded(row.id, /^[1-9]\d*$/, 20),
		attempt: bounded(row.attempt, /^[1-9]\d*$/, 20),
	});
}

export function buildHeavyShardReceipt(input: {
	readonly spikes: unknown;
	readonly id: unknown;
	readonly spike: unknown;
	readonly source: unknown;
	readonly run: unknown;
	readonly commandResult: unknown;
}): HeavyShardReceipt {
	if (input.commandResult !== "success") refuse();
	const shard = validateHeavyShard(input.spikes, input.id, input.spike);
	return Object.freeze({
		version: 1,
		run: run(input.run),
		...shard,
		source: source(input.source),
		completed: true,
	});
}

function parseReceipt(value: unknown): HeavyShardReceipt {
	const row = object(value, ["version", "run", "id", "spike", "source", "completed"]);
	if (row.version !== 1 || row.completed !== true) refuse();
	return Object.freeze({
		version: 1,
		run: run(row.run),
		id: bounded(row.id, /^spike-\d{3}$/, 9),
		spike: bounded(row.spike, spikePath, 200),
		source: source(row.source),
		completed: true,
	});
}

function directory(value: string): string {
	if (!value || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) refuse();
	const resolved = path.resolve(value);
	const stat = lstatSync(resolved);
	if (!stat.isDirectory() || stat.isSymbolicLink()) refuse();
	return resolved;
}

function readRegular(file: string, maximum: number): Buffer {
	const before = lstatSync(file);
	if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) refuse();
	const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) refuse();
		const bytes = Buffer.alloc(maximum + 1);
		let used = 0;
		while (used < bytes.length) {
			const count = readSync(fd, bytes, used, bytes.length - used, used);
			if (!count) break;
			used += count;
		}
		const after = fstatSync(fd);
		if (used > maximum || used !== opened.size || after.size !== opened.size) refuse();
		return bytes.subarray(0, used);
	} finally {
		closeSync(fd);
	}
}

export function writeHeavyShardReceipt(folder: string, receipt: HeavyShardReceipt): string {
	try {
		const checked = parseReceipt(receipt);
		const file = path.join(directory(folder), `heavy-shard-${checked.id}.json`);
		writeFileSync(file, `${JSON.stringify(checked)}\n`, { flag: "wx" });
		return file;
	} catch {
		return refuse();
	}
}

export function collectHeavyShardReceipts(
	spikes: unknown,
	expectedSource: unknown,
	expectedRun: unknown,
	folder: string,
): HeavyShardSummary {
	try {
		const plan = planHeavyShards(spikes);
		const captured = source(expectedSource);
		const currentRun = run(expectedRun);
		const root = directory(folder);
		const expected = new Map(plan.shards.map((shard) => [`heavy-shard-${shard.id}.json`, shard]));
		const seen = new Set<string>();
		const entries = opendirSync(root);
		try {
			for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
				const shard = expected.get(entry.name);
				if (!shard || seen.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) refuse();
				const bytes = readRegular(path.join(root, entry.name), MAX_RECEIPT_BYTES);
				const text = bytes.toString("utf8");
				if (!Buffer.from(text).equals(bytes)) refuse();
				const value: unknown = JSON.parse(text);
				if (text !== `${JSON.stringify(value)}\n`) refuse();
				const receipt = parseReceipt(value);
				if (
					receipt.id !== shard.id ||
					receipt.spike !== shard.spike ||
					JSON.stringify(receipt.source) !== JSON.stringify(captured) ||
					JSON.stringify(receipt.run) !== JSON.stringify(currentRun)
				)
					refuse();
				seen.add(entry.name);
			}
		} finally {
			entries.closeSync();
		}
		if (seen.size !== expected.size) refuse();
		return Object.freeze({ source: captured, completed: plan.shards });
	} catch {
		return refuse();
	}
}

function gitMetadata(root: string, revision: string): string {
	const result = spawnSync(
		"git",
		["-c", "gc.auto=0", "-c", "maintenance.auto=false", "rev-parse", "--verify", revision],
		{ cwd: root, encoding: "utf8", maxBuffer: 4096, windowsHide: true },
	);
	if (result.error || result.signal || result.status !== 0) refuse();
	return bounded(result.stdout.trim(), sha40, 40);
}

function captureSource(root: string, env: NodeJS.ProcessEnv): Source {
	try {
		const pinnedNode = readRegular(path.join(root, ".node-version"), 128).toString("utf8").trim();
		if (pinnedNode !== process.versions.node) refuse();
		const captured = source({
			checkoutSha: gitMetadata(root, "HEAD"),
			treeSha: gitMetadata(root, "HEAD^{tree}"),
			lockfileSha256: createHash("sha256")
				.update(readRegular(path.join(root, "pnpm-lock.yaml"), 16 * 1024 * 1024))
				.digest("hex"),
			nodeVersion: pinnedNode,
			platform: process.platform,
			architecture: process.arch,
		});
		if (captured.checkoutSha !== env.GITHUB_SHA) refuse();
		return captured;
	} catch {
		return refuse();
	}
}

function main(argv: readonly string[]): number {
	const all = argv[0] === "--" ? argv.slice(1) : argv;
	const command = all[0];
	const env = process.env;
	if (command === "plan") {
		const args = cliArgs(all.slice(1), ["spikes"]);
		const plan = planHeavyShards(args.spikes ?? env.SPIKES);
		setOutputs({
			matrix: JSON.stringify(plan.matrix),
			selected: String(plan.selected),
			count: String(plan.count),
		});
		return 0;
	}
	if (command === "validate" || command === "receipt") {
		const args = cliArgs(
			all.slice(1),
			command === "receipt" ? ["spikes", "id", "spike", "runner-temp"] : ["spikes", "id", "spike"],
		);
		const spikes = args.spikes ?? env.SPIKES;
		const id = args.id ?? env.SHARD_ID;
		const spike = args.spike ?? env.SPIKE;
		validateHeavyShard(spikes, id, spike);
		if (command === "validate") return 0;
		const receipt = buildHeavyShardReceipt({
			spikes,
			id,
			spike,
			source: captureSource(process.cwd(), env),
			run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT },
			commandResult: env.SHARD_COMMAND_RESULT,
		});
		setOutputs({
			path: writeHeavyShardReceipt(args["runner-temp"] ?? env.RUNNER_TEMP ?? "", receipt),
		});
		return 0;
	}
	if (command === "collect") {
		const args = cliArgs(all.slice(1), ["spikes", "directory"]);
		const summary = collectHeavyShardReceipts(
			args.spikes ?? env.SPIKES,
			captureSource(process.cwd(), env),
			{ id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT },
			args.directory ?? env.SHARD_RECEIPTS ?? "",
		);
		setOutputs({
			source: JSON.stringify(summary.source),
			completed: JSON.stringify(summary.completed),
		});
		return 0;
	}
	throw new UsageError("expected plan, validate, receipt or collect");
}

if (import.meta.main) await runCli("heavy-shards", () => main(process.argv.slice(2)));
