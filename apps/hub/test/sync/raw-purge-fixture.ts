import { copyFileSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Account } from "@draftyak/protocol/entities/account";
import Database from "better-sqlite3-multiple-ciphers";
import type { WorkScope } from "../../src/jobs/database.ts";
import type { MetadataAccountRef } from "../../src/sync/apply.ts";
import { NativeRawStore, RAW_CONTENT_MIGRATIONS } from "../../src/sync/raw-store.ts";
import { captureConnections } from "../extensions/helpers.ts";
import { fixture, type NativeApplyFixture } from "./apply-fixture.ts";
import type { NativeRawFixture } from "./raw-fixture.ts";

export type PurgeFixture = NativeApplyFixture & {
	upgradeRaw(): Promise<void>;
	breakRawSchema(scope: WorkScope, kind: "partial" | "applied-missing" | "missing-index"): void;
};

const executeNative = Database.prototype.exec;

/** Real native services; only their explicitly registered SQL input varies. */
export async function purgeFixture(
	mode: "current" | "absent" | "legacy" | "wrong-index" = "current",
): Promise<PurgeFixture> {
	let folder: string | undefined;
	let removeFolder = (): void => {};
	if (mode === "legacy" || mode === "wrong-index") {
		const parent = realpathSync(tmpdir());
		const owned = realpathSync(mkdtempSync(path.join(parent, "draftyak-raw-purge-sql-")));
		const born = lstatSync(owned);
		folder = owned;
		removeFolder = (): void => {
			const current = lstatSync(owned);
			if (
				path.dirname(owned) !== parent ||
				!path.basename(owned).startsWith("draftyak-raw-purge-sql-") ||
				current.isSymbolicLink() ||
				!current.isDirectory() ||
				current.dev !== born.dev ||
				current.ino !== born.ino ||
				realpathSync(owned) !== owned
			)
				throw new Error("Raw purge SQL cleanup refused");
			rmSync(owned, { recursive: true, force: true });
		};
		copyFileSync(
			path.join(RAW_CONTENT_MIGRATIONS, "0001_raw.sql"),
			path.join(owned, "0001_raw.sql"),
		);
		if (mode === "wrong-index")
			writeFileSync(
				path.join(owned, "0002_account_purge.sql"),
				"CREATE INDEX rawcontent_account_purge ON rawcontent_objects(user_id,account_id,id);\n",
			);
	}
	try {
		const observed = captureConnections();
		let f: NativeApplyFixture;
		try {
			f = await fixture(mode === "absent" ? undefined : (folder ?? RAW_CONTENT_MIGRATIONS));
		} finally {
			observed.restore();
		}
		const matching = [
			...new Set(
				observed.connections.filter(
					(connection) => connection.open && connection.name === f.native.filename,
				),
			),
		];
		const connection = matching[0];
		if (matching.length !== 1 || !connection) {
			await f.cleanup();
			throw new Error("Raw purge native fixture connection unavailable");
		}
		const close = f.cleanup;
		return Object.assign(f, {
			breakRawSchema(
				scope: WorkScope,
				kind: "partial" | "applied-missing" | "missing-index",
			): void {
				f.database.sql(scope);
				if (
					!connection.open ||
					connection.name !== f.native.filename ||
					!connection.inTransaction ||
					!["partial", "applied-missing", "missing-index"].includes(kind)
				)
					throw new Error("Raw purge native fixture transaction unavailable");
				if (kind === "missing-index") {
					Reflect.apply(executeNative, connection, ["DROP INDEX main.rawcontent_account_purge"]);
					return;
				}
				Reflect.apply(executeNative, connection, ["DROP TABLE main.rawcontent_chunks"]);
				if (kind === "applied-missing")
					Reflect.apply(executeNative, connection, ["DROP TABLE main.rawcontent_objects"]);
			},
			async upgradeRaw(): Promise<void> {
				if (mode !== "legacy" || folder === undefined)
					throw new Error("Raw purge upgrade fixture refused");
				copyFileSync(
					path.join(RAW_CONTENT_MIGRATIONS, "0002_account_purge.sql"),
					path.join(folder, "0002_account_purge.sql"),
				);
				await f.store.migrate("rawcontent");
			},
			async cleanup(): Promise<void> {
				try {
					await close();
				} finally {
					removeFolder();
				}
			},
		});
	} catch (error) {
		removeFolder();
		throw error;
	}
}

/** A structural test view over the same genuine store/account/device services. */
export function rawView(f: PurgeFixture, ref: MetadataAccountRef = f.ref()): NativeRawFixture {
	const clock = { wallMs: () => f.clock.wall, monotonicMs: () => f.clock.monotonic };
	return {
		...f,
		model: new NativeRawStore(f.database, f.accounts, f.devices, clock),
		ref: (overrides: Partial<MetadataAccountRef> = {}) => ({ ...ref, ...overrides }),
	};
}

export function replaceAccount(f: PurgeFixture, changes: Partial<Account>): MetadataAccountRef {
	return f.database.write((scope) => {
		const current = f.accounts.get(scope, f.account.userId, f.account.id);
		if (!current) throw new Error("Raw purge account fixture unavailable");
		const next = f.accounts.replace(
			scope,
			{ ...current.account, ...changes } as Account,
			current.generation,
		);
		f.account = next.account as typeof f.account;
		f.generation = next.generation;
		return f.ref();
	});
}
