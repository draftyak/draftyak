import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLICY_TIMEOUT_MS } from "../../src/extensions/policy.ts";
import { MAX_LISTENERS, MODULE_TIMEOUT_MS } from "../../src/extensions/registry.ts";
import {
	blockNativeClose,
	busyFor,
	captureConnections,
	type Fixture,
	fixture,
	flush,
	manualClock,
	pin,
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

const YEAR_AND_A_DAY_MS = 366 * 24 * 60 * 60 * 1000;
const policy = (id: string, result = '{ kind: "require", approvals: 1 }'): string =>
	`registry.sendPolicy({ id: ${JSON.stringify(id)}, async evaluate() { return ${result}; } });`;
const input = {
	phase: "claim",
	snapshot: {} as never,
	flags: [],
	userId: ULID,
	accountId: ULID,
} as const;

describe("configured module startup", () => {
	it("starts with no modules when config.json is absent", async () => {
		const host = await f.start();
		expect(host.modules).toEqual([]);
		expect(host.providers("auditSink")).toEqual([]);
		expect(await host.evaluateSendPolicy(input)).toEqual({
			kind: "require",
			approvals: 1,
			roles: [],
		});
		expect(trace()).toEqual([]);
	});

	it("loads modules in config order and keeps only their declared registrations", async () => {
		const alpha = f.module("alpha", policy("alpha-floor"), { provides: ["sendPolicy"] });
		const beta = f.module(
			"beta",
			`registry.auditSink({ id: "beta-sink", async append() {} });
			registry.adminOp("rotate", { summarize: () => ["rotate"], async apply() {} });`,
			{ provides: ["auditSink", "adminOp"], version: "2.1.0-rc.1" },
		);
		f.config([alpha, { ...beta, version: "2.1.0-rc.1" }]);
		const host = await f.start();
		expect(host.modules).toEqual([
			{ id: "alpha", version: "1.0.0" },
			{ id: "beta", version: "2.1.0-rc.1" },
		]);
		expect(trace()).toEqual(["alpha:loaded", "alpha:register", "beta:loaded", "beta:register"]);
		const [sink] = host.providers("auditSink");
		expect(host.providers("auditSink")).toHaveLength(1);
		expect([sink?.module, sink?.id]).toEqual(["beta", "beta-sink"]);
		expect(Object.isFrozen(sink)).toBe(true);
		expect(Object.getPrototypeOf(sink)).toBeNull();
		expect(host.adminOperation("beta", "rotate")?.summarize({})).toEqual(["rotate"]);
		expect(host.adminOperation("alpha", "rotate")).toBeUndefined();
		expect(host.providers("transport")).toEqual([]);
		expect(() => host.providers("sendPolicy" as never)).toThrow(TypeError);
	});
});

describe("registration refusals", () => {
	const refusals: [string, string, readonly string[]][] = [
		["a second registration of one service", `${policy("one")} ${policy("two")}`, ["sendPolicy"]],
		[
			"an undeclared service",
			`${policy("one")} registry.auditSink({ id: "sink", async append() {} });`,
			["sendPolicy"],
		],
		["a null provider", "registry.sendPolicy(null);", ["sendPolicy"]],
		["a provider without its method", 'registry.sendPolicy({ id: "bare" });', ["sendPolicy"]],
		[
			"a provider id outside the module grammar",
			'registry.sendPolicy({ id: "Bare", async evaluate() {} });',
			["sendPolicy"],
		],
		[
			"a provider id read through an accessor",
			'registry.sendPolicy({ get id() { trace.push("getter"); return "x"; }, async evaluate() {} });',
			["sendPolicy"],
		],
		[
			"an undeclared admin operation",
			'registry.adminOp("rotate", { summarize: () => [], async apply() {} });',
			[],
		],
		[
			"a repeated admin operation kind",
			`registry.adminOp("rotate", { summarize: () => [], async apply() {} });
			registry.adminOp("rotate", { summarize: () => [], async apply() {} });`,
			["adminOp"],
		],
		[
			"an admin operation kind outside the grammar",
			'registry.adminOp("Rotate.All", { summarize: () => [], async apply() {} });',
			["adminOp"],
		],
		[
			"an admin operation without apply",
			'registry.adminOp("rotate", { summarize: () => [] });',
			["adminOp"],
		],
		["undeclared device routes", "registry.deviceRoutes({ fetch: () => new Response() });", []],
		[
			"device routes registered twice",
			`registry.deviceRoutes({ fetch: () => new Response() });
			registry.deviceRoutes({ fetch: () => new Response() });`,
			["deviceRoutes"],
		],
		["device routes without fetch", "registry.deviceRoutes({});", ["deviceRoutes"]],
		["a listener that is not a function", 'registry.onEvent("listener");', []],
		[
			"one listener too many",
			`for (let index = 0; index <= ${MAX_LISTENERS}; index++) registry.onEvent(() => {});`,
			[],
		],
		["a migrations folder the config does not pin", 'registry.migrations("/elsewhere");', []],
		["a migrations declaration without a folder", "registry.migrations(undefined);", []],
		[
			"a backup target refusing an unknown data class",
			`registry.backup({ id: "b", refuses: ["slack.everything"], async put() {}, async list() { return []; }, async *get() {}, async delete() {} });`,
			["backup"],
		],
		[
			"a certificate provider with an unbounded renewal window",
			'registry.cert({ id: "c", renewBeforeMs: Infinity, async obtain() { return []; } });',
			["cert"],
		],
		[
			"a certificate provider renewing more than a year ahead",
			`registry.cert({ id: "c", renewBeforeMs: ${YEAR_AND_A_DAY_MS + 1}, async obtain() { return []; } });`,
			["cert"],
		],
	];
	it.each(refusals)(
		"refuses %s even when the module catches the refusal",
		async (_, body, provides) => {
			const alpha = f.module(
				"alpha",
				`try { ${body} } catch (error) { trace.push(error.constructor.name); }`,
				{ provides },
			);
			f.config([alpha]);
			await refused("registration", f.start());
			expect(trace()).toContain("ExtensionError");
			expect(trace()).not.toContain("getter");
		},
	);

	it("accepts a certificate provider renewing a year and a day ahead", async () => {
		f.config([
			f.module(
				"alpha",
				`registry.cert({ id: "c", renewBeforeMs: ${YEAR_AND_A_DAY_MS}, async obtain() { return []; } });`,
				{ provides: ["cert"] },
			),
		]);
		const host = await f.start();
		expect(host.providers("cert").map(({ id, renewBeforeMs }) => [id, renewBeforeMs])).toEqual([
			["c", YEAR_AND_A_DAY_MS],
		]);
	});

	it("refuses a declared service the module never registers", async () => {
		for (const provides of [["sendPolicy"], ["adminOp"], ["deviceRoutes"], ["auditSink", "push"]]) {
			resetTrace();
			f.config([
				f.module("alpha", 'registry.auditSink({ id: "sink", async append() {} });', { provides }),
			]);
			await refused("registration", f.start());
			expect(trace()).toContain("alpha:register");
		}
	});

	it("refuses one-per-hub services and repeated provider ids across modules", async () => {
		const identity = (id: string): string =>
			`registry.identity({ id: ${JSON.stringify(id)}, async users() { return []; }, maxOwners: () => 1 });`;
		const workspace = (id: string): string =>
			`registry.workspace({ id: ${JSON.stringify(id)}, async workspacesFor() { return []; }, async canAccess() { return true; } });`;
		for (const [service, register] of [
			["identity", identity],
			["workspace", workspace],
		] as const) {
			f.config([
				f.module("alpha", register("alpha-one"), { provides: [service] }),
				f.module("beta", register("beta-one"), { provides: [service] }),
			]);
			await refused("registration", f.start());
		}
		f.config([
			f.module("alpha", policy("shared"), { provides: ["sendPolicy"] }),
			f.module("beta", policy("shared"), { provides: ["sendPolicy"] }),
		]);
		await refused("registration", f.start());
		f.config([
			f.module("alpha", policy("alpha-floor"), { provides: ["sendPolicy"] }),
			f.module("beta", policy("beta-floor"), { provides: ["sendPolicy"] }),
		]);
		expect((await f.start()).modules).toHaveLength(2);
	});

	it("refuses late registrations and leaves the running host unchanged", async () => {
		f.config([
			f.module(
				"alpha",
				`${policy("alpha-floor")}
				setTimeout(() => {
					try { registry.auditSink({ id: "late", async append() {} }); }
					catch (error) { trace.push("late:" + error.code); }
				}, 0);`,
				{ provides: ["sendPolicy", "auditSink"] },
			),
		]);
		await refused("registration", f.start());
		await flush();
		expect(trace()).toContain("late:registration");
		resetTrace();
		f.config([f.module("alpha", policy("alpha-floor"), { provides: ["sendPolicy"] })]);
		const host = await f.start();
		const late = registry("alpha");
		refusedNow("registration", () =>
			late.sendPolicy({ id: "late", evaluate: async () => ({ kind: "deny", reason: "late" }) }),
		);
		refusedNow("registration", () => late.onEvent(() => undefined));
		refusedNow("registration", () =>
			late.adminOp("late", { summarize: () => [], apply: async () => undefined }),
		);
		refusedNow("registration", () => late.migrations("/elsewhere"));
		expect(await host.evaluateSendPolicy(input)).toEqual({
			kind: "require",
			approvals: 1,
			roles: [],
		});
		expect(host.adminOperation("alpha", "late")).toBeUndefined();
	});
});

describe("startup failures", () => {
	it("fails when module evaluation throws, has a syntax error or never finishes", async () => {
		f.config([f.module("alpha", "", { top: 'throw new Error("PRIVATE_CANARY");' })]);
		await refused("module", f.start());
		f.config([f.module("alpha", "", { top: "export const broken = ;" })]);
		await refused("module", f.start());
		const clock = manualClock();
		f.config([f.module("alpha", "", { top: "await new Promise(() => {});" })]);
		const pending = f.start({ clock });
		await flush();
		expect(clock.waits).toEqual([MODULE_TIMEOUT_MS]);
		clock.fire();
		await refused("module", pending);
		expect(trace()).not.toContain("alpha:register");
	});

	it("fails when register throws, rejects or never settles", async () => {
		f.config([f.module("alpha", 'throw new Error("PRIVATE_CANARY");')]);
		await refused("module", f.start());
		f.config([f.module("alpha", 'await Promise.reject(new Error("PRIVATE_CANARY"));')]);
		await refused("module", f.start());
		const clock = manualClock();
		f.config([f.module("alpha", "await new Promise(() => {});")]);
		const pending = f.start({ clock });
		await flush();
		expect(clock.waits).toEqual([MODULE_TIMEOUT_MS, MODULE_TIMEOUT_MS]);
		clock.fire();
		await refused("module", pending);
	});

	it.each([
		["evaluation", "one millisecond inside ten seconds", MODULE_TIMEOUT_MS - 1, true],
		["evaluation", "to ten seconds", MODULE_TIMEOUT_MS, false],
		["evaluation", "past ten seconds", MODULE_TIMEOUT_MS + 1, false],
		["evaluation", "while the clock goes backwards", -1, false],
		["register()", "one millisecond inside ten seconds", MODULE_TIMEOUT_MS - 1, true],
		["register()", "to ten seconds", MODULE_TIMEOUT_MS, false],
		["register()", "past ten seconds", MODULE_TIMEOUT_MS + 1, false],
		["register()", "while the clock goes backwards", -1, false],
	])(
		"judges module %s a busy event loop delays %s by the host's monotonic clock",
		async (where, _, ms, starts) => {
			const clock = manualClock();
			const late = busyFor(ms);
			f.config([
				where === "evaluation" ? f.module("alpha", "", { top: late }) : f.module("alpha", late),
			]);
			const pending = f.start({ clock });
			if (starts) expect((await pending).modules).toEqual([{ id: "alpha", version: "1.0.0" }]);
			else await refused("module", pending);
			const registered = where === "register()" || starts;
			expect(clock.waits).toEqual(
				registered ? [MODULE_TIMEOUT_MS, MODULE_TIMEOUT_MS] : [MODULE_TIMEOUT_MS],
			);
			expect(trace().includes("alpha:register")).toBe(registered);
		},
	);

	it.each([
		["another module id", "beta", {}],
		["another version", "alpha", { version: "1.0.1" }],
		["an unknown descriptor field", "alpha", { descriptor: "\n\tcapabilities: []," }],
		[
			"a descriptor accessor",
			"alpha",
			{ descriptor: '\n\tget extra() { trace.push("getter"); },' },
		],
		["an invalid migrations folder", "alpha", { descriptor: '\n\tmigrations: "/elsewhere",' }],
	])("refuses a default export with %s before registration", async (_, id, options) => {
		const entry = f.module(id, "", options);
		f.config([{ ...entry, id: "alpha", version: "1.0.0" }]);
		await refused("module", f.start());
		expect(trace()).toContain(`${id}:loaded`);
		expect(trace()).not.toContain(`${id}:register`);
		expect(trace()).not.toContain("getter");
	});

	it("refuses a declared migrations folder that is not the pinned one", async () => {
		const other = path.join(f.dir, "other-migrations");
		mkdirSync(other);
		writeFileSync(path.join(other, "0001_rows.sql"), "CREATE TABLE ext_alpha_rows(id TEXT);");
		f.config([f.module("alpha", "", { descriptor: `\n\tmigrations: ${JSON.stringify(other)},` })]);
		await refused("module", f.start());
		expect(trace()).not.toContain("alpha:register");
	});

	it("accepts the pinned migrations folder declared once and refuses a second declaration", async () => {
		const directory = path.join(f.dir, "modules", "alpha", "migrations");
		const declare = `registry.migrations(${JSON.stringify(directory)});`;
		const migrations = {
			"0001_rows.sql": "CREATE TABLE ext_alpha_rows(id TEXT PRIMARY KEY) STRICT;",
		};
		f.config([
			f.module("alpha", declare, {
				migrations,
				descriptor: `\n\tmigrations: ${JSON.stringify(directory)},`,
			}),
		]);
		const host = await f.start();
		expect(host.modules).toEqual([{ id: "alpha", version: "1.0.0" }]);
		expect(registry("alpha").db().insert("ext_alpha_rows", { id: "a" })).toBe(1);
		host.close();
		resetTrace();
		f.config([
			f.module("alpha", `${declare} try { ${declare} } catch (error) { trace.push(error.code); }`, {
				migrations,
			}),
		]);
		await refused("registration", f.start());
		expect(trace()).toContain("registration");
	});

	it("refuses a module without a default export", async () => {
		const entry = f.module("alpha");
		const bare = readFileSync(entry.entry, "utf8").replace("export default {", "const unused = {");
		writeFileSync(entry.entry, bare);
		f.config([{ ...entry, sha512: pin(bare) }]);
		await refused("module", f.start());
		expect(trace()).toEqual(["alpha:loaded"]);
	});

	it("retires every registration and closes every module database after a later failure", async () => {
		const capture = captureConnections();
		try {
			f.config([
				f.module("alpha", `${policy("alpha-floor")} registry.onEvent(() => {});`, {
					provides: ["sendPolicy"],
				}),
				f.module("beta", "", { provides: ["auditSink"] }),
			]);
			await refused("registration", f.start());
			expect(capture.connections).toHaveLength(2);
			expect(capture.connections.every((connection) => connection.open === false)).toBe(true);
		} finally {
			capture.restore();
		}
		const alpha = registry("alpha");
		refusedNow("registration", () =>
			alpha.sendPolicy({ id: "again", evaluate: async () => ({ kind: "deny", reason: "x" }) }),
		);
		refusedNow("database", () => alpha.db().select("ext_alpha_rows", { limit: 1 }));
		refusedNow("unavailable", () => alpha.log.info("alpha.started"));
		f.config([f.module("alpha", policy("alpha-floor"), { provides: ["sendPolicy"] })]);
		expect((await f.start()).modules).toEqual([{ id: "alpha", version: "1.0.0" }]);
	});

	it("keeps a failed native close and refuses the next start until it closes", async () => {
		f.config([f.module("alpha")]);
		const capture = captureConnections();
		const host = await f.start().finally(() => capture.restore());
		const [connection] = capture.connections;
		const close = blockNativeClose();
		try {
			refusedNow("cleanup", () => host.close());
			expect(connection?.open).toBe(true);
			expect(() => host.close()).not.toThrow();
			await refused("cleanup", f.start());
			close.blocked = false;
			const next = await f.start();
			expect(connection?.open).toBe(false);
			next.close();
		} finally {
			close.restore();
		}
	});

	it("reports the startup failure and keeps a connection whose close failed", async () => {
		f.config([f.module("alpha"), f.module("beta", 'throw new Error("PRIVATE_CANARY");')]);
		const close = blockNativeClose();
		try {
			await refused("module", f.start());
			await refused("cleanup", f.start());
			close.blocked = false;
			f.config([f.module("alpha")]);
			expect((await f.start()).modules).toEqual([{ id: "alpha", version: "1.0.0" }]);
		} finally {
			close.restore();
		}
	});
});

describe("host lifecycle", () => {
	it("allows one live host per data folder, even while the first is still starting", async () => {
		f.config([f.module("alpha", policy("alpha-floor"), { provides: ["sendPolicy"] })]);
		const first = f.start();
		await refused("unavailable", f.start());
		const host = await first;
		host.close();
		host.close();
		expect(host.providers("auditSink")).toEqual([]);
		expect(await host.evaluateSendPolicy(input)).toEqual({ kind: "deny", policies: [] });
		expect(await host.canAccessWorkspace(ULID, ULID)).toBe(false);
		await f.start();
	});

	it("closes the module databases and retires every registration on close", async () => {
		f.config([
			f.module(
				"alpha",
				`registry.adminOp("rotate", { summarize: () => [], async apply() {} });
				registry.deviceRoutes({ fetch: () => new Response() });
				registry.auditSink({ id: "alpha-sink", async append() {} });
				registry.onEvent(() => trace.push("event"));`,
				{ provides: ["adminOp", "deviceRoutes", "auditSink"] },
			),
		]);
		const host = await f.start();
		const event = {
			id: ULID,
			at: 1,
			action: "outbox.sent",
			actor: { kind: "hub", id: null },
			refs: {},
		} as const;
		expect(host.adminOperation("alpha", "rotate")).toBeDefined();
		expect(host.deviceRoutes("alpha")).toBeDefined();
		expect(host.providers("auditSink")).toHaveLength(1);
		host.notify(event);
		host.close();
		expect(host.adminOperation("alpha", "rotate")).toBeUndefined();
		expect(host.deviceRoutes("alpha")).toBeUndefined();
		expect(host.providers("auditSink")).toEqual([]);
		host.notify(event);
		await flush();
		expect(trace()).not.toContain("event");
		refusedNow("database", () => registry("alpha").db().select("ext_alpha_rows", { limit: 1 }));
	});

	it("refuses registrations it returned before close once the host closes", async () => {
		f.config([
			f.module(
				"alpha",
				`registry.adminOp("rotate", { summarize: () => { trace.push("summarize"); return []; }, async apply() { trace.push("apply"); } });
				registry.deviceRoutes({ fetch: () => { trace.push("fetch"); return new Response("DYTEST-ROUTE"); } });
				registry.auditSink({ id: "alpha-sink", async append() { trace.push("append"); } });`,
				{ provides: ["adminOp", "deviceRoutes", "auditSink"] },
			),
		]);
		const host = await f.start();
		const [sink] = host.providers("auditSink");
		const operation = host.adminOperation("alpha", "rotate");
		const routes = host.deviceRoutes("alpha");
		const request = () => new Request("https://hub.test/ext/alpha/status");
		expect(operation?.summarize({})).toEqual([]);
		await operation?.apply({});
		await sink?.append({} as never);
		expect(await (await routes?.fetch(request()))?.text()).toBe("DYTEST-ROUTE");
		expect(trace().slice(-4)).toEqual(["summarize", "apply", "append", "fetch"]);
		trace().splice(0);
		host.close();
		refusedNow("unavailable", () => operation?.summarize({}));
		refusedNow("unavailable", () => operation?.apply({}));
		refusedNow("unavailable", () => sink?.append({} as never));
		refusedNow("unavailable", () => routes?.fetch(request()));
		expect(trace()).toEqual([]);
	});

	it("denies a decision and refuses access that settle only after close", async () => {
		const shared = globalThis as Record<symbol, unknown>;
		const gate = Symbol.for("draftyak.test.gate");
		const wait = 'await globalThis[Symbol.for("draftyak.test.gate")];';
		let release = (): void => undefined;
		shared[gate] = Promise.resolve();
		try {
			f.config([
				f.module(
					"alpha",
					`registry.sendPolicy({ id: "gated", async evaluate() { ${wait} return { kind: "require", approvals: 2 }; } });
					registry.workspace({ id: "gated", async workspacesFor() { return []; }, async canAccess() { ${wait} return true; } });`,
					{ provides: ["sendPolicy", "workspace"] },
				),
			]);
			const host = await f.start({ clock: manualClock() });
			expect(await host.evaluateSendPolicy(input)).toEqual({
				kind: "require",
				approvals: 2,
				roles: [],
			});
			expect(await host.canAccessWorkspace(ULID, ULID)).toBe(true);
			shared[gate] = new Promise<void>((resolve) => {
				release = resolve;
			});
			const decision = host.evaluateSendPolicy(input);
			const access = host.canAccessWorkspace(ULID, ULID);
			await flush();
			host.close();
			release();
			expect(await decision).toEqual({ kind: "deny", policies: [] });
			expect(await access).toBe(false);
		} finally {
			release();
			delete shared[gate];
		}
	});

	it.each([
		// "." exists wherever the suite runs, so the refusal can't come from a missing folder.
		["a relative data folder", () => ({ dataDirectory: "." })],
		[
			"a data folder with a trailing separator",
			(dir: string) => ({ dataDirectory: `${dir}${path.sep}` }),
		],
		["a master key look-alike", () => ({ masterKey: { derive: () => Buffer.alloc(32) } })],
		["a clock without a timer", () => ({ clock: { wallMs: () => 0, monotonicMs: () => 0 } })],
		[
			"a clock without a monotonic reading",
			() => ({ clock: { wallMs: () => 0, after: async () => undefined } }),
		],
		["a null clock", () => ({ clock: null })],
		["a log sink that is not a function", () => ({ log: "console" })],
		["an unknown option", () => ({ store: {} })],
	])("refuses %s before reading config", async (_, options) => {
		f.config([f.module("alpha")]);
		await refused("config", f.start(options(f.dir) as never));
		expect(trace()).toEqual([]);
	});

	it("refuses a data folder reached through a directory link", async () => {
		const target = path.join(f.dir, "real");
		mkdirSync(target);
		const alias = path.join(f.dir, "alias");
		symlinkSync(target, alias, "junction");
		await refused("config", f.start({ dataDirectory: alias }));
	});
});

describe("the deadline clock captured at start", () => {
	const shared = globalThis as Record<symbol, unknown>;
	const gate = Symbol.for("draftyak.test.gate");
	let release = (): void => undefined;
	beforeEach(() => {
		shared[gate] = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.config([
			f.module(
				"alpha",
				'registry.sendPolicy({ id: "gated", async evaluate() { await globalThis[Symbol.for("draftyak.test.gate")]; return { kind: "require", approvals: 2 }; } });',
				{ provides: ["sendPolicy"] },
			),
		]);
	});
	afterEach(() => {
		release();
		delete shared[gate];
	});

	it("denies a result that arrives past two seconds on the default monotonic clock", async () => {
		const reading = performance.now.bind(performance);
		let skew = 0;
		const now = vi.spyOn(performance, "now").mockImplementation(() => reading() + skew);
		try {
			const host = await f.start();
			const decision = host.evaluateSendPolicy(input);
			await flush();
			skew = POLICY_TIMEOUT_MS + 1;
			release();
			expect(await decision).toEqual({ kind: "deny", policies: ["alpha/gated"] });
			// With the skew now steady, the same policy is in time again.
			expect(await host.evaluateSendPolicy(input)).toEqual({
				kind: "require",
				approvals: 2,
				roles: [],
			});
		} finally {
			now.mockRestore();
		}
	});

	it.each(["after", "monotonicMs"] as const)(
		"keeps the supplied clock's %s from start when the clock object changes later",
		async (member) => {
			const clock = manualClock();
			const host = await f.start({ clock });
			// Either replacement would deny if it were used: a timer that has already ended, or a
			// reading that moves past the bound each time it is read.
			const reads: string[] = [];
			if (member === "after")
				clock.after = async () => {
					reads.push(member);
				};
			else
				clock.monotonicMs = () => {
					reads.push(member);
					return reads.length * (POLICY_TIMEOUT_MS + 1);
				};
			const decision = host.evaluateSendPolicy(input);
			await flush();
			release();
			expect(await decision).toEqual({ kind: "require", approvals: 2, roles: [] });
			expect(reads).toEqual([]);
			expect(clock.waits).toEqual([MODULE_TIMEOUT_MS, MODULE_TIMEOUT_MS, POLICY_TIMEOUT_MS]);
		},
	);
});

it("delivers only an ids-only, frozen event to listeners and isolates their failures", async () => {
	f.config([
		f.module(
			"alpha",
			`registry.onEvent(() => { throw new Error("PRIVATE_CANARY"); });
			registry.onEvent(async () => { throw new Error("PRIVATE_CANARY"); });
			registry.onEvent((event) => {
				trace.push(Object.keys(event).sort().join(","), Object.isFrozen(event), Object.isFrozen(event.refs));
				try { event.refs.outbox = "changed"; } catch (error) { trace.push(error.constructor.name); }
			});`,
		),
	]);
	const host = await f.start();
	const event = {
		id: ULID,
		at: 1,
		action: "outbox.sent",
		actor: { kind: "device", id: ULID },
		refs: { outbox: ULID },
	} as const;
	host.notify(event);
	host.notify({ ...event, refs: { outbox: "not-an-id" } } as never);
	expect(trace()).not.toContain("action,at,id,refs");
	await flush();
	expect(trace().filter((item) => item === "action,at,id,refs")).toHaveLength(1);
	expect(trace()).toContain("TypeError");
	expect(trace().filter((item) => item === true)).toHaveLength(2);
	expect(event.refs.outbox).toBe(ULID);
});
