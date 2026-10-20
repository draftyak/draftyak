import { argon2, timingSafeEqual } from "node:crypto";
import { AuditEvent } from "@draftyak/protocol/entities/audit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { type PinProof, PinService, type PinWallClock } from "../../src/identity/pin.ts";
import { newId } from "../../src/kernel/ids.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";
import { addShadows, fixture, nativeBinding, removeFixture } from "./helpers.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let audit: AuditChain;
let pins: PinService;
let wall: number;
const user = newId(1);
beforeEach(async () => {
	f = await fixture();
	wall = 1_800_000_000_000;
	const clock: PinWallClock = { wallMs: () => wall };
	const subkey = f.key.derive("audit");
	audit = new AuditChain(subkey);
	subkey.fill(0);
	pins = new PinService(f.store, audit, clock);
	f.store.write((tx) => tx.run("INSERT INTO users VALUES(?,?)", [user, wall]));
	await pins.initialize(user, "738294");
});
afterEach(() => {
	vi.restoreAllMocks();
	pins.lock();
	f.store.close();
	audit.destroy();
	f.key.destroy();
	removeFixture(f.dir);
});

it("checks a real Argon2 PIN outside a transaction and issues one scoped use", async () => {
	const pending = pins.verify(user, "738294", "approval:nonce-1");
	// A transaction can run while Argon2 is in flight: no write lock spans the await.
	f.store.write((tx) => tx.run("UPDATE users SET created_at=2 WHERE id=?", [user]));
	const proof = await pending;
	expect(JSON.stringify(proof)).toBe("{}");
	f.store.write((tx) => pins.consume(tx, proof, user, "approval:nonce-1"));
	expect(() => f.store.write((tx) => pins.consume(tx, proof, user, "approval:nonce-1"))).toThrow(
		"PIN_REQUIRED",
	);
	f.store.read((db) => audit.verify(db));
});
it("matches an independent native Argon2id recomputation at the fixed memory, passes and lanes", async () => {
	const row = f.store.read((db) =>
		db.get<{ salt: Buffer; hash: Buffer }>(
			"SELECT salt,hash FROM main.approval_pins WHERE user_id=?",
			[user],
		),
	);
	if (!row) throw new Error("Missing native test PIN");
	const input = Buffer.from("738294", "utf8");
	let derived: Buffer | undefined;
	try {
		derived = await new Promise<Buffer>((resolve, reject) => {
			argon2(
				"argon2id",
				{
					message: input,
					nonce: row.salt,
					parallelism: 4,
					tagLength: 32,
					memory: 65_536,
					passes: 3,
				},
				(error, output) => (error ? reject(error) : resolve(output)),
			);
		});
		expect(row.salt.byteLength).toBe(16);
		expect(timingSafeEqual(derived, row.hash)).toBe(true);
	} finally {
		input.fill(0);
		derived?.fill(0);
		row.salt.fill(0);
		row.hash.fill(0);
	}
});
it("refuses missing PIN, forged handles and a proof for another operation", async () => {
	await expect(pins.verify(user, "", "approval:n1")).rejects.toThrow("PIN_INVALID");
	expect(() =>
		f.store.write((tx) => pins.consume(tx, {} as PinProof, user, "approval:n1")),
	).toThrow("PIN_REQUIRED");
	const proof = await pins.verify(user, "738294", "approval:n1");
	expect(() => f.store.write((tx) => pins.consume(tx, proof, user, "approval:n2"))).toThrow(
		"PIN_REQUIRED",
	);
});
it("counts concurrent failures without lost updates and locks for fifteen minutes", async () => {
	const results = await Promise.allSettled(
		Array.from({ length: 4 }, () => pins.verify(user, "999999", "approval:n1")),
	);
	expect(results.every((result) => result.status === "rejected")).toBe(true);
	expect(
		f.store.read((db) => db.get<{ failures: number }>("SELECT failures FROM approval_pins"))
			?.failures,
	).toBe(4);
	await expect(pins.verify(user, "999999", "approval:n1")).rejects.toThrow("PIN_LOCKED");
	await expect(pins.verify(user, "738294", "approval:n1")).rejects.toThrow("PIN_LOCKED");
	wall += 900_001;
	const proof = await pins.verify(user, "738294", "approval:n1");
	f.store.write((tx) => pins.consume(tx, proof, user, "approval:n1"));
	expect(
		f.store.read((db) => db.get<{ failures: number }>("SELECT failures FROM approval_pins"))
			?.failures,
	).toBe(0);
});
it("accepts exactly thirty seconds and expires its next monotonic millisecond while wall time stands still", async () => {
	let now = 1_000;
	const monotonic = vi.spyOn(performance, "now").mockImplementation(() => now);
	let atBoundaryConsumed = false;
	let refusal: unknown;
	try {
		const exact = await pins.verify(user, "738294", "approval:n1");
		now += 30_000;
		f.store.write((tx) => pins.consume(tx, exact, user, "approval:n1"));
		atBoundaryConsumed = true;
		now = 100_000;
		const expired = await pins.verify(user, "738294", "approval:n1");
		now += 30_001;
		try {
			f.store.write((tx) => pins.consume(tx, expired, user, "approval:n1"));
		} catch (error) {
			refusal = error;
		}
	} finally {
		monotonic.mockRestore();
	}
	expect(atBoundaryConsumed).toBe(true);
	expect(refusal).toMatchObject({ message: "PIN_REQUIRED" });
});
it("expires a proof on wall advance or rewind and refuses a changed PIN version", async () => {
	const exact = await pins.verify(user, "738294", "approval:n1");
	wall += 30_000;
	f.store.write((tx) => pins.consume(tx, exact, user, "approval:n1"));
	const forward = await pins.verify(user, "738294", "approval:n1");
	wall += 30_001;
	expect(() => f.store.write((tx) => pins.consume(tx, forward, user, "approval:n1"))).toThrow(
		"PIN_REQUIRED",
	);
	const backward = await pins.verify(user, "738294", "approval:n1");
	wall--;
	expect(() => f.store.write((tx) => pins.consume(tx, backward, user, "approval:n1"))).toThrow(
		"PIN_REQUIRED",
	);
	const changed = await pins.verify(user, "738294", "approval:n1");
	f.store.write((tx) => tx.run("UPDATE approval_pins SET version=version+1"));
	expect(() => f.store.write((tx) => pins.consume(tx, changed, user, "approval:n1"))).toThrow(
		"PIN_CHANGED",
	);
});
it.each(["hash=zeroblob(32)", "salt=zeroblob(16)"])(
	"refuses PIN material replacement during Argon2 without a version change: %s",
	async (assignment) => {
		const pending = pins.verify(user, "738294", "approval:n1");
		f.store.write((tx) => tx.run(`UPDATE main.approval_pins SET ${assignment}`));
		await expect(pending).rejects.toThrow("PIN_CHANGED");
	},
);
it("cannot recreate a PIN or complete hashing after the hub locks", async () => {
	await expect(pins.initialize(user, "111111")).rejects.toThrow("PIN_CHANGED");
	const pending = pins.verify(user, "738294", "approval:n1");
	pins.lock();
	await expect(pending).rejects.toThrow("PIN_REQUIRED");
	await expect(pins.verify(user, "738294", "approval:n1")).rejects.toThrow("PIN_REQUIRED");
});

it("rolls prepared PIN installation back with the native owner's transaction state", async () => {
	const candidate = newId(2);
	f.store.write((tx) => tx.run("INSERT INTO users VALUES(?,?)", [candidate, wall]));
	const prepared = await pins.prepareInitialization(candidate, "492738");
	expect(() =>
		f.store.write((tx) => {
			pins.install(tx, prepared, candidate);
			tx.run("UPDATE main.users SET created_at=7 WHERE id=?", [candidate]);
			throw new Error("operation failed");
		}),
	).toThrow("operation failed");
	expect(
		f.store.read((db) => db.get("SELECT user_id FROM approval_pins WHERE user_id=?", [candidate])),
	).toBeUndefined();
	expect(
		f.store.read((db) =>
			db.get<{ created_at: number }>("SELECT created_at FROM main.users WHERE id=?", [candidate]),
		)?.created_at,
	).toBe(wall);
	expect(() => f.store.write((tx) => pins.install(tx, prepared, candidate))).toThrow(
		"PIN_REQUIRED",
	);
});

it("discards abandoned verification and initialization proofs", async () => {
	const proof = await pins.verify(user, "738294", "approval:n1");
	pins.discard(proof);
	expect(() => f.store.write((tx) => pins.consume(tx, proof, user, "approval:n1"))).toThrow(
		"PIN_REQUIRED",
	);
	const prepared = await pins.prepareInitialization(user, "492738");
	pins.discard(prepared);
	expect(() => f.store.write((tx) => pins.install(tx, prepared, user))).toThrow("PIN_REQUIRED");
});

it("expires a prepared initialization without creating a durable PIN", async () => {
	const candidate = newId(5);
	f.store.write((tx) => {
		tx.run("INSERT INTO main.users VALUES(?,?)", [candidate, wall]);
	});
	const prepared = await pins.prepareInitialization(candidate, "492738");
	wall += 30_001;
	expect(() => f.store.write((tx) => pins.install(tx, prepared, candidate))).toThrow(
		"PIN_REQUIRED",
	);
	expect(
		f.store.read((db) =>
			db.get("SELECT user_id FROM main.approval_pins WHERE user_id=?", [candidate]),
		),
	).toBeUndefined();
});

it("refuses noncanonical PINs and scopes without coercing input objects", async () => {
	let hooks = 0;
	const object = {
		[Symbol.toPrimitive]() {
			hooks++;
			return "738294";
		},
	};
	const proxy = new Proxy(object, {
		get() {
			hooks++;
			throw new Error("DYTEST-INPUT-HOOK");
		},
	});
	for (const pin of [
		"738294\n",
		"738294\r",
		"７３８２９４",
		"1".repeat(65),
		"12345",
		object,
		proxy,
	])
		await expect(pins.prepareInitialization(user, pin as string)).rejects.toThrow("PIN_INVALID");
	for (const scope of ["approval:n1\n", "approval:n1\r", "a".repeat(161), "", object, proxy])
		await expect(pins.verify(user, "738294", scope as string)).rejects.toThrow("PIN_INVALID");
	expect(hooks).toBe(0);
	expect(
		f.store.read((db) => db.get<{ failures: number }>("SELECT failures FROM main.approval_pins"))
			?.failures,
	).toBe(0);
	await expect(pins.verify(user, "738294\n", "approval:n1")).rejects.toThrow("PIN_INVALID");
	expect(
		f.store.read((db) => db.get<{ failures: number }>("SELECT failures FROM main.approval_pins"))
			?.failures,
	).toBe(1);
});

it("refuses malformed stored PIN fields before Argon2 or proof issuance", async () => {
	const saved = f.store.read((db) =>
		db.get<{ hash: Buffer; salt: Buffer }>("SELECT hash,salt FROM main.approval_pins"),
	);
	if (!saved) throw new Error("Missing test PIN");
	try {
		for (const assignment of [
			"hash=zeroblob(4097)",
			"salt=zeroblob(4097)",
			"version=0",
			"failures=-1",
			"locked_until=-1",
		]) {
			f.store.write((tx) => tx.run(`UPDATE main.approval_pins SET ${assignment}`));
			await expect(pins.verify(user, "738294", "approval:n1")).rejects.toThrow("PIN_CHANGED");
			f.store.write((tx) =>
				tx.run("UPDATE main.approval_pins SET hash=?,salt=?,version=1,failures=0,locked_until=0", [
					saved.hash,
					saved.salt,
				]),
			);
		}
		const proof = await pins.verify(user, "738294", "approval:n1");
		f.store.write((tx) => pins.consume(tx, proof, user, "approval:n1"));
	} finally {
		saved.hash.fill(0);
		saved.salt.fill(0);
	}
});

it("uses the durable main PIN records despite temporary shadows", async () => {
	await addShadows(
		f,
		"CREATE TEMP TABLE approval_pins AS SELECT * FROM main.approval_pins WHERE 0; CREATE TEMP TABLE hub_meta AS SELECT * FROM main.hub_meta;",
	);
	f.store.write((tx) => tx.run("UPDATE temp.hub_meta SET identity_cert='DYTEST-SHADOW'"));
	const candidate = newId(3);
	f.store.write((tx) => tx.run("INSERT INTO main.users VALUES(?,?)", [candidate, wall]));
	await pins.initialize(candidate, "492738");
	const proof = await pins.verify(user, "738294", "approval:n1");
	f.store.write((tx) => pins.consume(tx, proof, user, "approval:n1"));
	expect(f.store.read((db) => db.all("SELECT * FROM temp.approval_pins"))).toEqual([]);
	expect(
		f.store.read((db) =>
			db.get<{ count: number }>("SELECT count(*) AS count FROM main.approval_pins"),
		)?.count,
	).toBe(2);
	f.store.read((db) => audit.verify(db));
});

it("requires a genuine Store before preparing a PIN and bypasses no substituted input methods", () => {
	let hooks = 0;
	const hook = () => {
		hooks++;
		throw new Error("DYTEST-STORE-HOOK");
	};
	const fake = Object.assign(Object.create(HubStore.prototype) as HubStore, { read: hook });
	expect(() => new PinService(fake, audit)).toThrow();
	expect(() => new PinService(new Proxy(f.store, { get: hook }), audit)).toThrow();
	expect(hooks).toBe(0);
});

it("preserves an initialization handle across fake, read, expired and foreign transaction refusals", async () => {
	const candidate = newId(4);
	f.store.write((tx) => {
		tx.run("INSERT INTO main.users VALUES(?,?)", [candidate, wall]);
	});
	const prepared = await pins.prepareInitialization(candidate, "492738");
	let hooks = 0;
	const fake = Object.defineProperty(Object.create(null), "get", {
		get() {
			hooks++;
			throw new Error("DYTEST-TX-HOOK");
		},
	}) as SqlTransaction;
	expect(() => pins.install(fake, prepared, candidate)).toThrow("Database transaction unavailable");
	f.store.read((reader) => {
		expect(() => pins.install(reader as SqlTransaction, prepared, candidate)).toThrow(
			"Database transaction unavailable",
		);
	});
	let expired: SqlTransaction | undefined;
	f.store.write((tx) => {
		expired = tx;
	});
	const retired = expired;
	if (!retired) throw new Error("Missing native transaction");
	expect(() => pins.install(retired, prepared, candidate)).toThrow(
		"Database transaction unavailable",
	);
	const other = await fixture();
	try {
		other.store.write((tx) => {
			expect(() => pins.install(tx, prepared, candidate)).toThrow(
				"Database transaction unavailable",
			);
		});
	} finally {
		other.store.close();
		other.key.destroy();
		removeFixture(other.dir);
	}
	f.store.write((tx) => {
		expect(Object.isFrozen(tx)).toBe(true);
		expect(
			Reflect.set(tx, "run", () => {
				hooks++;
			}),
		).toBe(false);
		pins.install(tx, prepared, candidate);
	});
	expect(() => f.store.write((tx) => pins.install(tx, prepared, candidate))).toThrow(
		"PIN_REQUIRED",
	);
	expect(hooks).toBe(0);
});

it("preserves a genuine PIN proof until one live write from the issuing Store consumes it", async () => {
	const proof = await pins.verify(user, "738294", "approval:n1");
	let hooks = 0;
	const hook = () => {
		hooks++;
		throw new Error("DYTEST-TX-HOOK");
	};
	const fake = new Proxy(Object.create(null), { get: hook }) as SqlTransaction;
	expect(() => pins.consume(fake, proof, user, "approval:n1")).toThrow(
		"Database transaction unavailable",
	);
	f.store.read((reader) => {
		expect(() => pins.consume(reader as SqlTransaction, proof, user, "approval:n1")).toThrow(
			"Database transaction unavailable",
		);
	});
	let expired: SqlTransaction | undefined;
	f.store.write((tx) => {
		expired = tx;
	});
	const retired = expired;
	if (!retired) throw new Error("Missing native transaction");
	expect(() => pins.consume(retired, proof, user, "approval:n1")).toThrow(
		"Database transaction unavailable",
	);
	const other = await fixture();
	try {
		other.store.write((tx) => {
			expect(() => pins.consume(tx, proof, user, "approval:n1")).toThrow(
				"Database transaction unavailable",
			);
		});
	} finally {
		other.store.close();
		other.key.destroy();
		removeFixture(other.dir);
	}
	f.store.write((tx) => pins.consume(tx, proof, user, "approval:n1"));
	expect(() => f.store.write((tx) => pins.consume(tx, proof, user, "approval:n1"))).toThrow(
		"PIN_REQUIRED",
	);
	expect(hooks).toBe(0);
});

it.each([
	"hash=zeroblob(32)",
	"salt=zeroblob(16)",
	"locked_until=-1",
	"hash=zeroblob(4097)",
	"salt=zeroblob(4097)",
])("refuses post-verification PIN material or row corruption: %s", async (assignment) => {
	const proof = await pins.verify(user, "738294", "approval:n1");
	f.store.write((tx) => {
		tx.run(`UPDATE main.approval_pins SET ${assignment}`);
	});
	expect(() => f.store.write((tx) => pins.consume(tx, proof, user, "approval:n1"))).toThrow(
		"PIN_CHANGED",
	);
	expect(() => f.store.write((tx) => pins.consume(tx, proof, user, "approval:n1"))).toThrow(
		"PIN_REQUIRED",
	);
});

it("accounts for concurrent failed PINs across two genuine encrypted connections", async () => {
	const otherStore = new HubStore({ filename: f.filename, masterKey: f.key, nativeBinding });
	const key = f.key.derive("audit");
	const otherAudit = new AuditChain(key);
	key.fill(0);
	const otherPins = new PinService(otherStore, otherAudit, { wallMs: () => wall });
	try {
		const outcomes = await Promise.allSettled([
			pins.verify(user, "999999", "approval:n1"),
			otherPins.verify(user, "999999", "approval:n1"),
			pins.verify(user, "999999", "approval:n1"),
			otherPins.verify(user, "999999", "approval:n1"),
		]);
		expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
		expect(
			otherStore.read((db) =>
				db.get<{ failures: number }>("SELECT failures FROM main.approval_pins"),
			)?.failures,
		).toBe(4);
		await expect(otherPins.verify(user, "999999", "approval:n1")).rejects.toThrow("PIN_LOCKED");
		await expect(pins.verify(user, "738294", "approval:n1")).rejects.toThrow("PIN_LOCKED");
		const row = f.store.read((db) =>
			db.get<{ failures: number; locked_until: number }>(
				"SELECT failures,locked_until FROM main.approval_pins",
			),
		);
		expect(row).toEqual({ failures: 5, locked_until: wall + 900_000 });
		wall += 899_999;
		await expect(pins.verify(user, "738294", "approval:n1")).rejects.toThrow("PIN_LOCKED");
		wall++;
		const proof = await otherPins.verify(user, "738294", "approval:n1");
		otherStore.write((tx) => otherPins.consume(tx, proof, user, "approval:n1"));
		expect(
			f.store.read((db) => db.get<{ failures: number }>("SELECT failures FROM main.approval_pins"))
				?.failures,
		).toBe(0);
		f.store.read((db) => {
			audit.verify(db);
		});
	} finally {
		otherPins.lock();
		otherAudit.destroy();
		otherStore.close();
	}
});

it("preserves prepared and verified handles after a caught native transaction-wide rollback", async () => {
	const candidate = newId(7);
	f.store.write((tx) => tx.run("INSERT INTO main.users VALUES(?,?)", [candidate, wall]));
	const prepared = await pins.prepareInitialization(candidate, "492738");
	const proof = await pins.verify(user, "738294", "approval:n1");
	const refusals: unknown[] = [];
	try {
		f.store.write((tx) => {
			try {
				tx.run("INSERT OR ROLLBACK INTO main.users VALUES(?,?)", [user, wall]);
			} catch {
				/* Native duplicate key rolls back the entire transaction. */
			}
			for (const attempt of [
				() => pins.install(tx, prepared, candidate),
				() => pins.consume(tx, proof, user, "approval:n1"),
			]) {
				try {
					attempt();
				} catch (error) {
					refusals.push(error);
				}
			}
		});
	} catch {
		/* Native wrapper may refuse its final commit after SQLite rollback. */
	}
	expect(refusals).toEqual([
		expect.objectContaining({ message: "Database transaction unavailable" }),
		expect.objectContaining({ message: "Database transaction unavailable" }),
	]);
	f.store.write((tx) => {
		expect(() => tx.run("INSERT OR ABORT INTO main.users VALUES(?,?)", [user, wall])).toThrow();
		pins.install(tx, prepared, candidate);
		pins.consume(tx, proof, user, "approval:n1");
	});
	const installed = await pins.verify(candidate, "492738", "approval:n2");
	f.store.write((tx) => pins.consume(tx, installed, candidate, "approval:n2"));
});

it("does not resurrect a consumed proof when its authorized SQL operation rolls back", async () => {
	const proof = await pins.verify(user, "738294", "approval:n1");
	expect(() =>
		f.store.write((tx) => {
			pins.consume(tx, proof, user, "approval:n1");
			tx.run("UPDATE main.users SET created_at=7 WHERE id=?", [user]);
			throw new Error("DYTEST-OPERATION-ROLLBACK");
		}),
	).toThrow("DYTEST-OPERATION-ROLLBACK");
	expect(
		f.store.read((db) =>
			db.get<{ created_at: number }>("SELECT created_at FROM main.users WHERE id=?", [user]),
		)?.created_at,
	).toBe(wall);
	expect(() => f.store.write((tx) => pins.consume(tx, proof, user, "approval:n1"))).toThrow(
		"PIN_REQUIRED",
	);
});

it.each(["user", "scope"] as const)(
	"burns a proof after a genuine attempted use with the wrong %s",
	async (field) => {
		const proof = await pins.verify(user, "738294", "approval:n1");
		expect(() =>
			f.store.write((tx) =>
				pins.consume(
					tx,
					proof,
					field === "user" ? newId(9) : user,
					field === "scope" ? "approval:n2" : "approval:n1",
				),
			),
		).toThrow("PIN_REQUIRED");
		expect(() => f.store.write((tx) => pins.consume(tx, proof, user, "approval:n1"))).toThrow(
			"PIN_REQUIRED",
		);
	},
);

it("refuses an overflowing lock deadline without committing a failure count or diagnostic data", async () => {
	for (let count = 0; count < 4; count++)
		await expect(pins.verify(user, "999999", "approval:n1")).rejects.toThrow("PIN_INVALID");
	wall = Number.MAX_SAFE_INTEGER;
	await expect(pins.verify(user, "999999", "approval:n1")).rejects.toMatchObject({
		code: "PIN_REQUIRED",
		message: "PIN_REQUIRED",
	});
	expect(
		f.store.read((db) => db.get("SELECT failures,locked_until FROM main.approval_pins")),
	).toEqual({ failures: 4, locked_until: 0 });
	const service = new PinService(f.store, audit, {
		wallMs() {
			throw new Error("DYTEST-CLOCK-PRIVATE-DIAGNOSTIC");
		},
	});
	try {
		await expect(service.prepareInitialization(newId(9), "492738")).rejects.toMatchObject({
			code: "PIN_REQUIRED",
			message: "PIN_REQUIRED",
		});
	} finally {
		service.lock();
	}
});

it("rejects malformed clock samples without coercing them or refreshing proof authority", async () => {
	let hooks = 0;
	const validWall = wall;
	for (const sample of [
		String(wall),
		{
			valueOf() {
				hooks++;
				return validWall;
			},
		},
		NaN,
		Infinity,
		-1,
		wall + 0.5,
	]) {
		const proof = await pins.verify(user, "738294", "approval:n1");
		wall = sample as number;
		expect(() => f.store.write((tx) => pins.consume(tx, proof, user, "approval:n1"))).toThrow(
			"PIN_REQUIRED",
		);
		wall = validWall;
	}
	const proof = await pins.verify(user, "738294", "approval:n1");
	const now = vi.spyOn(performance, "now").mockReturnValue(NaN);
	try {
		expect(() => f.store.write((tx) => pins.consume(tx, proof, user, "approval:n1"))).toThrow(
			"PIN_REQUIRED",
		);
	} finally {
		now.mockRestore();
	}
	expect(hooks).toBe(0);
});

it("bounds concurrent native KDF work and refuses lock while initialization is pending", async () => {
	const pending = Array.from({ length: 4 }, () => pins.verify(user, "738294", "approval:n1"));
	await expect(pins.verify(user, "738294", "approval:n1")).rejects.toThrow("PIN_BUSY");
	const proofs = await Promise.all(pending);
	for (const proof of proofs) pins.discard(proof);
	const prepared = pins.prepareInitialization(newId(8), "492738");
	pins.lock();
	await expect(prepared).rejects.toThrow("PIN_REQUIRED");
});

it("replaces native failures with fixed PIN errors and rolls back unsuccessful audit writes", async () => {
	const subkey = f.key.derive("audit");
	const unusable = new AuditChain(subkey);
	subkey.fill(0);
	unusable.destroy();
	const service = new PinService(f.store, unusable, { wallMs: () => wall });
	try {
		await expect(service.verify(user, "999999", "approval:n1")).rejects.toMatchObject({
			message: "PIN_REQUIRED",
			code: "PIN_REQUIRED",
		});
		expect(
			f.store.read((db) => db.get<{ failures: number }>("SELECT failures FROM main.approval_pins"))
				?.failures,
		).toBe(0);
		const candidate = newId(9);
		f.store.write((tx) => tx.run("INSERT INTO main.users VALUES(?,?)", [candidate, wall]));
		await expect(service.initialize(candidate, "492738")).rejects.toMatchObject({
			message: "PIN_REQUIRED",
			code: "PIN_REQUIRED",
		});
		expect(
			f.store.read((db) =>
				db.get("SELECT user_id FROM main.approval_pins WHERE user_id=?", [candidate]),
			),
		).toBeUndefined();
	} finally {
		service.lock();
	}
	const pending = pins.verify(user, "738294", "approval:n1");
	f.store.close();
	await expect(pending).rejects.toMatchObject({ message: "PIN_REQUIRED", code: "PIN_REQUIRED" });
});

it("writes complete merged ID-only AuditEvent records for PIN state changes", async () => {
	await expect(pins.verify(user, "999999", "approval:n1")).rejects.toThrow("PIN_INVALID");
	const page = f.store.read((db) => audit.exportVerifiedJsonl(db));
	const events = page.jsonl
		.trim()
		.split("\n")
		.map((line) => {
			const { seq, previous, mac, ...event } = JSON.parse(line);
			expect(Number.isSafeInteger(seq)).toBe(true);
			expect(typeof previous).toBe("string");
			expect(mac).toMatch(/^[0-9a-f]{64}$/);
			return AuditEvent.parse(event);
		});
	expect(events.map((event) => event.action)).toEqual(["pin.initialized", "pin.failed"]);
	for (const event of events) {
		expect(event.actor).toEqual({ kind: "hub", id: null });
		expect(event.refs).toEqual({ user });
	}
});
