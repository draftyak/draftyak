import Database from "better-sqlite3-multiple-ciphers";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionLogEntry } from "../../src/extensions/registry.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore } from "../../src/store/store.ts";
import {
	type Fixture,
	fixture,
	refused,
	refusedNow,
	registry,
	resetTrace,
	trace,
	ULID,
} from "./helpers.ts";

let f: Fixture;
beforeEach(() => {
	resetTrace();
	f = fixture();
});
afterEach(() => f.remove());

const CONTRACT = [
	"adminOp",
	"auditSink",
	"backup",
	"cert",
	"db",
	"deviceRoutes",
	"identity",
	"log",
	"migrations",
	"onEvent",
	"push",
	"sendPolicy",
	"transport",
	"workspace",
];
const rows = {
	"0001_rows.sql": "CREATE TABLE ext_alpha_rows(id TEXT PRIMARY KEY, data BLOB) STRICT;",
};
const intrinsics = new Set<unknown>([
	Object.prototype,
	Function.prototype,
	Array.prototype,
	Uint8Array.prototype,
	Object.getPrototypeOf(Uint8Array.prototype),
	Object.getPrototypeOf(async () => undefined),
]);

/** Every object and function reachable through properties, accessors and prototypes. */
function reachable(...roots: unknown[]): Set<object> {
	const seen = new Set<object>();
	const stack = [...roots];
	while (stack.length > 0) {
		const value = stack.pop();
		if (value === null || (typeof value !== "object" && typeof value !== "function")) continue;
		if (seen.has(value) || intrinsics.has(value)) continue;
		seen.add(value);
		stack.push(Object.getPrototypeOf(value));
		for (const key of Reflect.ownKeys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			stack.push(descriptor?.value, descriptor?.get, descriptor?.set);
		}
	}
	return seen;
}

describe("what a module can reach", () => {
	it("receives only the frozen contract surface", async () => {
		f.config([f.module("alpha", "", { migrations: rows })]);
		await f.start();
		const surface = registry("alpha");
		const database = surface.db();
		expect(Reflect.ownKeys(surface).sort()).toEqual(CONTRACT);
		expect(Reflect.ownKeys(database).sort()).toEqual([
			"delete",
			"insert",
			"select",
			"transaction",
			"update",
		]);
		expect(Reflect.ownKeys(surface.log).sort()).toEqual(["debug", "error", "info", "warn"]);
		for (const object of [surface, database, surface.log]) {
			expect(Object.isFrozen(object)).toBe(true);
			expect(Object.getPrototypeOf(object)).toBeNull();
		}
		for (const name of [
			"masterKey",
			"key",
			"store",
			"executor",
			"tickets",
			"broker",
			"clock",
			"scheduler",
		])
			expect(Reflect.get(surface, name)).toBeUndefined();
		database.insert("ext_alpha_rows", { id: "a", data: new Uint8Array([1]) });
		const found = reachable(surface, database, database.select("ext_alpha_rows", { limit: 1 }));
		for (const value of found) {
			expect(value).not.toBeInstanceOf(MasterKey);
			expect(value).not.toBeInstanceOf(Database);
			expect(value).not.toBeInstanceOf(HubStore);
			expect(value).not.toBeInstanceOf(Kysely);
			expect(Buffer.isBuffer(value)).toBe(false);
			if (typeof value === "function") {
				expect(Reflect.ownKeys(value).sort()).toEqual(["length", "name"]);
			} else if (!(value instanceof Uint8Array)) {
				expect(Object.isFrozen(value)).toBe(true);
				expect([null, Array.prototype]).toContain(Object.getPrototypeOf(value));
			}
		}
	});

	it("gives a hostile module nothing through constructors, callers or this", async () => {
		f.config([
			f.module(
				"alpha",
				`const attempt = (name, operation) => {
					try { trace.push([name, operation()]); } catch (error) { trace.push([name, error.constructor.name]); }
				};
				attempt("registry constructor", () => registry.constructor);
				attempt("registry prototype", () => Object.getPrototypeOf(registry));
				attempt("database constructor", () => registry.db().constructor);
				attempt("function prototype", () => registry.sendPolicy.prototype);
				attempt("caller", () => registry.db.caller);
				attempt("arguments", () => registry.onEvent.arguments);
				attempt("replace db", () => { registry.db = () => ({}); return "replaced"; });
				attempt("add key", () => { registry.masterKey = 1; return "added"; });
				attempt("transaction this", () => registry.db().transaction(function () { return this; }));`,
				{ migrations: rows },
			),
		]);
		await f.start();
		const results = new Map(trace().filter(Array.isArray) as [string, unknown][]);
		expect(results.get("registry constructor")).toBeUndefined();
		expect(results.get("registry prototype")).toBeNull();
		expect(results.get("database constructor")).toBeUndefined();
		expect(results.get("function prototype")).toBeUndefined();
		expect(["TypeError", null]).toContain(results.get("caller"));
		expect(["TypeError", null]).toContain(results.get("arguments"));
		expect(results.get("replace db")).toBe("TypeError");
		expect(results.get("add key")).toBe("TypeError");
		expect(results.has("transaction this")).toBe(true);
		expect(results.get("transaction this")).toBeUndefined();
	});

	it("keys every module database before any module code runs and keeps no master key", async () => {
		const nativeKey = Database.prototype.key;
		const keyed = vi.spyOn(Database.prototype, "key").mockImplementation(function (
			this: Database.Database,
			bytes,
		) {
			trace().push("keyed");
			return nativeKey.call(this, bytes);
		});
		try {
			f.config([
				f.module("alpha", "", { migrations: rows }),
				f.module("beta", "registry.onEvent(() => {});"),
			]);
			const host = await f.start();
			expect(trace()).toEqual([
				"keyed",
				"keyed",
				"alpha:loaded",
				"alpha:register",
				"beta:loaded",
				"beta:register",
			]);
			f.key.destroy();
			const database = registry("alpha").db();
			expect(database.insert("ext_alpha_rows", { id: "after-lock" })).toBe(1);
			expect(database.select("ext_alpha_rows", { limit: 1 })).toHaveLength(1);
			host.close();
			await refused("database", f.start());
		} finally {
			keyed.mockRestore();
		}
	});
});

describe("hostile registrations", () => {
	it("keeps the methods and id captured at registration", async () => {
		f.config([
			f.module(
				"alpha",
				`const policy = { id: "strict", async evaluate() { return { kind: "deny", reason: "x" }; } };
				registry.sendPolicy(policy);
				policy.id = "other";
				policy.evaluate = async () => ({ kind: "require", approvals: 1 });
				const operation = { summarize: () => ["original"], async apply() {} };
				registry.adminOp("rotate", operation);
				operation.summarize = () => ["replaced"];
				const routes = { fetch: () => new Response("original"), routes: [] };
				registry.deviceRoutes(routes);
				routes.fetch = () => new Response("replaced");`,
				{ provides: ["sendPolicy", "adminOp", "deviceRoutes"] },
			),
		]);
		const host = await f.start();
		expect(
			await host.evaluateSendPolicy({
				phase: "propose",
				snapshot: {} as never,
				flags: [],
				userId: ULID,
				accountId: ULID,
			}),
		).toEqual({ kind: "deny", policies: ["alpha/strict"] });
		const operation = host.adminOperation("alpha", "rotate");
		expect(operation?.summarize({})).toEqual(["original"]);
		expect(Object.isFrozen(operation)).toBe(true);
		const routes = host.deviceRoutes("alpha");
		expect(await (await routes?.fetch(new Request("https://hub.test/ext/alpha/")))?.text()).toBe(
			"original",
		);
		expect(Reflect.ownKeys(routes ?? {})).toEqual(["fetch"]);
		expect(Object.isFrozen(routes)).toBe(true);
		expect(Object.getPrototypeOf(routes)).toBeNull();
	});

	it("refuses a proxied provider without running any trap", async () => {
		f.config([
			f.module(
				"alpha",
				`const handler = new Proxy({}, { get: (_, trap) => (...args) => { trace.push("trap:" + String(trap)); return Reflect[trap](...args); } });
				try { registry.sendPolicy(new Proxy({ id: "p", async evaluate() {} }, handler)); }
				catch (error) { trace.push(error.code); }`,
				{ provides: ["sendPolicy"] },
			),
		]);
		await refused("registration", f.start());
		expect(trace()).toContain("registration");
		expect(trace().some((item) => String(item).startsWith("trap:"))).toBe(false);
	});

	it("logs only validated action codes and ULID references, attributed to the module", async () => {
		const entries: ExtensionLogEntry[] = [];
		f.config([f.module("alpha")]);
		await f.start({
			log: (entry) => {
				entries.push(entry);
				throw new Error("PRIVATE_SINK_FAILURE");
			},
		});
		const log = registry("alpha").log;
		log.info("alpha.started", { outbox: ULID });
		refusedNow("module", () => log.warn("DYTEST free text"));
		refusedNow("module", () => log.warn("alpha.x".padEnd(65, "x")));
		refusedNow("module", () => log.error("alpha.failed", { outbox: "DYTEST-not-an-id" }));
		refusedNow("module", () => log.error("alpha.failed", { "Bad-Kind": ULID }));
		refusedNow("module", () =>
			log.debug(
				"alpha.many",
				Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, ULID])),
			),
		);
		expect(entries).toEqual([
			{ module: "alpha", level: "info", action: "alpha.started", refs: { outbox: ULID } },
		]);
		expect(Object.isFrozen(entries[0])).toBe(true);
		expect(Object.isFrozen(entries[0]?.refs)).toBe(true);
	});
});
