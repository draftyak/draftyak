import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { expect, test } from "vitest";
import { assertSettings, openEncrypted } from "../../src/store/open.ts";
import { fixture, nativeBinding } from "./helpers.ts";

type NativeConnection = ReturnType<typeof openEncrypted>;
type StoreFixture = Awaited<ReturnType<typeof fixture>>;

// Native pragma state is distinct from proving a platform's physical flush behavior.
const flags = (database: NativeConnection) => ({
	fullfsync: database.pragma("fullfsync", { simple: true }),
	checkpoint_fullfsync: database.pragma("checkpoint_fullfsync", { simple: true }),
});

function removeFixture(directory: string): void {
	const resolved = path.resolve(directory);
	if (
		path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
		!path.basename(resolved).startsWith("draftyak-store-")
	)
		throw new Error("Unexpected fixture directory");
	rmSync(resolved, { recursive: true, force: true });
	if (existsSync(resolved)) throw new Error("Native fixture cleanup incomplete");
}

async function withNativeStore(
	run: (current: StoreFixture, track: (database: NativeConnection) => NativeConnection) => void,
): Promise<void> {
	const current = await fixture();
	const connections: NativeConnection[] = [];
	try {
		run(current, (database) => {
			connections.push(database);
			return database;
		});
	} finally {
		try {
			for (const database of connections) if (database.open) database.close();
			current.store.close();
		} finally {
			current.key.destroy();
		}
		removeFixture(current.dir);
	}
}

test("native defaults stay off while every created or reopened encrypted connection enables both flags", async () => {
	await withNativeStore((current, track) => {
		const raw = track(new Database(":memory:", { nativeBinding }));
		expect(flags(raw)).toEqual({ fullfsync: 0, checkpoint_fullfsync: 0 });

		const filename = path.join(current.dir, "durability.db");
		const created = track(openEncrypted({ filename, nativeBinding, create: true }, current.key));
		expect(flags(created)).toEqual({ fullfsync: 1, checkpoint_fullfsync: 1 });
		created.exec("CREATE TABLE durability_control(value INTEGER NOT NULL) STRICT");
		created.prepare("INSERT INTO durability_control(value) VALUES (?)").run(17);
		created.close();

		const reopened = track(openEncrypted({ filename, nativeBinding }, current.key));
		const sibling = track(openEncrypted({ filename, nativeBinding }, current.key));
		expect(flags(reopened)).toEqual({ fullfsync: 1, checkpoint_fullfsync: 1 });
		expect(flags(sibling)).toEqual({ fullfsync: 1, checkpoint_fullfsync: 1 });
		expect(reopened.prepare("SELECT value FROM durability_control").get()).toEqual({ value: 17 });
		expect(() => assertSettings(reopened)).not.toThrow();
		expect(() => assertSettings(sibling)).not.toThrow();
	});
});

test.each(["fullfsync", "checkpoint_fullfsync"] as const)(
	"assertSettings refuses a real connection after only %s is lowered",
	async (setting) => {
		await withNativeStore((current, track) => {
			const changed = track(
				openEncrypted({ filename: current.filename, nativeBinding }, current.key),
			);
			const independent = track(
				openEncrypted({ filename: current.filename, nativeBinding }, current.key),
			);
			changed.pragma(`${setting} = OFF`);
			expect(flags(changed)).toEqual({
				fullfsync: setting === "fullfsync" ? 0 : 1,
				checkpoint_fullfsync: setting === "checkpoint_fullfsync" ? 0 : 1,
			});
			expect(() => assertSettings(changed)).toThrow("Database settings were not confirmed");
			expect(flags(independent)).toEqual({ fullfsync: 1, checkpoint_fullfsync: 1 });
			expect(() => assertSettings(independent)).not.toThrow();
			changed.pragma(`${setting} = ON`);
			expect(() => assertSettings(changed)).not.toThrow();
		});
	},
);
