import { readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { acquireBenchLock, benchTimeout } from "@draftyak/spike-kit";
import { expect, it } from "vitest";
import { DB_FILES } from "../src/canary.ts";
import { openEncrypted, readSettings, truncateWal } from "../src/db.ts";
import { evidenceDir } from "../src/matrix.ts";
import type { SqliteDatabase } from "../src/open.ts";
import { hostTarget, PACKAGE, packageDir } from "../src/prebuilds.ts";
import { recording, writeCodeEvidence } from "../src/record.ts";
import { type Rotation, rotate } from "../src/rotate.ts";
import {
	addConversation,
	binding,
	coreDatabase,
	ftsIntegrity,
	newKey,
	tempDir,
} from "./support.ts";

// §15 S1: the cost of secure_delete on 10k rows, with and without their FTS5 rows (and FTS5's own
// secure-delete), plus what opening with the key and each rotation method cost at that size. Then
// how FTS5's secure-delete scales: the oldest 5,000 messages deleted from 10k and from 50k.
const ROWS = 10_000;
const BATCH = 500;
const REPEATS = 3;
const BODY_WORDS = 60;
const SAMPLE = 5_000;
const SIZES = [10_000, 50_000] as const;

type Table = "plain" | "fts" | "fts-secure";
const TABLES: readonly Table[] = ["plain", "fts", "fts-secure"];

interface Run {
	readonly insertMs: number;
	readonly deleteMs: number;
	readonly walBytesAfterDelete: number;
	readonly dbBytesAfterInsert: number;
	readonly freedPages: number;
	readonly vacuumMs: number;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const median = (values: readonly number[]): number => {
	const sorted = values.toSorted((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? (sorted[middle] ?? 0)
		: ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};
const timed = (action: () => void): number => {
	const started = performance.now();
	action();
	return round1(performance.now() - started);
};

// Deterministic text from a 4,096-word vocabulary, skewed like natural language.
function textSource(seed: number): (words: number) => string {
	const syllables = "ka lo mi ne ru sa to vi ze po da fe gu hi jo be".split(" ");
	const word = (index: number): string =>
		[index & 15, (index >> 4) & 15, (index >> 8) & 15].map((at) => syllables[at]).join("");
	let state = seed >>> 0;
	const random = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = Math.imul(state ^ (state >>> 15), state | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
	};
	return (words) =>
		Array.from({ length: words }, () => word(Math.floor(4096 * random() ** 2))).join(" ");
}

function fill(db: SqliteDatabase, rows: number): void {
	const text = textSource(rows);
	const insert = db.prepare(
		"INSERT INTO messages (id, conversation_id, sender, subject, body, sent_at) VALUES (?, 'conv-1', ?, ?, ?, ?)",
	);
	for (let start = 0; start < rows; start += BATCH) {
		db.transaction(() => {
			for (let index = start; index < Math.min(start + BATCH, rows); index++) {
				insert.run(
					`msg-${index}`,
					`sender${index % 97}@example.com`,
					text(6),
					text(BODY_WORDS),
					index,
				);
			}
		})();
	}
}

type Synchronous = "FULL" | "NORMAL";

async function benchDatabase(
	file: string,
	key: string,
	table: Table,
	secureDelete: boolean,
	synchronous: Synchronous = "FULL",
) {
	const db = await coreDatabase(file, key);
	if (table === "plain") {
		db.exec(`DROP TRIGGER messages_ai; DROP TRIGGER messages_ad; DROP TRIGGER messages_au;
			DROP TABLE fts_messages`);
	} else if (table === "fts") {
		db.exec("INSERT INTO fts_messages (fts_messages, rank) VALUES ('secure-delete', 0)");
	}
	if (!secureDelete) db.pragma("secure_delete = OFF");
	db.pragma(`synchronous = ${synchronous}`);
	addConversation(db);
	return db;
}

const removeDatabase = (file: string): void => {
	for (const suffix of DB_FILES) rmSync(`${file}${suffix}`, { force: true, maxRetries: 5 });
};

async function runOnce(
	dir: string,
	table: Table,
	secureDelete: boolean,
	synchronous: Synchronous = "FULL",
): Promise<Run> {
	const file = path.join(dir, "bench.db");
	const db = await benchDatabase(file, newKey(), table, secureDelete, synchronous);
	try {
		const insertMs = timed(() => fill(db, ROWS));
		db.pragma("wal_checkpoint(TRUNCATE)");
		const dbBytesAfterInsert = statSync(file).size;
		db.pragma("wal_autocheckpoint = 0");
		const remove = db.prepare(
			"DELETE FROM messages WHERE seq IN (SELECT seq FROM messages ORDER BY seq LIMIT ?)",
		);
		const deleteMs = timed(() => {
			while (db.transaction(() => remove.run(BATCH).changes)() > 0);
		});
		const walBytesAfterDelete = statSync(`${file}-wal`).size;
		expect(db.prepare("SELECT count(*) FROM messages").pluck().get()).toBe(0);
		if (table !== "plain") ftsIntegrity(db);
		const freedPages = db.pragma("freelist_count", { simple: true }) as number;
		const vacuumMs = timed(() => db.pragma("incremental_vacuum"));
		return { insertMs, deleteMs, walBytesAfterDelete, dbBytesAfterInsert, freedPages, vacuumMs };
	} finally {
		db.close();
		removeDatabase(file);
	}
}

interface Scaled {
	readonly insertMs: number;
	readonly deleteMs: number;
	readonly walBytesAfterDelete: number;
}

// The production setup with `rows` messages; then the oldest SAMPLE go, BATCH per transaction.
async function scaleOnce(dir: string, rows: number): Promise<Scaled> {
	const file = path.join(dir, "scale.db");
	const db = await benchDatabase(file, newKey(), "fts-secure", true);
	try {
		const insertMs = timed(() => fill(db, rows));
		truncateWal(db);
		db.pragma("wal_autocheckpoint = 0");
		const remove = db.prepare(
			"DELETE FROM messages WHERE seq IN (SELECT seq FROM messages ORDER BY seq LIMIT ?)",
		);
		let left = SAMPLE;
		const deleteMs = timed(() => {
			while (left > 0) left -= db.transaction(() => remove.run(Math.min(BATCH, left)).changes)();
		});
		const walBytesAfterDelete = statSync(`${file}-wal`).size;
		ftsIntegrity(db);
		return { insertMs, deleteMs, walBytesAfterDelete };
	} finally {
		db.close();
		removeDatabase(file);
	}
}

// The median of each measurement over the repeats.
function summarize<T extends object>(runs: readonly T[]): T {
	const keys = Object.keys(runs[0] ?? {}) as (keyof T)[];
	return Object.fromEntries(
		keys.map((key) => [key, median(runs.map((run) => Number(run[key])))]),
	) as unknown as T;
}

const overhead = (on: number, off: number): number => round1((100 * (on - off)) / off);

it("measures secure_delete on 10k rows and their FTS5 rows, the keyed open, both rotations and scaling", {
	timeout: benchTimeout(600_000),
	tags: ["requires:bench-host"],
}, async (ctx) => {
	using lock = await acquireBenchLock({ label: "s01 secure_delete bench", signal: ctx.signal });
	const dir = tempDir("s01-bench-");
	const cases: (Run & { readonly table: Table; readonly secureDelete: boolean })[] = [];
	for (const table of TABLES) {
		for (const secureDelete of [false, true]) {
			const runs: Run[] = [];
			for (let repeat = 0; repeat < REPEATS; repeat++) {
				runs.push(await runOnce(dir, table, secureDelete));
			}
			cases.push({ table, secureDelete, ...summarize(runs) });
		}
	}
	const find = (table: Table, secureDelete: boolean) =>
		cases.find((entry) => entry.table === table && entry.secureDelete === secureDelete);
	const compare = (on: Run | undefined, off: Run | undefined) => ({
		insertPercent: overhead(on?.insertMs ?? 0, off?.insertMs ?? 1),
		deletePercent: overhead(on?.deleteMs ?? 0, off?.deleteMs ?? 1),
		walBytesPercent: overhead(on?.walBytesAfterDelete ?? 0, off?.walBytesAfterDelete ?? 1),
	});
	// SQLite's secure_delete per table setup, then FTS5's own secure-delete with secure_delete on.
	const secureDeleteOverhead = TABLES.map((table) => ({
		table,
		...compare(find(table, true), find(table, false)),
	}));
	const ftsSecureDeleteOverhead = compare(find("fts-secure", true), find("fts", true));
	// What synchronous=FULL adds over the build's NORMAL: a WAL sync at each of the 40 commits.
	const normalRuns: Run[] = [];
	for (let repeat = 0; repeat < REPEATS; repeat++) {
		normalRuns.push(await runOnce(dir, "plain", true, "NORMAL"));
	}
	const normal = summarize(normalRuns);
	const full = find("plain", true);
	const synchronousCost = {
		table: "plain",
		commits: (2 * ROWS) / BATCH,
		normal: { insertMs: normal.insertMs, deleteMs: normal.deleteMs },
		full: { insertMs: full?.insertMs ?? 0, deleteMs: full?.deleteMs ?? 0 },
	};

	// The production setup at 10k rows: what a keyed open and each rotation method cost.
	const key = newKey();
	const source = path.join(dir, "source.db");
	const db = await benchDatabase(source, key, "fts-secure", true);
	try {
		fill(db, ROWS);
		db.pragma("wal_checkpoint(TRUNCATE)");
	} finally {
		db.close();
	}
	let kdfIterations = 0;
	let settings: ReturnType<typeof readSettings> | undefined;
	const openMs = median(
		Array.from({ length: 5 }, () => {
			let opened: SqliteDatabase | undefined;
			const ms = timed(() => {
				opened = openEncrypted(source, key, binding());
			});
			kdfIterations = Number(opened?.pragma("kdf_iter", { simple: true }));
			settings = opened && readSettings(opened);
			opened?.close();
			return ms;
		}),
	);
	const rotations: Rotation[] = [];
	for (const method of ["vacuum-into", "attach-copy"] as const) {
		const runs: Rotation[] = [];
		for (let repeat = 0; repeat < REPEATS; repeat++) {
			const target = path.join(dir, `rotated-${method}-${repeat}.db`);
			runs.push(rotate(method, source, target, { from: key, to: newKey() }, binding()));
			removeDatabase(target);
		}
		rotations.push({
			method,
			copyMs: median(runs.map((run) => run.copyMs)),
			verifyMs: median(runs.map((run) => run.verifyMs)),
			bytes: median(runs.map((run) => run.bytes)),
		});
	}
	const sourceBytes = statSync(source).size;

	const scaling = [];
	for (const rows of SIZES) {
		const runs: Scaled[] = [];
		for (let repeat = 0; repeat < REPEATS; repeat++) runs.push(await scaleOnce(dir, rows));
		const run = summarize(runs);
		const perMessageMs = Math.round((1000 * run.deleteMs) / SAMPLE) / 1000;
		scaling.push({ rows, deleted: SAMPLE, ...run, perMessageMs });
	}

	const { version } = JSON.parse(readFileSync(path.join(packageDir(), "package.json"), "utf8")) as {
		version: string;
	};
	const data = {
		target: hostTarget(),
		package: `${PACKAGE}@${version}`,
		rows: ROWS,
		batch: BATCH,
		repeats: REPEATS,
		bodyWords: BODY_WORDS,
		settings,
		cases,
		secureDeleteOverhead,
		ftsSecureDeleteOverhead,
		synchronousCost,
		openMs,
		// SQLite3MC runs chacha20's key through PBKDF2-HMAC-SHA256 on every open and ATTACH.
		kdfIterations,
		sourceBytes,
		rotations,
		scaling,
		lock: { waitedMs: lock.waitedMs, idle: lock.idle },
	};
	const summary = { cases, ftsSecureDeleteOverhead, synchronousCost, openMs, rotations, scaling };
	console.log(JSON.stringify(summary));
	for (const rotation of rotations) expect(rotation.bytes).toBeGreaterThan(0);
	if (recording()) {
		const file = path.join(evidenceDir, `bench-${hostTarget()}.json`);
		console.log(`evidence: ${await writeCodeEvidence(file, data)}`);
	} else {
		console.log("evidence not recorded: run pnpm --filter @draftyak/spike-s01-sqlite3mc record");
	}
});
